import { OptInsSchema, type Demographics, type OptIns } from '@mawsool/types';
import { OPT_IN_IDLE_LIMIT_DAYS } from '@mawsool/rules';
import type { StorageAdapter } from '@mawsool/ui';
import { z } from 'zod';
import { KEYS } from './keys';
import { withStoreLock } from './lock';
import { loadOutcomeStatistics, saveOutcomeStatistics } from './outcome-statistics';
import { callServer, callServerInBackground, markServerFootprint, type ServerDeps } from './server';
import { loadEquity, saveEquity } from './share';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The two opt-in choices the server can hold for a person. */
export type Choice = 'equity' | 'statistics';

/** Which choices the phone turned off because the server had them off, and has not yet told the person about. */
const ClearedNoteSchema = z.object({ equity: z.boolean().default(false), statistics: z.boolean().default(false) });
export type ClearedNote = z.infer<typeof ClearedNoteSchema>;

/**
 * What a read of the server's two choices ended in. It is a test seam: callers act on it only to decide what to record.
 *  - `unchanged`: the server answered and the phone had nothing to turn off;
 *  - `turned_off`: the server answered and at least one choice the phone had on is now off on the phone;
 *  - `not_recognised`: the server answered 401, so it does not know this phone. Nothing is changed and nothing is registered;
 *  - `failed`: no usable answer (offline, a server error, a refusal, an answer of an unexpected shape): nothing is changed.
 */
export type LearnResult = 'unchanged' | 'turned_off' | 'not_recognised' | 'failed';

/**
 * Marks, per choice, of the sends that may turn that choice on at the server. A read of the server's choices is a snapshot: a send
 * that starts after the snapshot was taken, or is still on its way, can make the server hold the choice just after the read said it
 * was off. If the phone then turned its own note off from that answer, the choice would be on at the server with no way to turn it
 * off from Settings. So a send brackets itself with these marks, and a read that began before a send started, or that meets one still
 * pending, leaves that choice's note alone (`reconcileChoices`).
 *  - `gen` goes up when a send starts and again when it ends, whatever way it ends;
 *  - `pendingSince` (ms, wall clock) is set while a send is under way. A mark older than `PENDING_MS` is taken as abandoned (a tab
 *    closed mid-send), so a mark that could not be cleared never blocks the idle limit for ever.
 */
const MarkSchema = z.object({ gen: z.number().int().default(0), pendingSince: z.number().nullable().default(null) });
const MarksSchema = z.object({ equity: MarkSchema.default({ gen: 0, pendingSince: null }), statistics: MarkSchema.default({ gen: 0, pendingSince: null }) });
export type SendMarks = z.infer<typeof MarksSchema>;
const PENDING_MS = 2 * 60 * 1000;

/** The marks as stored; none stored (or an unreadable value) reads as no send ever made. A store that will not answer throws. */
export async function readSendMarks(storage: StorageAdapter): Promise<SendMarks> {
  const parsed = MarksSchema.safeParse((await storage.get<unknown>(KEYS.choiceSends)) ?? {});
  return parsed.success ? parsed.data : MarksSchema.parse({});
}

function changeMark(storage: StorageAdapter, choice: Choice, change: (mark: SendMarks[Choice]) => SendMarks[Choice]): Promise<void> {
  return withStoreLock(storage, async () => {
    const marks = await readSendMarks(storage);
    await storage.set(KEYS.choiceSends, { ...marks, [choice]: change(marks[choice]) });
  });
}

/**
 * Runs `send`, a request that may turn `choice` on at the server together with the phone's note of it, between the two marks. When the
 * start mark cannot be written nothing is run (`started: false`): a send that cannot be marked could be undone by a read that
 * is answered a moment before it. The end mark is written however the send ends; if it cannot be, the start mark times out.
 */
export async function withChoiceSend<T>(storage: StorageAdapter, choice: Choice, now: () => Date, send: () => Promise<T>): Promise<{ started: true; value: T } | { started: false }> {
  try {
    await changeMark(storage, choice, (mark) => ({ gen: mark.gen + 1, pendingSince: now().getTime() }));
  } catch {
    return { started: false };
  }
  try {
    return { started: true, value: await send() };
  } finally {
    await changeMark(storage, choice, (mark) => ({ gen: mark.gen + 1, pendingSince: null })).catch(() => undefined);
  }
}

