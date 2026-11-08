import { type CrisisHandoffReceipt, type CrisisTrigger, type Locale, type PhoneNumber, type Screening, type ScoreEntry } from '@mawsool/types';
import type { StorageAdapter } from '@mawsool/ui';
import { z } from 'zod';
import type { NewId, Now } from './clock';
import type { FlushResult } from './crisis-outbox';
import { KEYS } from './keys';
import { parsePhone } from './reminders';
import { callServer, markServerFootprint, type ServerDeps } from './server';
import { buildContent, EMPTY_SHARING } from './share';

/**
 * What the phone remembers about the hand-off to the crisis line, so the person can stop it: the id the phone made for
 * it, the crisis event it belongs to, and whether the server confirmed it. It holds no score and no number, and it goes
 * with everything else on "Delete everything". `sending` is written before the send, so a reply that was lost still
 * leaves a record to stop from.
 */
export const HandoffRecordSchema = z.object({
  handoffId: z.uuid(),
  crisisEventId: z.uuid(),
  state: z.enum(['sending', 'sent']),
  startedAt: z.iso.datetime({ offset: true }),
});
export type HandoffRecord = z.infer<typeof HandoffRecordSchema>;

export async function loadHandoff(storage: StorageAdapter): Promise<HandoffRecord | null> {
  const parsed = HandoffRecordSchema.safeParse(await storage.get<unknown>(KEYS.crisisHandoff));
  return parsed.success ? parsed.data : null;
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
 * - `invalid_number`: the number typed is not an international number; nothing was sent.
 * - `failed`: the phone could not write its own record, so nothing was sent.
 */
export type SendOutcome = 'sent' | 'offline' | 'not_ready' | 'rejected' | 'invalid_number' | 'failed';

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
    const earlier = await loadHandoff(storage);
    record = earlier && earlier.crisisEventId === input.crisisEventId && earlier.state === 'sending' ? earlier : { handoffId: deps.newId(), crisisEventId: input.crisisEventId, state: 'sending', startedAt: deps.now().toISOString() };
    await markServerFootprint(storage, deps.now);
    await storage.set(KEYS.crisisHandoff, record);
  } catch {
    return 'failed';
  }

  const sent = await callServer<CrisisHandoffReceipt>(deps.server, 'POST', '/me/crisis-handoffs', { handoffId: record.handoffId, crisisEventId: record.crisisEventId, consented: true, ...preview });
  if (!sent.ok) {
    if (sent.reason !== 'rejected') return 'offline';
    // A refusal means nothing was stored, so the record has nothing to stop.
    await storage.remove(KEYS.crisisHandoff).catch(() => undefined);
    return sent.status === 409 ? 'not_ready' : 'rejected';
  }
  try {
    await storage.set(KEYS.crisisHandoff, { ...record, state: 'sent' });
  } catch {
    // The record stays `sending`, which is enough to stop it from.
  }
  return 'sent';
}

export type StopOutcome = 'stopped' | 'offline' | 'failed';

/**
 * Stops the hand-off: the server revokes the consent and deletes what it stored, and only then does the phone drop its record.
 * A hand-off the server no longer has (404) is already stopped. Offline keeps the record, so the person can try again.
 */
export async function stopHandoff(deps: { server: ServerDeps }, record: HandoffRecord): Promise<StopOutcome> {
  const done = await callServer(deps.server, 'DELETE', `/me/crisis-handoffs/${record.handoffId}`);
  if (!done.ok && !(done.reason === 'rejected' && done.status === 404)) return done.reason === 'rejected' ? 'failed' : 'offline';
  try {
    await deps.server.storage.remove(KEYS.crisisHandoff);
  } catch {
    return 'failed';
  }
  return 'stopped';
}

