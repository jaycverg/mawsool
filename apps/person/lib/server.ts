import type { Locale } from '@mawsool/types';
import { loadDeviceIdentity, loadOrCreateIdentity, personAuthorization, registerDevice, type DeviceIdentity, type RandomSource, type RegistrationResult, type StorageAdapter } from '@mawsool/ui';
import { KEYS } from './keys';
import { within } from './within';

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
export type CallResult<T> =
  | { ok: true; status: number; body: T }
  | {
      ok: false;
      reason: 'offline' | 'rejected' | 'not_registered';
      status: number | null;
      /** The API's error code on a refusal, when it sent one. */
      error?: string | null;
    };

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

/** How long the registration of the phone, and then the call itself, may each take before the call ends as a failure (`offline`, or `not_registered` for the registration). */
export const SERVER_CALL_PATIENCE_MS = 10_000;

/**
 * Registers the phone unless this page load already has. The registration has the same limit as the call it comes before: without it a server
 * that accepts the connection and never answers would hold a choice send (and the mark that brackets it) for as long as the browser waits.
 * A registration that runs out of time is a failed one, so nothing the call was to send is sent.
 */
async function ensureRegistered(deps: ServerDeps, identity: DeviceIdentity): Promise<boolean> {
  if (registered.get(deps.storage) === identity.id) return true;
  const signal = AbortSignal.timeout(SERVER_CALL_PATIENCE_MS);
  const result = await within<RegistrationResult>(
    registerDevice({ fetch: (url, init) => deps.fetch(url, { ...init, signal }), apiUrl: deps.apiUrl, identity, locale: deps.locale }),
    SERVER_CALL_PATIENCE_MS,
    'failed',
  );
  if (result === 'registered' || result === 'already_registered') {
    registered.set(deps.storage, identity.id);
    // The person's own action has registered the phone: the server knows it again, so the background reads that stopped at a 401 may resume.
    await deps.storage.remove(KEYS.serverForgotPhone).catch(() => undefined);
    return true;
  }
  return false;
}

/** Forgets that the device registered, for a test or after the identity is wiped. */
export function forgetRegistration(storage: StorageAdapter): void {
  registered.delete(storage);
}

/**
 * One authenticated call to the Ticket API. The device registers first if it has not yet, and every call has a ten second limit.
 *
 * A 401 on a registered phone means the server no longer knows this person (a demo reset, or a database that was
 * rebuilt), not that the phone did anything wrong. The phone then registers itself again with the same id and secret,
 * which the server accepts for an id it does not hold, and repeats the call once. Asking again is safe: the call was
 * refused before it did anything. A second 401 is reported as it is, so a refusal that is real cannot loop.
 */
export async function callServer<T>(deps: ServerDeps, method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<CallResult<T>> {
  const first = await callOnce<T>(deps, method, path, body);
  if (first.ok || first.reason !== 'rejected' || first.status !== 401) return first;
  forgetRegistration(deps.storage);
  return callOnce<T>(deps, method, path, body);
}

/**
 * One read made by the app on its own, with no person acting: it uses the credential the phone already holds and nothing
 * else. It never makes an identity, never registers the device and never registers it again, so a phone the server has
 * forgotten is not quietly made a new person by a call nobody asked for. A 401 comes back as it is (`rejected`, status 401)
 * and the caller changes nothing. A call the person takes themselves uses `callServer`.
 */
export async function callServerInBackground<T>(deps: ServerDeps, path: string): Promise<CallResult<T>> {
  return callOnce<T>(deps, 'GET', path, undefined, { register: false });
}

async function callOnce<T>(deps: ServerDeps, method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown, options: { register: boolean } = { register: true }): Promise<CallResult<T>> {
  let identity: DeviceIdentity | null;
  try {
    identity = options.register ? await loadOrCreateIdentity(deps.storage, deps.random) : await loadDeviceIdentity(deps.storage);
  } catch {
    // The phone's own store would not give up or keep the device secret: nothing can be asked of the server.
    return { ok: false, reason: 'not_registered', status: null };
  }
  if (identity === null) return { ok: false, reason: 'not_registered', status: null };
  if (options.register && !(await ensureRegistered(deps, identity))) return { ok: false, reason: 'not_registered', status: null };
  let response: Response;
  try {
    response = await deps.fetch(`${deps.apiUrl}${path}`, {
      method,
      headers: { authorization: personAuthorization(identity), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(SERVER_CALL_PATIENCE_MS),
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
  if (!response.ok) {
    const code = (parsed as { error?: unknown } | null)?.error;
    return { ok: false, reason: 'rejected', status: response.status, ...(typeof code === 'string' ? { error: code } : {}) };
  }
  return { ok: true, status: response.status, body: parsed as T };
}
