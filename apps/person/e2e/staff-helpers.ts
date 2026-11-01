import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { BrowserContext } from '@playwright/test';
import { E2E_INBOUND_KEYS } from '../../api/src/cli/e2e-keys';
import commonAr from '../../../packages/ui/messages/ar.json';
import commonEn from '../../../packages/ui/messages/en.json';
import clinicianAr from '../../clinician/messages/ar.json';
import clinicianEn from '../../clinician/messages/en.json';
import { API, INSPECT, type Locale } from './helpers';

/** The clinician and ops apps of this run. The gate sets both; a run of the person app alone has neither. */
export const CLINIC = process.env.E2E_CLINICIAN_URL ?? 'http://127.0.0.1:3376';
export const OPS = process.env.E2E_OPS_URL ?? 'http://127.0.0.1:3377';

export const FACILITY_A = '00000000-0000-4000-8000-00000000fa01';
export const FACILITY_B = '00000000-0000-4000-8000-00000000fb02';
export const CLINICIAN_A = 'clinician.a@demo.mawsool.test';
export const CLINICIAN_B = 'clinician.b@demo.mawsool.test';
export const OPS_USER = 'ops@demo.mawsool.test';
export const SESSION_KEY = 'mawsool.staffSession';

const CLINICIAN_MESSAGES = { ar: { ...commonAr, ...clinicianAr }, en: { ...commonEn, ...clinicianEn } } as unknown as Record<Locale, Record<string, unknown>>;

/** A message in the clinician app's own message files (and the shared ones), so the tests read the words a clinician sees. */
export function cmsg(locale: Locale, path: string): string {
  const found = path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], CLINICIAN_MESSAGES[locale]);
  if (typeof found !== 'string') throw new Error(`no clinician message ${path} in ${locale}`);
  return found;
}

export interface Reply {
  status: number;
  headers: Headers;
  text: string;
  json: () => any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** One request to the real API, from Node. */
export async function call(method: string, path: string, options: { headers?: Record<string, string>; body?: unknown; raw?: string } = {}): Promise<Reply> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { ...(options.body !== undefined || options.raw !== undefined ? { 'content-type': 'application/json' } : {}), ...options.headers },
    body: options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, text, json: () => JSON.parse(text) };
}

export interface Person {
  id: string;
  headers: { authorization: string };
}

