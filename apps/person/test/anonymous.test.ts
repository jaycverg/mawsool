import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createIndexedDbStorage, createTabMark } from '@mawsool/ui';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ANONYMOUS_DB,
  ANONYMOUS_KEPT_KEYS,
  anonymousSessionId,
  createAnonymousStorage,
  createAnonymousStore,
  endAnonymousSession,
  isAnonymous,
  isAnonymousMark,
  reconcileAnonymousStore,
  startAnonymousSession,
  wipeAnonymousData,
  type AnonymousEnv,
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
import { ANONYMOUS_WALLED_ROUTES, GUARDED_ROUTES, isAnonymousWalledPath } from '../lib/routes';
import { loadScreenings, saveAnswer } from '../lib/screening-store';
import { callServer } from '../lib/server';
import { refreshDemoClock, refreshDirectory, syncNow } from '../lib/sync';
import ar from '../messages/ar.json';
import en from '../messages/en.json';
import { fixtureClock, memoryStorage } from './helpers/memory';

const SESSION = '11111111-1111-4111-8111-111111111111';

/** The browser's parts for one anonymous store, over a fresh in-memory IndexedDB. */
const freshEnv = (): AnonymousEnv => ({ indexedDB: new IDBFactory(), crypto: globalThis.crypto });

/** Whether the anonymous database exists at all: false once it has been deleted, ciphertext, key and owner with it. */
async function dbExists(env: AnonymousEnv): Promise<boolean> {
  return (await env.indexedDB.databases()).some((db) => db.name === ANONYMOUS_DB);
}

