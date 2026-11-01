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

for (const file of ['index.html', 'en/index.html', 'ar/index.html', 'en/ticket/index.html', 'ar/ticket/index.html', 'manifest.webmanifest', 'sw.js']) {
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

// No server output may sneak into a static export.
need(!existsSync(resolve(out, '_next/server')), 'out/ contains _next/server');
const stray = readdirSync(out).filter((name) => name === 'api');
need(stray.length === 0, 'out/ contains an api folder');

// Self-hosted fonts: no request to a font CDN.
const allHtml = [en, ar].join('\n');
need(!/fonts\.(googleapis|gstatic)\.com/.test(allHtml), 'pages reference a font CDN');

if (problems.length > 0) {
  for (const problem of problems) console.error(`export check: ${problem}`);
  process.exit(1);
}
console.log('export check: ok');
