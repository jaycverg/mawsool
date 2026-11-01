import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs script with JSDoc types
import { PRECACHE_ROUTES, buildPrecache, injectPrecache, routeFile } from '../scripts/build-precache.mjs';

const SW = readFileSync(join(__dirname, '..', 'public', 'sw.js'), 'utf8');

function fixture(files: Record<string, string>): string {
  const out = mkdtempSync(join(tmpdir(), 'precache-'));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(out, path)), { recursive: true });
    writeFileSync(join(out, path), body);
  }
  return out;
}

const PAGES = Object.fromEntries((PRECACHE_ROUTES as string[]).map((route) => [routeFile(route), `page ${route}`]));

const BASE = {
  ...PAGES,
  'index.html': 'root',
  'en/index.html': 'en page',
  'ar/index.html': 'ar page',
  'manifest.webmanifest': '{}',
  'icon.svg': '<svg/>',
  'icons/icon-192.png': 'png',
  '_next/static/chunks/a.css': 'css',
  '_next/static/chunks/a.js': 'js',
  '_next/static/media/ibm-plex-sans-latin-400-normal.abc.woff2': 'font',
  '_next/static/media/ibm-plex-sans-arabic-arabic-400-normal.def.woff2': 'font',
  '_next/static/media/ibm-plex-sans-latin-400-normal.abc.woff': 'old font format',
  '_next/static/media/ibm-plex-sans-cyrillic-400-normal.ghi.woff2': 'other subset',
  'sw.js': SW,
};

describe('build-time precache list', () => {
  it('lists the pages, built css and js, Latin and Arabic woff2 fonts, the manifest, the favicon and the icons', () => {
    const { urls } = buildPrecache(fixture(BASE));
    expect(urls).toEqual([
      ...PRECACHE_ROUTES,
      '/_next/static/chunks/a.css',
      '/_next/static/chunks/a.js',
      '/_next/static/media/ibm-plex-sans-arabic-arabic-400-normal.def.woff2',
      '/_next/static/media/ibm-plex-sans-latin-400-normal.abc.woff2',
      '/manifest.webmanifest',
      '/icon.svg',
      '/icons/icon-192.png',
    ]);
  });

  it.each(['crisis', 'check-in', 'result'])('opens the %s screen offline in both languages', (screen) => {
    for (const locale of ['en', 'ar']) expect(PRECACHE_ROUTES).toContain(`/${locale}/${screen}/`);
  });

  it('refuses a build that lacks one of the offline screens', () => {
    const { ['en/crisis/index.html']: _missing, ...without } = BASE;
    expect(() => buildPrecache(fixture(without))).toThrow(/\/en\/crisis\//);
  });

  it('never lists the service worker itself, other font subsets or old font formats', () => {
    const { urls } = buildPrecache(fixture(BASE));
    expect(urls).not.toContain('/sw.js');
    expect(urls.some((u: string) => u.includes('cyrillic') || u.endsWith('.woff'))).toBe(false);
  });

  it('derives a different version when a built asset is added or a page changes, and the same version for the same build', () => {
    const one = buildPrecache(fixture(BASE)).version;
    expect(buildPrecache(fixture(BASE)).version).toBe(one);
    expect(buildPrecache(fixture({ ...BASE, '_next/static/chunks/b.js': 'more' })).version).not.toBe(one);
    expect(buildPrecache(fixture({ ...BASE, 'en/index.html': 'en page changed' })).version).not.toBe(one);
    expect(one).toMatch(/^[0-9a-f]{12}$/);
  });

  it('can be extended with another route, and refuses a route that has no page', () => {
    const out = fixture({ ...BASE, 'en/extra/index.html': 'extra' });
    expect(buildPrecache(out, [...PRECACHE_ROUTES, '/en/extra/']).urls).toContain('/en/extra/');
    expect(() => buildPrecache(out, [...PRECACHE_ROUTES, '/en/missing/'])).toThrow(/\/en\/missing\//);
    expect(routeFile('/')).toBe('index.html');
    expect(routeFile('/en/crisis/')).toBe('en/crisis/index.html');
  });
});

describe('writing the list into sw.js', () => {
  const manifest = { version: 'abc123', urls: ['/en/', '/_next/static/x.css'] };

  it('replaces the placeholder and leaves the rest of the worker unchanged', () => {
    const injected = injectPrecache(SW, manifest);
    expect(injected).toContain('"version":"abc123"');
    expect(injected).not.toContain('"version": "dev"');
    expect(injected.replace(/\/\*PRECACHE_START\*\/[\s\S]*?\/\*PRECACHE_END\*\//, '')).toBe(
      SW.replace(/\/\*PRECACHE_START\*\/[\s\S]*?\/\*PRECACHE_END\*\//, ''),
    );
  });

  it('is idempotent: injecting twice equals injecting the last list once', () => {
    const twice = injectPrecache(injectPrecache(SW, { version: 'old', urls: ['/old/'] }), manifest);
    expect(twice).toBe(injectPrecache(SW, manifest));
  });

  it('changes the bytes of the worker when the version changes, so browsers install the update', () => {
    expect(injectPrecache(SW, manifest)).not.toBe(injectPrecache(SW, { ...manifest, version: 'def456' }));
  });

  it('refuses a worker without markers', () => {
    expect(() => injectPrecache('self.addEventListener("fetch", () => {});', manifest)).toThrow(/markers/);
  });
});
