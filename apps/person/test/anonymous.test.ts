import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createTabMark } from '@mawsool/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ANONYMOUS_KEPT_KEYS, createAnonymousStorage, endAnonymousSession, isAnonymous, startAnonymousSession, wipeAnonymousData } from '../lib/anonymous';
import { createCrisisStore, isCrisisMark, type CrisisMark } from '../lib/crisis';
import { pendingEvents } from '../lib/crisis-outbox';
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

/** A `sessionStorage` over a map, with the properties `wipeAnonymousData` walks. */
function fakeSession() {
  const data = new Map<string, string>();
  const session = {
    get length() {
      return data.size;
    },
    key: (index: number) => [...data.keys()][index] ?? null,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  } as unknown as Storage;
  return { session, data };
}

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
  startAnonymousSession();
});

afterEach(() => {
  endAnonymousSession();
  vi.unstubAllGlobals();
});

describe('an anonymous session', () => {
  it('is a mark on the tab: started, read back, and ended', () => {
    expect(isAnonymous()).toBe(true);
    endAnonymousSession();
    expect(isAnonymous()).toBe(false);
    startAnonymousSession();
    expect(isAnonymous()).toBe(true);
  });
});

describe('the anonymous store', () => {
  const setup = () => {
    const persistent = memoryStorage();
    const { session, data } = fakeSession();
    const make = () => createAnonymousStorage(() => persistent.storage, session);
    return { persistent, session, data, make };
  };

  it('keeps the check-ins for the tab: a new page load over the same tab reads them, and nothing reaches the device store', async () => {
    const { persistent, make, data } = setup();
    const clock = fixtureClock();
    const saved = await saveAnswer(make(), { instrument: 'gad7', index: 0, value: 2 }, { now: clock.now, newId: clock.newId });
    const reloaded = make(); // each screen is its own page load
    expect(await loadScreenings(reloaded)).toEqual([saved]);
    expect([...data.keys()].every((name) => name.startsWith('mawsool.anon:'))).toBe(true);
    expect(persistent.data.size).toBe(0);
    expect(await reloaded.keys()).toEqual([KEYS.screenings]);
  });

  it('sends the crisis block to the device store, as outside an anonymous session, and reads it from there', async () => {
    const { persistent, make, data } = setup();
    const anonymous = make();
    await anonymous.set(KEYS.crisisBlock, { blocked: true });
    expect(persistent.data.get(KEYS.crisisBlock)).toEqual({ blocked: true });
    expect(data.size).toBe(0);
    expect(await anonymous.get(KEYS.crisisBlock)).toEqual({ blocked: true });
  });

  it.each([KEYS.footprint, KEYS.crisisOutbox, KEYS.tickets, KEYS.directory, KEYS.invite, KEYS.equity, KEYS.crisisHandoff, KEYS.reminders, KEYS.followUp, KEYS.demoOffset, 'identity'])(
    'refuses to keep %s, so a path that was missed leaves no trace of a server relationship',
    async (key) => {
      const { persistent, make, data } = setup();
      const anonymous = make();
      await expect(anonymous.set(key, { x: 1 })).rejects.toThrow(/keeps nothing/);
      await expect(anonymous.setIfAbsent(key, { x: 1 })).rejects.toThrow(/keeps nothing/);
      expect(await anonymous.get(key)).toBeUndefined();
      expect(data.size).toBe(0);
      expect(persistent.data.size).toBe(0);
    },
  );

  it('keeps only the check-ins besides the crisis block', () => {
    expect(ANONYMOUS_KEPT_KEYS).toEqual([KEYS.screenings]);
  });

  it('is emptied by clear(): the check-ins and the crisis block go, and a sibling key of the device store stays', async () => {
    const { persistent, make, data } = setup();
    const anonymous = make();
    await anonymous.set(KEYS.screenings, [{ id: 'a' }]);
    await anonymous.set(KEYS.crisisBlock, { blocked: true });
    await persistent.storage.set(KEYS.tickets, [{ id: 'earlier' }]);
    await anonymous.clear();
    expect(data.size).toBe(0);
    expect(await anonymous.get(KEYS.screenings)).toBeUndefined();
    expect(persistent.data.has(KEYS.crisisBlock)).toBe(false);
    expect(persistent.data.has(KEYS.tickets)).toBe(true);
  });

  it('holds on to the check-ins in memory when the browser refuses sessionStorage', async () => {
    const persistent = memoryStorage();
    const refusing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); }, length: 0, key: () => null } as unknown as Storage;
    const anonymous = createAnonymousStorage(() => persistent.storage, refusing);
    await anonymous.set(KEYS.screenings, [{ id: 'a' }]);
    expect(await anonymous.get(KEYS.screenings)).toEqual([{ id: 'a' }]);
  });

  it('is wiped by wipeAnonymousData, which leaves every other key of the tab alone', () => {
    const { session, data } = fakeSession();
    data.set('mawsool.anon:screenings', '[]');
    data.set('mawsool.crisis-mark', '{}');
    data.set('theme', 'dark');
    wipeAnonymousData(session);
    expect([...data.keys()].sort()).toEqual(['mawsool.crisis-mark', 'theme']);
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
    const anonymous = createAnonymousStorage(() => store.storage, fakeSession().session);
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
    const anonymousStore = createAnonymousStorage(() => persistent.storage, fakeSession().session);
    const clock = fixtureClock();
    const fallback = createTabMark<CrisisMark>(undefined, 'crisis', isCrisisMark);
    await createCrisisStore(anonymousStore, { now: clock.now, newId: clock.newId, fallback, anonymous: true }).raise(RAISE);
    fallback.set(null); // the tab (and its mark) closed
    const reopened = createCrisisStore(persistent.storage, { now: clock.now, newId: clock.newId, fallback: createTabMark<CrisisMark>(undefined, 'crisis', isCrisisMark) });
    expect((await reopened.read()).status).toBe('blocked');
  });
});

describe('Delete everything in an anonymous session', () => {
  it('erases the session without a request: the check-ins and the crisis block go, and the server is never asked', async () => {
    const { calls, fetchStub } = stubNetwork();
    const persistent = memoryStorage({ [KEYS.crisisBlock]: { blocked: true, trigger: 'phq9_item9' } });
    const { session, data } = fakeSession();
    const anonymous = createAnonymousStorage(() => persistent.storage, session);
    await anonymous.set(KEYS.screenings, [{ id: 'a' }]);
    const tabMark = createTabMark<{ id: string }>(undefined, 'k', (value): value is { id: string } => typeof value === 'object');
    tabMark.set({ id: 'open' });
    const outcome = await eraseEverything({
      storage: anonymous,
      tabMark,
      server: { storage: anonymous, fetch: deviceFetch(), apiUrl: 'http://api.test', locale: 'en', random: globalThis.crypto },
      flushCrisis: async () => ({ outcome: 'empty', sent: 0, rejected: 0 }),
      crisisIsOpen: async () => true,
    });
    expect(outcome).toMatchObject({ status: 'erased', crisisWasOpen: true });
    expect(data.size).toBe(0);
    expect(persistent.data.has(KEYS.crisisBlock)).toBe(false);
    expect(tabMark.get()).toBeNull();
    expect(fetchStub).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(refusedRequests.count).toBe(0);
  });

  it('reaches what an anonymous session left in the tab even when the deleting is done outside it', async () => {
    const { session, data } = fakeSession();
    data.set('mawsool.anon:screenings', '[{"id":"a"}]');
    vi.stubGlobal('window', { sessionStorage: session });
    await deleteDeviceData(memoryStorage().storage);
    expect(data.size).toBe(0);
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
