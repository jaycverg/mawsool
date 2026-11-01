import { SessionSchema, type Session, type StaffRole } from '@mawsool/types';

export const STAFF_SESSION_KEY = 'mawsool.staffSession';

export type SignInResult =
  | { status: 'signed_in'; session: Session }
  /** The link is invalid, expired or already used, or the server could not be reached. */
  | { status: 'failed' }
  /** The link worked but belongs to the other staff app; nothing is kept. */
  | { status: 'wrong_app'; role: StaffRole };

/**
 * Exchanges a sign-in token for a staff session. The token is one-time, so this must run only when the person
 * asks for it, never on page load: a prefetch or a double render would use the link up.
 */
export async function verifySignIn(options: {
  fetch: typeof fetch;
  apiUrl: string;
  token: string;
  /** Roles this app serves. A session for any other role is refused. */
  allowedRoles: readonly StaffRole[];
}): Promise<SignInResult> {
  try {
    const response = await options.fetch(`${options.apiUrl}/auth/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: options.token }),
    });
    if (response.status !== 200) return { status: 'failed' };
    const parsed = SessionSchema.safeParse(await response.json());
    if (!parsed.success) return { status: 'failed' };
    if (!options.allowedRoles.includes(parsed.data.role)) return { status: 'wrong_app', role: parsed.data.role };
    return { status: 'signed_in', session: parsed.data };
  } catch {
    return { status: 'failed' };
  }
}

/** Keeps the session for this browser tab only. Returns false when storage is unavailable. */
export function storeStaffSession(storage: Pick<Storage, 'setItem'> | undefined, session: Session): boolean {
  try {
    if (!storage) return false;
    storage.setItem(STAFF_SESSION_KEY, JSON.stringify(session));
    return true;
  } catch {
    return false;
  }
}

/**
 * The staff session kept in this tab, if there is one that is still valid: well formed and not past its expiry. A
 * stored value that does not parse, or has expired, is treated as no session. The server decides every request anyway;
 * this only spares a screen from asking with a token it already knows is dead.
 */
export function readStaffSession(storage: Pick<Storage, 'getItem'> | undefined, now: Date): Session | null {
  try {
    const raw = storage?.getItem(STAFF_SESSION_KEY);
    if (!raw) return null;
    const parsed = SessionSchema.safeParse(JSON.parse(raw));
    return parsed.success && Date.parse(parsed.data.expiresAt) > now.getTime() ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Forgets the session in this tab. */
export function clearStaffSession(storage: Pick<Storage, 'removeItem'> | undefined): void {
  try {
    storage?.removeItem(STAFF_SESSION_KEY);
  } catch {
    // Storage that cannot be reached holds no session this page could have read either.
  }
}

/** How a staff request ended. `unauthorized` means the session is no longer good and the person must sign in again. */
export type StaffCall<T> = { status: 'ok'; httpStatus: number; body: T } | { status: 'unauthorized' } | { status: 'refused'; httpStatus: number; error: string | null } | { status: 'unreachable' };

/**
 * One call to the Ticket API with a staff session. A 401 is `unauthorized` (the caller drops the session and goes to
 * sign-in), any other failure answer is `refused` with the API's error code (404 not found, 410 withdrawn, 409 conflict,
 * ...), and a network failure is `unreachable`.
 */
export async function staffCall<T = unknown>(options: {
  fetch: typeof fetch;
  apiUrl: string;
  session: Pick<Session, 'sessionToken'>;
  method?: 'GET' | 'POST';
  path: string;
  body?: unknown;
}): Promise<StaffCall<T>> {
  try {
    const response = await options.fetch(`${options.apiUrl}${options.path}`, {
      method: options.method ?? 'GET',
      headers: { authorization: `Bearer ${options.session.sessionToken}`, ...(options.body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    if (response.status === 401) return { status: 'unauthorized' };
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) return { status: 'refused', httpStatus: response.status, error: typeof (body as { error?: unknown } | null)?.error === 'string' ? (body as { error: string }).error : null };
    return { status: 'ok', httpStatus: response.status, body: body as T };
  } catch {
    return { status: 'unreachable' };
  }
}

/**
 * Asks the API to issue a sign-in link for an address. The API answers 202 whether or not the address belongs to a
 * staff user, so `accepted` says nothing about whether the address exists and the page must not either.
 * Anything else, including a network error, is `failed`.
 */
export async function requestSignInLink(options: {
  fetch: typeof fetch;
  apiUrl: string;
  email: string;
}): Promise<'accepted' | 'failed'> {
  try {
    const response = await options.fetch(`${options.apiUrl}/auth/magic-link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: options.email }),
    });
    return response.status === 202 ? 'accepted' : 'failed';
  } catch {
    return 'failed';
  }
}