/** True when `choice` has had a send start, end or still under way since `before` was read: the answer of a read begun then is not to be trusted for it. */
function sendSince(marks: SendMarks, before: SendMarks, choice: Choice, now: Date): boolean {
  const mark = marks[choice];
  const pending = mark.pendingSince !== null && now.getTime() - mark.pendingSince < PENDING_MS;
  return mark.gen !== before[choice].gen || pending;
}

/** True when the UTC day `lastReached` is `OPT_IN_IDLE_LIMIT_DAYS` or more before the day of `now`, the server's own idle rule. */
function idleLimitReached(lastReached: string, now: Date): boolean {
  const reached = Date.parse(`${lastReached}T00:00:00Z`);
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(reached) && today - reached >= OPT_IN_IDLE_LIMIT_DAYS * DAY_MS;
}

/**
 * Turns off, on the phone, each choice the phone has on and the server has off, and never turns one on: a server that says on
 * and a phone that says off is left as it is. Equity also drops the four buckets the phone kept for it. The two notes are
 * re-read inside the store lock, so a choice the person has just changed is judged on its value now, and a choice with a send
 * started, ended or pending since `before` (the marks read before the request was made) is left alone, because the answer may
 * predate that send. A write the store refuses throws, so the caller treats the read as not done and tries again at the next start.
 *
 * The person is told (by the note Settings shows once) only when idleness is the evidence: the phone's own last confirmed reach of the
 * server (`lastReached`, a UTC day) is at the limit or more behind `now`. With no such day, or a recent one, the choice is corrected
 * without the note, because a phone that never reached the server, or did so lately, was not turned off for six months of silence
 * (a statistics choice noted "may be on" before a send that never arrived is the case).
 *
 * Returns which choices were turned off.
 */
export function reconcileChoices(storage: StorageAdapter, server: OptIns, context: { lastReached: string | null; now: Date; before: SendMarks }): Promise<ClearedNote> {
  return withStoreLock(storage, async () => {
    const marks = await readSendMarks(storage);
    const equity = !server.equityOptIn && !sendSince(marks, context.before, 'equity', context.now) && (await loadEquity(storage)).optIn;
    const statistics = !server.outcomeStatsOptIn && !sendSince(marks, context.before, 'statistics', context.now) && (await loadOutcomeStatistics(storage));
    if (equity) await saveEquity(storage, { optIn: false, buckets: {} });
    if (statistics) await saveOutcomeStatistics(storage, false);
    if ((equity || statistics) && context.lastReached !== null && idleLimitReached(context.lastReached, context.now)) {
      const earlier = await readClearedNote(storage);
      await storage.set(KEYS.optInsCleared, { equity: earlier.equity || equity, statistics: earlier.statistics || statistics }).catch(() => undefined);
    }
    return { equity, statistics };
  });
}

async function readClearedNote(storage: StorageAdapter): Promise<ClearedNote> {
  const parsed = ClearedNoteSchema.safeParse(await storage.get<unknown>(KEYS.optInsCleared).catch(() => undefined));
  return parsed.success ? parsed.data : { equity: false, statistics: false };
}

/**
 * Hands Settings the note of choices the server switched off, once: it is read and removed in the same step, so the next visit
 * does not show it again. Null when there is nothing to tell. A store that will not answer or will not forget the note says
 * nothing now (an unforgotten note is shown again, which is the safe side).
 */
export function takeClearedNote(storage: StorageAdapter): Promise<ClearedNote | null> {
  return withStoreLock(storage, async () => {
    try {
      const stored = await storage.get<unknown>(KEYS.optInsCleared);
      if (stored === undefined) return null;
      const note = await readClearedNote(storage);
      await storage.remove(KEYS.optInsCleared);
      return note.equity || note.statistics ? note : null;
    } catch {
      return null;
    }
  });
}

/**
 * Reads the server's two choices in the background, never registering the phone, and brings the phone's notes into line where the
 * server has a choice off (see `reconcileChoices`). `lastReached` is the day of the phone's last confirmed reach, read before
 * the caller records today. Every failure is a result, never a throw, except a refused write, which the caller sees as `failed`.
 */
