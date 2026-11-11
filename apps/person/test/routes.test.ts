import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ANONYMOUS_WALLED_ROUTES, GUARDED_ROUTES, href, isGuardedPath, stripLocale } from '../lib/routes';

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

describe('every guarded or walled route names a screen that exists', () => {
  const pageOf = (route: string) => join(__dirname, '..', 'app', '[locale]', route.slice(1), 'page.tsx');

  it('has an exported page for each entry of both lists, so a route that is guarded or walled does not 404', () => {
    expect([...GUARDED_ROUTES, ...ANONYMOUS_WALLED_ROUTES].length).toBeGreaterThan(10);
    for (const route of GUARDED_ROUTES) expect(existsSync(pageOf(route)), `${route} is guarded and has no page`).toBe(true);
    for (const route of ANONYMOUS_WALLED_ROUTES) expect(existsSync(pageOf(route)), `${route} is walled and has no page`).toBe(true);
    for (const route of [...GUARDED_ROUTES, ...ANONYMOUS_WALLED_ROUTES]) expect(readFileSync(pageOf(route), 'utf8'), `${route} exports a page`).toMatch(/export default /);
  });

  it('would fail for a route with no page, so the check above can go red', () => {
    expect(existsSync(pageOf('/reroute'))).toBe(false);
    expect(existsSync(pageOf('/follow-up'))).toBe(false);
    expect(existsSync(pageOf('/remeasure'))).toBe(true);
  });

  it('no longer lists the two routes that never had a screen: a reroute goes through the options screen and the next-day check is its own screen', () => {
    for (const route of ['/reroute', '/follow-up']) {
      expect(GUARDED_ROUTES as readonly string[]).not.toContain(route);
      expect(ANONYMOUS_WALLED_ROUTES as readonly string[]).not.toContain(route);
    }
    expect(GUARDED_ROUTES).toContain('/options');
    expect(GUARDED_ROUTES).toContain('/next-day');
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
