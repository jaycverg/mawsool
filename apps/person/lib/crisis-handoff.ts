import { type CrisisHandoffReceipt, type CrisisTrigger, type HandoffScore, type Locale, type PhoneNumber, type Screening } from '@mawsool/types';
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

/**
 * The records to show after a re-read of the store: the new list when the read answers, and the list last read (`previous`) when the read
 * fails or does not answer within `storeMs`. A screen that dropped its list on a failed read would stop offering Stop and would tell the next
 * retry that no earlier attempt exists ("nothing was sent") while the server may hold the note. Never rejects; the crisis screen never waits on it.
 */
export function reloadHandoffs(storage: StorageAdapter, previous: readonly HandoffRecord[], storeMs: number = HANDOFF_STORE_PATIENCE_MS): Promise<readonly HandoffRecord[]> {
  return within<readonly HandoffRecord[]>(loadHandoffs(storage), storeMs, previous);
}

/**
 * What a screen remembers in memory about its own sends, per crisis event: the record of an attempt that was taken past the point where a request may have left
 * the phone, until the attempt ends in a refusal or the note is stopped. The screen shows the records the store holds together with these (`merge`), so a store
 * that breaks, or never answers a read again, after the attempt cannot hide Stop or make the next retry look like a first attempt. It is the screen's own copy
 * and never written anywhere: the store stays the record, this only covers what the store can no longer be asked.
 */
export class HandoffMemory {
  private readonly attempts = new Map<string, HandoffRecord>();

  /** Wired to `SendDeps.onIssue`: the record the send is about to issue its request with. */
  readonly issued = (record: HandoffRecord): void => {
    this.attempts.set(record.crisisEventId, { ...record, state: 'sending' });
  };

  /**
   * Settles the attempt for one crisis by its outcome: `sent` confirms it, `unconfirmed` keeps it as it is, and a refusal of a first attempt
   * (`offline`, a phone that could not register, `not_ready`, `rejected`) or a `stopped` forgets it, since the server holds nothing and the send removed the stored record too. A retry never ends in the first three (`sendHandoff` says `unconfirmed` for them, as an earlier
   * attempt may be held), so this never forgets an attempt that may still be at the server. `failed` and `invalid_number` end before anything is
   * issued and leave an earlier attempt alone.
   */
  settled(crisisEventId: string, outcome: SendOutcome): void {
    const held = this.attempts.get(crisisEventId);
    if (!held) return;
    if (outcome === 'sent') this.attempts.set(crisisEventId, { ...held, state: 'sent' });
    else if (outcome === 'offline' || outcome === 'not_ready' || outcome === 'rejected' || outcome === 'stopped') this.attempts.delete(crisisEventId);
  }

  /** The person stopped this note and the server confirmed it. */
  stopped(handoffId: string): void {
    for (const [eventId, held] of this.attempts) if (held.handoffId === handoffId) this.attempts.delete(eventId);
  }

  /** What the store read, plus the attempts it does not show: the store's own record wins for a crisis it lists. */
  merge(read: readonly HandoffRecord[]): HandoffRecord[] {
    return [...read, ...[...this.attempts.values()].filter((held) => !read.some((record) => record.crisisEventId === held.crisisEventId))];
  }
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
  scores: HandoffScore[];
  callbackNumber: PhoneNumber | null;
}

/**
 * The totals of the latest finished check-ins (an instrument and a total each: never an item answer, a band or the time it was taken,
 * none of which the crisis line's console shows), the language, why the screen opened and the number if one was typed.
 */
