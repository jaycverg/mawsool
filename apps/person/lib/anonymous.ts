import { StorageDecryptError, createEncryptedStorage, createIndexedDbStorage, createTabMark, deleteIndexedDb, safeSessionStorage, type CryptoLike, type StorageAdapter } from '@mawsool/ui';
import { CRISIS_MARK_KEY, isCrisisMark, type CrisisMark } from './crisis';
import { KEYS } from './keys';
import { within } from './within';

/**
 * Anonymous mode: a session that makes no request to the server at all and keeps nothing on one. It lasts as long as the
 * browser tab. The tab holds one small plain-text note for it, `{ session }`: a random id that says "this tab is anonymous" and
 * names the session's database. It holds no answer, score, result or person id, and goes when the tab closes, the session is
 * left, or the tab is wiped. It survives a reload and navigation in the tab (the same place, and for the same reason, as the
 * crisis mark).
 */
const MARK_KEY = 'mawsool.anonymous';

/** What the tab's note holds: a random id, nothing else. */
export interface AnonymousMark {
  session: string;
}

export function isAnonymousMark(value: unknown): value is AnonymousMark {
  const candidate = value as Partial<AnonymousMark> | null;
  return typeof candidate === 'object' && candidate !== null && typeof candidate.session === 'string' && candidate.session.length > 0 && Object.keys(candidate).length === 1;
}

const mark = createTabMark<AnonymousMark>(safeSessionStorage(), MARK_KEY, isAnonymousMark);
const crisisMark = createTabMark<CrisisMark>(safeSessionStorage(), CRISIS_MARK_KEY, isCrisisMark);

/** Whether this tab is in an anonymous session. Synchronous, so a guard can ask it before any request. */
export function isAnonymous(): boolean {
  return mark.get() !== null;
}

/** The id of this tab's anonymous session, or null when the tab is not in one. */
export function anonymousSessionId(): string | null {
  return mark.get()?.session ?? null;
}

/** Begins an anonymous session in this tab, with a fresh id. The caller reloads the page so every screen starts from the anonymous store. */
export function startAnonymousSession(newId: () => string = () => crypto.randomUUID()): void {
  mark.set({ session: newId() });
}

/** How long leaving a session waits for the store to be deleted before it carries on; the next start deletes what is left. */
const WIPE_PATIENCE_MS = 3000;

/**
 * Ends the anonymous session in this tab and removes what it kept: the encrypted check-ins and the key that opens them. The
 * crisis block (kept on purpose, see `createAnonymousStorage`) is left to be resolved like any other.
 *
 * It is refused while a crisis is open in this tab (the tab's crisis mark is set): the crisis was opened as an anonymous one and
 * must stay one until it is resolved, and the way to leave is shut during it (`/anonymous` is a guarded screen). If the store cannot
 * be deleted right now the session still ends, and a later start of the app in a tab with no such live session deletes it.
 * The caller reloads the page.
 */
export async function endAnonymousSession(store: AnonymousStore | null = anonymousStore(), crisisOpen: () => boolean = () => crisisMark.get() !== null): Promise<'left' | 'refused'> {
  if (crisisOpen()) return 'refused';
  const id = anonymousSessionId();
  mark.set(null);
  if (store) await within(store.wipe(id), WIPE_PATIENCE_MS, undefined);
  return 'left';
}

/** What every anonymous session's IndexedDB database is called, followed by the session's id: apart from the device's own, so deleting one touches nothing else. */
export const ANONYMOUS_DB_PREFIX = 'mawsool-anon-';
const dbNameOf = (session: string): string => `${ANONYMOUS_DB_PREFIX}${session}`;
const lockNameOf = (session: string): string => `mawsool-anon:${session}`;

/**
 * What an anonymous session keeps for the tab: the check-ins taken in it, answers included, as AES-GCM ciphertext in a database of
 * their own, under a key that cannot be exported and lives in that same database. Deleting the database deletes both.
 */
export const ANONYMOUS_KEPT_KEYS: readonly string[] = [KEYS.screenings];

/** The part of the Web Locks API this uses. */
export interface LocksLike {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
  request<T>(name: string, options: { ifAvailable: true }, callback: (lock: object | null) => Promise<T> | T): Promise<T>;
}

/** The parts of the browser the anonymous store needs, so tests can supply their own. */
export interface AnonymousEnv {
  indexedDB: IDBFactory;
  crypto: CryptoLike;
  /**
   * Web Locks. A live anonymous page holds its session's lock for as long as the page lives, so another tab can tell a live
   * session's database from one whose tab closed. Where there are none (an old browser) every other session's database counts as
   * abandoned, which is how it behaved before locks were used: a second tab starting the app deletes it.
   */
  locks?: LocksLike | null;
  /**
   * How long a database whose lock is free is given before it counts as abandoned: a page reload releases the lock between one
   * page and the next, and the next page takes it again within moments. Default 2000 ms.
   */
  abandonedGraceMs?: number;
}

