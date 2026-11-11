import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { StorageDecryptError, createIndexedDbStorage, createTabMark } from '@mawsool/ui';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ANONYMOUS_DB_PREFIX,
  ANONYMOUS_KEPT_KEYS,
  anonymousSessionId,
  createAnonymousStorage,
  createAnonymousStore,
  deviceSessionRegistry,
  endAnonymousSession,
  isAnonymous,
  isAnonymousMark,
  reconcileAnonymousStore,
  startAnonymousSession,
  wipeAnonymousData,
  type AnonymousEnv,
  type AnonymousStore,
  type LocksLike,
  type SessionRegistry,
} from '../lib/anonymous';
import { createCrisisStore, isCrisisMark, type CrisisMark } from '../lib/crisis';
import { pendingEvents } from '../lib/crisis-outbox';
import { recordAnswer } from '../lib/record-answer';
import { deleteDeviceData } from '../lib/device-data';
import { refreshDemoOffset } from '../lib/demo-offset';
import { loadDirectory } from '../lib/directory';
import { eraseEverything } from '../lib/erase';
import { KEYS } from '../lib/keys';
import { deviceFetch, refusedRequests } from '../lib/net';
import { ANONYMOUS_WALLED_ROUTES, GUARDED_ROUTES, isAnonymousWalledPath, isGuardedPath } from '../lib/routes';
import { loadScreenings, saveAnswer } from '../lib/screening-store';
import { callServer } from '../lib/server';
import { refreshDemoClock, refreshDirectory, syncNow } from '../lib/sync';
import ar from '../messages/ar.json';
import en from '../messages/en.json';
import { fixtureClock, memoryStorage } from './helpers/memory';

const SESSION = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const dbOf = (session: string) => `${ANONYMOUS_DB_PREFIX}${session}`;

/**
 * Web Locks over a set of held names. `hold` is a page that took the lock and has not gone; `release` is that page going. An
 * `ifAvailable` request runs its callback with a lock when the name is free, and with null when it is held.
 */
function fakeLocks() {
  const held = new Set<string>();
  const locks: LocksLike = {
    request: ((name: string, a: unknown, b?: unknown) => {
      const options = typeof a === 'function' ? {} : (a as { ifAvailable?: boolean });
      const callback = (typeof a === 'function' ? a : b) as (lock?: object | null) => unknown;
      if (options.ifAvailable) {
        if (held.has(name)) return Promise.resolve(callback(null));
        held.add(name);
        return Promise.resolve(callback({})).finally(() => held.delete(name));
      }
      held.add(name);
      return callback() as Promise<never>;
    }) as LocksLike['request'],
  };
  return { locks, held };
}

/** The browser's parts for one anonymous store, over a fresh in-memory IndexedDB. The grace for a reloading page is none, so a test does not wait. */
const freshEnv = (locks?: LocksLike | null): AnonymousEnv => ({ indexedDB: new IDBFactory(), crypto: globalThis.crypto, locks: locks ?? null, abandonedGraceMs: 0 });

/** The names of the anonymous databases that exist: empty once they have been deleted, ciphertext and key with them. */
async function dbNames(env: AnonymousEnv): Promise<string[]> {
  return (await env.indexedDB.databases()).flatMap((db) => (db.name?.startsWith(ANONYMOUS_DB_PREFIX) ? [db.name] : []));
}
const dbExists = async (env: AnonymousEnv, session = SESSION) => (await dbNames(env)).includes(dbOf(session));

/** The rows of a session's anonymous database exactly as the browser holds them. */
async function rawRows(env: AnonymousEnv, session = SESSION): Promise<Map<string, unknown>> {
  const raw = createIndexedDbStorage({ indexedDB: env.indexedDB, dbName: dbOf(session) });
  return new Map(await Promise.all((await raw.keys()).map(async (key) => [key, await raw.get<unknown>(key)] as const)));
}

/** The bytes of a stored ciphertext as text, to look for what must not be in it. */
const ciphertextText = (row: unknown): string => Buffer.from((row as { ct: ArrayBuffer }).ct).toString('latin1');

/** Every way a page can reach a network, as stubs that record a call and then fail it. */
function stubNetwork() {
  const calls: string[] = [];
  const failing = (name: string) =>
    vi.fn(() => {
      calls.push(name);
      throw new Error(`${name} must not be used`);
    });
  const fetchStub = vi.fn(async (input: unknown) => {
    calls.push(`fetch ${String(input)}`);
    throw new Error('fetch must not be used');
  });
  vi.stubGlobal('window', { fetch: fetchStub, indexedDB: undefined, crypto: globalThis.crypto });
  vi.stubGlobal('fetch', fetchStub);
  vi.stubGlobal('XMLHttpRequest', failing('XMLHttpRequest'));
  vi.stubGlobal('WebSocket', failing('WebSocket'));
  vi.stubGlobal('EventSource', failing('EventSource'));
  vi.stubGlobal('navigator', { sendBeacon: failing('sendBeacon') });
  return { calls, fetchStub };
}

beforeEach(() => {
  refusedRequests.count = 0;
  startAnonymousSession(() => SESSION);
});