export function buildHandoffPreview(input: { screenings: readonly Screening[]; language: Locale; trigger: CrisisTrigger; callback: PhoneNumber | null }): HandoffPreview {
  return { language: input.language, trigger: input.trigger, scores: (buildContent(input.screenings, {}, EMPTY_SHARING).scores ?? []).map(({ instrument, total }) => ({ instrument, total })), callbackNumber: input.callback };
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
 * - `offline`: nothing left the phone: the browser reports no network, the crisis queue could not be flushed, or the phone could not
 *   register or hold no credential. The screen says nothing was sent and stays as it is. Only for a first attempt: a retry that finds an
 *   earlier attempt's record (or is told the screen holds one) says `unconfirmed` at those exits and at `failed`'s, and keeps the record,
 *   since the earlier attempt may have arrived.
 * - `unconfirmed`: the request was issued and the phone has no answer to go by (no answer in time, a dropped connection, a server error, the
 *   call's own time limit), so the server may well hold the note. The `sending` record stays, so the person can stop it and a retry reuses
 *   its id. The screen says the phone could not confirm it arrived, never that nothing was sent.
 * - `not_ready`: the server does not yet hold the crisis record this belongs to. Only for a first attempt: on a retry the answer does not say what the
 *   server held when the earlier request arrived, so it is `unconfirmed`.
 * - `rejected`: the server refused the request for good. Only for a first attempt, like `not_ready`.
 * - `stopped`: the server says this hand-off was already stopped, so it was not stored. Nothing is offered again. The one refusal a retry reports as such.
 * - `invalid_number`: the number typed is not an international number; nothing was sent.
 * - `failed`: the phone could not write its own record, or its store did not answer in time, so nothing was sent. Only for a first attempt, like `offline`.
 */
export type SendOutcome = 'sent' | 'offline' | 'unconfirmed' | 'not_ready' | 'stopped' | 'rejected' | 'invalid_number' | 'failed';

export interface SendDeps {
  server: ServerDeps;
  /** Sends the queued crisis events, so the one this hand-off belongs to is on the server first. */
  flush: () => Promise<FlushResult>;
  now: Now;
  newId: NewId;
  patience?: HandoffPatience;
  /** Whether the browser reports a network; when it says there is none the send stops before it writes or sends anything. */
  isOnline?: () => boolean;
  /**
   * Called with the record just before the request is issued: from here on the server may hold the note, whatever the store answers later.
   * The screen keeps it in memory (`HandoffMemory.issued`), so it does not depend on a re-read of the store to know an attempt was made.
   */
  onIssue?: (record: HandoffRecord) => void;
}

/**
 * Hands the short template to the crisis line, once the person has agreed. Online only and optional: it never changes the
 * crisis record or the block, and every failure is an outcome, not an exception. The phone notes that the server may hold
 * something (so "Delete everything" reaches it) and writes its record before the send, then confirms it after.
 *
 * A retry of a send that did not finish reuses the same id, so a reply lost after the server stored the hand-off cannot
 * leave two.
 */
export async function sendHandoff(
  deps: SendDeps,
  input: { crisisEventId: string; screenings: readonly Screening[]; language: Locale; trigger: CrisisTrigger; callbackInput: string; earlierRecordHeld: boolean },
): Promise<SendOutcome> {
  const storeMs = deps.patience?.storeMs ?? HANDOFF_STORE_PATIENCE_MS;
  const networkMs = deps.patience?.networkMs ?? HANDOFF_NETWORK_PATIENCE_MS;
  const { storage } = deps.server;
  // A crisis that opened in an anonymous session is never handed over, whatever session this phone is in now: the stored record
  // says so, and this is the second guard behind the screen not offering it. Nothing is read from the server or sent to it.
  // A store that does not answer cannot say, and could not keep the record the send needs first, so nothing is sent.
  const crisis = await within<CrisisRecord | undefined | typeof TIMED_OUT>(storage.get<CrisisRecord>(KEYS.crisisBlock).catch(() => undefined), storeMs, TIMED_OUT);
  if (crisis === TIMED_OUT) return input.earlierRecordHeld ? 'unconfirmed' : 'failed';
  if (crisis?.anonymous && crisis.event?.id === input.crisisEventId) return 'failed';
  const typed = input.callbackInput.trim();
  const callback = typed === '' ? null : parsePhone(typed);
  if (typed !== '' && !callback) return 'invalid_number';
  const preview = buildHandoffPreview({ screenings: input.screenings, language: input.language, trigger: input.trigger, callback });

  // A retry reuses an earlier attempt's record, and that attempt may have reached the server. "Nothing was sent" is then never true of the note, so the
  // exits below that mean nothing left the phone this time say `unconfirmed` and keep the record (Stop stays); only a first attempt says `offline` or
  // `failed`. The earlier record is known from this read or from the screen, which already holds it: a store that will not answer this read, or answers
  // it with an error, cannot make the retry look like a first attempt.
  const prior = await within<HandoffRecord | null | typeof TIMED_OUT>(loadHandoffs(storage).then((records) => handoffFor(records, input.crisisEventId), () => null), storeMs, TIMED_OUT);
  if (prior === TIMED_OUT) return input.earlierRecordHeld ? 'unconfirmed' : 'failed';
  const earlier = prior !== null || input.earlierRecordHeld;
  const nothingLeft: SendOutcome = earlier ? 'unconfirmed' : 'offline';

  // The browser says there is no network: nothing is written or sent this time.
  if (deps.isOnline && !deps.isOnline()) return nothingLeft;
  const flushed = await within(deps.flush().catch(() => null), networkMs, null);
  if (flushed === null || flushed.outcome === 'offline' || flushed.outcome === 'conflict') return nothingLeft;

  const record = await within(recordBeforeSend(deps, input.crisisEventId), storeMs, null);
  if (record === null) return earlier ? 'unconfirmed' : 'failed';

  deps.onIssue?.(record);
  const sent = await within(callServer<CrisisHandoffReceipt>(deps.server, 'POST', '/me/crisis-handoffs', { handoffId: record.handoffId, crisisEventId: record.crisisEventId, consented: true, ...preview }), networkMs, null);
  // No answer in time: the server may or may not hold the note. The `sending` record stays, so the person can stop it and a retry reuses its id.
  if (sent === null) return 'unconfirmed';
  if (!sent.ok) {
    // Once the request was issued, a dropped connection, a server error or a call that ran out of time all leave it unknown whether the note
    // arrived: the same outcome as no answer in time, so the screen never says "nothing was sent" for them. The record stays to stop from.
    if (sent.reason === 'offline') return 'unconfirmed';
    // A phone that could not register or has no credential sent nothing this time, and a refusal means this request stored nothing. A record made by
    // THIS attempt then has nothing to stop. But on a retry an earlier attempt may have arrived, and neither answer says it did not: only the server's
    // own `handoff_stopped` (that very id was stopped, so nothing is held under it) does. Every other exit of a retry, `not_ready` included (a crisis
    // record the server lacks now says nothing of what it held when the earlier request arrived), keeps the record and the screen's memory of the attempt
    // and says `unconfirmed`, so Stop stays. If the store will not take the change, the record stays and a stop finds the server has none.
    const idStopped = sent.reason === 'rejected' && sent.status === 409 && sent.error === 'handoff_stopped';
    if (earlier && !idStopped) return 'unconfirmed';
    await within(changeHandoffs(storage, (records) => records.filter((other) => other.handoffId !== record.handoffId)).catch(() => undefined), storeMs, undefined);
    if (sent.reason === 'not_registered') return 'offline';
    if (idStopped) return 'stopped';
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
