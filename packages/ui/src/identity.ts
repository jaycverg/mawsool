import type { Locale } from '@mawsool/types';
import type { StorageAdapter } from './platform/storage';

/** A device's pseudonymous identity. No name, email, Emirates ID or phone is involved. */
export interface DeviceIdentity {
  /** Random UUID. Becomes the person id on the server. */
  id: string;
  /** 32 random bytes, base64url (43 characters). The server keeps only its SHA-256. */
  secret: string;
}

/** The parts of the Web Crypto API this needs, so tests can supply their own. */
export interface RandomSource {
  randomUUID(): string;
  getRandomValues<T extends ArrayBufferView>(array: T): T;
}

const STORAGE_KEY = 'identity';

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/** Generates a fresh identity. Needs no network. */
export function createDeviceIdentity(random: RandomSource): DeviceIdentity {
  return { id: random.randomUUID(), secret: base64Url(random.getRandomValues(new Uint8Array(32))) };
}

/**
 * Returns the identity stored on this device, creating and storing one on first run. Works fully offline.
 * Concurrent callers on a fresh device all get the one identity that was stored first: a loser's identity would
 * otherwise own tickets nobody could revoke.
 */
export async function loadOrCreateIdentity(storage: StorageAdapter, random: RandomSource): Promise<DeviceIdentity> {
  return storage.setIfAbsent(STORAGE_KEY, createDeviceIdentity(random));
}

/** The `Authorization` header value for person routes. */
export function personAuthorization(identity: DeviceIdentity): string {
  return `Bearer ${identity.id}.${identity.secret}`;
}

export type RegistrationResult = 'registered' | 'already_registered' | 'conflict' | 'failed';

/**
 * Registers the device with the server. The person app calls this at its first server write, not on first run,
 * so check-in needs no network. `failed` covers every network or server error, so the caller can try again at
 * the next write; `conflict` means the server already holds this id with a different secret.
 */
export async function registerDevice(options: {
  fetch: typeof fetch;
  apiUrl: string;
  identity: DeviceIdentity;
  locale: Locale;
}): Promise<RegistrationResult> {
  const { identity, locale } = options;
  try {
    const response = await options.fetch(`${options.apiUrl}/persons`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: identity.id, secret: identity.secret, locale }),
    });
    if (response.status === 201) return 'registered';
    if (response.status === 200) return 'already_registered';
    if (response.status === 409) return 'conflict';
    return 'failed';
  } catch {
    return 'failed';
  }
}
