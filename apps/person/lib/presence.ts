import type { StorageAdapter } from '@mawsool/ui';
import { z } from 'zod';
import { KEYS } from './keys';
import { loadOutcomeStatistics } from './outcome-statistics';
import { registeredThisPageLoad, type ServerDeps } from './server';
import { learnServerChoices } from './server-choices';
import { loadEquity } from './share';

/**
 * What a presence check did. `sent` and `turned_off` made a request that went through; the others did not change anything on the
 * server. The result exists as a test seam (callers ignore it), so each reason to do nothing is observable on its own:
 *  - `sent`: the server answered with its two choices and the phone had nothing to turn off;
 *  - `turned_off`: the server answered and had a choice off that the phone had on, which the phone now has off too;
 *  - `not_recognised`: the server answered 401, so it no longer knows this phone. Nothing on the phone changed, no day was
 *    recorded, and the phone was not registered again: a background read never makes the phone a new person;
 *  - `still_not_recognised`: an earlier background read was answered 401 and no action of the person has registered the phone since
 *    (`server:not-recognised`), so no request is made; each start would otherwise make one more that cannot succeed;
 *  - `anonymous`: an anonymous session sends nothing, so it is checked before the store is opened;
 *  - `crisis_open`: a crisis is open, and nothing here sits on or beside that screen;
 *  - `no_opt_in`: neither the equity nor the statistics choice is on, so there is nothing the server could turn off;
 *  - `not_due`: the server was already reached today (a UTC day on the wall clock);
 *  - `offline`: the browser says there is no network, so no request is made that would fail;
 *  - `failed`: the call did not go through, or the store would not answer; the day is not recorded, so the next start tries again.
 */
export type PresenceResult = 'sent' | 'turned_off' | 'not_recognised' | 'still_not_recognised' | 'anonymous' | 'crisis_open' | 'no_opt_in' | 'not_due' | 'offline' | 'failed';

const StoredDaySchema = z.object({ day: z.string() });

/** The UTC `YYYY-MM-DD` of an instant, the day the API's `last_seen_on` counts in. */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

export interface PresenceDeps {
  server: ServerDeps;
  /** The wall clock, not the care clock: the API dates a person's last visit on the wall clock. */
  now: () => Date;
  isAnonymous: () => boolean;
  isOnline: () => boolean;
  /** Whether a crisis is open on this phone. */
  crisisOpen: (storage: StorageAdapter) => Promise<boolean>;
}

let inFlight: Promise<PresenceResult> | null = null;

/**
 * Tells the server the person is still using this phone, so a choice they left on (the equity group totals, the anonymous
 * symptom-change figures) is not turned off by the idle limit while they use the app every week, and learns from the same answer
 * whether the server has turned either choice off, in which case the phone turns it off too (`learnServerChoices`). The server dates
 * a person's last visit from any authenticated request; opening the app, the home screen, check-ins and Settings make none, so
 * while one of the two choices is on the app makes one call a day (a read of the person's own two choices), at most. It is
 * background work: never part of the crisis path, never awaited by a screen, never run in an anonymous session or while a crisis is
 * open, never registers or re-registers the phone, and any failure is silent and tried again the next time the app starts or the
 * browser comes back online. Two overlapping calls share one request.
 */
export function keepSeenToday(deps: PresenceDeps): Promise<PresenceResult> {
  inFlight ??= check(deps, 'daily').finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * The same read, made when the person opens Settings while a choice is on, so what Settings shows is what the server holds. It is
 * made whether or not today's call was made (the answer is what Settings needs), records no day, and has every guard of the daily
 * call. Both reads reconcile under the store's lock, so whichever finishes first has done the work and the other finds nothing to
 * turn off; either way the phone's notes are final by the time this returns.
 */
export function learnChoicesOnOpen(deps: PresenceDeps): Promise<PresenceResult> {
  return check(deps, 'open');
}

async function check(deps: PresenceDeps, mode: 'daily' | 'open'): Promise<PresenceResult> {
  try {
    if (deps.isAnonymous()) return 'anonymous';
    const { storage } = deps.server;
    if (await deps.crisisOpen(storage)) return 'crisis_open';
    const [equity, statistics] = await Promise.all([loadEquity(storage), loadOutcomeStatistics(storage)]);
    if (!equity.optIn && !statistics) return 'no_opt_in';
    // A phone the server has forgotten stays forgotten until the person's own action registers it again (`ensureRegistered` clears the note): the read itself never registers.
    if ((await storage.get<unknown>(KEYS.serverForgotPhone)) !== undefined) return 'still_not_recognised';
    const today = utcDay(deps.now());
    const stored = StoredDaySchema.safeParse(await storage.get<unknown>(KEYS.lastSeenSent));
    if (mode === 'daily' && stored.success && stored.data.day === today) return 'not_due';
    if (!deps.isOnline()) return 'offline';
    const learned = await learnServerChoices(deps.server, { lastReached: stored.success ? stored.data.day : null, now: deps.now() });
    if (learned === 'not_recognised') await noteForgottenPhone(storage, today);
    if (learned === 'not_recognised' || learned === 'failed') return learned;
    if (mode === 'daily') await storage.set(KEYS.lastSeenSent, { day: today }).catch(() => undefined);
    return learned === 'turned_off' ? 'turned_off' : 'sent';
  } catch {
    return 'failed';
  }
}

/**
 * Writes the note that the server answered 401, unless a call the person made has registered the phone in this page load, before the read
 * or while it was on its way: the note must not outlast that registration whichever of the two finished first. The registration clears the
 * note the moment it succeeds, but a write that was already on its way (the phone's store encrypts before it writes, the clear does not) can
 * land after that clear, so a registration seen once the write has ended removes the note again. A write or a removal the store refuses
 * changes nothing else.
 */
async function noteForgottenPhone(storage: StorageAdapter, today: string): Promise<void> {
  if (!registeredThisPageLoad(storage)) await storage.set(KEYS.serverForgotPhone, { since: today }).catch(() => undefined);
  if (registeredThisPageLoad(storage)) await storage.remove(KEYS.serverForgotPhone).catch(() => undefined);
}
