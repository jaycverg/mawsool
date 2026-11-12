import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { PERSON_SECRET_PATTERN, RegisterPersonRequestSchema } from '@mawsool/types';
import {
  createDeviceIdentity,
  createIndexedDbStorage,
  loadDeviceIdentity,
  loadOrCreateIdentity,
  personAuthorization,
  registerDevice,
} from '../src';

const random = globalThis.crypto;
const storage = () => createIndexedDbStorage({ indexedDB: new IDBFactory() });
const identity = createDeviceIdentity(random);

describe('device identity', () => {
  it('is a UUID and a 43-character base64url secret the server will accept', () => {
    expect(identity.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(identity.secret).toMatch(PERSON_SECRET_PATTERN);
    expect(RegisterPersonRequestSchema.safeParse({ ...identity, locale: 'ar' }).success).toBe(true);
  });

  it('differs on every call', () => {
    const secrets = new Set(Array.from({ length: 50 }, () => createDeviceIdentity(random).secret));
    expect(secrets.size).toBe(50);
  });

  it('is created on first run, stored, and returned unchanged afterwards, with no network call', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('network is off');
    });
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const store = storage();
      const first = await loadOrCreateIdentity(store, random);
      const second = await loadOrCreateIdentity(store, random);
      expect(second).toEqual(first);
      expect(await store.get('identity')).toEqual(first);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('gives every concurrent caller on a fresh device the one stored identity', async () => {
    const store = storage();
    const results = await Promise.all(Array.from({ length: 8 }, () => loadOrCreateIdentity(store, random)));
    const stored = await store.get<typeof identity>('identity');
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    for (const result of results) expect(result).toEqual(stored);
  });

  it('gives two tabs on the same database the one stored identity', async () => {
    const factory = new IDBFactory();
    const [a, b] = await Promise.all([
      loadOrCreateIdentity(createIndexedDbStorage({ indexedDB: factory }), random),
      loadOrCreateIdentity(createIndexedDbStorage({ indexedDB: factory }), random),
    ]);
    expect(a).toEqual(b);
    expect(await createIndexedDbStorage({ indexedDB: factory }).get('identity')).toEqual(a);
  });

  it('reads the stored identity without ever making one, so background work cannot give a phone a credential', async () => {
    const empty = storage();
    expect(await loadDeviceIdentity(empty)).toBeNull();
    expect(await empty.get('identity')).toBeUndefined();
    const store = storage();
    const made = await loadOrCreateIdentity(store, random);
    expect(await loadDeviceIdentity(store)).toEqual(made);
    await store.set('identity', { id: 7 });
    expect(await loadDeviceIdentity(store)).toBeNull();
  });

  it('builds the bearer value the API expects', () => {
    expect(personAuthorization({ id: 'abc', secret: 'def' })).toBe('Bearer abc.def');
  });
});

describe('registerDevice', () => {
  const call = (status: number | Error) => {
    const fetchFn = vi.fn(async () => {
      if (status instanceof Error) throw status;
      return new Response('{}', { status });
    });
    return { fetchFn, result: registerDevice({ fetch: fetchFn as never, apiUrl: 'http://api.test', identity, locale: 'ar' }) };
  };

  it('posts exactly the id, secret and locale to /persons', async () => {
    const { fetchFn, result } = call(201);
    expect(await result).toBe('registered');
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://api.test/persons');
    expect(init.method).toBe('POST');
    expect(Object.keys(JSON.parse(init.body as string)).sort()).toEqual(['id', 'locale', 'secret']);
  });

  it('reports each outcome the server can give', async () => {
    expect(await call(200).result).toBe('already_registered');
    expect(await call(409).result).toBe('conflict');
    expect(await call(500).result).toBe('failed');
    expect(await call(400).result).toBe('failed');
  });

  it('reports failed, without throwing, when the network is down, so the next write can retry', async () => {
    expect(await call(new TypeError('Failed to fetch')).result).toBe('failed');
  });
});