/** A device that has registered through the real route, as the person app's does at its first server write. */
export async function newPerson(): Promise<Person> {
  const id = randomUUID();
  const secret = randomBytes(32).toString('base64url');
  const res = await call('POST', '/persons', { body: { id, secret, locale: 'en' } });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${res.text}`);
  return { id, headers: { authorization: `Bearer ${id}.${secret}` } };
}

export interface StaffSession {
  sessionToken: string;
  expiresAt: string;
  role: 'clinician' | 'ops' | 'admin';
  facilityId: string | null;
}

/** The sign-in link the API logged for an address (read from its log), as the page would receive it by hand. */
export async function loggedLink(email: string): Promise<string | null> {
  const res = await fetch(`${INSPECT}/logged-sign-in-link?to=${encodeURIComponent(email)}`);
  return ((await res.json()) as { link: string | null }).link;
}

/** Asks for a sign-in link for an address, the way the staff sign-in page does. */
export async function requestLink(email: string): Promise<string> {
  const requested = await call('POST', '/auth/magic-link', { body: { email } });
  if (requested.status !== 202) throw new Error(`magic-link failed: ${requested.status}`);
  const link = await loggedLink(email);
  if (!link) throw new Error(`no link was logged for ${email}`);
  return link;
}

/** A staff session obtained through the real sign-in: request, logged link, verify. */
export async function staffSession(email: string): Promise<StaffSession> {
  const token = new URL(await requestLink(email)).searchParams.get('token')!;
  const verified = await call('POST', '/auth/verify', { body: { token } });
  if (verified.status !== 200) throw new Error(`verify failed: ${verified.status} ${verified.text}`);
  return verified.json();
}

export const bearer = (session: Pick<StaffSession, 'sessionToken'>) => ({ authorization: `Bearer ${session.sessionToken}` });

/** Puts a signed-in staff session into the first load of every tab of the context that is on `origin`, as the sign-in page would have left it. */
export async function keepSession(context: BrowserContext, origin: string, session: StaffSession): Promise<void> {
  await context.addInitScript(
    ([target, key, value]) => {
      // Once per tab: a page that clears the session (or never kept it) must not have it put back by the next navigation.
      if (location.origin === target && !sessionStorage.getItem('e2e.session-kept')) {
        sessionStorage.setItem(key as string, value as string);
        sessionStorage.setItem('e2e.session-kept', '1');
      }
    },
    [new URL(origin).origin, SESSION_KEY, JSON.stringify(session)],
  );
}

/** A request body signed as a front door would sign it. This is written out here, from the documented scheme, not imported. */
export function signedRequest(source: 'phc' | 'tamm' | 'school', options: { body?: unknown; raw?: string; key?: string; timestamp?: number; nonce?: string } = {}) {
  const raw = options.raw ?? JSON.stringify(options.body ?? { result: 'positive', screenedAt: new Date().toISOString(), locale: 'en' });
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  const nonce = options.nonce ?? randomBytes(18).toString('base64url');
  const signature = createHmac('sha256', options.key ?? E2E_INBOUND_KEYS[source]).update([source, timestamp, nonce, raw].join('\n')).digest('hex');
  return {
    raw,
    headers: { 'x-mawsool-source': source, 'x-mawsool-timestamp': timestamp, 'x-mawsool-nonce': nonce, 'x-mawsool-signature': signature },
  };
}

export const sendScreen = (signed: ReturnType<typeof signedRequest>, extra: Record<string, string> = {}) => call('POST', '/inbound/screens', { raw: signed.raw, headers: { ...signed.headers, ...extra } });

export interface Receipt {
  inviteId: string;
  code: string;
  claimUrl: string;
  expiresAt: string;
}

/** A front door hands over a positive screen and gets the claim code back. */
export async function handOver(source: 'phc' | 'tamm' | 'school', locale: Locale = 'en'): Promise<Receipt> {
  const res = await sendScreen(signedRequest(source, { body: { result: 'positive', screenedAt: new Date().toISOString(), locale } }));
  if (res.status !== 201) throw new Error(`hand-over failed: ${res.status} ${res.text}`);
  return res.json();
}

export async function inboundCounts(): Promise<{ invites: number; nonces: number }> {
  return (await (await fetch(`${INSPECT}/inbound/counts`)).json()) as { invites: number; nonces: number };
}

/** The first sample service of a tier at a facility, from the public directory. */
export async function serviceAt(facilityId: string, tier: 'gp' | 'specialist' | 'tele' | 'community' = 'gp'): Promise<string> {
  const services = (await call('GET', '/services')).json() as { id: string; tier: string; facilityId: string | null }[];
  const found = services.filter((service) => service.facilityId === facilityId && service.tier === tier).sort((a, b) => a.id.localeCompare(b.id))[0];
  if (!found) throw new Error(`no ${tier} service at ${facilityId}`);
  return found.id;
}

export const FREE_TEXT = 'FREE-TEXT-MARKER-7743';
export const CONDITION = 'CONDITION-MARKER-3319';
export const SUMMARY = 'APPROVED-SUMMARY-MARKER-2288';

const SCORES = [{ instrument: 'phq9', total: 11, band: 'moderate', takenAt: '2026-10-29T08:00:00+04:00' }];
const TRAJECTORY = [
  { instrument: 'gad7', total: 9, band: 'mild', takenAt: '2026-10-08T08:00:00+04:00' },
  { instrument: 'gad7', total: 14, band: 'moderate', takenAt: '2026-10-29T08:00:00+04:00' },
];

export interface TicketOptions {
  serviceId: string;
  consents?: string[];
  approvedSummary?: string | null;
  summaryBuiltFrom?: string[];
  inviteId?: string | null;
  content?: Record<string, unknown>;
}

export interface MadeTicket {
  id: string;
  shortCode: string;
  consents: { id: string; element: string }[];
  source: string;
}

/** A ticket a person sends through the real API, with every kind of content in the request and the elements in `consents` ticked. */
export async function makeTicket(person: Person, options: TicketOptions): Promise<MadeTicket> {
  const res = await call('POST', '/tickets', {
    headers: person.headers,
    body: {
      clientRequestId: randomUUID(),
      serviceId: options.serviceId,
      windowDays: 7,
      language: 'ar',
      consents: options.consents ?? ['ticket', 'scores'],
      content: options.content ?? { scores: SCORES, trajectory: TRAJECTORY, free_text: FREE_TEXT, conditions: [CONDITION], preferences: { language: 'ar', modality: 'in_person' } },
      approvedSummary: options.approvedSummary ?? null,
      summaryRequestId: null,
      summaryBuiltFrom: options.summaryBuiltFrom ?? [],
      inviteId: options.inviteId ?? null,
    },
  });
  if (res.status !== 201) throw new Error(`ticket failed: ${res.status} ${res.text}`);
  return res.json().ticket;
}

export const revokeConsent = (person: Person, ticket: MadeTicket, element: string) =>
  call('DELETE', `/consents/${ticket.consents.find((consent) => consent.element === element)!.id}`, { headers: person.headers });

/** What the real R4 schema says about a bundle the run exported. */
export async function validateBundle(text: string): Promise<{ valid: boolean; errors?: string[] }> {
  const res = await fetch(`${INSPECT}/fhir/validate`, { method: 'POST', body: text });
  return (await res.json()) as { valid: boolean; errors?: string[] };
}
