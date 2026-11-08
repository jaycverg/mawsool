import { type CrisisHandoffReceipt, type CrisisTrigger, type Locale, type PhoneNumber, type Screening, type ScoreEntry } from '@mawsool/types';
import type { StorageAdapter } from '@mawsool/ui';
import { z } from 'zod';
import type { NewId, Now } from './clock';
import type { FlushResult } from './crisis-outbox';
import { KEYS } from './keys';
import { parsePhone } from './reminders';
import { callServer, markServerFootprint, type ServerDeps } from './server';
import { withStoreLock } from './lock';
import { buildContent, EMPTY_SHARING } from './share';

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

/**
 * - `sent`: the server holds the hand-off and the consent is recorded.
 * - `offline`: no connection (or the server failed); nothing is known to be stored. The crisis screen says so and stays as it is.
 * - `not_ready`: the server does not yet hold the crisis record this belongs to.
 * - `rejected`: the server refused the request for good.
 * - `stopped`: the server says this hand-off was already stopped, so it was not stored. Nothing is offered again.
 * - `invalid_number`: the number typed is not an international number; nothing was sent.
 * - `failed`: the phone could not write its own record, so nothing was sent.
 */
export type SendOutcome = 'sent' | 'offline' | 'not_ready' | 'stopped' | 'rejected' | 'invalid_number' | 'failed';

export interface SendDeps {
  server: ServerDeps;
  /** Sends the queued crisis events, so the one this hand-off belongs to is on the server first. */
  flush: () => Promise<FlushResult>;
  now: Now;
  newId: NewId;
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
  const typed = input.callbackInput.trim();
  const callback = typed === '' ? null : parsePhone(typed);
  if (typed !== '' && !callback) return 'invalid_number';
  const preview = buildHandoffPreview({ screenings: input.screenings, language: input.language, trigger: input.trigger, callback });

  const flushed = await deps.flush().catch(() => null);
  if (flushed === null || flushed.outcome === 'offline' || flushed.outcome === 'conflict') return 'offline';

  const { storage } = deps.server;
  let record: HandoffRecord;
  try {
    const earlier = handoffFor(await loadHandoffs(storage), input.crisisEventId);
    // Only this crisis's own unconfirmed record is reused. An earlier crisis's record is left exactly as it is.
    record = earlier ?? { handoffId: deps.newId(), crisisEventId: input.crisisEventId, state: 'sending', startedAt: deps.now().toISOString() };
    await markServerFootprint(storage, deps.now);
    await changeHandoffs(storage, (records) => [...records.filter((other) => other.handoffId !== record.handoffId), { ...record, state: 'sending' }]);
  } catch {
    return 'failed';
  }

  const sent = await callServer<CrisisHandoffReceipt>(deps.server, 'POST', '/me/crisis-handoffs', { handoffId: record.handoffId, crisisEventId: record.crisisEventId, consented: true, ...preview });
  if (!sent.ok) {
    if (sent.reason !== 'rejected') return 'offline';
    // A refusal means nothing was stored, so the record has nothing to stop.
    await changeHandoffs(storage, (records) => records.filter((other) => other.handoffId !== record.handoffId)).catch(() => undefined);
    if (sent.status === 409 && sent.error === 'handoff_stopped') return 'stopped';
    return sent.status === 409 ? 'not_ready' : 'rejected';
  }
  try {
    await changeHandoffs(storage, (records) => records.map((other) => (other.handoffId === record.handoffId ? { ...other, state: 'sent' as const } : other)));
  } catch {
    // The record stays `sending`, which is enough to stop it from.
  }
  return 'sent';
}

export type StopOutcome = 'stopped' | 'offline' | 'failed';

/**
 * Stops one hand-off: the server revokes the consent and deletes what it stored, and only then does the phone drop that one record
 * (the others stay).
 * A hand-off the server no longer has (404) is already stopped. Offline keeps the record, so the person can try again.
 */
export async function stopHandoff(deps: { server: ServerDeps }, record: HandoffRecord): Promise<StopOutcome> {
  const done = await callServer(deps.server, 'DELETE', `/me/crisis-handoffs/${record.handoffId}`);
  if (!done.ok && !(done.reason === 'rejected' && done.status === 404)) return done.reason === 'rejected' ? 'failed' : 'offline';
  try {
    await changeHandoffs(deps.server.storage, (records) => records.filter((other) => other.handoffId !== record.handoffId));
  } catch {
    return 'failed';
  }
  return 'stopped';
}

