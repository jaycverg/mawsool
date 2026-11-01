import { describe, expect, it } from 'vitest';
import { GUARDED_ROUTES, href, isGuardedPath, stripLocale } from '../lib/routes';

describe('isGuardedPath', () => {
  it.each(['/en/options/', '/ar/options/', '/en/consent/', '/ar/consent/', '/en/ticket/', '/ar/ticket/', '/en/check-in/', '/en/result/', '/en/check-ins/', '/en/options', '/ar/consent/extra/'])(
    'guards %s',
    (path) => expect(isGuardedPath(path)).toBe(true),
  );

  it.each(['/', '/en/', '/ar/', '/en/crisis/', '/ar/crisis/', '/en/settings/', '/en/options-info/', '/en/ticketing/'])('leaves %s open', (path) =>
    expect(isGuardedPath(path)).toBe(false),
  );

  it('covers the screens the spec names', () => {
    for (const route of ['/options', '/consent', '/ticket']) expect(GUARDED_ROUTES).toContain(route);
  });
});

describe('path helpers', () => {
  it('strips the locale and a trailing slash', () => {
    expect(stripLocale('/ar/options/')).toBe('/options');
    expect(stripLocale('/en/')).toBe('/');
    expect(stripLocale('/options/')).toBe('/options');
    expect(stripLocale('/')).toBe('/');
  });

  it('builds locale paths with an optional query, and falls back to English for an unknown locale', () => {
    expect(href('ar', 'crisis')).toBe('/ar/crisis/');
    expect(href('en', '')).toBe('/en/');
    expect(href('en', 'result', { id: 'a b' })).toBe('/en/result/?id=a+b');
    expect(href('xx', 'options')).toBe('/en/options/');
  });
});
