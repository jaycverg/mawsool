// @ts-check
// Serves the person app's static export (out/) the way a static host would, for the end-to-end run.
// Usage: node e2e/serve-static.mjs   (E2E_STATIC_PORT; serves ./out)
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../out', import.meta.url)));
const PORT = Number(process.env.E2E_STATIC_PORT ?? 3450);

const TYPES = /** @type {Record<string, string>} */ ({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
});

/** The file a request path maps to: the path itself, or its index.html, as a static host with trailing slashes does. */
function resolveFile(/** @type {string} */ pathname) {
  const target = normalize(join(ROOT, decodeURIComponent(pathname)));
  if (target !== ROOT && !target.startsWith(ROOT + sep)) return null;
  for (const candidate of [target, join(target, 'index.html')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Requests that reached this server, by path. A test reads it to prove a page was served from the service worker's cache. */
const hits = new Map();

const server = createServer((request, response) => {
  const { pathname } = new URL(request.url ?? '/', 'http://localhost');
  if (pathname === '/__e2e/hits') {
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(Object.fromEntries(hits)));
    return;
  }
  hits.set(pathname, (hits.get(pathname) ?? 0) + 1);
  const file = request.method === 'GET' || request.method === 'HEAD' ? resolveFile(pathname) : null;
  if (!file) {
    response.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    return;
  }
  response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  if (request.method === 'HEAD') response.end();
  else createReadStream(file).pipe(response);
});

server.listen(PORT, '127.0.0.1', () => console.log(`static export on http://127.0.0.1:${PORT}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
