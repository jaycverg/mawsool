import { createTabMark, safeSessionStorage, type StorageAdapter } from '@mawsool/ui';
import { KEYS } from './keys';

/**
 * Anonymous mode: a session that makes no request to the server at all and keeps nothing on one. It lasts as long as the
 * browser tab, so the mark that says "this tab is anonymous" lives in the tab's `sessionStorage` (the same place, and for the
 * same reason, as the crisis mark): it survives a reload and navigation in the tab and goes when the tab closes.
 */
const MARK_KEY = 'mawsool.anonymous';
const isMark = (value: unknown): value is true => value === true;
const mark = createTabMark<true>(safeSessionStorage(), MARK_KEY, isMark);

/** Whether this tab is in an anonymous session. Synchronous, so a guard can ask it before any request. */
export function isAnonymous(): boolean {
  return mark.get() === true;
}

/** Begins an anonymous session in this tab. The caller reloads the page so every screen starts from the anonymous store. */
export function startAnonymousSession(): void {
  mark.set(true);
}

/**
 * Ends the anonymous session in this tab and removes what it kept. The check-ins and results taken in it are gone; the crisis block
 * (kept on purpose, see `createAnonymousStorage`) is left to be resolved like any other. The caller reloads the page.
 */
export function endAnonymousSession(): void {
  wipeAnonymousData();
  mark.set(null);
}

/** The prefix every value of an anonymous session has in `sessionStorage`. */
const SESSION_PREFIX = 'mawsool.anon:';

/**
 * What an anonymous session keeps for the tab: the check-ins taken in it, answers included. This is deliberate, and the
 * second place the app holds something in plain text: an encrypted store would have to outlive the tab to be worth its key.
 */
export const ANONYMOUS_KEPT_KEYS: readonly string[] = [KEYS.screenings];

/** Removes every value an anonymous session kept in the tab. */
export function wipeAnonymousData(session: Pick<Storage, 'length' | 'key' | 'removeItem'> | undefined = safeSessionStorage()): void {
  if (!session) return;
  try {
    const names: string[] = [];
    for (let index = 0; index < session.length; index += 1) {
      const name = session.key(index);
      if (name?.startsWith(SESSION_PREFIX)) names.push(name);
    }
    for (const name of names) session.removeItem(name);
  } catch {
    // The browser refused: nothing was kept that this could reach.
  }
}

/**
 * The store an anonymous session reads and writes. It is not the device's encrypted store:
 *
 *  - the check-ins (`screenings`) are kept for the tab only, in `sessionStorage`, so they survive moving between screens (each
 *    screen is its own page load) and are gone when the tab closes or the session is left;
 *  - the crisis block goes to the device's own store as it does outside an anonymous session, because a person in a crisis who
 *    closes the tab must still find the help screen next time. It holds a trigger name and times and no answer or score, and it
 *    never reaches a server from an anonymous session (see `anonymous` on the crisis record);
 *  - nothing else is kept. A write under any other key (the device identity, the server footprint, the crisis queue, a ticket, the
 *    directory) is refused, so a path that was missed cannot leave a trace of a server relationship.
 */
export function createAnonymousStorage(persistent: () => StorageAdapter, session: Storage | undefined = safeSessionStorage()): StorageAdapter {
  const memory = new Map<string, string>();
  const kept = (key: string) => ANONYMOUS_KEPT_KEYS.includes(key);
  const nameOf = (key: string) => `${SESSION_PREFIX}${key}`;
  const read = (key: string): string | undefined => {
    try {
      return session?.getItem(nameOf(key)) ?? memory.get(key);
    } catch {
      return memory.get(key);
    }
  };
  const write = (key: string, text: string): void => {
    memory.set(key, text);
    try {
      session?.setItem(nameOf(key), text);
    } catch {
      // Memory still holds it for this page load.
    }
  };
  const refuse = (key: string) => new Error(`An anonymous session keeps nothing under "${key}"`);
  const parse = <T>(text: string | undefined): T | undefined => (text === undefined ? undefined : (JSON.parse(text) as T));

  return {
    async get<T>(key: string) {
      if (key === KEYS.crisisBlock) return persistent().get<T>(key);
      return kept(key) ? parse<T>(read(key)) : undefined;
    },
    async set<T>(key: string, value: T) {
      if (key === KEYS.crisisBlock) return persistent().set(key, value);
      if (!kept(key)) throw refuse(key);
      write(key, JSON.stringify(value));
    },
    async setIfAbsent<T>(key: string, value: T) {
      if (key === KEYS.crisisBlock) return persistent().setIfAbsent(key, value);
      if (!kept(key)) throw refuse(key);
      const existing = read(key);
      if (existing !== undefined) return parse<T>(existing) as T;
      write(key, JSON.stringify(value));
      return value;
    },
    async remove(key: string) {
      if (key === KEYS.crisisBlock) return persistent().remove(key);
      memory.delete(key);
      try {
        session?.removeItem(nameOf(key));
      } catch {
        // Nothing was kept that this could reach.
      }
    },
    async keys() {
      return ANONYMOUS_KEPT_KEYS.filter((key) => read(key) !== undefined);
    },
    async clear() {
      memory.clear();
      wipeAnonymousData(session);
      await persistent().remove(KEYS.crisisBlock);
    },
  };
}
