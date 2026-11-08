import { createEncryptedStorage, createIndexedDbStorage, createTabMark, deleteIndexedDb, safeSessionStorage, type CryptoLike, type StorageAdapter } from '@mawsool/ui';
import { KEYS } from './keys';
import { within } from './within';

/**
 * Anonymous mode: a session that makes no request to the server at all and keeps nothing on one. It lasts as long as the
 * browser tab. The tab holds one small plain-text note for it, `{ session }`: a random id that says "this tab is anonymous" and
 * which session the anonymous store belongs to. It holds no answer, score, result or person id, and goes when the tab closes,
 * the session is left, or the tab is wiped. It survives a reload and navigation in the tab (the same place, and for the same
 * reason, as the crisis mark).
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
 * crisis block (kept on purpose, see `createAnonymousStorage`) is left to be resolved like any other. If the store cannot be
 * deleted right now the session still ends, and the next start of the app in any tab that is not this session deletes it. The
 * caller reloads the page.
 */
export async function endAnonymousSession(store: AnonymousStore | null = anonymousStore()): Promise<void> {
  mark.set(null);
  if (store) await within(store.wipe(), WIPE_PATIENCE_MS, undefined);
}

/** The IndexedDB database an anonymous session keeps its check-ins in: apart from the device's own, so deleting it touches nothing else. */
export const ANONYMOUS_DB = 'mawsool-anon';

/** The one record of the database that is not encrypted: which session owns it. */
const OWNER_KEY = 'owner';

/**
 * What an anonymous session keeps for the tab: the check-ins taken in it, answers included, as AES-GCM ciphertext in a database
 * of their own, under a key that cannot be exported and lives in that same database. Deleting the database deletes both.
 */
export const ANONYMOUS_KEPT_KEYS: readonly string[] = [KEYS.screenings];

/** The parts of the browser the anonymous store needs, so tests can supply their own. */
export interface AnonymousEnv {
  indexedDB: IDBFactory;
  crypto: CryptoLike;
}

/** The browser's own, or null where there is no IndexedDB to keep anything in. */
function browserEnv(): AnonymousEnv | null {
  try {
    return typeof window === 'undefined' || !window.indexedDB ? null : { indexedDB: window.indexedDB, crypto: window.crypto };
  } catch {
    return null;
  }
}

/** The encrypted database of an anonymous session, and the three things that happen to it. */
export interface AnonymousStore {
  /**
   * The encrypted store, once it belongs to this tab's session: a database left by another session (a closed tab, an
   * earlier session in this one) is deleted first. Memoised for the page load, and tried again after a failure.
   */
  open(): Promise<StorageAdapter>;
  /** Start of the app: in an anonymous tab, makes the store this session's; in any other tab, deletes whatever an anonymous session left. */
  reconcile(): Promise<void>;
  /** Deletes the database: every ciphertext and the key. The next `open()` starts a new one. */
  wipe(): Promise<void>;
}

/**
 * The anonymous session's encrypted database. `session` says which tab session is asking (null for a tab that is not
 * anonymous, which owns nothing).
 */
export function createAnonymousStore(env: AnonymousEnv, session: () => string | null = anonymousSessionId): AnonymousStore {
  let claim: Promise<StorageAdapter> | null = null;
  let raw: StorageAdapter | null = null;
  const rawStore = (): StorageAdapter => (raw ??= createIndexedDbStorage({ indexedDB: env.indexedDB, dbName: ANONYMOUS_DB }));

  async function wipe(): Promise<void> {
    claim = null;
    await deleteIndexedDb(env.indexedDB, ANONYMOUS_DB);
  }

  async function makeOwned(id: string): Promise<StorageAdapter> {
    const owner = await rawStore().get<string>(OWNER_KEY);
    if (owner !== undefined && owner !== id) await deleteIndexedDb(env.indexedDB, ANONYMOUS_DB);
    if (owner !== id) await rawStore().set(OWNER_KEY, id);
    return createEncryptedStorage(rawStore(), env.crypto);
  }

  function open(): Promise<StorageAdapter> {
    const id = session();
    if (id === null) return Promise.reject(new Error('This tab is not in an anonymous session'));
    claim ??= makeOwned(id).catch((error: unknown) => {
      claim = null; // a failure is not remembered: the next call opens the database again
      raw = null;
      throw error;
    });
    return claim;
  }

  return {
    open,
    reconcile: async () => {
      if (session() === null) await wipe();
      else await open().then(() => undefined);
    },
    wipe,
  };
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
 * Start of the app, in every tab, with nothing awaited and nothing thrown: an anonymous tab makes the store its own session's
 * (deleting a stale one), a tab that is not anonymous deletes whatever an anonymous session left behind. A tab that closed
 * could not run any code, so this is where its store goes.
 */
export function reconcileAnonymousStore(store: AnonymousStore | null = anonymousStore()): Promise<void> {
  if (!store) return Promise.resolve();
  return store.reconcile().catch(() => undefined);
}

/**
 * Deletes what an anonymous session kept on this device, whichever mode the deleting is done in: the encrypted check-ins and
 * their key. Never throws: a browser with nothing to delete has nothing kept.
 */
export async function wipeAnonymousData(store: AnonymousStore | null = anonymousStore()): Promise<void> {
  if (!store) return;
  try {
    await store.wipe();
  } catch {
    // The browser refused to delete it: the next start of the app tries again.
  }
}

/**
 * The store an anonymous session reads and writes. It is not the device's encrypted store:
 *
 *  - the check-ins (`screenings`) are kept for the tab session only, as ciphertext in a database of their own (see
 *    `ANONYMOUS_KEPT_KEYS`), so they survive moving between screens (each screen is its own page load) and are gone when the
 *    session is left, everything is deleted, or the tab session ends;
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

  return {
    async get<T>(key: string) {
      if (key === KEYS.crisisBlock) return persistent().get<T>(key);
      return kept(key) ? (await sealed()).get<T>(key) : undefined;
    },
    async set<T>(key: string, value: T) {
      if (key === KEYS.crisisBlock) return persistent().set(key, value);
      if (!kept(key)) throw refuse(key);
      await (await sealed()).set(key, value);
    },
    async setIfAbsent<T>(key: string, value: T) {
      if (key === KEYS.crisisBlock) return persistent().setIfAbsent(key, value);
      if (!kept(key)) throw refuse(key);
      return (await sealed()).setIfAbsent(key, value);
    },
    async remove(key: string) {
      if (key === KEYS.crisisBlock) return persistent().remove(key);
      if (kept(key)) await (await sealed()).remove(key);
    },
    async keys() {
      const names = await (await sealed()).keys();
      return names.filter(kept);
    },
    async clear() {
      await store?.wipe();
      await persistent().remove(KEYS.crisisBlock);
    },
  };
}
