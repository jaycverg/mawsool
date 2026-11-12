import { type CrisisHandoffReceipt, type CrisisTrigger, type Locale, type PhoneNumber, type Screening, type ScoreEntry } from '@mawsool/types';
import type { StorageAdapter } from '@mawsool/ui';
import { z } from 'zod';
import type { NewId, Now } from './clock';
import type { CrisisRecord } from './crisis';
import type { FlushResult } from './crisis-outbox';
import { KEYS } from './keys';
import { parsePhone } from './reminders';
import { callServer, markServerFootprint, type ServerDeps } from './server';
import { withStoreLock } from './lock';
import { buildContent, EMPTY_SHARING } from './share';
import { within } from './within';

/**
 * What the phone remembers about a hand-off to the crisis line, so the person can stop it: the id the phone made for
 * it, the crisis event it belongs to, and whether the server confirmed it. It holds no score and no number, and it goes
 * with everything else on "Delete everything". `sending` is written before the send, so a reply that was lost still
 * leaves a record to stop from. There is one record per crisis event, kept side by side: a later crisis never hides or
 * overwrites the record of an earlier one.
 */
export const HandoffRecordSchema = z.object({
  handoffId: z.uuid(),
  crisisEventId: z.uuid(),
  state: z.enum(['sending', 'sent']),
  startedAt: z.iso.datetime({ offset: true }),
});
export type HandoffRecord = z.infer<typeof HandoffRecordSchema>;