export async function learnServerChoices(server: ServerDeps, context: { lastReached: string | null; now: Date }): Promise<LearnResult> {
  try {
    const before = await readSendMarks(server.storage);
    const read = await callServerInBackground<unknown>(server, '/me/opt-ins');
    if (!read.ok) return read.reason === 'rejected' && read.status === 401 ? 'not_recognised' : 'failed';
    const choices = OptInsSchema.safeParse(read.body);
    if (!choices.success) return 'failed';
    const turnedOff = await reconcileChoices(server.storage, choices.data, { ...context, before });
    return turnedOff.equity || turnedOff.statistics ? 'turned_off' : 'unchanged';
  } catch {
    return 'failed';
  }
}

/**
 * - `confirmed`: the server has the choice on, so a `true` that the phone's note alone stands behind may go out;
 * - `cleared`: the server has it off; the phone's note is now off too (and the person is told on the screen, not in Settings);
 * - `unread`: the server could not be asked, or its answer could not be used, or the phone could not turn its note off: nothing says the choice is on.
 */
export type Confirmed = 'confirmed' | 'cleared' | 'unread';

/**
 * Asks the server whether it holds `choice` before a `true` is sent that comes only from the phone's stored note (the person did not
 * tick the box on this screen). The phone's note can be stale: the idle limit may have turned the choice off at the server, and the
 * daily read may not have run or may have failed, so sending `true` from the note would turn a cleared choice back on without the
 * person choosing it. This is a foreground read, made because the person pressed send, so it may register the phone as any call
 * the person makes does. A server that has the choice off is reconciled into the phone's note here.
 */
export async function confirmStoredChoice(server: ServerDeps, choice: Choice, now: () => Date): Promise<Confirmed> {
  try {
    const before = await readSendMarks(server.storage);
    const read = await callServer<unknown>(server, 'GET', '/me/opt-ins');
    if (!read.ok) return 'unread';
    const choices = OptInsSchema.safeParse(read.body);
    if (!choices.success) return 'unread';
    if (choice === 'equity' ? choices.data.equityOptIn : choices.data.outcomeStatsOptIn) return 'confirmed';
    await reconcileChoices(server.storage, choices.data, { lastReached: null, now: now(), before });
    const stillOn = choice === 'equity' ? (await loadEquity(server.storage)).optIn : await loadOutcomeStatistics(server.storage);
    return stillOn ? 'unread' : 'cleared';
  } catch {
    return 'unread';
  }
}

/**
 * How sending the group-totals choice ended:
 *  - `skipped`: the box is unticked and the phone holds no note of it, so there is nothing to tell the server;
 *  - `saved`: the server took the choice and the phone noted it; `saved_unnoted`: the server took it and the phone could not note it;
 *  - `cleared` / `unread`: the box was ticked only by the phone's note and the server was asked first (`confirmStoredChoice`); nothing was sent;
 *  - `offline` / `rejected`: the server could not be reached, or refused.
 */
export type EquitySend = 'skipped' | 'saved' | 'saved_unnoted' | 'cleared' | 'unread' | 'offline' | 'rejected';

/**
 * Sends the group-totals choice with the referral: on with the buckets, or off when the box was unticked and the phone held a note of it.
 * A `true` that only the phone's stored note stands behind (`tickedHere` false) is sent only after the server confirms it holds the choice.
 * The send is bracketed by `withChoiceSend`. A start mark the phone cannot write throws, as any local failure around sending does.
 */
export async function sendEquityChoice(server: ServerDeps, input: { on: boolean; buckets: Demographics; storedOptIn: boolean; tickedHere: boolean; now: () => Date }): Promise<EquitySend> {
  if (!input.on && !input.storedOptIn) return 'skipped';
  if (input.on && !input.tickedHere) {
    const confirmed = await confirmStoredChoice(server, 'equity', input.now);
    if (confirmed !== 'confirmed') return confirmed;
  }
  const sent = await withChoiceSend(server.storage, 'equity', input.now, async (): Promise<EquitySend> => {
    await markServerFootprint(server.storage, input.now);
    const saved = await callServer(server, 'PUT', '/me/equity', input.on ? { optIn: true, buckets: input.buckets } : { optIn: false });
    if (!saved.ok) return saved.reason === 'offline' ? 'offline' : 'rejected';
    return (await saveEquity(server.storage, { optIn: input.on, buckets: input.on ? input.buckets : {} }).then(() => true, () => false)) ? 'saved' : 'saved_unnoted';
  });
  if (!sent.started) throw new Error('the phone could not mark the send');
  return sent.value;
}
