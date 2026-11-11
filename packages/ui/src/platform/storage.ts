/**
 * Where the person app keeps data on the device. The web implementation uses IndexedDB; a native wrapper swaps
 * in secure storage behind the same interface. Encryption sits above this adapter, not in it.
 */
export interface StorageAdapter {
  get<T>(key: string): Promise<T | undefined>;
  /**
   * Resolves once the value is committed to the store, not when the write was merely accepted: a write that is later
   * rolled back (quota, a closing database) rejects. Revoke and delete rely on this to know a record is really gone.
   */
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
  /** Called when this connection is closed because the database is being deleted or changed from elsewhere, so a caller holding state derived from its contents (a cached key) can drop it. */
  onVersionChange?: () => void;
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

/** Resolves when the transaction has committed, and rejects if it fails or is aborted, whatever its requests said. */
function committed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/** Runs one write in its own transaction and waits for the commit. */
async function write(db: () => Promise<IDBDatabase>, storeName: string, operation: (store: IDBObjectStore) => IDBRequest): Promise<void> {
  const tx = (await db()).transaction(storeName, 'readwrite');
  const done = committed(tx);
  operation(tx.objectStore(storeName));
  await done;
}

/** A key-value store in IndexedDB. Values are stored with the structured clone algorithm. */
export function createIndexedDbStorage(options: IndexedDbStorageOptions): StorageAdapter {
  const storeName = options.storeName ?? 'kv';
  let connection: Promise<IDBDatabase> | null = null;
  // When another connection (or this page's own delete request) asks to change or delete the database, this one closes and is
  // opened again by the next call, so a delete is never left waiting on an idle connection.
  const db = () =>
    (connection ??= open(options).then((opened) => {
      opened.onversionchange = () => {
        opened.close();
        connection = null;
        options.onVersionChange?.();
      };
      return opened;
    }));
  const store = async (mode: IDBTransactionMode) => (await db()).transaction(storeName, mode).objectStore(storeName);

  return {
    async get<T>(key: string) {
      return (await request((await store('readonly')).get(key))) as T | undefined;
    },
    set: (key, value) => write(db, storeName, (store) => store.put(value, key)),
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
    remove: (key) => write(db, storeName, (store) => store.delete(key)),
    async keys() {
      return (await request((await store('readonly')).getAllKeys())).map(String);
    },
    clear: () => write(db, storeName, (store) => store.clear()),
  };
}

/** What `deleteIndexedDb` reports: the browser deleted the database, or something still holds a connection to it and the deletion is only queued. */
export type IndexedDbDeletion = 'deleted' | 'blocked';

/**
 * Deletes the whole database `dbName`, every record in it. Connections that are open to it, in this page or another, are asked to
 * close first. Resolves `'deleted'` once the browser has deleted it; rejects if it could not. Resolves `'blocked'`, without waiting for
 * the last connection to close, if something holds a connection and ignores the request: the browser finishes the deletion when it
 * does, but the database still exists now, so a caller that keeps a record of it must keep that record.
 */
export function deleteIndexedDb(factory: IDBFactory, dbName: string): Promise<IndexedDbDeletion> {
  return new Promise((resolve, reject) => {
    const deleting = factory.deleteDatabase(dbName);
    deleting.onsuccess = () => resolve('deleted');
    deleting.onerror = () => reject(deleting.error ?? new Error('IndexedDB could not be deleted'));
    deleting.onblocked = () => resolve('blocked');
  });
}
