import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { StorageDecryptError, createEncryptedStorage, createIndexedDbStorage, type CryptoLike, type StorageAdapter } from '../src';

const crypto = globalThis.crypto;

function setup() {
  const raw = createIndexedDbStorage({ indexedDB: new IDBFactory() });
  return { raw, secure: createEncryptedStorage(raw, crypto) };
}

describe('encrypted storage', () => {
  it('stores, reads, lists and removes values like the adapter it wraps', async () => {
    const { secure } = setup();
    expect(await secure.get('a')).toBeUndefined();
    await secure.set('a', { n: 1, list: [1, 2], nested: { ok: true } });
    await secure.set('b', 'two');
    expect(await secure.get('a')).toEqual({ n: 1, list: [1, 2], nested: { ok: true } });
    expect((await secure.keys()).sort()).toEqual(['a', 'b']);
    await secure.remove('a');
    expect(await secure.get('a')).toBeUndefined();
    expect(await secure.keys()).toEqual(['b']);
  });

  it('keeps no plaintext at rest: the stored value is an IV and ciphertext, whatever the content', async () => {
    const { raw, secure } = setup();
    const secret = 'phq9-item9-several-days-0123456789';
    await secure.set('screenings', [{ answers: [0, 0, 0, 0, 0, 0, 0, 0, 1], note: secret }]);
    const stored = await raw.get<{ v: number; iv: Uint8Array; ct: ArrayBuffer }>('screenings');
    expect(Object.keys(stored!).sort()).toEqual(['ct', 'iv', 'v']);
    expect(stored!.iv).toHaveLength(12);
    const bytes = new TextDecoder('latin1').decode(new Uint8Array(stored!.ct));
    expect(bytes).not.toContain(secret);
    expect(bytes).not.toContain('answers');
  });

  it('uses a fresh IV for every write, so equal values do not give equal ciphertext', async () => {
    const { raw, secure } = setup();
    await secure.set('a', 'same');
    await secure.set('b', 'same');
    const a = await raw.get<{ iv: Uint8Array }>('a');
    const b = await raw.get<{ iv: Uint8Array }>('b');
    expect([...a!.iv]).not.toEqual([...b!.iv]);
  });

  it('keeps the key non-extractable, so page scripts can use it but never read its bytes', async () => {
    const { raw, secure } = setup();
    await secure.set('a', 1);
    const key = await raw.get<CryptoKey>('__device-key');
    expect(key?.extractable).toBe(false);
    expect(key?.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
    await expect(crypto.subtle.exportKey('raw', key!)).rejects.toThrow();
  });

  it('never lists the key slot and refuses reserved names', async () => {
    const { secure } = setup();
    await secure.set('a', 1);
    expect(await secure.keys()).toEqual(['a']);
    await expect(secure.get('__device-key')).rejects.toThrow(RangeError);
    await expect(secure.set('__device-key', 1)).rejects.toThrow(RangeError);
    await expect(secure.setIfAbsent('__x', 1)).rejects.toThrow(RangeError);
    await expect(secure.remove('__device-key')).rejects.toThrow(RangeError);
  });

  it('reads its own data after a reload, and a wrapper on another device cannot read it', async () => {
    const factory = new IDBFactory();
    const first = createEncryptedStorage(createIndexedDbStorage({ indexedDB: factory }), crypto);
    await first.set('a', { kept: true });
    const reloaded = createEncryptedStorage(createIndexedDbStorage({ indexedDB: factory }), crypto);
    expect(await reloaded.get('a')).toEqual({ kept: true });

    // A copied data row without the original key: swap in a key from a second, unrelated device.
    const raw = createIndexedDbStorage({ indexedDB: factory });
    const stranger = setup();
    await stranger.secure.set('probe', 1);
    await raw.set('__device-key', await stranger.raw.get('__device-key'));
    await expect(createEncryptedStorage(raw, crypto).get('a')).rejects.toThrow(StorageDecryptError);
  });

  it('fails to decrypt a ciphertext copied under another name', async () => {
    const { raw, secure } = setup();
    await secure.set('first', 'value');
    await raw.set('second', await raw.get('first'));
    await expect(secure.get('second')).rejects.toThrow(StorageDecryptError);
    expect(await secure.get('first')).toBe('value');
  });

  it('fails to decrypt altered bytes, and a stored value that is not ours', async () => {
    const { raw, secure } = setup();
    await secure.set('a', 'value');
    const stored = await raw.get<{ v: 1; iv: Uint8Array; ct: ArrayBuffer }>('a');
    const altered = new Uint8Array(stored!.ct.slice(0));
    altered[0] = altered[0]! ^ 0xff;
    await raw.set('a', { ...stored, ct: altered.buffer });
    await expect(secure.get('a')).rejects.toThrow(StorageDecryptError);
    await raw.set('plain', { id: 'x', secret: 'y' });
    await expect(secure.get('plain')).rejects.toThrow('could not be decrypted');
  });

  it('setIfAbsent keeps the first value and returns it to every racing caller', async () => {
    const { secure } = setup();
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => secure.setIfAbsent('identity', { id: `caller-${i}` })));
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(await secure.get('identity')).toEqual(results[0]);
    expect(await secure.setIfAbsent('identity', { id: 'late' })).toEqual(results[0]);
  });

  it('makes one key even when the first writes race on a fresh device', async () => {
    const { raw, secure } = setup();
    await Promise.all([secure.set('a', 1), secure.set('b', 2), secure.set('c', 3)]);
    expect(await Promise.all([secure.get('a'), secure.get('b'), secure.get('c')])).toEqual([1, 2, 3]);
    expect(await raw.keys()).toContain('__device-key');
  });

  it('adopts the key another wrapper stored first', async () => {
    const factory = new IDBFactory();
    const one = createEncryptedStorage(createIndexedDbStorage({ indexedDB: factory }), crypto);
    const two = createEncryptedStorage(createIndexedDbStorage({ indexedDB: factory }), crypto);
    await Promise.all([one.set('a', 'from one'), two.set('b', 'from two')]);
    expect(await one.get('b')).toBe('from two');
    expect(await two.get('a')).toBe('from one');
  });

  it('clear removes everything including the key, and the next write starts a new key', async () => {
    const { raw, secure } = setup();
    await secure.set('a', 1);
    const before = await raw.get<CryptoKey>('__device-key');
    await secure.clear();
    expect(await raw.keys()).toEqual([]);
    expect(await secure.get('a')).toBeUndefined();
    await secure.set('a', 2);
    expect(await secure.get('a')).toBe(2);
    expect(await raw.get('__device-key')).not.toBe(before);
  });

  it('refuses a value it cannot serialise', async () => {
    const { secure } = setup();
    await expect(secure.set('a', undefined)).rejects.toThrow(TypeError);
  });

  it('does not remember a failed key creation: the next call tries again', async () => {
    const raw = createIndexedDbStorage({ indexedDB: new IDBFactory() });
    let failNext = true;
    const flaky: StorageAdapter = {
      ...raw,
      async setIfAbsent(key, value) {
        if (failNext) {
          failNext = false;
          throw new Error('disk full');
        }
        return raw.setIfAbsent(key, value);
      },
    };
    const secure = createEncryptedStorage(flaky, crypto);
    await expect(secure.set('a', 1)).rejects.toThrow('disk full');
    await secure.set('a', 1);
    expect(await secure.get('a')).toBe(1);
  });

  it('uses only the crypto it is given', async () => {
    const getRandomValues = vi.fn(<T extends ArrayBufferView>(array: T) => crypto.getRandomValues(array));
    const custom: CryptoLike = { subtle: crypto.subtle, getRandomValues: getRandomValues as CryptoLike['getRandomValues'] };
    const secure = createEncryptedStorage(createIndexedDbStorage({ indexedDB: new IDBFactory() }), custom);
    await secure.set('a', 1);
    expect(getRandomValues).toHaveBeenCalledTimes(1);
  });
});
