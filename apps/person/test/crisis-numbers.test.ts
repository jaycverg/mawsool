import { CRISIS_NUMBERS_CONFIG } from '@mawsool/rules';
import { createTranslator } from 'next-intl';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { crisisTexts, numbersText, type Translate } from '../lib/crisis-copy';
import { crisisLines, formatDialNumber } from '../lib/crisis-numbers';

const messages = (locale: 'ar' | 'en') => JSON.parse(readFileSync(join(__dirname, '..', 'messages', `${locale}.json`), 'utf8')) as Record<string, Record<string, unknown>>;
const translator = (locale: 'ar' | 'en', namespace: 'crisis' | 'settings') =>
  createTranslator({ locale, messages: messages(locale) as never, namespace: namespace as never }) as unknown as Translate;

const CHANGED = [
  { number: '800725462' as const, role: 'hotline' as const, label: 'LINE-X' },
  { number: '999' as const, role: 'police' as const, label: 'Police' },
  { number: '998' as const, role: 'ambulance' as const, label: 'Ambulance' },
];

describe('crisis numbers', () => {
  it('come from the config by role, with the ambulance and then the police as the emergency numbers', () => {
    expect(CRISIS_NUMBERS_CONFIG.map((entry) => entry.number)).toEqual(['800725462', '999', '998']);
    const lines = crisisLines();
    expect(lines.hotline).toEqual({ number: '800725462', name: '800-SAKINA', display: '800 725462' });
    expect(lines.emergency.map((line) => line.number)).toEqual(['998', '999']);
  });

  it('follow the roles, not the order, in the config', () => {
    const lines = crisisLines([CHANGED[2]!, CHANGED[1]!, CHANGED[0]!]);
    expect(lines.hotline.number).toBe('800725462');
    expect(lines.emergency.map((line) => line.number)).toEqual(['998', '999']);
  });

  it.each(['hotline', 'ambulance', 'police'] as const)('refuse a config with no %s rather than show a screen without it', (role) => {
    expect(() => crisisLines(CHANGED.filter((entry) => entry.role !== role))).toThrow(role);
  });

  it('read the hotline as 800 725462 and leave short numbers alone', () => {
    expect(formatDialNumber('800725462')).toBe('800 725462');
    expect(formatDialNumber('999')).toBe('999');
  });
});

describe.each(['en', 'ar'] as const)('no number in the %s message file', (locale) => {
  it('holds any crisis number, the hotline digits or the line name, anywhere in any message', () => {
    const text = JSON.stringify(messages(locale));
    const spaced = (n: string) => formatDialNumber(n);
    for (const entry of CRISIS_NUMBERS_CONFIG) {
      expect(text, entry.number).not.toContain(entry.number);
      expect(text, spaced(entry.number)).not.toContain(spaced(entry.number));
      if (entry.role === 'hotline') expect(text, entry.label).not.toContain(entry.label);
    }
    expect(text).not.toContain('725462');
    expect(text).not.toContain('SAKINA');
    expect(text).not.toMatch(/\b(998|999)\b/);
  });
});

describe.each(['en', 'ar'] as const)('the %s crisis screen text', (locale) => {
  const render = (config: Parameters<typeof crisisLines>[0]) => crisisTexts(translator(locale, 'crisis'), crisisLines(config));

  it('shows the numbers in the config', () => {
    const texts = render(undefined);
    expect(texts.hotline.title).toContain('800-SAKINA');
    expect(texts.hotline.detail).toContain('800 725462');
    expect(texts.emergency.map((line) => line.dial)).toEqual(['998', '999']);
    expect(texts.emergency[0]!.title).toContain('998');
    expect(texts.emergency[1]!.title).toContain('999');
    expect(texts.offline).toContain('999');
    expect(texts.offline).toContain('998');
  });

  it('changes when the config changes: a new hotline number, name and emergency numbers show up everywhere, the old ones nowhere', () => {
    const changed = render([
      { number: '800725462', role: 'hotline', label: 'LINE-X' },
      { number: '998', role: 'police', label: 'Police' },
      { number: '999', role: 'ambulance', label: 'Ambulance' },
    ]);
    const all = JSON.stringify(changed);
    expect(changed.hotline.title).toContain('LINE-X');
    expect(all).not.toContain('SAKINA');
    // The roles swapped: 999 is now the ambulance, 998 the police.
    expect(changed.emergency.map((line) => line.dial)).toEqual(['999', '998']);
    expect(changed.emergency[0]!.title).toContain('999');
    expect(changed.offline.indexOf('998')).toBeLessThan(changed.offline.indexOf('999'));
  });

  it('shows a changed hotline number, formatted, in the detail line', () => {
    const lines = crisisLines(CHANGED.map((entry) => (entry.role === 'hotline' ? { ...entry, number: '800111222' as never } : entry)));
    const texts = crisisTexts(translator(locale, 'crisis'), lines);
    expect(texts.hotline.detail).toContain('800 111222');
    expect(texts.hotline.detail).not.toContain('725462');
  });

  it('puts the privacy screen\'s list of numbers through the same config', () => {
    const t = translator(locale, 'settings');
    expect(numbersText(t, crisisLines())).toContain('800 725462');
    const other = numbersText(t, crisisLines(CHANGED.map((entry) => (entry.role === 'police' ? { ...entry, number: '997' as never } : entry))));
    expect(other).toContain('997');
    expect(other).not.toContain('999');
  });
});
