/**
 * Where the person app keeps data on the device. The web implementation uses IndexedDB; a native wrapper swaps
 * in secure storage behind the same interface. Encryption sits above this adapter, not in it.
 */
export interface StorageAdapter {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  /**
   * Stores `value` only if nothing is stored under `key`, and returns whatever is stored afterwards: the existing
   * value, or `value`. It is atomic, so two callers racing on a fresh key both get the same stored value.
   */
  setIfAbsent<T>(key: string, value: T): Promise<T>;
  remove(key: string): Promise<void>;
  keys(): Promise<string[]>;
  /** Removes everything this adapter stored. */
  clear(): Promise<void>;
}

export interface IndexedDbStorageOptions {
  indexedDB: IDBFactory;
  dbName?: string;
  storeName?: string;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function open({ indexedDB, dbName = 'mawsool', storeName = 'kv' }: IndexedDbStorageOptions): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open(dbName, 1);
    opening.onupgradeneeded = () => {
      if (!opening.result.objectStoreNames.contains(storeName)) opening.result.createObjectStore(storeName);
    };
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error ?? new Error('IndexedDB could not be opened'));
    opening.onblocked = () => reject(new Error('IndexedDB open was blocked'));
  });
}

/** A key-value store in IndexedDB. Values are stored with the structured clone algorithm. */
export function createIndexedDbStorage(options: IndexedDbStorageOptions): StorageAdapter {
  const storeName = options.storeName ?? 'kv';
  let connection: Promise<IDBDatabase> | null = null;
  const db = () => (connection ??= open(options));
  const store = async (mode: IDBTransactionMode) => (await db()).transaction(storeName, mode).objectStore(storeName);

  return {
    async get<T>(key: string) {
      return (await request((await store('readonly')).get(key))) as T | undefined;
    },
    async set<T>(key: string, value: T) {
      await request((await store('readwrite')).put(value, key));
    },
    async setIfAbsent<T>(key: string, value: T) {
      // One readwrite transaction: IndexedDB runs these one after another, so the second racer sees the first's write.
      const tx = (await db()).transaction(storeName, 'readwrite');
      const objectStore = tx.objectStore(storeName);
      return new Promise<T>((resolve, reject) => {
        let stored = value;
        const existing = objectStore.get(key);
        existing.onsuccess = () => {
          if (existing.result !== undefined) stored = existing.result as T;
          else objectStore.add(value, key);
        };
        tx.oncomplete = () => resolve(stored);
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
      });
    },
    async remove(key) {
      await request((await store('readwrite')).delete(key));
    },
    async keys() {
      return (await request((await store('readonly')).getAllKeys())).map(String);
    },
    async clear() {
      await request((await store('readwrite')).clear());
    },
  };
}
