/**
 * A single on/off marker that lives as long as the browser tab, and is readable at once. The person app keeps a
 * crisis block in it as well as in the encrypted store, so a store that refuses or hangs cannot lose the block: the
 * flag is set before anything asynchronous happens, and it survives a full page navigation, Back and a reload in
 * the same tab. It holds a bare "on", no content.
 */
export interface TabFlagAdapter {
  get(): boolean;
  set(on: boolean): void;
}

type SessionLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/**
 * Web version, over `sessionStorage` (pass `undefined` where it does not exist or is blocked). It also keeps the
 * value in memory, so a browser that refuses `sessionStorage` still holds the flag for client-side navigation.
 * Every storage access is guarded: reading the property can itself throw.
 */
export function createTabFlag(session: SessionLike | undefined, key: string): TabFlagAdapter {
  let memory = false;
  return {
    get() {
      if (memory) return true;
      try {
        return session?.getItem(key) === '1';
      } catch {
        return false;
      }
    },
    set(on) {
      memory = on;
      try {
        if (on) session?.setItem(key, '1');
        else session?.removeItem(key);
      } catch {
        // Memory still holds it for this page-load.
      }
    },
  };
}

/** `window.sessionStorage`, or undefined when the browser blocks it. */
export function safeSessionStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.sessionStorage;
  } catch {
    return undefined;
  }
}
