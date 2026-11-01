import type { StorageAdapter } from './storage';

/** The slot that holds the device key. Names starting with `__` are reserved and never reach callers. */
const KEY_SLOT = '__device-key';
const IV_BYTES = 12;

/** What is stored for a value: a random IV and the AES-GCM ciphertext. */
interface Envelope {
  v: 1;
  iv: Uint8Array<ArrayBuffer>;
  ct: ArrayBuffer;
}

/** Thrown when a stored value cannot be decrypted: the key is gone or changed, or the stored bytes were altered. */
export class StorageDecryptError extends Error {
  constructor(name: string) {
    super(`stored value "${name}" could not be decrypted`);
    this.name = 'StorageDecryptError';
  }
}

/** The parts of Web Crypto this needs, so tests can supply their own. */
export type CryptoLike = Pick<Crypto, 'subtle' | 'getRandomValues'>;

function isEnvelope(value: unknown): value is Envelope {
  const candidate = value as Partial<Envelope> | null;
  return typeof candidate === 'object' && candidate !== null && candidate.v === 1 && candidate.iv instanceof Uint8Array && candidate.ct instanceof ArrayBuffer;
}

function assertNotReserved(name: string): void {
  if (name.startsWith('__')) throw new RangeError(`"${name}" is a reserved storage name`);
}

/**
 * Wraps a storage adapter so every value is encrypted with AES-GCM before it is stored.
 *
 * The key is a 256-bit AES-GCM `CryptoKey` created with `extractable: false` and kept in the same IndexedDB as the
 * data. Scripts on the page can use it but cannot read its bytes, so a copied database file is ciphertext without
 * the browser profile. Each value gets a fresh random IV, and its name is bound in as additional data, so a
 * ciphertext copied under another name fails to decrypt.
 *
 * Values must be JSON-serialisable. Names are stored in the clear; they hold no data. The same interface goes in
 * and comes out, so the identity, the check-ins and everything else sit behind one wrapper.
 */
export function createEncryptedStorage(inner: StorageAdapter, crypto: CryptoLike): StorageAdapter {
  let keyPromise: Promise<CryptoKey> | null = null;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  /** The device key. Created once; callers racing on a fresh device converge on the one that was stored first. */
  const deviceKey = (): Promise<CryptoKey> => {
    keyPromise ??= crypto.subtle
      .generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
      .then((candidate) => inner.setIfAbsent<CryptoKey>(KEY_SLOT, candidate))
      .catch((error: unknown) => {
        keyPromise = null; // a failure must not be remembered: the next call tries again
        throw error;
      });
    return keyPromise;
  };

  async function seal(name: string, value: unknown): Promise<Envelope> {
    const json = JSON.stringify(value);
    if (json === undefined) throw new TypeError(`"${name}" cannot be stored: the value is not serialisable`);
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(name) }, await deviceKey(), encoder.encode(json));
    return { v: 1, iv, ct };
  }

  async function open<T>(name: string, stored: unknown): Promise<T> {
    if (!isEnvelope(stored)) throw new StorageDecryptError(name);
    try {
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: stored.iv, additionalData: encoder.encode(name) }, await deviceKey(), stored.ct);
      return JSON.parse(decoder.decode(plain)) as T;
    } catch {
      throw new StorageDecryptError(name);
    }
  }

  return {
    async get<T>(name: string) {
      assertNotReserved(name);
      const stored = await inner.get<unknown>(name);
      return stored === undefined ? undefined : open<T>(name, stored);
    },
    async set<T>(name: string, value: T) {
      assertNotReserved(name);
      await inner.set(name, await seal(name, value));
    },
    async setIfAbsent<T>(name: string, value: T) {
      assertNotReserved(name);
      return open<T>(name, await inner.setIfAbsent(name, await seal(name, value)));
    },
    async remove(name) {
      assertNotReserved(name);
      await inner.remove(name);
    },
    async keys() {
      return (await inner.keys()).filter((name) => name !== KEY_SLOT);
    },
    async clear() {
      await inner.clear();
      keyPromise = null; // the key went with everything else; the next write makes a new one
    },
  };
}
