/**
 * A small marker that lives as long as the browser tab, and is readable at once, with no await. The person app
 * keeps its crisis block in one as well as in the encrypted store, so a store that refuses or hangs cannot lose the
 * block: the mark is set before anything asynchronous happens, and it survives a full page navigation, Back and a
 * reload in the same tab. What it holds is chosen by the caller and is meant to be small and plain.
 */
export interface TabMarkAdapter<T> {
  /** The mark, or null when there is none. */
  get(): T | null;
  /** Sets the mark, or clears it with null. */
  set(value: T | null): void;
}

type SessionLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/**
 * Web version, over `sessionStorage` (pass `undefined` where it does not exist or is blocked). It also keeps the
 * value in memory, so a browser that refuses `sessionStorage` still holds the mark for client-side navigation.
 * `isValid` guards what comes back from storage: anything else reads as no mark. Every storage access is guarded,
 * because reading the property can itself throw.
 */
export function createTabMark<T>(session: SessionLike | undefined, key: string, isValid: (value: unknown) => value is T): TabMarkAdapter<T> {
  let memory: T | null = null;
  return {
    get() {
      if (memory !== null) return memory;
      try {
        const stored = session?.getItem(key);
        if (!stored) return null;
        const parsed: unknown = JSON.parse(stored);
        return isValid(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },
    set(value) {
      memory = value;
      try {
        if (value === null) session?.removeItem(key);
        else session?.setItem(key, JSON.stringify(value));
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
