import { LOCALES, type Locale } from '@mawsool/types';

export { LOCALES, type Locale };

export const DEFAULT_LOCALE: Locale = 'en';
export const DEFAULT_LOCALE_STORAGE_KEY = 'mawsool.locale';

/** Names of the languages in their own script, for the toggle. */
export const LOCALE_LABELS: Record<Locale, string> = { ar: 'عربي', en: 'English' };

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/** `ar` is right to left; `en` is left to right. */
export function directionFor(locale: Locale): 'rtl' | 'ltr' {
  return locale === 'ar' ? 'rtl' : 'ltr';
}

export function isRtl(locale: Locale): boolean {
  return directionFor(locale) === 'rtl';
}

/** The locale a first-time visitor gets: the stored choice, else the first supported browser language, else English. */
export function resolveInitialLocale(stored: string | null | undefined, browserLanguages: readonly string[]): Locale {
  if (isLocale(stored)) return stored;
  for (const tag of browserLanguages) {
    const primary = tag.toLowerCase().split('-')[0];
    if (isLocale(primary)) return primary;
  }
  return DEFAULT_LOCALE;
}

/** The locale at the start of a path, or null: `/ar/ticket` gives `ar`. */
export function localeFromPathname(pathname: string): Locale | null {
  const first = pathname.split('/')[1];
  return isLocale(first) ? first : null;
}

/** Replaces the leading locale segment, or adds one: `/en/ticket` to `ar` gives `/ar/ticket`. */
export function swapLocaleInPath(pathname: string, to: Locale): string {
  const segments = pathname.split('/');
  if (isLocale(segments[1])) {
    segments[1] = to;
    return segments.join('/');
  }
  return `/${to}${pathname.startsWith('/') ? '' : '/'}${pathname}`;
}

/** The locale to switch to from `current`. */
export function otherLocale(current: Locale): Locale {
  return current === 'ar' ? 'en' : 'ar';
}

/** Reads the remembered locale. Storage can be missing or blocked (private mode), so every access is guarded. */
export function readStoredLocale(storage: Pick<Storage, 'getItem'> | undefined, key = DEFAULT_LOCALE_STORAGE_KEY): Locale | null {
  try {
    const value = storage?.getItem(key);
    return isLocale(value) ? value : null;
  } catch {
    return null;
  }
}

/** Remembers the locale; returns false when storage is unavailable. */
export function storeLocale(storage: Pick<Storage, 'setItem'> | undefined, locale: Locale, key = DEFAULT_LOCALE_STORAGE_KEY): boolean {
  try {
    if (!storage) return false;
    storage.setItem(key, locale);
    return true;
  } catch {
    return false;
  }
}

/** Merges message trees: keys in `app` win over keys in `common`, one level of nesting at a time. */
export function mergeMessages<T extends Record<string, unknown>>(common: T, app: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...common };
  for (const [key, value] of Object.entries(app)) {
    const existing = out[key];
    out[key] =
      isPlainObject(existing) && isPlainObject(value) ? mergeMessages(existing, value) : value;
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
