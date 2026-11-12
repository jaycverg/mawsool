import type { StorageAdapter } from '@mawsool/ui';
import { z } from 'zod';
import { KEYS } from './keys';
import { loadOutcomeStatistics } from './outcome-statistics';
import { callServer, type ServerDeps } from './server';
import { loadEquity } from './share';

/**
 * What a presence check did. Only `sent` made a request. The result exists as a test seam (callers ignore it), so each reason
 * to do nothing is observable on its own:
 *  - `anonymous`: an anonymous session sends nothing, so it is checked before the store is opened;
 *  - `crisis_open`: a crisis is open, and nothing here sits on or beside that screen;
 *  - `no_opt_in`: neither the equity nor the statistics choice is on, so there is nothing the server could turn off;
 *  - `not_due`: the server was already reached today (a UTC day on the wall clock);
 *  - `offline`: the browser says there is no network, so no request is made that would fail;
 *  - `failed`: the call did not go through, or the store would not answer; the day is not recorded, so the next start tries again.
 */
export type PresenceResult = 'sent' | 'anonymous' | 'crisis_open' | 'no_opt_in' | 'not_due' | 'offline' | 'failed';

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
 * symptom-change figures) is not turned off by the idle limit while they use the app every week. The server dates a person's
 * last visit from any authenticated request; opening the app, the home screen, check-ins and Settings make none, so while one of
 * the two choices is on the app makes one call a day (an existing read of the person's own tickets), at most. It is background
 * work: never part of the crisis path, never awaited by a screen, never run in an anonymous session or while a crisis is open,
 * and any failure is silent and tried again the next time the app starts or the browser comes back online. Two overlapping
 * calls share one request.
 */
export function keepSeenToday(deps: PresenceDeps): Promise<PresenceResult> {
  inFlight ??= check(deps).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function check(deps: PresenceDeps): Promise<PresenceResult> {
  try {
    if (deps.isAnonymous()) return 'anonymous';
    const { storage } = deps.server;
    if (await deps.crisisOpen(storage)) return 'crisis_open';
    const [equity, statistics] = await Promise.all([loadEquity(storage), loadOutcomeStatistics(storage)]);
    if (!equity.optIn && !statistics) return 'no_opt_in';
    const today = utcDay(deps.now());
    const stored = StoredDaySchema.safeParse(await storage.get<unknown>(KEYS.lastSeenSent));
    if (stored.success && stored.data.day === today) return 'not_due';
    if (!deps.isOnline()) return 'offline';
    const reached = await callServer<unknown>(deps.server, 'GET', '/me/tickets');
    if (!reached.ok) return 'failed';
    await storage.set(KEYS.lastSeenSent, { day: today }).catch(() => undefined);
    return 'sent';
  } catch {
    return 'failed';
  }
}