/** The rows of the anonymous database exactly as the browser holds them. */
async function rawRows(env: AnonymousEnv): Promise<Map<string, unknown>> {
  const raw = createIndexedDbStorage({ indexedDB: env.indexedDB, dbName: ANONYMOUS_DB });
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
  await endAnonymousSession(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** One anonymous store over a fresh IndexedDB, with the device's own store beside it and the tab session it answers to. */
function setup(initialPersistent: Record<string, unknown> = {}) {
  const env = freshEnv();
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

describe('an anonymous session', () => {
  it('is a note on the tab that holds a random id and nothing else: started, read back, and ended', async () => {
    expect(isAnonymous()).toBe(true);
    expect(anonymousSessionId()).toBe(SESSION);
    await endAnonymousSession(null);
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
  it('keeps the check-ins as ciphertext under a key that cannot be exported, in a database of its own', async () => {
    const { env, persistent, anonymous } = setup();
    const saved = await saveCheckIn(anonymous);
    const rows = await rawRows(env);
    expect([...rows.keys()].sort()).toEqual(['__device-key', 'owner', KEYS.screenings]);
    expect(rows.get('owner')).toBe(SESSION); // the one plain row: a random id
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

  it('sends the crisis block to the device store, as outside an anonymous session, and reads it from there', async () => {
    const { env, persistent, anonymous } = setup();
    await anonymous.set(KEYS.crisisBlock, { blocked: true });
    expect(persistent.data.get(KEYS.crisisBlock)).toEqual({ blocked: true });
    expect(await dbExists(env)).toBe(false); // the crisis block never touched the anonymous database
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

describe('the wipe paths of the anonymous store', () => {
  async function seeded() {
    const ctx = setup();
    await saveCheckIn(ctx.anonymous);
    const before = await rawRows(ctx.env);
    expect([...before.keys()]).toContain(KEYS.screenings);
    expect([...before.keys()]).toContain('__device-key');
    return ctx;
  }

  it('leaving the session deletes the database, the ciphertext and the key with it, and ends the session', async () => {
    const { env, store } = await seeded();
    await endAnonymousSession(store);
    expect(await dbExists(env)).toBe(false);
    expect(isAnonymous()).toBe(false);
  });

  it('leaving still ends the session when the database cannot be deleted, and the next start deletes it', async () => {
    const { env, store, make } = await seeded();
    await endAnonymousSession({ ...store, wipe: () => Promise.reject(new Error('refused')) });
    expect(isAnonymous()).toBe(false);
    expect(await dbExists(env)).toBe(true);
    await reconcileAnonymousStore(make(() => null));
    expect(await dbExists(env)).toBe(false);
  });

  it('leaving does not wait for ever on a database that hangs', async () => {
    await seeded();
    vi.useFakeTimers();
    const leaving = endAnonymousSession({ open: () => new Promise(() => undefined), reconcile: () => new Promise(() => undefined), wipe: () => new Promise(() => undefined) });
    await vi.advanceTimersByTimeAsync(3000);
    await leaving;
    expect(isAnonymous()).toBe(false);
  });

  it('Delete everything deletes the database too, in an anonymous session and outside one, ciphertext and key', async () => {
    const inSession = await seeded();
    await deleteDeviceData(inSession.anonymous, undefined, inSession.store);
    expect(await dbExists(inSession.env)).toBe(false);

    const outside = await seeded();
    outside.tab.session = null; // the deleting is done in a tab that is not anonymous
    await deleteDeviceData(memoryStorage().storage, undefined, outside.store);
    expect(await dbExists(outside.env)).toBe(false);
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

  it('a start in a tab that is not anonymous deletes what an earlier anonymous session left, as a closed tab could not', async () => {
    const { env, make } = await seeded();
    await reconcileAnonymousStore(make(() => null));
    expect(await dbExists(env)).toBe(false);
  });

  it('a start in a new anonymous session deletes the earlier session\'s check-ins and key, and keeps only its own owner', async () => {
    const { env, make } = await seeded();
    const OTHER = '22222222-2222-4222-8222-222222222222';
    const next = createAnonymousStorage(() => memoryStorage().storage, make(() => OTHER));
    await reconcileAnonymousStore(make(() => OTHER));
    const rows = await rawRows(env);
    expect([...rows.keys()]).toEqual(['owner']);
    expect(rows.get('owner')).toBe(OTHER);
    expect(await next.get(KEYS.screenings)).toBeUndefined();
  });

  it('a start in the same session keeps its check-ins and key', async () => {
    const { env, make, anonymous } = await seeded();
    const before = await rawRows(env);
    await reconcileAnonymousStore(make());
    const after = await rawRows(env);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    expect(await anonymous.get(KEYS.screenings)).toHaveLength(1);
  });

  it('a start that fails or finds no IndexedDB throws nothing and wipes nothing it cannot reach', async () => {
    await expect(reconcileAnonymousStore(null)).resolves.toBeUndefined();
    await expect(reconcileAnonymousStore({ open: () => Promise.reject(new Error('x')), reconcile: () => Promise.reject(new Error('x')), wipe: () => Promise.reject(new Error('x')) })).resolves.toBeUndefined();
    await expect(wipeAnonymousData({ open: () => Promise.reject(new Error('x')), reconcile: () => Promise.reject(new Error('x')), wipe: () => Promise.reject(new Error('x')) })).resolves.toBeUndefined();
    await expect(wipeAnonymousData(null)).resolves.toBeUndefined();
  });
});

describe('a store that refuses or hangs never stands between an anonymous session and the crisis screen', () => {
  const trigger = { instrument: 'phq9', index: 8, value: 1 } as const;
  function crisisSetup(anonymousStore: ReturnType<typeof createAnonymousStore>) {
    const clock = fixtureClock();
    const persistent = memoryStorage();
    const storage = createAnonymousStorage(() => persistent.storage, anonymousStore);
    const fallback = createTabMark<CrisisMark>(undefined, 'crisis', isCrisisMark);
    const crisis = createCrisisStore(storage, { now: clock.now, newId: clock.newId, fallback, readPatienceMs: 20, anonymous: true });
    return { storage, persistent, fallback, crisis, deps: { storage, crisis, now: clock.now, newId: clock.newId, locale: 'en' as const, patienceMs: 40 } };
  }
  const refusing = (): ReturnType<typeof createAnonymousStore> => ({ open: () => Promise.reject(new Error('refused')), reconcile: () => Promise.reject(new Error('refused')), wipe: () => Promise.resolve() });
  const hanging = (): ReturnType<typeof createAnonymousStore> => ({ open: () => new Promise(() => undefined), reconcile: () => new Promise(() => undefined), wipe: () => new Promise(() => undefined) });

  it('takes the crisis path and saves the block on the device when the anonymous database refuses', async () => {
    const { deps, persistent, fallback, crisis } = crisisSetup(refusing());
    const outcome = await recordAnswer(trigger, deps);
    expect(outcome).toMatchObject({ kind: 'crisis', screening: null, blockSaved: true });
    expect(fallback.get()).not.toBeNull();
    expect(persistent.data.get(KEYS.crisisBlock)).toMatchObject({ blocked: true, trigger: 'phq9_item9', anonymous: true });
    expect((await crisis.read()).status).toBe('blocked');
  });

  it('takes the crisis path, within its patience, when the anonymous database hangs, and the tab still says blocked', async () => {
    const { deps, fallback, crisis } = crisisSetup(hanging());
    const started = Date.now();
    const outcome = await recordAnswer(trigger, deps);
    expect(outcome.kind).toBe('crisis');
    expect(Date.now() - started).toBeLessThan(1000);
    expect(fallback.get()).not.toBeNull();
    expect((await crisis.read()).status).toBe('blocked');
  });

  it('reads the block and resolves it without ever asking the anonymous database', async () => {
    const asked: string[] = [];
    const watching: ReturnType<typeof createAnonymousStore> = { open: () => { asked.push('open'); return new Promise(() => undefined); }, reconcile: () => Promise.resolve(), wipe: () => Promise.resolve() };
    const { crisis } = crisisSetup(watching);
    await crisis.raise({ trigger: 'phq9_item9', screeningId: null, locale: 'en' });
    expect((await crisis.read()).status).toBe('blocked');
    await crisis.recordCall('999');
    await crisis.resolve();
    expect((await crisis.read()).status).toBe('clear');
    expect(asked).toEqual([]);
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
