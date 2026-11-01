/*
 * Service worker. It precaches the app shell so the app opens offline after one online visit, and serves
 * anything it has cached before touching the network. Requests to other origins, including the API, are never
 * touched.
 *
 * The list between the markers is replaced after every build by scripts/build-precache.mjs: the pages, the built
 * CSS and JS, the fonts, the manifest and the icons, with a version derived from them. A copy of this file that
 * has not been through that step (development) precaches nothing.
 */
const PRECACHE = /*PRECACHE_START*/ { "version": "dev", "urls": [] } /*PRECACHE_END*/;
const SHELL_CACHE = `mawsool-shell-${PRECACHE.version}`;
const RUNTIME_CACHE = `mawsool-runtime-${PRECACHE.version}`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(PRECACHE.urls))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((name) => name !== SHELL_CACHE && name !== RUNTIME_CACHE).map((name) => caches.delete(name))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
  } else if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(cacheFirst(request));
  } else {
    event.respondWith(staleWhileRevalidate(request));
  }
});

/** Any cache this worker owns, shell or runtime. A page's query string (?id=) does not change which page it is. */
function cached(request) {
  return caches.match(request, { ignoreSearch: true });
}

async function networkFirst(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (error) {
    const hit = await cached(request);
    if (hit) return hit;
    throw error;
  }
}

async function cacheFirst(request) {
  const hit = await cached(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) (await caches.open(RUNTIME_CACHE)).put(request, response.clone());
  return response;
}

async function staleWhileRevalidate(request) {
  const hit = await cached(request);
  const refresh = fetch(request)
    .then(async (response) => {
      if (response.ok) (await caches.open(RUNTIME_CACHE)).put(request, response.clone());
      return response;
    })
    .catch(() => undefined);
  return hit || (await refresh) || Response.error();
}