/** The browser's own, or null where there is no IndexedDB to keep anything in. */
function browserEnv(): AnonymousEnv | null {
  try {
    return typeof window === 'undefined' || !window.indexedDB ? null : { indexedDB: window.indexedDB, crypto: window.crypto, locks: (navigator.locks as unknown as LocksLike | undefined) ?? null };
  } catch {
    return null;
  }
}

/** The encrypted database of an anonymous session, and the things that happen to it. */
export interface AnonymousStore {
  /**
   * The encrypted store of this tab's session, and this page's hold on the session's lock. Memoised for the page load, and dropped
   * when the database is deleted from elsewhere or fails, so it never outlives its database (nor the key it cached).
   */
  open(): Promise<StorageAdapter>;
  /**
   * Start of the app, in every tab: an anonymous tab takes its session's lock; every tab then deletes the anonymous databases of
   * other sessions that are abandoned (no live page holds their lock). A live session's database is never deleted by another tab.
   */
  reconcile(): Promise<void>;
  /** Deletes one session's database (by default this tab's): every ciphertext and the key. The next `open()` starts a new one. */
  wipe(session?: string | null): Promise<void>;
  /** Deletes every anonymous database on the device, live or not: "Delete everything". Where the browser cannot list databases, this tab's own. */
  wipeAll(): Promise<void>;
}

/**
 * The anonymous sessions' encrypted databases. `session` says which tab session is asking (null for a tab that is not anonymous,
 * which owns nothing). Each session has its own database, named by its id, so two live anonymous tabs never share or delete one
 * another's check-ins.
 */
export function createAnonymousStore(env: AnonymousEnv, session: () => string | null = anonymousSessionId): AnonymousStore {
  let claim: { session: string; storage: StorageAdapter } | null = null;
  let held: string | null = null;

  const forget = () => {
    claim = null;
  };

  /** Holds the session's lock until this page goes. Never resolves; a browser without locks holds nothing. */
  function holdLock(id: string): void {
    if (!env.locks || held === id) return;
    held = id;
    env.locks.request(lockNameOf(id), () => new Promise<never>(() => undefined)).catch(() => {
      held = null;
    });
  }

  /** The same store, but a call that fails drops the claim, so a database the browser refused once is opened afresh by the next call. */
  function failureForgets(inner: StorageAdapter): StorageAdapter {
    const guard = <T>(call: Promise<T>): Promise<T> =>
      call.catch((error: unknown) => {
        if (claim?.storage === wrapped) forget();
        throw error;
      });
    const wrapped: StorageAdapter = {
      get: <T,>(key: string) => guard(inner.get<T>(key)),
      set: (key, value) => guard(inner.set(key, value)),
      setIfAbsent: (key, value) => guard(inner.setIfAbsent(key, value)),
      remove: (key) => guard(inner.remove(key)),
      keys: () => guard(inner.keys()),
      clear: () => guard(inner.clear()),
    };
    return wrapped;
  }

  function open(): Promise<StorageAdapter> {
    const id = session();
    if (id === null) return Promise.reject(new Error('This tab is not in an anonymous session'));
    holdLock(id);
    if (claim?.session !== id) {
      // A connection closed from elsewhere (the database was deleted) drops this claim, and with it the wrapper's cached key: the
      // next call opens a new empty database and makes a new key, rather than sealing with a key no database holds.
      const raw = createIndexedDbStorage({ indexedDB: env.indexedDB, dbName: dbNameOf(id), onVersionChange: forget });
      claim = { session: id, storage: failureForgets(createEncryptedStorage(raw, env.crypto)) };
    }
    return Promise.resolve(claim.storage);
  }

  async function wipe(target: string | null = session()): Promise<void> {
    forget();
    if (target !== null) await deleteIndexedDb(env.indexedDB, dbNameOf(target));
  }

  /** The ids of the anonymous databases the browser lists, or null when it cannot list them. */
  async function listed(): Promise<string[] | null> {
    if (typeof env.indexedDB.databases !== 'function') return null;
    const all = await env.indexedDB.databases();
    return all.flatMap((db) => (db.name?.startsWith(ANONYMOUS_DB_PREFIX) ? [db.name.slice(ANONYMOUS_DB_PREFIX.length)] : []));
  }

  async function wipeAll(): Promise<void> {
    forget();
    const ids = await listed();
    if (ids === null) return wipe();
    for (const id of ids) await deleteIndexedDb(env.indexedDB, dbNameOf(id));
  }

  /** Whether no live page holds a session's lock, twice, a grace apart (a page that is reloading has none in between). */
  async function abandoned(id: string): Promise<boolean> {
    const locks = env.locks;
    if (!locks) return true;
    const free = () => locks.request(lockNameOf(id), { ifAvailable: true }, (lock) => lock !== null);
    if (!(await free())) return false;
    await new Promise((resolve) => setTimeout(resolve, env.abandonedGraceMs ?? 2000));
    return free();
  }

  async function reconcile(): Promise<void> {
    const own = session();
    if (own !== null) holdLock(own);
    for (const id of (await listed()) ?? []) {
      if (id !== own && (await abandoned(id))) await deleteIndexedDb(env.indexedDB, dbNameOf(id));
    }
  }

  return { open, reconcile, wipe, wipeAll };
}

