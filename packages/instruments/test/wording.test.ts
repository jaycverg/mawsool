import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { INSTRUMENTS, LOCALES } from '@mawsool/types';
import {
  WORDING,
  WORDING_SOURCES,
  itemCount,
  needsUnverifiedLabel,
  sourceFor,
  wordingFor,
} from '../src';

const SOURCES_MD = readFileSync(join(__dirname, '..', 'SOURCES.md'), 'utf8');

describe('wording data', () => {
  it.each(INSTRUMENTS.flatMap((i) => LOCALES.map((l) => [i, l] as const)))('%s %s has one item per question, numbered in order', (instrument, locale) => {
    const { items } = wordingFor(instrument, locale);
    expect(items.map((item) => item.id)).toEqual(
      Array.from({ length: itemCount(instrument) }, (_, n) => `${instrument}.${n + 1}`),
    );
  });

  it('PHQ-9 item 9 in English is the suicidal-thoughts item, as published', () => {
    expect(wordingFor('phq9', 'en').items[8]?.text).toBe(
      'Thoughts that you would be better off dead or of hurting yourself in some way',
    );
  });

  it('every item of a verified locale has text, a source, and a stem', () => {
    for (const instrument of INSTRUMENTS) {
      for (const locale of LOCALES) {
        const wording = wordingFor(instrument, locale);
        if (wording.wordingStatus !== 'verified') continue;
        expect(wording.sourceId, `${instrument} ${locale}`).not.toBeNull();
        expect(wording.stem, `${instrument} ${locale}`).toBeTruthy();
        for (const item of wording.items) expect(item.text, item.id).toBeTruthy();
      }
    }
  });
});

describe('wordingStatus', () => {
  const status = (i: (typeof INSTRUMENTS)[number], l: (typeof LOCALES)[number]) => wordingFor(i, l).wordingStatus;

  it('marks only the English PHQ-9 and GAD-7, which have a cited published validation study, as verified', () => {
    expect(status('phq9', 'en')).toBe('verified');
    expect(status('gad7', 'en')).toBe('verified');
  });

  it('keeps every other instrument and locale unverified, including copied text with no validation of that form', () => {
    expect(status('who5', 'en')).toBe('unverified');
    expect(status('cssrs', 'en')).toBe('unverified');
    for (const instrument of INSTRUMENTS) expect(status(instrument, 'ar'), `${instrument} ar`).toBe('unverified');
  });

  it('keeps the text of the Arabic PHQ-9, GAD-7 and WHO-5 while marking it unverified', () => {
    for (const instrument of ['phq9', 'gad7', 'who5'] as const) {
      const wording = wordingFor(instrument, 'ar');
      expect(wording.sourceId).toBe(`${instrument}-ar`);
      expect(wording.items.every((item) => item.text !== null && item.text.length > 0), instrument).toBe(true);
    }
  });

  it('keeps the English WHO-5 text and source while marking it unverified, and the label fires', () => {
    const wording = wordingFor('who5', 'en');
    expect(wording.sourceId).toBe('who5-en');
    expect(wording.items.map((item) => item.text)).toEqual([
      'I have felt cheerful and in good spirits',
      'I have felt calm and relaxed',
      'I have felt active and vigorous',
      'I woke up feeling fresh and rested',
      'My daily life has been filled with things that interest me',
    ]);
    expect(sourceFor('who5', 'en')?.validationSource).toBeNull();
    for (const item of wording.items) expect(needsUnverifiedLabel('who5', 'en', item)).toBe(true);
  });

  it('has no item text at all for the Arabic C-SSRS, because none was obtained', () => {
    const wording = wordingFor('cssrs', 'ar');
    expect(wording.sourceId).toBeNull();
    expect(wording.items.every((item) => item.text === null)).toBe(true);
    expect(sourceFor('cssrs', 'ar')).toBeNull();
  });

  it('asks for a visible label on every item of every unverified locale, and on no item of a verified one', () => {
    for (const instrument of INSTRUMENTS) {
      for (const locale of LOCALES) {
        const wording = wordingFor(instrument, locale);
        for (const item of wording.items) {
          expect(needsUnverifiedLabel(instrument, locale, item), `${item.id} ${locale}`).toBe(wording.wordingStatus === 'unverified');
        }
      }
    }
  });

  it('asks for a label on an item with no text even if its locale were marked verified', () => {
    expect(needsUnverifiedLabel('cssrs', 'ar', { id: 'cssrs.1', text: null })).toBe(true);
  });

  it('never marks a locale verified unless its source has a URL and a cited published validation study', () => {
    for (const instrument of INSTRUMENTS) {
      for (const locale of LOCALES) {
        const wording = wordingFor(instrument, locale);
        if (wording.wordingStatus !== 'verified') continue;
        const source = sourceFor(instrument, locale);
        expect(source?.url, `${instrument} ${locale}`).toMatch(/^https:\/\//);
        expect(source?.validationSource?.url, `${instrument} ${locale}`).toMatch(/^https:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/\d+\/$/);
        expect(source?.validationSource?.citation, `${instrument} ${locale}`).toBeTruthy();
      }
    }
  });

  it('gives every unverified locale that has a source a reason and no validation study, and every source a status basis', () => {
    for (const [id, source] of Object.entries(WORDING_SOURCES)) {
      expect(source.statusBasis.length, id).toBeGreaterThan(20);
      const { wordingStatus } = wordingFor(source.instrument, source.locale);
      if (wordingStatus === 'unverified') expect(source.validationSource, id).toBeNull();
    }
  });
});

describe('SOURCES.md', () => {
  it('has a row for every source id, and every wording source id resolves', () => {
    for (const id of Object.keys(WORDING_SOURCES)) {
      expect(SOURCES_MD, id).toContain(`\`${id}\``);
    }
    for (const instrument of INSTRUMENTS) {
      for (const locale of LOCALES) {
        const { sourceId } = wordingFor(instrument, locale);
        if (sourceId !== null) expect(WORDING_SOURCES[sourceId]).toBeDefined();
      }
    }
  });

  it('states the status of every instrument-locale row, and that unverified rows are unverified', () => {
    for (const instrument of INSTRUMENTS) {
      for (const locale of LOCALES) {
        const id = `${instrument}-${locale}`;
        const row = SOURCES_MD.split('\n').find((line) => line.includes(`\`${id}\``));
        expect(row, id).toBeDefined();
        const expected = WORDING[instrument][locale].wordingStatus;
        expect(row, id).toMatch(expected === 'verified' ? /\|\s*verified\s*\|/ : /\|\s*unverified\s*\|/);
      }
    }
  });

  it('keeps source ids and WORDING_SOURCES keys identical', () => {
    for (const [key, source] of Object.entries(WORDING_SOURCES)) expect(source.id).toBe(key);
  });
});

describe('package boundary', () => {
  it('imports nothing but relative files and @mawsool/types, so no network or AI client can enter the crisis path', () => {
    const dir = join(__dirname, '..', 'src');
    const files = readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map((entry) => join(entry.parentPath, entry.name));
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const imports = [...readFileSync(file, 'utf8').matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);
      for (const spec of imports) {
        expect(spec.startsWith('.') || spec === '@mawsool/types', `${file} imports ${spec}`).toBe(true);
      }
    }
  });
});
