// @ts-check
// Runs after `next build`: checks the static export is what the person app promises to be.
// Fails with one line per problem. Usage: node scripts/check-export.mjs
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = resolve(fileURLToPath(new URL('..', import.meta.url)), 'out');
/** @type {string[]} */
const problems = [];
const need = (/** @type {boolean} */ ok, /** @type {string} */ message) => {
  if (!ok) problems.push(message);
};

if (!existsSync(out)) {
  console.error('out/ does not exist: the build did not produce a static export');
  process.exit(1);
}

for (const file of [
  'index.html',
  'en/index.html',
  'ar/index.html',
  ...['en', 'ar'].flatMap((l) => ['ticket', 'crisis', 'check-in', 'check-ins', 'result', 'options', 'settings', 'consent'].map((screen) => `${l}/${screen}/index.html`)),
  'manifest.webmanifest',
  'icon.svg',
  'sw.js',
]) {
  need(existsSync(resolve(out, file)), `missing out/${file}`);
}

const html = (/** @type {string} */ file) => (existsSync(resolve(out, file)) ? readFileSync(resolve(out, file), 'utf8') : '');
const en = html('en/index.html');
const ar = html('ar/index.html');
need(/<html[^>]*\blang="en"/.test(en) && /<html[^>]*\bdir="ltr"/.test(en), 'en page must set lang="en" dir="ltr"');
need(/<html[^>]*\blang="ar"/.test(ar) && /<html[^>]*\bdir="rtl"/.test(ar), 'ar page must set lang="ar" dir="rtl"');
need(/rel="manifest"/.test(en) && /rel="manifest"/.test(ar), 'pages must link the web manifest');
need(en.includes('How have you been over the last two weeks?'), 'en page is missing its message text');
need(ar.includes('كيف كان حالك خلال الأسبوعين الماضيين؟'), 'ar page is missing its message text');

if (existsSync(resolve(out, 'manifest.webmanifest'))) {
  const manifest = JSON.parse(readFileSync(resolve(out, 'manifest.webmanifest'), 'utf8'));
  for (const key of ['name', 'short_name', 'start_url', 'display', 'icons', 'theme_color', 'background_color']) {
    need(key in manifest, `manifest is missing ${key}`);
  }
  need(manifest.display === 'standalone', 'manifest display must be standalone');
  const sizes = new Set((manifest.icons ?? []).map((/** @type {{sizes: string}} */ icon) => icon.sizes));
  need(sizes.has('192x192') && sizes.has('512x512'), 'manifest needs 192x192 and 512x512 icons');
  for (const icon of manifest.icons ?? []) need(existsSync(resolve(out, icon.src.replace(/^\//, ''))), `manifest icon ${icon.src} is missing from out/`);
}

// The service worker must carry the real precache list written after the build.
if (existsSync(resolve(out, 'sw.js'))) {
  const worker = readFileSync(resolve(out, 'sw.js'), 'utf8');
  const listed = /\/\*PRECACHE_START\*\/\s*(\{[\s\S]*?\})\s*\/\*PRECACHE_END\*\//.exec(worker)?.[1];
  const precache = listed ? JSON.parse(listed) : null;
  need(precache !== null, 'sw.js has no precache list');
  if (precache) {
    need(typeof precache.version === 'string' && precache.version !== 'dev', 'sw.js precache version was not derived from the build');
    const urls = /** @type {string[]} */ (precache.urls);
    for (const route of ['/', '/en/', '/ar/', ...['en', 'ar'].flatMap((l) => ['crisis', 'check-in', 'result'].map((screen) => `/${l}/${screen}/`))]) {
      need(urls.includes(route), `precache is missing the page ${route}`);
    }
    need(urls.some((u) => /^\/_next\/static\/.*\.css$/.test(u)), 'precache has no built stylesheet');
    need(urls.some((u) => /^\/_next\/static\/.*\.js$/.test(u)), 'precache has no built script');
    need(urls.some((u) => /latin-400-normal.*\.woff2$/.test(u)), 'precache has no Latin font');
    need(urls.some((u) => /arabic-400-normal.*\.woff2$/.test(u)), 'precache has no Arabic font');
    need(urls.includes('/manifest.webmanifest') && urls.some((u) => u.startsWith('/icons/')), 'precache is missing the manifest or icons');
    for (const url of urls) {
      const file = url.endsWith('/') ? `${url}index.html` : url;
      need(existsSync(resolve(out, file.replace(/^\//, ''))), `precache lists ${url}, which is not in out/`);
    }
  }
}

// No server output may sneak into a static export.
need(!existsSync(resolve(out, '_next/server')), 'out/ contains _next/server');
const stray = readdirSync(out).filter((name) => name === 'api');
need(stray.length === 0, 'out/ contains an api folder');

// Self-hosted fonts: no request to a font CDN.
const allHtml = [en, ar].join('\n');
need(!/fonts\.(googleapis|gstatic)\.com/.test(allHtml), 'pages reference a font CDN');

// The crisis screen ships with its numbers in the page itself, in both languages, so it opens offline from the cache.
for (const [locale, call] of [['en', 'Call 800-SAKINA'], ['ar', 'اتصل بـ 800-SAKINA']]) {
  const crisis = html(`${locale}/crisis/index.html`);
  need(crisis.includes(call) && crisis.includes('800 725462') && crisis.includes('tel:998') && crisis.includes('tel:999'), `${locale} crisis page is missing its numbers`);
}
// A guarded screen's static page holds only the waiting state: no option or check-in content before the block is read.
for (const locale of ['en', 'ar']) {
  const options = html(`${locale}/options/index.html`);
  need(options.includes('data-crisis-guard="checking"') && !/data-tier=/.test(options), `${locale} options page must hold only the guard's waiting state`);
}
// A favicon is linked, so browsers never request /favicon.ico.
need(/rel="icon"/.test(en) && /rel="icon"/.test(ar), 'pages must link a favicon');

if (problems.length > 0) {
  for (const problem of problems) console.error(`export check: ${problem}`);
  process.exit(1);
}
console.log('export check: ok');