let browserStore: AnonymousStore | null | undefined;

/** The browser's anonymous store, or null where the browser has no IndexedDB. Created on first use. */
export function anonymousStore(): AnonymousStore | null {
  if (browserStore === undefined) {
    const env = browserEnv();
    browserStore = env ? createAnonymousStore(env) : null;
  }
  return browserStore;
}

/**
 * Start of the app, in every tab, with nothing awaited and nothing thrown: an anonymous tab takes its session's lock, and every tab
 * deletes the databases of anonymous sessions whose tab has gone (a closed tab could not wipe its own). A session that is still
 * open in another tab is left alone.
 */
export function reconcileAnonymousStore(store: AnonymousStore | null = anonymousStore()): Promise<void> {
  if (!store) return Promise.resolve();
  return store.reconcile().catch(() => undefined);
}

/**
 * Deletes everything an anonymous session kept on this device, whichever mode the deleting is done in and whether or not another
 * tab's session is live: the encrypted check-ins and their keys. Never throws: a browser with nothing to delete has nothing kept.
 */
export async function wipeAnonymousData(store: AnonymousStore | null = anonymousStore()): Promise<void> {
  if (!store) return;
  try {
    await store.wipeAll();
  } catch {
    // The browser refused to delete it: the next start of the app tries again.
  }
}

/**
 * The store an anonymous session reads and writes. It is not the device's encrypted store:
 *
 *  - the check-ins (`screenings`) are kept for the tab session only, as ciphertext in a database of their own (see
 *    `ANONYMOUS_KEPT_KEYS`), so they survive moving between screens (each screen is its own page load) and are gone when the
 *    session is left, everything is deleted, or the tab session ends. A value that cannot be decrypted (its key is gone) is
 *    deleted with its database and the session starts fresh, rather than failing every later read and write;
 *  - the crisis block goes to the device's own store as it does outside an anonymous session, because a person in a crisis who
 *    closes the tab must still find the help screen next time. It holds a trigger name and times and no answer or score, and it
 *    never reaches a server from an anonymous session (see `anonymous` on the crisis record). It never waits on the anonymous
 *    database: that store refusing or hanging cannot stand between the person and the help screen;
 *  - nothing else is kept. A write under any other key (the device identity, the server footprint, the crisis queue, a ticket, the
 *    directory) is refused, so a path that was missed cannot leave a trace of a server relationship.
 */
export function createAnonymousStorage(persistent: () => StorageAdapter, store: AnonymousStore | null = anonymousStore()): StorageAdapter {
  const kept = (key: string) => ANONYMOUS_KEPT_KEYS.includes(key);
  const refuse = (key: string) => new Error(`An anonymous session keeps nothing under "${key}"`);
  const sealed = (): Promise<StorageAdapter> => (store ? store.open() : Promise.reject(new Error('This browser has no IndexedDB to keep an anonymous session in')));

  /** Runs one operation on the sealed store; if its contents cannot be decrypted, deletes the database and runs it once more on the new one. */
  async function recovering<T>(operation: (inner: StorageAdapter) => Promise<T>): Promise<T> {
    try {
      return await operation(await sealed());
    } catch (error) {
      if (!(error instanceof StorageDecryptError) || !store) throw error;
      await store.wipe();
      return operation(await sealed());
    }
  }

  return {
    async get<T>(key: string) {
      if (key === KEYS.crisisBlock) return persistent().get<T>(key);
      return kept(key) ? recovering((inner) => inner.get<T>(key)) : undefined;
    },
    async set<T>(key: string, value: T) {
      if (key === KEYS.crisisBlock) return persistent().set(key, value);
      if (!kept(key)) throw refuse(key);
      await recovering((inner) => inner.set(key, value));
    },
    async setIfAbsent<T>(key: string, value: T) {
      if (key === KEYS.crisisBlock) return persistent().setIfAbsent(key, value);
      if (!kept(key)) throw refuse(key);
      return recovering((inner) => inner.setIfAbsent(key, value));
    },
    async remove(key: string) {
      if (key === KEYS.crisisBlock) return persistent().remove(key);
      if (kept(key)) await recovering((inner) => inner.remove(key));
    },
    async keys() {
      const names = await recovering((inner) => inner.keys());
      return names.filter(kept);
    },
    async clear() {
      await store?.wipeAll();
      await persistent().remove(KEYS.crisisBlock);
    },
  };
}
