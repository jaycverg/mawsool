import { createEncryptedStorage, createIndexedDbStorage, type StorageAdapter } from '@mawsool/ui';

let storage: StorageAdapter | null = null;

/**
 * The device's encrypted store, created on first use. Everything the person app keeps on the phone goes through
 * it: the identity, check-ins, preferences, the crisis block and the offline queue. Browser only.
 */
export function deviceStorage(): StorageAdapter {
  storage ??= createEncryptedStorage(createIndexedDbStorage({ indexedDB: window.indexedDB }), window.crypto);
  return storage;
}