/** Every hand-off record on the phone, oldest first. Entries that do not parse are left out. */
export async function loadHandoffs(storage: StorageAdapter): Promise<HandoffRecord[]> {
  const stored = await storage.get<unknown>(KEYS.crisisHandoff);
  if (!Array.isArray(stored)) return [];
  return stored.flatMap((entry) => {
    const parsed = HandoffRecordSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

/** The record for one crisis event, or null. */
export function handoffFor(records: readonly HandoffRecord[], crisisEventId: string | null): HandoffRecord | null {
  return crisisEventId === null ? null : (records.find((record) => record.crisisEventId === crisisEventId) ?? null);
}

/**
 * The crisis the screen may offer a hand-off for: the open crisis's own event, or null when none is open or when it opened in an
 * anonymous session, whose crisis is never handed over (whatever session the phone is in when the record is read).
 */
export function handoffOffer(record: CrisisRecord | null): { eventId: string; trigger: CrisisTrigger } | null {
  return record?.blocked && record.event && !record.anonymous ? { eventId: record.event.id, trigger: record.event.trigger } : null;
}

/**
 * What the crisis screen shows for the crisis that is open: `sent` once this crisis's note is confirmed, `sending` while
 * its send is unconfirmed (the form stays, so a retry reuses the id), and `offer` otherwise. Another crisis's record never
 * decides it.
 */
export function offerState(records: readonly HandoffRecord[], crisisEventId: string): 'offer' | 'sending' | 'sent' {
  const mine = handoffFor(records, crisisEventId);
  return mine === null ? 'offer' : mine.state;
}

/** Changes the list of records under the store lock, so two writers (a send and a stop) never overwrite each other. */
function changeHandoffs(storage: StorageAdapter, change: (records: HandoffRecord[]) => HandoffRecord[]): Promise<void> {
  return withStoreLock(storage, async () => {
    await storage.set(KEYS.crisisHandoff, change(await loadHandoffs(storage)));
  });
}

/** What would be sent, as the screen shows it before the person agrees. */
export interface HandoffPreview {
  language: Locale;
  trigger: CrisisTrigger;
  scores: ScoreEntry[];
  callbackNumber: PhoneNumber | null;
}

/** The totals of the latest finished check-ins (never item answers), the language, why the screen opened and the number if one was typed. */
export function buildHandoffPreview(input: { screenings: readonly Screening[]; language: Locale; trigger: CrisisTrigger; callback: PhoneNumber | null }): HandoffPreview {
  return { language: input.language, trigger: input.trigger, scores: buildContent(input.screenings, {}, EMPTY_SHARING).scores ?? [], callbackNumber: input.callback };
}

/** How long the hand-off waits on the phone's own store for one step before it gives up. The crisis screen never waits on this. */
export const HANDOFF_STORE_PATIENCE_MS = 2000;
/** How long the hand-off waits on the network (the crisis queue's flush, or the call itself) before it gives up. */
export const HANDOFF_NETWORK_PATIENCE_MS = 15_000;

/** The waits a test shortens; each defaults to the constant above. */
export interface HandoffPatience {
  storeMs?: number;
  networkMs?: number;
}

/**
 * - `sent`: the server holds the hand-off and the consent is recorded.
 * - `offline`: no connection, the server failed, or the network did not answer in time; nothing is known to be stored (a note that may be on its way stays
 *   recorded as `sending`, so it can still be stopped). The crisis screen says so and stays as it is.
 * - `not_ready`: the server does not yet hold the crisis record this belongs to.
 * - `rejected`: the server refused the request for good.
 * - `stopped`: the server says this hand-off was already stopped, so it was not stored. Nothing is offered again.
 * - `invalid_number`: the number typed is not an international number; nothing was sent.
 * - `failed`: the phone could not write its own record, or its store did not answer in time, so nothing was sent.
 */
export type SendOutcome = 'sent' | 'offline' | 'not_ready' | 'stopped' | 'rejected' | 'invalid_number' | 'failed';

export interface SendDeps {
  server: ServerDeps;
  /** Sends the queued crisis events, so the one this hand-off belongs to is on the server first. */
  flush: () => Promise<FlushResult>;
  now: Now;
  newId: NewId;
  patience?: HandoffPatience;
}

/**
 * Hands the short template to the crisis line, once the person has agreed. Online only and optional: it never changes the
 * crisis record or the block, and every failure is an outcome, not an exception. The phone notes that the server may hold
 * something (so "Delete everything" reaches it) and writes its record before the send, then confirms it after.
 *
 * A retry of a send that did not finish reuses the same id, so a reply lost after the server stored the hand-off cannot
 * leave two.
 */
export async function sendHandoff(deps: SendDeps, input: { crisisEventId: string; screenings: readonly Screening[]; language: Locale; trigger: CrisisTrigger; callbackInput: string }): Promise<SendOutcome> {
  const storeMs = deps.patience?.storeMs ?? HANDOFF_STORE_PATIENCE_MS;
  const networkMs = deps.patience?.networkMs ?? HANDOFF_NETWORK_PATIENCE_MS;
  const { storage } = deps.server;
  // A crisis that opened in an anonymous session is never handed over, whatever session this phone is in now: the stored record
  // says so, and this is the second guard behind the screen not offering it. Nothing is read from the server or sent to it.
  // A store that does not answer cannot say, and could not keep the record the send needs first, so nothing is sent.
  const crisis = await within<CrisisRecord | undefined | typeof TIMED_OUT>(storage.get<CrisisRecord>(KEYS.crisisBlock).catch(() => undefined), storeMs, TIMED_OUT);
  if (crisis === TIMED_OUT) return 'failed';
  if (crisis?.anonymous && crisis.event?.id === input.crisisEventId) return 'failed';
  const typed = input.callbackInput.trim();
  const callback = typed === '' ? null : parsePhone(typed);
  if (typed !== '' && !callback) return 'invalid_number';
  const preview = buildHandoffPreview({ screenings: input.screenings, language: input.language, trigger: input.trigger, callback });

  const flushed = await within(deps.flush().catch(() => null), networkMs, null);
  if (flushed === null || flushed.outcome === 'offline' || flushed.outcome === 'conflict') return 'offline';

  const record = await within(recordBeforeSend(deps, input.crisisEventId), storeMs, null);
  if (record === null) return 'failed';

  const sent = await within(callServer<CrisisHandoffReceipt>(deps.server, 'POST', '/me/crisis-handoffs', { handoffId: record.handoffId, crisisEventId: record.crisisEventId, consented: true, ...preview }), networkMs, null);
  // No answer in time: the server may or may not hold the note. The `sending` record stays, so the person can stop it and a retry reuses its id.
  if (sent === null) return 'offline';
  if (!sent.ok) {
    if (sent.reason !== 'rejected') return 'offline';
    // A refusal means nothing was stored, so the record has nothing to stop. If the store will not take the change, the record stays and a stop finds the server has none.
    await within(changeHandoffs(storage, (records) => records.filter((other) => other.handoffId !== record.handoffId)).catch(() => undefined), storeMs, undefined);
    if (sent.status === 409 && sent.error === 'handoff_stopped') return 'stopped';
    return sent.status === 409 ? 'not_ready' : 'rejected';
  }
  // The record stays `sending` if the store will not confirm it, which is enough to stop it from.
  await within(changeHandoffs(storage, (records) => records.map((other) => (other.handoffId === record.handoffId ? { ...other, state: 'sent' as const } : other))).catch(() => undefined), storeMs, undefined);
  return 'sent';
}

/** Returned by `within` in place of a value when a store step did not answer in time. */
const TIMED_OUT = Symbol('timed out');

/**
 * Notes the footprint and writes this crisis's record as `sending`, before anything is sent, reusing the id of this crisis's own
 * unconfirmed record (an earlier crisis's record is left exactly as it is). Null when the phone cannot write it. A call that is
 * given up on by its caller may still finish later; the record it leaves is a `sending` one, which stops and retries handle.
 */
async function recordBeforeSend(deps: SendDeps, crisisEventId: string): Promise<HandoffRecord | null> {
  const { storage } = deps.server;
  try {
    const earlier = handoffFor(await loadHandoffs(storage), crisisEventId);
    const record: HandoffRecord = earlier ?? { handoffId: deps.newId(), crisisEventId, state: 'sending', startedAt: deps.now().toISOString() };
    await markServerFootprint(storage, deps.now);
    await changeHandoffs(storage, (records) => [...records.filter((other) => other.handoffId !== record.handoffId), { ...record, state: 'sending' }]);
    return record;
  } catch {
    return null;
  }
}

export type StopOutcome = 'stopped' | 'offline' | 'failed';

/**
 * Stops one hand-off: the server revokes the consent and deletes what it stored, and only then does the phone drop that one record
 * (the others stay).
 * A hand-off the server no longer has (404) is already stopped. Offline keeps the record, so the person can try again.
 */
export async function stopHandoff(deps: { server: ServerDeps; patience?: HandoffPatience }, record: HandoffRecord): Promise<StopOutcome> {
  const storeMs = deps.patience?.storeMs ?? HANDOFF_STORE_PATIENCE_MS;
  const networkMs = deps.patience?.networkMs ?? HANDOFF_NETWORK_PATIENCE_MS;
  const done = await within(callServer(deps.server, 'DELETE', `/me/crisis-handoffs/${record.handoffId}`), networkMs, null);
  if (done === null) return 'offline';
  if (!done.ok && !(done.reason === 'rejected' && done.status === 404)) return done.reason === 'rejected' ? 'failed' : 'offline';
  const dropped = await within(changeHandoffs(deps.server.storage, (records) => records.filter((other) => other.handoffId !== record.handoffId)).then(() => true, () => false), storeMs, false);
  return dropped ? 'stopped' : 'failed';
}
