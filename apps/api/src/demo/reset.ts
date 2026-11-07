import type { DemoResetResult } from '@mawsool/types';
import type { OffsetClock } from '../clock';
import type { Db } from '../db/client';
import { createInvite, formatInviteCode } from '../inbound/service';
import { startOfDubaiDay } from '../metrics/facts';
import { readStaffAccess, runSeed } from '../seed/run';

/**
 * Puts the demo back to its start, in one call.
 *
 * - The clock offset goes to zero, in memory and in the database.
 * - The database is reloaded from the deterministic seed, anchored on the start of today (Dubai), so the seeded history
 *   ends where the demo begins, "the last 90 days" holds all of it and the seeded open invites are unexpired now. The same
 *   day gives the same rows. Staff who are signed in stay signed in.
 * - Noura's invite is made through `createInvite`, the service the signed route uses, so the mock TAMM page has a real
 *   code to open with. It is one more unclaimed invite until she claims it, after which her ticket counts instead.
 *
 * A phone that still holds a person id from before the reset is not handled here: the person is gone from the database,
 * and the phone re-registers itself the next time the server answers 401 (`callServer`).
 */
export async function resetDemo(deps: { db: Db; clock: OffsetClock; personAppUrl: string }): Promise<DemoResetResult> {
  const now = deps.clock.baseNow();
  // The reload empties the stored offset with every other table, in the same transaction, so the stored value and the
  // clock cannot disagree after a reload that failed: the clock is only zeroed once the reload has gone through.
  await runSeed(deps.db, startOfDubaiDay(now), await readStaffAccess(deps.db));
  deps.clock.reset();
  const invite = await createInvite(deps.db, deps.clock, 'tamm', { result: 'positive', screenedAt: now.toISOString(), locale: 'ar' });
  const code = formatInviteCode(invite.code);
  const tammUrl = (locale: 'ar' | 'en') => `${deps.personAppUrl}/${locale}/tamm/?code=${encodeURIComponent(code)}`;
  return {
    offsetMs: 0,
    seededAt: now.toISOString(),
    noura: { code, expiresAt: invite.expiresAt.toISOString(), tammUrl: { ar: tammUrl('ar'), en: tammUrl('en') } },
  };
}
