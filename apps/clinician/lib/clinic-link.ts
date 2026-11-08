import { ClinicLinkActResultSchema, ClinicLinkTicketSchema, type ClinicLinkActResult, type ClinicLinkMove, type ClinicLinkTicket } from '@mawsool/types';

/** What a response is checked with: a Zod schema, named by the one method used. */
interface Parser<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

/** What a clinic link carries in its URL fragment: the ticket's id and the one-time token, `<id>.<token>`. */
export interface LinkCredential {
  ticketId: string;
  token: string;
}

const FRAGMENT = /^#?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{20,200})$/i;

/** Reads the credential from the address's fragment, or null when it is missing or not shaped like one. */
export function credentialFromFragment(hash: string): LinkCredential | null {
  const match = FRAGMENT.exec(hash);
  return match ? { ticketId: match[1]!, token: match[2]! } : null;
}

/**
 * How a call to the clinic-link routes ended. `invalid` is one outcome for every link that is not live (used, expired, tampered,
 * for another ticket), as the API answers them alike; the page cannot tell them apart and does not try.
 */
export type LinkCall<T> = { status: 'ok'; body: T } | { status: 'invalid' | 'not_found' | 'withdrawn' | 'conflict' | 'failed' };

const BY_HTTP_STATUS: Record<number, 'invalid' | 'not_found' | 'withdrawn' | 'conflict'> = { 401: 'invalid', 404: 'not_found', 410: 'withdrawn', 409: 'conflict' };

async function post<T>(fetchFn: typeof fetch, apiUrl: string, path: string, body: object, schema: Parser<T>): Promise<LinkCall<T>> {
  let response: Response;
  try {
    // The credential goes in the body, never the URL, so no request line or log holds it. No cookie and no header carries a session.
    response = await fetchFn(`${apiUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), credentials: 'omit', signal: AbortSignal.timeout(10_000) });
  } catch {
    return { status: 'failed' };
  }
  const refused = BY_HTTP_STATUS[response.status];
  if (refused) return { status: refused };
  if (!response.ok) return { status: 'failed' };
  const parsed = schema.safeParse(await response.json().catch(() => null));
  return parsed.success ? { status: 'ok', body: parsed.data } : { status: 'failed' };
}

/** Asks what the link shows: the ticket's code, tier, state, deadline and the moves open to the clinic. Writes nothing. */
export const openLink = (fetchFn: typeof fetch, apiUrl: string, credential: LinkCredential): Promise<LinkCall<ClinicLinkTicket>> =>
  post(fetchFn, apiUrl, '/clinic-link/open', credential, ClinicLinkTicketSchema);

/** Makes one move with the link. The link is spent by it. */
export const actOnLink = (fetchFn: typeof fetch, apiUrl: string, credential: LinkCredential, to: ClinicLinkMove): Promise<LinkCall<ClinicLinkActResult>> =>
  post(fetchFn, apiUrl, '/clinic-link/act', { ...credential, to }, ClinicLinkActResultSchema);
