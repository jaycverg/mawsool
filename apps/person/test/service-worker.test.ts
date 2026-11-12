import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain .mjs script with JSDoc types
import { injectPrecache } from '../scripts/build-precache.mjs';

const SOURCE = readFileSync(join(__dirname, '..', 'public', 'sw.js'), 'utf8');
const ORIGIN = 'https://app.test';
const abs = (url: string) => new URL(url, ORIGIN).href;
const noSearch = (href: string) => href.split('?')[0]!;

type Handler = (event: Record<string, unknown>) => void;
type RequestLike = { url?: string; method?: string; mode?: string } | string;

const MANIFEST = {
  version: 'v-test',
  urls: ['/', '/en/', '/ar/', '/_next/static/chunks/a.css', '/_next/static/chunks/a.js', '/manifest.webmanifest', '/icons/icon-192.png'],
};

/** Runs the worker, with the build list injected the way the build does, against a fake worker scope. */
function load(options: { network?: (request: RequestLike) => Promise<unknown>; manifest?: typeof MANIFEST | null; windows?: { focus: () => Promise<unknown>; url: string }[] } = {}) {
  const handlers: Record<string, Handler> = {};
  const stores = new Map<string, Map<string, unknown>>();
  const key = (request: RequestLike) => (typeof request === 'string' ? abs(request) : request.url!);
  const store = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name)!;
  };
  const find = (request: RequestLike, ignoreSearch: boolean, only?: Map<string, unknown>) => {
    const wanted = ignoreSearch ? noSearch(key(request)) : key(request);
    for (const entries of only ? [only] : stores.values()) {
      for (const [href, value] of entries) if ((ignoreSearch ? noSearch(href) : href) === wanted) return value;
    }
    return undefined;
  };
  const caches = {
    open: vi.fn(async (name: string) => {
      const entries = store(name);
      return {
        addAll: vi.fn(async (urls: string[]) => urls.forEach((u) => entries.set(abs(u), `precached:${u}`))),
        put: vi.fn(async (request: RequestLike, response: unknown) => void entries.set(key(request), response)),
        match: vi.fn(async (request: RequestLike) => find(request, false, entries)),
      };
    }),
    keys: vi.fn(async () => [...stores.keys()]),
    delete: vi.fn(async (name: string) => stores.delete(name)),
    match: vi.fn(async (request: RequestLike, opts?: { ignoreSearch?: boolean }) => find(request, opts?.ignoreSearch === true)),
  };
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, handler: Handler) => void (handlers[type] = handler),
    skipWaiting: vi.fn(async () => undefined),
    clients: {
      claim: vi.fn(async () => undefined),
      matchAll: vi.fn(async (_query: unknown) => options.windows ?? []),
      openWindow: vi.fn(async (_url: string) => ({})),
    },
  };
  const fetch = vi.fn(options.network ?? (async () => ({ ok: true, clone: () => ({}) })));
  const source = options.manifest === null ? SOURCE : injectPrecache(SOURCE, options.manifest ?? MANIFEST);
  runInNewContext(source, { self, caches, fetch, URL, Response: { error: () => 'error-response' }, Promise });

  const install = async () => {
    let done: Promise<unknown> = Promise.resolve();
    handlers['install']!({ waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;
  };
  const request = async (req: RequestLike & { method?: string }) => {
    let response: Promise<unknown> | undefined;
    handlers['fetch']!({ request: { method: 'GET', ...(req as object) }, respondWith: (p: Promise<unknown>) => (response = p) });
    return response;
  };
  return { handlers, stores, caches, self, fetch, install, request };
}

const offline = async () => Promise.reject(new Error('offline'));

describe('service worker install and activate', () => {
  it('precaches exactly the list written by the build, then takes over', async () => {
    const { stores, self, install } = load();
    await install();
    expect([...stores.get('mawsool-shell-v-test')!.keys()]).toEqual(MANIFEST.urls.map(abs));
    expect(self.skipWaiting).toHaveBeenCalled();
  });

  it('precaches nothing in development, where no list was written', async () => {
    const { stores, install } = load({ manifest: null });
    await install();
    expect([...stores.get('mawsool-shell-dev')!.keys()]).toEqual([]);
  });

  it('keys its caches by the build version and deletes caches from other builds on activate', async () => {
    const { handlers, caches, stores, install } = load();
    await install();
    stores.set('mawsool-shell-old', new Map());
    stores.set('mawsool-runtime-old', new Map());
    stores.set('mawsool-runtime-v-test', new Map());
    let done: Promise<unknown> = Promise.resolve();
    handlers['activate']!({ waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;
    expect(caches.delete).toHaveBeenCalledWith('mawsool-shell-old');
    expect(caches.delete).toHaveBeenCalledWith('mawsool-runtime-old');
    expect([...stores.keys()].sort()).toEqual(['mawsool-runtime-v-test', 'mawsool-shell-v-test']);
  });
});

describe('with the network down after one online visit', () => {
  it.each(['/_next/static/chunks/a.css', '/_next/static/chunks/a.js'])('serves the precached build asset %s', async (path) => {
    const { install, request, fetch } = load({ network: offline });
    await install();
    expect(await request({ url: abs(path), mode: 'no-cors' })).toBe(`precached:${path}`);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['/icons/icon-192.png', '/manifest.webmanifest'])('serves the precached file %s', async (path) => {
    const { install, request } = load({ network: offline });
    await install();
    expect(await request({ url: abs(path), mode: 'no-cors' })).toBe(`precached:${path}`);
  });

  it.each(['/', '/en/', '/ar/'])('opens the precached page %s', async (path) => {
    const { install, request } = load({ network: offline });
    await install();
    expect(await request({ url: abs(path), mode: 'navigate' })).toBe(`precached:${path}`);
  });

  it('opens a precached page that is addressed with a query string, such as a ticket id', async () => {
    const { install, request } = load({ network: offline });
    await install();
    expect(await request({ url: abs('/en/?id=abc'), mode: 'navigate' })).toBe('precached:/en/');
  });

  it.each(['/en', '/ar', '/en/options', '/ar/consent', '/en/ticket', '/ar/crisis'])('opens the cached page for %s, with no trailing slash', async (path) => {
    const slashed = `${path}/`;
    const { install, request, stores } = load({ network: offline });
    await install();
    stores.get('mawsool-shell-v-test')!.set(abs(slashed), `precached:${slashed}`);
    expect(await request({ url: abs(path), mode: 'navigate' })).toBe(`precached:${slashed}`);
    expect(await request({ url: abs(`${path}?id=abc`), mode: 'navigate' })).toBe(`precached:${slashed}`);
  });

  it('does not add a slash to a file address, or to a request that is not a page navigation', async () => {
    const { install, request, stores } = load({ network: offline });
    await install();
    stores.get('mawsool-shell-v-test')!.set(abs('/icons/icon-192.png/'), 'wrong');
    expect(await request({ url: abs('/icons/icon-192.png'), mode: 'no-cors' })).toBe('precached:/icons/icon-192.png');
    stores.get('mawsool-shell-v-test')!.set(abs('/en/options/'), 'page');
    expect(await request({ url: abs('/en/options'), mode: 'no-cors' })).toBe('error-response');
    await expect(request({ url: abs('/other.txt'), mode: 'navigate' })).rejects.toThrow('offline');
  });

  it('matches a request that is not a page navigation on its whole address, so one query string never gets another one’s answer', async () => {
    const { install, request, stores, fetch } = load({ network: async (req) => ({ ok: true, clone: () => 'clone', body: `fresh:${(req as { url: string }).url}` }) });
    await install();
    // An API served from this origin: the English directory is cached, and the Arabic reader asks for hers.
    stores.set('mawsool-runtime-v-test', new Map([[abs('/services?locale=en'), 'english-copy']]));
    const answer = (await request({ url: abs('/services?locale=ar'), mode: 'cors' })) as { body: string };
    expect(answer.body).toBe(`fresh:${abs('/services?locale=ar')}`);
    expect(fetch).toHaveBeenCalledWith(expect.objectContaining({ url: abs('/services?locale=ar') }));
    // The same address is still served from the cache.
    expect(await request({ url: abs('/services?locale=en'), mode: 'cors' })).toBe('english-copy');
  });

  it('serves anything the runtime cache saved earlier', async () => {
    const { stores, request } = load({ network: offline });
    stores.set('mawsool-runtime-v-test', new Map([[abs('/fonts/extra.woff2'), 'runtime-hit']]));
    expect(await request({ url: abs('/fonts/extra.woff2'), mode: 'no-cors' })).toBe('runtime-hit');
  });

  it('fails a page that was never cached, rather than invent one', async () => {
    const { install, request } = load({ network: offline });
    await install();
    await expect(request({ url: abs('/other/'), mode: 'navigate' })).rejects.toThrow('offline');
  });

  it('answers an uncached asset with a network error, not a hang or a made-up body', async () => {
    const { install, request } = load({ network: offline });
    await install();
    expect(await request({ url: abs('/unknown.png'), mode: 'no-cors' })).toBe('error-response');
  });
});

describe('with the network up', () => {
  it('prefers the network for pages and stores the fresh copy', async () => {
    const fresh = { ok: true, clone: () => 'clone' };
    const { install, request, stores } = load({ network: async () => fresh });
    await install();
    expect(await request({ url: abs('/en/'), mode: 'navigate' })).toBe(fresh);
    expect(stores.get('mawsool-runtime-v-test')!.get(abs('/en/'))).toBe('clone');
  });

  it('answers a precached file at once and refreshes it in the background', async () => {
    const { install, request, fetch } = load({ network: async () => ({ ok: true, clone: () => 'clone' }) });
    await install();
    expect(await request({ url: abs('/icons/icon-192.png'), mode: 'no-cors' })).toBe('precached:/icons/icon-192.png');
    expect(fetch).toHaveBeenCalled();
  });

  it('does not touch non-GET requests or other origins, so API calls never go through it', async () => {
    const { handlers } = load();
    const respondWith = vi.fn();
    handlers['fetch']!({ request: { method: 'POST', url: abs('/x'), mode: 'cors' }, respondWith });
    handlers['fetch']!({ request: { method: 'GET', url: 'http://localhost:4000/services', mode: 'cors' }, respondWith });
    expect(respondWith).not.toHaveBeenCalled();
  });
});

describe('tapping a reminder notification', () => {
  /** Fires the worker's `notificationclick` handler and waits for the work it asked to keep alive. */
  async function tap(scope: ReturnType<typeof load>) {
    const notification = { close: vi.fn() };
    let kept: Promise<unknown> | undefined;
    scope.handlers['notificationclick']!({ notification, waitUntil: (work: Promise<unknown>) => (kept = work) });
    await kept;
    return notification;
  }

  it('closes the notification and opens the app at its root when no window of it is open', async () => {
    const scope = load();
    const notification = await tap(scope);
    expect(notification.close).toHaveBeenCalledTimes(1);
    expect(scope.self.clients.matchAll).toHaveBeenCalledWith({ type: 'window', includeUncontrolled: true });
    expect(scope.self.clients.openWindow).toHaveBeenCalledTimes(1);
    expect(scope.self.clients.openWindow).toHaveBeenCalledWith('/');
  });

  it('brings the first open window of the app forward instead of opening another', async () => {
    const first = { url: abs('/en/settings/'), focus: vi.fn(async () => undefined) };
    const second = { url: abs('/ar/'), focus: vi.fn(async () => undefined) };
    const scope = load({ windows: [first, second] });
    const notification = await tap(scope);
    expect(notification.close).toHaveBeenCalledTimes(1);
    expect(first.focus).toHaveBeenCalledTimes(1);
    expect(second.focus).not.toHaveBeenCalled();
    expect(scope.self.clients.openWindow).not.toHaveBeenCalled();
  });

  it('keeps the worker alive until the window is focused or opened, and opens a page the app really has', async () => {
    let focused = false;
    const scope = load({ windows: [{ url: abs('/en/'), focus: vi.fn(async () => { await Promise.resolve(); focused = true; }) }] });
    await tap(scope);
    expect(focused).toBe(true);
    // The root it opens is one of the pages the build precaches, so a closed app opens even with the network down.
    expect(MANIFEST.urls).toContain('/');
  });
});
