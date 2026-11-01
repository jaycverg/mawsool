import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOCALE,
  LOCALE_LABELS,
  directionFor,
  isLocale,
  isRtl,
  localeFromPathname,
  mergeMessages,
  otherLocale,
  readStoredLocale,
  resolveInitialLocale,
  storeLocale,
  swapLocaleInPath,
} from '../src';

describe('locale basics', () => {
  it('knows ar and en only', () => {
    expect(isLocale('ar')).toBe(true);
    expect(isLocale('en')).toBe(true);
    expect(isLocale('fr')).toBe(false);
    expect(isLocale(undefined)).toBe(false);
    expect(isLocale(3)).toBe(false);
  });

  it('sets right-to-left for Arabic only', () => {
    expect(directionFor('ar')).toBe('rtl');
    expect(directionFor('en')).toBe('ltr');
    expect(isRtl('ar')).toBe(true);
    expect(isRtl('en')).toBe(false);
  });

  it('labels each language in its own script', () => {
    expect(LOCALE_LABELS).toEqual({ ar: 'عربي', en: 'English' });
    expect(otherLocale('ar')).toBe('en');
    expect(otherLocale('en')).toBe('ar');
  });
});

describe('resolveInitialLocale', () => {
  it('prefers the stored choice', () => {
    expect(resolveInitialLocale('ar', ['en-US'])).toBe('ar');
    expect(resolveInitialLocale('en', ['ar-AE'])).toBe('en');
  });

  it('falls back to the first supported browser language, ignoring region and case', () => {
    expect(resolveInitialLocale(null, ['fr-FR', 'AR-ae', 'en'])).toBe('ar');
    expect(resolveInitialLocale(undefined, ['en-GB'])).toBe('en');
  });

  it('ignores an unsupported stored value and defaults to English with nothing usable', () => {
    expect(resolveInitialLocale('xx', ['ar'])).toBe('ar');
    expect(resolveInitialLocale(null, ['fr', 'de'])).toBe(DEFAULT_LOCALE);
    expect(resolveInitialLocale(null, [])).toBe('en');
  });
});

describe('paths', () => {
  it('reads and swaps the locale segment', () => {
    expect(localeFromPathname('/ar/ticket')).toBe('ar');
    expect(localeFromPathname('/ticket')).toBeNull();
    expect(localeFromPathname('/')).toBeNull();
    expect(swapLocaleInPath('/en/ticket', 'ar')).toBe('/ar/ticket');
    expect(swapLocaleInPath('/ar/', 'en')).toBe('/en/');
    expect(swapLocaleInPath('/ar', 'en')).toBe('/en');
  });

  it('adds a locale when the path has none', () => {
    expect(swapLocaleInPath('/ticket', 'ar')).toBe('/ar/ticket');
    expect(swapLocaleInPath('ticket', 'ar')).toBe('/ar/ticket');
  });
});

describe('remembering the locale', () => {
  const memory = () => {
    const data = new Map<string, string>();
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
  };

  it('round-trips through storage', () => {
    const storage = memory();
    expect(readStoredLocale(storage)).toBeNull();
    expect(storeLocale(storage, 'ar')).toBe(true);
    expect(readStoredLocale(storage)).toBe('ar');
  });

  it('survives missing or blocked storage', () => {
    const blocked = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readStoredLocale(undefined)).toBeNull();
    expect(readStoredLocale(blocked)).toBeNull();
    expect(storeLocale(undefined, 'ar')).toBe(false);
    expect(storeLocale(blocked, 'ar')).toBe(false);
  });

  it('ignores a stored value that is not a locale', () => {
    expect(readStoredLocale({ getItem: () => 'fr' })).toBeNull();
  });
});

describe('mergeMessages', () => {
  it('lets app keys win and merges nested objects', () => {
    const merged = mergeMessages({ common: { a: '1', b: '2' }, only: 'common' }, { common: { b: 'app' }, extra: { x: 'y' } });
    expect(merged).toEqual({ common: { a: '1', b: 'app' }, only: 'common', extra: { x: 'y' } });
  });

  it('replaces arrays and primitives wholesale', () => {
    expect(mergeMessages({ a: [1], b: { c: 1 } }, { a: [2], b: 'flat' })).toEqual({ a: [2], b: 'flat' });
  });
});
