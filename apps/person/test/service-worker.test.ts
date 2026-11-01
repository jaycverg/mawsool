import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const SOURCE = readFileSync(join(__dirname, '..', 'public', 'sw.js'), 'utf8');

type Handler = (event: Record<string, unknown>) => void;

/** Runs sw.js against a fake service worker scope and returns what it registered. */
function load(options: { network?: (request: { url: string }) => Promise<unknown> } = {}) {
  const handlers: Record<string, Handler> = {};
  const stores = new Map<string, Map<string, unknown>>();
  const open = vi.fn(async (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name)!;
    return {
      addAll: vi.fn(async (urls: string[]) => urls.forEach((u) => store.set(u, `precached:${u}`))),
      put: vi.fn(async (request: { url?: string } | string, response: unknown) => store.set(typeof request === 'string' ? request : request.url!, response)),
      match: vi.fn(async (request: { url?: string } | string) => store.get(typeof request === 'string' ? request : request.url!)),
    };
  });
  const caches = {
    open,
    keys: vi.fn(async () => [...stores.keys(), 'mawsool-shell-v0']),
    delete: vi.fn(async (name: string) => stores.delete(name)),
    match: vi.fn(async (request: { url?: string } | string) => {
      for (const store of stores.values()) {
        const hit = store.get(typeof request === 'string' ? request : request.url!);
        if (hit) return hit;
      }
      return undefined;
    }),
  };
  const self = {
    location: { origin: 'https://app.test' },
    addEventListener: (type: string, handler: Handler) => {
      handlers[type] = handler;
    },
    skipWaiting: vi.fn(async () => undefined),
    clients: { claim: vi.fn(async () => undefined) },
  };
  const fetch = vi.fn(options.network ?? (async () => ({ ok: true, clone: () => ({}) })));
  runInNewContext(SOURCE, { self, caches, fetch, URL, Response: { error: () => 'error-response' }, Promise });
  return { handlers, stores, caches, self, fetch };
}

describe('service worker baseline', () => {
  it('precaches the shell and both locale roots on install, then takes over', async () => {
    const { handlers, stores, self } = load();
    let done: Promise<unknown> = Promise.resolve();
    handlers['install']!({ waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;
    const shell = stores.get('mawsool-shell-v1')!;
    expect([...shell.keys()]).toEqual(['/', '/en/', '/ar/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png']);
    expect(self.skipWaiting).toHaveBeenCalled();
  });

  it('deletes caches from older versions on activate', async () => {
    const { handlers, caches, stores } = load();
    await caches.open('mawsool-shell-v1');
    let done: Promise<unknown> = Promise.resolve();
    handlers['activate']!({ waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;
    expect(caches.delete).toHaveBeenCalledWith('mawsool-shell-v0');
    expect(stores.has('mawsool-shell-v1')).toBe(true);
  });

  it('does not touch non-GET requests or other origins, so API calls never go through it', () => {
    const { handlers } = load();
    const respondWith = vi.fn();
    handlers['fetch']!({ request: { method: 'POST', url: 'https://app.test/x', mode: 'cors' }, respondWith });
    handlers['fetch']!({ request: { method: 'GET', url: 'http://localhost:4000/services', mode: 'cors' }, respondWith });
    expect(respondWith).not.toHaveBeenCalled();
  });

  it('serves a page from the cache when navigation fails offline', async () => {
    const { handlers, stores } = load({ network: async () => Promise.reject(new Error('offline')) });
    stores.set('mawsool-shell-v1', new Map([['https://app.test/en/', 'cached-en']]));
    let response: Promise<unknown> = Promise.resolve();
    handlers['fetch']!({
      request: { method: 'GET', url: 'https://app.test/en/', mode: 'navigate' },
      respondWith: (p: Promise<unknown>) => (response = p),
    });
    expect(await response).toBe('cached-en');
  });

  it('lets a failed navigation with nothing cached fail, rather than invent a page', async () => {
    const { handlers } = load({ network: async () => Promise.reject(new Error('offline')) });
    let response: Promise<unknown> = Promise.resolve();
    handlers['fetch']!({
      request: { method: 'GET', url: 'https://app.test/other/', mode: 'navigate' },
      respondWith: (p: Promise<unknown>) => (response = p),
    });
    await expect(response).rejects.toThrow('offline');
  });

  it('serves built assets from the cache first', async () => {
    const { handlers, stores, fetch } = load();
    stores.set('mawsool-runtime-v1', new Map([['https://app.test/_next/static/a.js', 'cached-js']]));
    let response: Promise<unknown> = Promise.resolve();
    handlers['fetch']!({
      request: { method: 'GET', url: 'https://app.test/_next/static/a.js', mode: 'no-cors' },
      respondWith: (p: Promise<unknown>) => (response = p),
    });
    expect(await response).toBe('cached-js');
    expect(fetch).not.toHaveBeenCalled();
  });
});
