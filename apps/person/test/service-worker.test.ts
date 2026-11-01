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
function load(options: { network?: (request: RequestLike) => Promise<unknown>; manifest?: typeof MANIFEST | null } = {}) {
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
    clients: { claim: vi.fn(async () => undefined) },
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
