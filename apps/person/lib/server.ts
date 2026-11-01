import type { Locale } from '@mawsool/types';
import { loadOrCreateIdentity, personAuthorization, registerDevice, type DeviceIdentity, type RandomSource, type StorageAdapter } from '@mawsool/ui';
import { KEYS } from './keys';

export interface ServerDeps {
  storage: StorageAdapter;
  fetch: typeof fetch;
  apiUrl: string;
  locale: Locale;
  random: RandomSource;
}

/**
 * How a call to the Ticket API ended. `offline` is a network failure or a server error (worth retrying), `rejected` is
 * a 4xx the person can do nothing about by retrying, with its status, and `not_registered` is a device the server does
 * not know and could not register.
 */
export type CallResult<T> = { ok: true; status: number; body: T } | { ok: false; reason: 'offline' | 'rejected' | 'not_registered'; status: number | null };

const registered = new WeakMap<StorageAdapter, string>();

/**
 * Notes that this phone is about to hand the server something it will hold (a ticket, a draft, the equity buckets).
 * It is written before the call, so a call that fails half way still counts: "Delete everything" must then reach the
 * server before it wipes the only secret that can ask for the data to be removed.
 */
export async function markServerFootprint(storage: StorageAdapter, now: () => Date): Promise<void> {
  if ((await storage.get<unknown>(KEYS.footprint)) === undefined) await storage.set(KEYS.footprint, { since: now().toISOString() });
}

export async function hasServerFootprint(storage: StorageAdapter): Promise<boolean> {
  return (await storage.get<unknown>(KEYS.footprint)) !== undefined;
}

async function ensureRegistered(deps: ServerDeps, identity: DeviceIdentity): Promise<boolean> {
  if (registered.get(deps.storage) === identity.id) return true;
  const result = await registerDevice({ fetch: deps.fetch, apiUrl: deps.apiUrl, identity, locale: deps.locale });
  if (result === 'registered' || result === 'already_registered') {
    registered.set(deps.storage, identity.id);
    return true;
  }
  return false;
}

/** Forgets that the device registered, for a test or after the identity is wiped. */
export function forgetRegistration(storage: StorageAdapter): void {
  registered.delete(storage);
}

/** One authenticated call to the Ticket API. The device registers first if it has not yet, and every call has a ten second limit. */
export async function callServer<T>(deps: ServerDeps, method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<CallResult<T>> {
  let identity: DeviceIdentity;
  try {
    identity = await loadOrCreateIdentity(deps.storage, deps.random);
  } catch {
    // The phone's own store would not give up or keep the device secret: nothing can be asked of the server.
    return { ok: false, reason: 'not_registered', status: null };
  }
  if (!(await ensureRegistered(deps, identity))) return { ok: false, reason: 'not_registered', status: null };
  let response: Response;
  try {
    response = await deps.fetch(`${deps.apiUrl}${path}`, {
      method,
      headers: { authorization: personAuthorization(identity), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { ok: false, reason: 'offline', status: null };
  }
  if (response.status >= 500) return { ok: false, reason: 'offline', status: response.status };
  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    // An empty or unreadable body: the status still says what happened.
  }
  if (!response.ok) return { ok: false, reason: 'rejected', status: response.status };
  return { ok: true, status: response.status, body: parsed as T };
}
