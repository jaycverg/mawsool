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

  it('marks the wording that came from a machine-checkable published source as verified', () => {
    expect(status('phq9', 'en')).toBe('verified');
    expect(status('phq9', 'ar')).toBe('verified');
    expect(status('gad7', 'en')).toBe('verified');
    expect(status('gad7', 'ar')).toBe('verified');
    expect(status('who5', 'en')).toBe('verified');
    expect(status('cssrs', 'en')).toBe('verified');
  });

  it('keeps the Arabic WHO-5 hand transcription and the missing Arabic C-SSRS unverified', () => {
    expect(status('who5', 'ar')).toBe('unverified');
    expect(status('cssrs', 'ar')).toBe('unverified');
  });

  it('has no item text at all for the Arabic C-SSRS, because none was obtained', () => {
    const wording = wordingFor('cssrs', 'ar');
    expect(wording.sourceId).toBeNull();
    expect(wording.items.every((item) => item.text === null)).toBe(true);
    expect(sourceFor('cssrs', 'ar')).toBeNull();
  });

  it('asks for a visible label on unverified wording and on missing text, and not on verified wording', () => {
    expect(needsUnverifiedLabel('who5', 'ar', wordingFor('who5', 'ar').items[0]!)).toBe(true);
    expect(needsUnverifiedLabel('cssrs', 'ar', wordingFor('cssrs', 'ar').items[0]!)).toBe(true);
    expect(needsUnverifiedLabel('phq9', 'en', wordingFor('phq9', 'en').items[0]!)).toBe(false);
    expect(needsUnverifiedLabel('phq9', 'ar', wordingFor('phq9', 'ar').items[8]!)).toBe(false);
  });

  it('never marks a locale verified unless its source row says where the text came from', () => {
    for (const instrument of INSTRUMENTS) {
      for (const locale of LOCALES) {
        const wording = wordingFor(instrument, locale);
        if (wording.wordingStatus === 'verified') {
          const source = sourceFor(instrument, locale);
          expect(source?.url, `${instrument} ${locale}`).toMatch(/^https:\/\//);
        }
      }
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