afterEach(async () => {
  await endAnonymousSession(null, () => false);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** One anonymous store over a fresh IndexedDB, with the device's own store beside it and the tab session it answers to. */
function setup(initialPersistent: Record<string, unknown> = {}, locks: LocksLike | null = null) {
  const env = freshEnv(locks);
  const persistent = memoryStorage(initialPersistent);
  const tab = { session: SESSION as string | null };
  const make = (session: () => string | null = () => tab.session) => createAnonymousStore(env, session);
  const store = make();
  const anonymous = createAnonymousStorage(() => persistent.storage, store);
  /** A new page load in the same tab: its own store object over the same browser database. */
  const reload = () => createAnonymousStorage(() => persistent.storage, make());
  return { env, persistent, tab, make, store, anonymous, reload };
}

async function saveCheckIn(storage: ReturnType<typeof createAnonymousStorage>) {
  const clock = fixtureClock();
  return saveAnswer(storage, { instrument: 'gad7', index: 0, value: 2 }, { now: clock.now, newId: clock.newId });
}

/** A store whose every call is told, for the places a real one would be asked. */
const stubStore = (over: Partial<AnonymousStore> = {}): AnonymousStore => ({
  open: () => Promise.reject(new Error('refused')),
  reconcile: () => Promise.resolve(),
  wipe: () => Promise.resolve('deleted'),
  wipeAll: () => Promise.resolve({ left: [] }),
  keep: () => Promise.resolve(),
  ...over,
});
const hangingStore = (): AnonymousStore => stubStore({ open: () => new Promise(() => undefined), reconcile: () => new Promise(() => undefined), wipe: () => new Promise(() => undefined), wipeAll: () => new Promise(() => undefined), keep: () => new Promise(() => undefined) });

describe('an anonymous session', () => {
  it('is a note on the tab that holds a random id and nothing else: started, read back, and ended', async () => {
    expect(isAnonymous()).toBe(true);
    expect(anonymousSessionId()).toBe(SESSION);
    await endAnonymousSession(null, () => false);
    expect(isAnonymous()).toBe(false);
    expect(anonymousSessionId()).toBeNull();
    startAnonymousSession();
    expect(anonymousSessionId()).toMatch(/^[0-9a-f-]{36}$/);
    expect(anonymousSessionId()).not.toBe(SESSION);
  });

  it('accepts only the note it writes: a session id, no extra field that could carry an answer, no bare flag', () => {
    expect(isAnonymousMark({ session: SESSION })).toBe(true);
    expect(isAnonymousMark({ session: SESSION, screenings: [] })).toBe(false);
    expect(isAnonymousMark({ session: '' })).toBe(false);
    expect(isAnonymousMark({})).toBe(false);
    expect(isAnonymousMark(true)).toBe(false);
    expect(isAnonymousMark(null)).toBe(false);
  });
});

describe('the anonymous store', () => {
  it('keeps the check-ins as ciphertext under a key that cannot be exported, in a database of its own named by the session', async () => {
    const { env, persistent, anonymous } = setup();
    const saved = await saveCheckIn(anonymous);
    expect(await dbNames(env)).toEqual([dbOf(SESSION)]);
    const rows = await rawRows(env);
    expect([...rows.keys()].sort()).toEqual(['__device-key', KEYS.screenings]);
    const key = rows.get('__device-key') as CryptoKey;
    expect(key.extractable).toBe(false);
    await expect(globalThis.crypto.subtle.exportKey('raw', key)).rejects.toThrow();
    const sealed = rows.get(KEYS.screenings);
    expect(JSON.stringify(sealed)).not.toContain('gad7');
    for (const word of ['gad7', 'instrument', 'answers', 'total', saved.id]) expect(ciphertextText(sealed), word).not.toContain(word);
    expect(persistent.data.size).toBe(0); // nothing reaches the device's own store
  });

  it('is read back by a new page load of the same session, as every screen is its own page load', async () => {
    const { anonymous, reload } = setup();
    const saved = await saveCheckIn(anonymous);
    const reloaded = reload();
    expect(await loadScreenings(reloaded)).toEqual([saved]);
    expect(await reloaded.keys()).toEqual([KEYS.screenings]);
  });

  it('gives two live sessions a database each, so neither reads or deletes the other\'s check-ins', async () => {
    const { env, persistent, make } = setup();
    const first = createAnonymousStorage(() => persistent.storage, make(() => SESSION));
    const second = createAnonymousStorage(() => persistent.storage, make(() => OTHER));
    await first.set(KEYS.screenings, [{ id: 'first' }]);
    await second.set(KEYS.screenings, [{ id: 'second' }]);
    expect((await dbNames(env)).sort()).toEqual([dbOf(SESSION), dbOf(OTHER)].sort());
    expect(await first.get(KEYS.screenings)).toEqual([{ id: 'first' }]);
    expect(await second.get(KEYS.screenings)).toEqual([{ id: 'second' }]);
  });

  it('sends the crisis block to the device store, as outside an anonymous session, and reads it from there', async () => {
    const { env, persistent, anonymous } = setup();
    await anonymous.set(KEYS.crisisBlock, { blocked: true });
    expect(persistent.data.get(KEYS.crisisBlock)).toEqual({ blocked: true });
    expect(await dbNames(env)).toEqual([]); // the crisis block never touched the anonymous database
    expect(await anonymous.get(KEYS.crisisBlock)).toEqual({ blocked: true });
  });

  it.each([KEYS.footprint, KEYS.crisisOutbox, KEYS.tickets, KEYS.directory, KEYS.invite, KEYS.equity, KEYS.crisisHandoff, KEYS.reminders, KEYS.followUp, KEYS.demoOffset, 'identity'])(
    'refuses to keep %s, so a path that was missed leaves no trace of a server relationship',
    async (key) => {
      const { persistent, anonymous } = setup();
      await expect(anonymous.set(key, { x: 1 })).rejects.toThrow(/keeps nothing/);
      await expect(anonymous.setIfAbsent(key, { x: 1 })).rejects.toThrow(/keeps nothing/);
      expect(await anonymous.get(key)).toBeUndefined();
      expect(await anonymous.keys()).toEqual([]);
      expect(persistent.data.size).toBe(0);
    },
  );

  it('keeps only the check-ins besides the crisis block', () => {
    expect(ANONYMOUS_KEPT_KEYS).toEqual([KEYS.screenings]);
  });

  it('does not fall back to plain text when the browser refuses its database: the write fails, and is tried again on the next call', async () => {
    const { env, anonymous } = setup();
    const good = env.indexedDB;
    env.indexedDB = { open: () => { throw new Error('refused'); }, deleteDatabase: good.deleteDatabase.bind(good), databases: good.databases.bind(good) } as unknown as IDBFactory;
    await expect(anonymous.set(KEYS.screenings, [{ id: 'a' }])).rejects.toThrow('refused');
    env.indexedDB = good;
    await anonymous.set(KEYS.screenings, [{ id: 'a' }]);
    expect(await anonymous.get(KEYS.screenings)).toEqual([{ id: 'a' }]);
  });
});

describe('an open anonymous page whose database is deleted from elsewhere', () => {
  it('does not seal with the key it cached: after another handle deletes the database, the next write makes a new key, and a reload reads it', async () => {
    const { env, anonymous, reload } = setup();
    await saveCheckIn(anonymous);
    const oldKey = (await rawRows(env)).get('__device-key');
    // Another tab deletes the database through its own handle while this page is open.
    await createAnonymousStore(env, () => null).wipe(SESSION);
    expect(await dbExists(env)).toBe(false);
    const after = await saveCheckIn(anonymous);
    const rows = await rawRows(env);
    expect(rows.get('__device-key')).toBeDefined();
    expect(rows.get('__device-key')).not.toBe(oldKey);
    expect(await loadScreenings(anonymous)).toEqual([after]);
    // A new page load of the session reads what was saved, instead of failing to decrypt it, and can go on saving.
    const reloaded = reload();
    expect(await loadScreenings(reloaded)).toEqual([after]);
    const clock = fixtureClock();
    await expect(saveAnswer(reloaded, { instrument: 'gad7', index: 1, value: 1, screeningId: after.id }, { now: clock.now, newId: clock.newId })).resolves.toMatchObject({ instrument: 'gad7' });
  });

  it('deletes a database whose values cannot be decrypted and starts fresh, rather than failing every read and write', async () => {
    const { env, anonymous } = setup();
    await anonymous.set(KEYS.screenings, [{ id: 'sealed' }]);
    // The key that sealed the value is lost without the database being told: a new one takes its place.
    const raw = createIndexedDbStorage({ indexedDB: env.indexedDB, dbName: dbOf(SESSION) });
    await raw.remove('__device-key');
    const fresh = createAnonymousStorage(() => memoryStorage().storage, createAnonymousStore(env, () => SESSION));
    expect(await fresh.get(KEYS.screenings)).toBeUndefined();
    await fresh.set(KEYS.screenings, [{ id: 'new' }]);
    expect(await fresh.get(KEYS.screenings)).toEqual([{ id: 'new' }]);
    // Writing and reading a value sealed by an unreadable key recovers the same way.
    await raw.set(KEYS.screenings, { v: 1, iv: new Uint8Array(12), ct: new ArrayBuffer(16) });
    await fresh.set(KEYS.screenings, [{ id: 'again' }]);
    expect(await fresh.get(KEYS.screenings)).toEqual([{ id: 'again' }]);
  });
});

describe('the wipe paths of the anonymous store', () => {
  async function seeded(locks: LocksLike | null = null) {
    const ctx = setup({}, locks);
    await saveCheckIn(ctx.anonymous);
    const before = await rawRows(ctx.env);
    expect([...before.keys()]).toContain(KEYS.screenings);
    expect([...before.keys()]).toContain('__device-key');
    return ctx;
  }

  it('leaving the session deletes the database, the ciphertext and the key with it, and ends the session', async () => {
    const { env, store } = await seeded();
    expect(await endAnonymousSession(store, () => false)).toBe('left');
    expect(await dbExists(env)).toBe(false);
    expect(isAnonymous()).toBe(false);
  });

  it('leaving still ends the session when the database cannot be deleted, and the next start deletes it', async () => {
    const { env, store, make } = await seeded();
    expect(await endAnonymousSession({ ...store, wipe: () => Promise.reject(new Error('refused')) }, () => false)).toBe('left');
    expect(isAnonymous()).toBe(false);
    expect(await dbExists(env)).toBe(true);
    await reconcileAnonymousStore(make(() => null));
    expect(await dbExists(env)).toBe(false);
  });

  it('leaving does not wait for ever on a database that hangs', async () => {
    await seeded();
    vi.useFakeTimers();
    const leaving = endAnonymousSession(hangingStore(), () => false);
    await vi.advanceTimersByTimeAsync(3000);
    await expect(leaving).resolves.toBe('left');
    expect(isAnonymous()).toBe(false);
  });

  it('leaving is refused while a crisis is open: the session stays, its database stays, and nothing is deleted', async () => {
    const { env, store } = await seeded();
    const wipe = vi.spyOn(store, 'wipe');
    expect(await endAnonymousSession(store, () => true)).toBe('refused');
    expect(isAnonymous()).toBe(true);
    expect(wipe).not.toHaveBeenCalled();
    expect(await dbExists(env)).toBe(true);
  });

  it('Delete everything deletes every anonymous database, in an anonymous session and outside one, a live session\'s too', async () => {
    const { locks, held } = fakeLocks();
    const inSession = await seeded(locks);
    held.add(`mawsool-anon:${SESSION}`);
    await deleteDeviceData(inSession.anonymous, undefined, inSession.store);
    expect(await dbNames(inSession.env)).toEqual([]);

    const outside = await seeded();
    outside.tab.session = null; // the deleting is done in a tab that is not anonymous
    await createAnonymousStorage(() => memoryStorage().storage, outside.make(() => OTHER)).set(KEYS.screenings, [{ id: 'other session' }]);
    expect((await dbNames(outside.env)).length).toBe(2);
    await deleteDeviceData(memoryStorage().storage, undefined, outside.store);
    expect(await dbNames(outside.env)).toEqual([]);
  });

  it('the anonymous store\'s clear() deletes the database and the crisis block and leaves the device store\'s other keys', async () => {
    const { env, persistent, anonymous } = await seeded();
    await persistent.storage.set(KEYS.crisisBlock, { blocked: true });
    await persistent.storage.set(KEYS.tickets, [{ id: 'earlier' }]);
    await anonymous.clear();
    expect(await dbExists(env)).toBe(false);
    expect(persistent.data.has(KEYS.crisisBlock)).toBe(false);
    expect(persistent.data.has(KEYS.tickets)).toBe(true);
    expect(await anonymous.get(KEYS.screenings)).toBeUndefined(); // the session goes on with a new, empty store
  });

  it('after a wipe the next write makes a new key: what was sealed under the old one is gone, not unreadable', async () => {
    const { env, anonymous } = await seeded();
    const oldKey = (await rawRows(env)).get('__device-key');
    await anonymous.clear();
    await anonymous.set(KEYS.screenings, [{ id: 'b' }]);
    const rows = await rawRows(env);
    expect(rows.get('__device-key')).not.toBe(oldKey);
    expect(await anonymous.get(KEYS.screenings)).toEqual([{ id: 'b' }]);
  });

  it('a start in a tab that is not anonymous deletes what an ended session left, as a closed tab could not', async () => {
    const { locks, held } = fakeLocks();
    const { env, make } = await seeded(locks);
    held.clear(); // no page holds the session's lock any more: its tab is gone
    await reconcileAnonymousStore(createAnonymousStore({ ...env, locks }, () => null));
    expect(await dbExists(env)).toBe(false);
    void make;
  });

  it('a start in another session deletes an ended session\'s check-ins and key, and leaves its own', async () => {
    const { locks, held } = fakeLocks();
    const { env } = await seeded(locks);
    held.clear(); // the first session's tab is gone
    const next = createAnonymousStorage(() => memoryStorage().storage, createAnonymousStore({ ...env, locks }, () => OTHER));
    await next.set(KEYS.screenings, [{ id: 'mine' }]);
    await reconcileAnonymousStore(createAnonymousStore({ ...env, locks }, () => OTHER));
    expect(await dbNames(env)).toEqual([dbOf(OTHER)]);
    expect(await next.get(KEYS.screenings)).toEqual([{ id: 'mine' }]);
  });

  it('a start in the same session keeps its check-ins and key, and a page reload does not delete its own database', async () => {
    const { locks } = fakeLocks(); // the lock is free: the page that held it is the one reloading
    const { env, anonymous } = await seeded(locks);
    const before = await rawRows(env);
    await reconcileAnonymousStore(createAnonymousStore({ ...env, locks }, () => SESSION));
    expect([...(await rawRows(env)).keys()].sort()).toEqual([...before.keys()].sort());
    expect(await anonymous.get(KEYS.screenings)).toHaveLength(1);
  });

  it('a start that fails or finds no IndexedDB throws nothing and wipes nothing it cannot reach', async () => {
    await expect(reconcileAnonymousStore(null)).resolves.toBeUndefined();
    await expect(reconcileAnonymousStore(stubStore({ reconcile: () => Promise.reject(new Error('x')) }))).resolves.toBeUndefined();
    await expect(wipeAnonymousData(stubStore({ wipeAll: () => Promise.reject(new Error('x')) }))).resolves.toEqual({ left: [] });
    await expect(wipeAnonymousData(null)).resolves.toEqual({ left: [] });
  });
});

describe('a live anonymous session is not deleted by another tab', () => {
  it('holds its session\'s lock on a start and on every use, and a tab that is not anonymous holds none', async () => {
    const { locks, held } = fakeLocks();
    const { make } = setup({}, locks);
    await make(() => null).reconcile();
    expect(held.size).toBe(0);
    await make(() => SESSION).reconcile();
    expect([...held]).toEqual([`mawsool-anon:${SESSION}`]);
  });

  it('is left alone by another tab\'s start while a page holds its lock, and deleted by the next start once the page has gone', async () => {
    const { locks, held } = fakeLocks();
    const { env, make, anonymous } = setup({}, locks);
    await anonymous.set(KEYS.screenings, [{ id: 'live' }]); // opening the store takes the lock
    expect(held.has(`mawsool-anon:${SESSION}`)).toBe(true);
    await make(() => null).reconcile(); // another tab starts the app
    await make(() => OTHER).reconcile(); // and so does a second anonymous session
    expect(await dbExists(env)).toBe(true);
    expect(await anonymous.get(KEYS.screenings)).toEqual([{ id: 'live' }]);
    held.delete(`mawsool-anon:${SESSION}`); // its tab closes
    await make(() => null).reconcile();
    expect(await dbExists(env)).toBe(false);
  });

  it('waits out a page reload: a lock that comes back within the grace keeps the database', async () => {
    const { locks, held } = fakeLocks();
    const { env, make, anonymous } = setup({}, locks);
    await anonymous.set(KEYS.screenings, [{ id: 'reloading' }]);
    held.delete(`mawsool-anon:${SESSION}`); // the page unloads: no lock between pages
    const env2 = { ...env, locks, abandonedGraceMs: 50 };
    const sweeping = createAnonymousStore(env2, () => null).reconcile();
    await new Promise((resolve) => setTimeout(resolve, 10));
    held.add(`mawsool-anon:${SESSION}`); // the next page took it again
    await sweeping;
    expect(await dbExists(env)).toBe(true);
    void make;
  });

  it('falls back, where there are no Web Locks, to deleting every other session\'s database at a start', async () => {
    const { env, make, anonymous } = setup();
    await anonymous.set(KEYS.screenings, [{ id: 'x' }]);
    await make(() => null).reconcile();
    expect(await dbExists(env)).toBe(false);
  });
});

describe('in a browser that cannot list its databases', () => {
  /** An IndexedDB without `databases()`, as in an older browser: it can open and delete a database by name and nothing more. */
  function blindEnv(locks: LocksLike | null = null): AnonymousEnv {
    const base = new IDBFactory();
    return { indexedDB: { open: base.open.bind(base), deleteDatabase: base.deleteDatabase.bind(base), cmp: base.cmp.bind(base) } as unknown as IDBFactory, crypto: globalThis.crypto, locks, abandonedGraceMs: 0 };
  }
  /** What the browser really holds, read through a handle that can list. */
  const namesIn = async (env: AnonymousEnv) => {
    const names: string[] = [];
    for (const id of [SESSION, OTHER]) {
      const probe = await new Promise<boolean>((resolve) => {
        const opening = env.indexedDB.open(dbOf(id));
        let existed = true;
        opening.onupgradeneeded = () => {
          existed = false;
        };
        opening.onsuccess = () => {
          opening.result.close();
          if (!existed) env.indexedDB.deleteDatabase(dbOf(id));
          resolve(existed);
        };
      });
      if (probe) names.push(dbOf(id));
    }
    return names;
  };
  function make(env: AnonymousEnv, devices = memoryStorage()) {
    const registry = deviceSessionRegistry(() => devices.storage);
    const as = (session: string | null) => createAnonymousStore(env, () => session, registry);
    return { devices, registry, as, storage: (session: string) => createAnonymousStorage(() => devices.storage, as(session)) };
  }

  it("adds the session's id to the device store's list before its database is first written", async () => {
    const { registry, as } = make(blindEnv());
    await as(SESSION).open();
    expect(await registry.list()).toEqual([SESSION]);
  });

  it('sweeps a closed session\'s database at the next start and takes its id off the list', async () => {
    const { locks, held } = fakeLocks();
    const env = blindEnv(locks);
    const { registry, as, storage } = make(env);
    await storage(SESSION).set(KEYS.screenings, [{ id: 'closed tab' }]);
    expect(await namesIn(env)).toEqual([dbOf(SESSION)]);
    held.clear(); // its tab closed
    await reconcileAnonymousStore(as(null));
    expect(await namesIn(env)).toEqual([]);
    expect(await registry.list()).toEqual([]);
  });

  it('leaves a live listed session alone, and its id on the list', async () => {
    const { locks } = fakeLocks();
    const env = blindEnv(locks);
    const { registry, as, storage } = make(env);
    await storage(SESSION).set(KEYS.screenings, [{ id: 'live' }]); // the page holds the lock
    await reconcileAnonymousStore(as(null));
    await reconcileAnonymousStore(as(OTHER));
    expect(await namesIn(env)).toEqual([dbOf(SESSION)]);
    expect((await registry.list()).sort()).toEqual([OTHER, SESSION].sort());
    expect(await storage(SESSION).get(KEYS.screenings)).toEqual([{ id: 'live' }]);
  });

  it('Delete everything deletes every listed session\'s database, live or not, and clears the list, though the browser cannot list them', async () => {
    const { locks } = fakeLocks();
    const env = blindEnv(locks);
    const devices = memoryStorage();
    const { registry, as, storage } = make(env, devices);
    await storage(SESSION).set(KEYS.screenings, [{ id: 'one' }]);
    await storage(OTHER).set(KEYS.screenings, [{ id: 'two' }]);
    expect((await namesIn(env)).sort()).toEqual([dbOf(SESSION), dbOf(OTHER)].sort());
    // The device's own store is cleared in the same erase, and the list lives in it: the databases go first.
    await deleteDeviceData(devices.storage, undefined, as(null));
    expect(await namesIn(env)).toEqual([]);
    expect(await registry.list()).toEqual([]);
    expect(devices.data.size).toBe(0);
  });

  it('is written to the device store only, so an anonymous session still makes no request', async () => {
    const { calls, fetchStub } = stubNetwork();
    const { as, storage } = make(blindEnv());
    await storage(SESSION).set(KEYS.screenings, [{ id: 'x' }]);
    await as(SESSION).reconcile();
    expect(fetchStub).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('survives a list that cannot be read or is not a list: it reads as empty rather than blocking the session', async () => {
    const devices = memoryStorage({ [KEYS.anonymousSessions]: 'not a list' });
    const { registry } = make(blindEnv(), devices);
    expect(await registry.list()).toEqual([]);
    devices.failures.read = true;
    expect(await registry.list()).toEqual([]);
  });
});

/** The same browser, except that deleting the named databases is refused, or only queued behind a connection that ignores the request. */
function failingDeletion(env: AnonymousEnv, names: string[], how: 'refuse' | 'block' | 'block-then-delete'): AnonymousEnv {
  const base = env.indexedDB;
  const factory = {
    open: base.open.bind(base),
    databases: base.databases.bind(base),
    cmp: base.cmp.bind(base),
    deleteDatabase(name: string) {
      if (!names.includes(name)) return base.deleteDatabase(name);
      if (how === 'block-then-delete') base.deleteDatabase(name); // the browser finishes it later; the caller is told it is queued now
      const request: { onerror?: () => void; onblocked?: () => void; error: Error } = { error: new Error('refused') };
      queueMicrotask(() => (how === 'refuse' ? request.onerror?.() : request.onblocked?.()));
      return request as unknown as IDBOpenDBRequest;
    },
  } as unknown as IDBFactory;
  return { ...env, indexedDB: factory };
}

describe('Delete everything never strands the phone\'s data behind an anonymous database', () => {
  /** Two sessions with check-ins, both on the device's list, beside ordinary keys in the device store. */
  async function twoSessions() {
    const env = freshEnv();
    const devices = memoryStorage({ [KEYS.tickets]: [{ id: 't' }], [KEYS.preferences]: { language: 'en' } });
    const registry = deviceSessionRegistry(() => devices.storage);
    const as = (over: AnonymousEnv, session: string | null) => createAnonymousStore(over, () => session, registry);
    await createAnonymousStorage(() => devices.storage, as(env, SESSION)).set(KEYS.screenings, [{ id: 'one' }]);
    await createAnonymousStorage(() => devices.storage, as(env, OTHER)).set(KEYS.screenings, [{ id: 'two' }]);
    expect((await registry.list()).sort()).toEqual([OTHER, SESSION].sort());
    return { env, devices, registry, as };
  }

  it('clears every ordinary key anyway when one anonymous database refuses deletion, keeps only that id on the list, and says so', async () => {
    const { env, devices, registry, as } = await twoSessions();
    const wiped = await deleteDeviceData(devices.storage, undefined, as(failingDeletion(env, [dbOf(OTHER)], 'refuse'), null));
    expect(wiped).toEqual({ anonymousLeft: true });
    expect(await dbNames(env)).toEqual([dbOf(OTHER)]);
    expect([...devices.data.keys()]).toEqual([KEYS.anonymousSessions]);
    expect(await registry.list()).toEqual([OTHER]);
  });

  it('is finished by the next start, which deletes the leftover database and takes the list\'s key away with it', async () => {
    const { env, devices, registry, as } = await twoSessions();
    await deleteDeviceData(devices.storage, undefined, as(failingDeletion(env, [dbOf(OTHER)], 'refuse'), null));
    await reconcileAnonymousStore(as(env, null));
    expect(await dbNames(env)).toEqual([]);
    expect(await registry.list()).toEqual([]);
    expect(devices.data.size).toBe(0);
  });

  it('does the same when the deletion is only queued behind a connection that ignores it: the id is kept, the rest is erased', async () => {
    const { env, devices, registry, as } = await twoSessions();
    const wiped = await deleteDeviceData(devices.storage, undefined, as(failingDeletion(env, [dbOf(SESSION)], 'block'), null));
    expect(wiped).toEqual({ anonymousLeft: true });
    expect([...devices.data.keys()]).toEqual([KEYS.anonymousSessions]);
    expect(await registry.list()).toEqual([SESSION]);
  });

  it('still deletes every database it can find from the list when the browser\'s listing of databases rejects, and reports nothing left', async () => {
    const { env, devices, registry, as } = await twoSessions();
    const base = env.indexedDB;
    const listingFails = { ...env, indexedDB: { open: base.open.bind(base), deleteDatabase: base.deleteDatabase.bind(base), cmp: base.cmp.bind(base), databases: () => Promise.reject(new Error('no listing')) } as unknown as IDBFactory };
    const wiped = await deleteDeviceData(devices.storage, undefined, as(listingFails, null));
    expect(wiped).toEqual({ anonymousLeft: false });
    expect(await dbNames(env)).toEqual([]);
    expect(devices.data.size).toBe(0);
    expect(await registry.list()).toEqual([]);
  });

  it('reports the ids it could not delete from wipeAll and takes the deleted ones off the list', async () => {
    const { env, registry, as } = await twoSessions();
    const result = await as(failingDeletion(env, [dbOf(OTHER)], 'refuse'), null).wipeAll();
    expect(result).toEqual({ left: [OTHER] });
    expect(await registry.list()).toEqual([OTHER]);
  });

  it('does not take an id off the list while its database is only queued for deletion', async () => {
    const { env, registry, as } = await twoSessions();
    const store = as(failingDeletion(env, [dbOf(OTHER)], 'block'), null);
    expect(await store.wipe(OTHER)).toBe('blocked');
    expect(await registry.list()).toContain(OTHER);
    expect(await dbNames(env)).toContain(dbOf(OTHER));
    expect(await as(env, null).wipe(OTHER)).toBe('deleted'); // once it is really deleted the id goes
    expect(await registry.list()).toEqual([SESSION]);
  });

  it('stands by the failure instead of writing to a database whose deletion is only queued, when its contents cannot be decrypted', async () => {
    const env = freshEnv();
    const devices = memoryStorage();
    await createAnonymousStorage(() => devices.storage, createAnonymousStore(env, () => SESSION)).set(KEYS.screenings, [{ id: 'sealed' }]);
    await createIndexedDbStorage({ indexedDB: env.indexedDB, dbName: dbOf(SESSION) }).remove('__device-key');
    const queued = createAnonymousStorage(() => devices.storage, createAnonymousStore(failingDeletion(env, [dbOf(SESSION)], 'block-then-delete'), () => SESSION));
    await expect(queued.get(KEYS.screenings)).rejects.toBeInstanceOf(StorageDecryptError);
  });

  it('keeps no empty list: the key is removed when the last id goes, and is not made by a device with no session', async () => {
    const devices = memoryStorage();
    const registry = deviceSessionRegistry(() => devices.storage);
    await registry.add(SESSION);
    await registry.add(OTHER);
    await registry.remove(SESSION);
    expect(devices.data.get(KEYS.anonymousSessions)).toEqual([OTHER]);
    await registry.remove(OTHER);
    expect(devices.data.has(KEYS.anonymousSessions)).toBe(false);
    await registry.remove(OTHER); // nothing to take off: nothing is written
    expect(devices.data.has(KEYS.anonymousSessions)).toBe(false);
  });

  it('drops its claim and rethrows when the list refuses the id, so the next call tries again instead of reusing the failure', async () => {
    const env = freshEnv();
    let refusing = true;
    const registry: SessionRegistry = {
      list: () => Promise.resolve([]),
      add: () => (refusing ? Promise.reject(new Error('list refused')) : Promise.resolve()),
      remove: () => Promise.resolve(),
    };
    const store = createAnonymousStore(env, () => SESSION, registry);
    await expect(store.open()).rejects.toThrow('list refused');
    refusing = false;
    const opened = await store.open();
    await opened.set(KEYS.screenings, [{ id: 'after' }]);
    expect(await opened.get(KEYS.screenings)).toEqual([{ id: 'after' }]);
  });
});

describe('a store that refuses or hangs never stands between an anonymous session and the crisis screen', () => {
  const trigger = { instrument: 'phq9', index: 8, value: 1 } as const;
  function crisisSetup(anonymousStore: AnonymousStore) {
    const clock = fixtureClock();
    const persistent = memoryStorage();
    const storage = createAnonymousStorage(() => persistent.storage, anonymousStore);
    const fallback = createTabMark<CrisisMark>(undefined, 'crisis', isCrisisMark);
    const crisis = createCrisisStore(storage, { now: clock.now, newId: clock.newId, fallback, readPatienceMs: 20, anonymous: true });
    return { storage, persistent, fallback, crisis, deps: { storage, crisis, now: clock.now, newId: clock.newId, locale: 'en' as const, patienceMs: 40 } };
  }

  it('takes the crisis path and saves the block on the device when the anonymous database refuses', async () => {
    const { deps, persistent, fallback, crisis } = crisisSetup(stubStore());
    const outcome = await recordAnswer(trigger, deps);
    expect(outcome).toMatchObject({ kind: 'crisis', screening: null, blockSaved: true });
    expect(fallback.get()).not.toBeNull();
    expect(persistent.data.get(KEYS.crisisBlock)).toMatchObject({ blocked: true, trigger: 'phq9_item9', anonymous: true });
    expect((await crisis.read()).status).toBe('blocked');
  });

  it('takes the crisis path, within its patience, when the anonymous database hangs, and the tab still says blocked', async () => {
    const { deps, fallback, crisis } = crisisSetup(hangingStore());
    const started = Date.now();
    const outcome = await recordAnswer(trigger, deps);
    expect(outcome.kind).toBe('crisis');
    expect(Date.now() - started).toBeLessThan(1000);
    expect(fallback.get()).not.toBeNull();
    expect((await crisis.read()).status).toBe('blocked');
  });

  it('reads the block and resolves it without ever asking the anonymous database', async () => {
    const asked: string[] = [];
    const { crisis } = crisisSetup(stubStore({ open: () => { asked.push('open'); return new Promise(() => undefined); } }));
    await crisis.raise({ trigger: 'phq9_item9', screeningId: null, locale: 'en' });
    expect((await crisis.read()).status).toBe('blocked');
    await crisis.recordCall('999');
    await crisis.resolve();
    expect((await crisis.read()).status).toBe('clear');
    expect(asked).toEqual([]);
  });
});

describe('a crisis opened in an anonymous session stays anonymous whatever happens to the session', () => {
  const RAISE = { trigger: 'phq9_item9', screeningId: null, locale: 'en' } as const;

  it('is never queued by a repair that runs after the session ended, when only the tab\'s mark held the block', async () => {
    const persistent = memoryStorage();
    const clock = fixtureClock();
    const fallback = createTabMark<CrisisMark>(undefined, 'crisis', isCrisisMark);
    // The crisis opens in an anonymous session while storage refuses every write: only the tab's mark holds it.
    persistent.failures.write = true;
    await createCrisisStore(persistent.storage, { now: clock.now, newId: clock.newId, fallback, anonymous: true }).raise(RAISE);
    expect(fallback.get()).toMatchObject({ trigger: 'phq9_item9', anonymous: true });
    expect(persistent.data.size).toBe(0);
    // Storage is back, and the next store is not anonymous (the session was left): the repair still must not send it.
    persistent.failures.write = false;
    const later = createCrisisStore(persistent.storage, { now: clock.now, newId: clock.newId, fallback, anonymous: false });
    expect(await later.repair('en')).toBe('repaired');
    expect(persistent.data.get(KEYS.crisisBlock)).toMatchObject({ blocked: true, anonymous: true });
    expect(await pendingEvents(persistent.storage)).toEqual([]);
    expect(persistent.data.has(KEYS.crisisOutbox)).toBe(false);
    await later.recordCall('999');
    expect(await pendingEvents(persistent.storage)).toEqual([]);
  });

  it('does not mark a crisis opened outside an anonymous session, which is queued as ever', async () => {
    const persistent = memoryStorage();
    const clock = fixtureClock();
    const fallback = createTabMark<CrisisMark>(undefined, 'crisis', isCrisisMark);
    await createCrisisStore(persistent.storage, { now: clock.now, newId: clock.newId, fallback }).raise(RAISE);
    expect(fallback.get()?.anonymous).toBeUndefined();
    expect(await pendingEvents(persistent.storage)).toHaveLength(1);
  });

  it('keeps the tab\'s mark to what the plain-text note is documented to hold', () => {
    expect(isCrisisMark({ trigger: 'phq9_item9', eventId: 'e', shownAt: '2026-11-01T08:00:00.000Z', anonymous: true })).toBe(true);
    expect(isCrisisMark({ trigger: 'phq9_item9', eventId: 'e', shownAt: '2026-11-01T08:00:00.000Z', anonymous: false })).toBe(false);
    expect(isCrisisMark({ trigger: 'phq9_item9', eventId: 'e', shownAt: '2026-11-01T08:00:00.000Z' })).toBe(true);
  });

  it('shuts the screen that starts or leaves a session while a crisis is open', () => {
    for (const path of ['/en/anonymous/', '/ar/anonymous/', '/en/anonymous']) expect(isGuardedPath(path)).toBe(true);
    expect(GUARDED_ROUTES as readonly string[]).toContain('/anonymous');
  });
});

describe('zero server calls', () => {
  it('is what every background job does in an anonymous session: none of them so much as tries a request', async () => {
    const { calls, fetchStub } = stubNetwork();
    syncNow('en');
    refreshDirectory('ar');
    refreshDemoClock({ restore: true });
    refreshDemoClock({ restore: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toEqual([]);
    expect(fetchStub).not.toHaveBeenCalled();
    // None of them got as far as asking the guard either: the entry points themselves returned first.
    expect(refusedRequests.count).toBe(0);
  });

  it('is enforced below the call sites too: the one fetch the app uses refuses before anything leaves the phone', async () => {
    const { calls, fetchStub } = stubNetwork();
    await expect(deviceFetch()('http://api.test/clock')).rejects.toThrow(/anonymous session makes no network request/);
    expect(refusedRequests.count).toBe(1);
    expect(fetchStub).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('turns every server entry point into the failure of a phone with no network, and calls nothing', async () => {
    const { calls, fetchStub } = stubNetwork();
    const store = memoryStorage();
    const { env } = setup();
    const anonymous = createAnonymousStorage(() => store.storage, createAnonymousStore(env, () => SESSION));
    const fetcher = deviceFetch();
    expect(await callServer({ storage: anonymous, fetch: fetcher, apiUrl: 'http://api.test', locale: 'en', random: globalThis.crypto }, 'POST', '/me/crisis-handoffs', {})).toMatchObject({ ok: false });
    expect(await loadDirectory({ storage: anonymous, fetch: fetcher, apiUrl: 'http://api.test', locale: 'en', now: () => new Date() })).toBeNull();
    await refreshDemoOffset(anonymous);
    expect(fetchStub).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(await anonymous.keys()).toEqual([]);
    expect(store.data.size).toBe(0);
  });

  it('is not left to chance: no file of the app names the network except the one guard', () => {
    const root = join(__dirname, '..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === '.next' || name === 'out' || name === 'test' || name === 'e2e' || name.startsWith('.')) continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(name)) files.push(path);
      }
    };
    for (const dir of ['app', 'components', 'lib']) walk(join(root, dir));
    expect(files.length).toBeGreaterThan(40);
    const offenders = files
      .filter((file) => relative(root, file) !== join('lib', 'net.ts'))
      .filter((file) => /window\.fetch|globalThis\.fetch|\bXMLHttpRequest\b|\bsendBeacon\b|\bnew WebSocket\b|\bnew EventSource\b|(?<![.\w])fetch\(/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(root, file));
    expect(offenders).toEqual([]);
  });
});

describe('the crisis path in an anonymous session', () => {
  const RAISE = { trigger: 'phq9_item9', screeningId: '00000000-0000-4000-8000-0000000000aa', locale: 'en' } as const;
  function setup(anonymous: boolean, storage = memoryStorage()) {
    const clock = fixtureClock();
    const fallback = createTabMark<CrisisMark>(undefined, 'crisis', isCrisisMark);
    return { ...storage, crisis: createCrisisStore(storage.storage, { now: clock.now, newId: clock.newId, fallback, readPatienceMs: 20, anonymous }), fallback, clock };
  }

  it('shows and records everything locally but queues nothing for the server, through the whole crisis', async () => {
    const { crisis, storage } = setup(true);
    expect(await crisis.raise(RAISE)).toBe('saved');
    const opened = await crisis.read();
    expect(opened.status).toBe('blocked');
    expect(opened.record).toMatchObject({ blocked: true, trigger: 'phq9_item9', anonymous: true });
    expect(opened.record?.event).not.toBeNull();
    await crisis.recordCall('800725462');
    await crisis.confirmContact();
    expect((await crisis.read()).record?.event).toMatchObject({ callTapped: '800725462', humanContactConfirmed: true });
    await crisis.resolve();
    expect((await crisis.read()).status).toBe('clear');
    expect(await pendingEvents(storage)).toEqual([]);
    expect(await storage.get(KEYS.crisisOutbox)).toBeUndefined();
  });

  it('queues the same crisis outside an anonymous session, so the check above is not an artefact of the setup', async () => {
    const { crisis, storage } = setup(false);
    await crisis.raise(RAISE);
    expect(await pendingEvents(storage)).toHaveLength(1);
  });

  it('keeps an anonymous crisis off the server even when the record is changed in an ordinary session later', async () => {
    const first = setup(true);
    await first.crisis.raise(RAISE);
    const later = setup(false, { storage: first.storage, data: first.data, failures: first.failures });
    later.fallback.set(first.fallback.get());
    await later.crisis.recordCall('999');
    await later.crisis.confirmContact();
    expect((await later.crisis.read()).record?.event?.callTapped).toBe('999');
    expect(await pendingEvents(first.storage)).toEqual([]);
  });

  it('does not hand the flag on to the next crisis: one opened in an ordinary session after an anonymous one is queued', async () => {
    const first = setup(true);
    await first.crisis.raise(RAISE);
    await first.crisis.resolve();
    const ordinary = setup(false, { storage: first.storage, data: first.data, failures: first.failures });
    await ordinary.crisis.raise({ ...RAISE, screeningId: '00000000-0000-4000-8000-0000000000bb' });
    const record = (await ordinary.crisis.read()).record;
    expect(record?.anonymous).toBeUndefined();
    expect(await pendingEvents(first.storage)).toHaveLength(1);
  });

  it('survives closing the tab and reopening in an ordinary session: the block is still there', async () => {
    const persistent = memoryStorage();
    const anonymousStore = createAnonymousStorage(() => persistent.storage, createAnonymousStore(freshEnv(), () => SESSION));
    const clock = fixtureClock();
    const fallback = createTabMark<CrisisMark>(undefined, 'crisis', isCrisisMark);
    await createCrisisStore(anonymousStore, { now: clock.now, newId: clock.newId, fallback, anonymous: true }).raise(RAISE);
    fallback.set(null); // the tab (and its mark) closed
    const reopened = createCrisisStore(persistent.storage, { now: clock.now, newId: clock.newId, fallback: createTabMark<CrisisMark>(undefined, 'crisis', isCrisisMark) });
    expect((await reopened.read()).status).toBe('blocked');
  });
});

describe('Delete everything in an anonymous session', () => {
  it('erases the session without a request: the encrypted check-ins, their key and the crisis block go, and the server is never asked', async () => {
    const { calls, fetchStub } = stubNetwork();
    const { env, persistent, store, anonymous } = setup({ [KEYS.crisisBlock]: { blocked: true, trigger: 'phq9_item9' } });
    await saveCheckIn(anonymous);
    expect(await dbExists(env)).toBe(true);
    const tabMark = createTabMark<{ id: string }>(undefined, 'k', (value): value is { id: string } => typeof value === 'object');
    tabMark.set({ id: 'open' });
    const outcome = await eraseEverything({
      storage: anonymous,
      tabMark,
      server: { storage: anonymous, fetch: deviceFetch(), apiUrl: 'http://api.test', locale: 'en', random: globalThis.crypto },
      flushCrisis: async () => ({ outcome: 'empty', sent: 0, rejected: 0 }),
      crisisIsOpen: async () => true,
      anonymousStore: store,
    });
    expect(outcome).toMatchObject({ status: 'erased', crisisWasOpen: true });
    expect(await dbExists(env)).toBe(false);
    expect(persistent.data.has(KEYS.crisisBlock)).toBe(false);
    expect(tabMark.get()).toBeNull();
    expect(fetchStub).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(refusedRequests.count).toBe(0);
  });
});

describe('the screens an anonymous session cannot open', () => {
  it.each(['/en/options/', '/ar/options/', '/en/consent/', '/en/ticket/', '/ar/ticket/', '/en/claim/', '/en/tamm/', '/en/remeasure/', '/en/next-day/', '/en/options/extra/'])('walls %s', (path) => {
    expect(isAnonymousWalledPath(path)).toBe(true);
  });

  it.each(['/', '/en/', '/en/check-in/', '/ar/check-ins/', '/en/result/', '/ar/crisis/', '/en/settings/', '/en/anonymous/', '/en/options-info/'])('leaves %s open', (path) => {
    expect(isAnonymousWalledPath(path)).toBe(false);
  });

  it('is decided for every screen of the app: a new page must be walled or named as one that works with no server', () => {
    const screens = readdirSync(join(__dirname, '..', 'app', '[locale]'), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => `/${entry.name}`);
    const worksWithNoServer = ['/anonymous', '/check-in', '/check-ins', '/crisis', '/result', '/settings'];
    expect(screens.filter((screen) => !worksWithNoServer.includes(screen) && !(ANONYMOUS_WALLED_ROUTES as readonly string[]).includes(screen))).toEqual([]);
    expect(worksWithNoServer.filter((screen) => !screens.includes(screen))).toEqual([]);
    // The crisis block still decides first: every screen that leads on to matching is both guarded and walled.
    for (const route of ['/options', '/consent', '/ticket', '/remeasure', '/next-day']) {
      expect(GUARDED_ROUTES as readonly string[]).toContain(route);
      expect(ANONYMOUS_WALLED_ROUTES as readonly string[]).toContain(route);
    }
  });
});

describe('what an anonymous session tells the person', () => {
  const keys = ['banner', 'bannerLink', 'homeTitle', 'homeBody', 'homeAction', 'title', 'introOff', 'introOn', 'worksTitle', 'works1', 'works2', 'cannotTitle', 'cannot1', 'cannot2', 'cannot3', 'keepsTitle', 'keeps', 'start', 'notNow', 'leave', 'leaveConfirm', 'leaveYes', 'leaveNo', 'wallTitle', 'wallBody', 'wallMeaning', 'wallHome', 'resultNote', 'settingsTitle', 'settingsBody', 'deleteBody'] as const;

  it('is written in both languages for every message, with the Arabic in Arabic script', () => {
    expect(Object.keys(en.anonymous).sort()).toEqual([...keys].sort());
    expect(Object.keys(ar.anonymous).sort()).toEqual([...keys].sort());
    for (const key of keys) {
      expect(en.anonymous[key].length, `en ${key}`).toBeGreaterThan(3);
      expect(ar.anonymous[key], `ar ${key}`).toMatch(/[؀-ۿ]/);
    }
  });

  it('says in both languages what it cannot do: no ticket, nothing shared, nothing kept on a server', () => {
    expect(en.anonymous.cannot1).toMatch(/no ticket/i);
    expect(en.anonymous.cannot2).toMatch(/nothing is shared/i);
    expect(en.anonymous.cannot3).toMatch(/nothing is kept on a server/i);
    expect(ar.anonymous.cannot1).toContain('لا تذكرة');
    expect(ar.anonymous.cannot2).toContain('لا يُشارَك شيء');
    expect(ar.anonymous.cannot3).toContain('لا يُحفَظ شيء على أي خادم');
  });
});
