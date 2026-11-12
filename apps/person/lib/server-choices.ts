import { OptInsSchema, type OptIns } from '@mawsool/types';
import { OPT_IN_IDLE_LIMIT_DAYS } from '@mawsool/rules';
import type { StorageAdapter } from '@mawsool/ui';
import { z } from 'zod';
import { KEYS } from './keys';
import { withStoreLock } from './lock';
import { loadOutcomeStatistics, saveOutcomeStatistics } from './outcome-statistics';
import { callServerInBackground, type ServerDeps } from './server';
import { loadEquity, saveEquity } from './share';

const DAY_MS = 24 * 60 * 60 * 1000;

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

/** True when the UTC day `lastReached` is `OPT_IN_IDLE_LIMIT_DAYS` or more before the day of `now`, the server's own idle rule. */
function idleLimitReached(lastReached: string, now: Date): boolean {
  const reached = Date.parse(`${lastReached}T00:00:00Z`);
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(reached) && today - reached >= OPT_IN_IDLE_LIMIT_DAYS * DAY_MS;
}

/**
 * Turns off, on the phone, each choice the phone has on and the server has off, and never turns one on: a server that says on
 * and a phone that says off is left as it is. Equity also drops the four buckets the phone kept for it. The two notes are
 * re-read inside the store lock, so a choice the person has just changed is judged on its value now. A write the store refuses
 * throws, so the caller treats the read as not done and tries again at the next start.
 *
 * The person is told only when the idle limit is the plausible cause: the phone's last confirmed reach of the server
 * (`lastReached`, a UTC day) is at the limit or more behind `now`, or unknown. A phone that reached the server recently and
 * still disagrees with it (a statistics choice noted before a send that never arrived) is corrected without the note, which
 * would give the wrong reason.
 *
 * Returns which choices were turned off.
 */
export function reconcileChoices(storage: StorageAdapter, server: OptIns, context: { lastReached: string | null; now: Date }): Promise<ClearedNote> {
  return withStoreLock(storage, async () => {
    const equity = !server.equityOptIn && (await loadEquity(storage)).optIn;
    const statistics = !server.outcomeStatsOptIn && (await loadOutcomeStatistics(storage));
    if (equity) await saveEquity(storage, { optIn: false, buckets: {} });
    if (statistics) await saveOutcomeStatistics(storage, false);
    const idle = context.lastReached === null || idleLimitReached(context.lastReached, context.now);
    if ((equity || statistics) && idle) {
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
    const read = await callServerInBackground<unknown>(server, '/me/opt-ins');
    if (!read.ok) return read.reason === 'rejected' && read.status === 401 ? 'not_recognised' : 'failed';
    const choices = OptInsSchema.safeParse(read.body);
    if (!choices.success) return 'failed';
    const turnedOff = await reconcileChoices(server.storage, choices.data, context);
    return turnedOff.equity || turnedOff.statistics ? 'turned_off' : 'unchanged';
  } catch {
    return 'failed';
  }
}
