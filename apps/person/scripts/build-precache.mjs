// @ts-check
// Runs after `next build`: writes the real precache list into out/sw.js.
//
// The service worker source (public/sw.js) holds a placeholder list. This step replaces it with the pages in
// PRECACHE_ROUTES, the built CSS and JS under _next/static, the Latin and Arabic font files, the manifest, the favicon and the
// icons, and derives the cache version from that list and the page contents. A new build therefore changes the
// bytes of sw.js, which is what makes browsers install the new worker and drop the old cache.
//
// To precache another screen, add its route to PRECACHE_ROUTES.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Locales the app is built in. */
const LOCALES = ['en', 'ar'];

/**
 * Screens that open offline in every locale after one online visit: the whole person app is local-first, and the
 * crisis screen, the check-in and the result in particular must never depend on the network. Each is a directory
 * route with a page in the export; a screen with a query string (`/result/?id=`) is the same page.
 */
export const OFFLINE_SCREENS = ['crisis', 'check-in', 'check-ins', 'result', 'options', 'settings', 'consent', 'ticket', 'remeasure', 'next-day'];

/** Pages that must open offline after one online visit. Each is a directory route that exists in the export. */
export const PRECACHE_ROUTES = ['/', ...LOCALES.flatMap((locale) => [`/${locale}/`, ...OFFLINE_SCREENS.map((screen) => `/${locale}/${screen}/`)])];

/** Built font files worth caching: woff2 in the Latin and Arabic subsets. Other subsets load on demand. */
const FONT_FILE = /-(latin|arabic)-\d+-normal\.[\w-]+\.woff2$/;

const START = '/*PRECACHE_START*/';
const END = '/*PRECACHE_END*/';

/** @param {string} dir @returns {string[]} absolute file paths, sorted */
function listFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? listFiles(join(dir, entry.name)) : [join(dir, entry.name)]))
    .sort();
}

/** @param {string} outDir @param {string} file */
const toUrl = (outDir, file) => `/${relative(outDir, file).split(sep).join('/')}`;

/**
 * @param {string} route a directory route such as /en/
 * @returns {string} path of its HTML file relative to the export root
 */
export function routeFile(route) {
  return route === '/' ? 'index.html' : `${route.replace(/^\/|\/$/g, '')}/index.html`;
}

/**
 * Collects what to precache from a static export.
 * @param {string} outDir
 * @param {string[]} [routes]
 * @returns {{ version: string, urls: string[] }}
 */
export function buildPrecache(outDir, routes = PRECACHE_ROUTES) {
  for (const route of routes) {
    if (!existsSync(join(outDir, routeFile(route)))) throw new Error(`precache route ${route} has no page in ${outDir}`);
  }
  const staticDir = join(outDir, '_next', 'static');
  const built = listFiles(staticDir)
    .filter((file) => /\.(css|js)$/.test(file) || FONT_FILE.test(file))
    .map((file) => toUrl(outDir, file));
  const publicFiles = ['manifest.webmanifest', 'icon.svg', ...listFiles(join(outDir, 'icons')).map((f) => relative(outDir, f))]
    .filter((rel) => existsSync(join(outDir, rel)))
    .map((rel) => `/${rel.split(sep).join('/')}`);
  const urls = [...new Set([...routes, ...built, ...publicFiles])];

  // Pages are not content-hashed, so their bytes go into the version along with the list.
  const hash = createHash('sha256').update(JSON.stringify(urls));
  for (const route of routes) hash.update(readFileSync(join(outDir, routeFile(route))));
  return { version: hash.digest('hex').slice(0, 12), urls };
}

/**
 * Replaces the placeholder between the markers in the worker source. Safe to run twice.
 * @param {string} source
 * @param {{ version: string, urls: string[] }} manifest
 */
export function injectPrecache(source, manifest) {
  const start = source.indexOf(START);
  const end = source.indexOf(END);
  if (start === -1 || end === -1 || end < start) throw new Error('sw.js is missing its precache markers');
  return `${source.slice(0, start)}${START} ${JSON.stringify(manifest)} ${source.slice(end)}`;
}

/** @param {string} outDir */
export function writePrecache(outDir) {
  const file = join(outDir, 'sw.js');
  const manifest = buildPrecache(outDir);
  writeFileSync(file, injectPrecache(readFileSync(file, 'utf8'), manifest));
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = resolve(fileURLToPath(new URL('..', import.meta.url)), 'out');
  const { version, urls } = writePrecache(out);
  console.log(`precache: ${urls.length} urls, version ${version}`);
}
