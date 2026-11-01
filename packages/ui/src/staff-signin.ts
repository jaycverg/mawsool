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
