import type { DemoResetResult } from '@mawsool/types';
import type { OffsetClock } from '../clock';
import type { Cipher } from '../crypto';
import type { Db } from '../db/client';
import { createInvite, formatInviteCode } from '../inbound/service';
import { startOfDubaiDay } from '../metrics/facts';
import { readStaffAccess, runSeed } from '../seed/run';

/**
 * Puts the demo back to its start, in one call.
 *
 * - The clock offset goes to zero, in memory and in the database. The routes run this through the clock mover's queue.
 * - The database is reloaded from the deterministic seed, anchored on the start of today (Dubai), so the seeded history
 *   ends where the demo begins, "the last 90 days" holds all of it and the seeded open invites are unexpired now. The same
 *   day gives the same rows. Staff who are signed in stay signed in.
 * - Noura's invite is made through `createInvite`, the service the signed route uses, so the mock TAMM page has a real
 *   code to open with. It is one more unclaimed invite until she claims it, after which her ticket counts instead.
 *
 * A phone that still holds a person id from before the reset is not handled here: the person is gone from the database,
 * and the phone re-registers itself the next time the server answers 401 (`callServer`).
 */
export async function resetDemo(deps: { db: Db; cipher: Cipher; clock: OffsetClock; personAppUrl: string }): Promise<DemoResetResult> {
  // The clock is zeroed before the reload, so a sweep that starts during it reads the fresh seed at real time and cannot mark
  // the new tickets overdue at a demo date. The routes run this after any advance and that advance's own sweep (the clock
  // mover's queue). Not covered: the sweep pg-boss runs every minute is not on that queue, and one that began before this
  // started can still append `overdue` to the reloaded tickets. The reload rolls back whole if it fails, so the stored offset
  // still holds the previous value: put the clock back to it, and the clock and the row agree.
  const previousOffset = deps.clock.offset;
  deps.clock.reset();
  const now = deps.clock.now();
  try {
    await runSeed(deps.db, deps.cipher, startOfDubaiDay(now), await readStaffAccess(deps.db));
  } catch (error) {
    deps.clock.setOffset(previousOffset);
    throw error;
  }
  const invite = await createInvite(deps.db, deps.clock, 'tamm', { result: 'positive', screenedAt: now.toISOString(), locale: 'ar' });
  const code = formatInviteCode(invite.code);
  const tammUrl = (locale: 'ar' | 'en') => `${deps.personAppUrl}/${locale}/tamm/?code=${encodeURIComponent(code)}`;
  return {
    offsetMs: 0,
    seededAt: now.toISOString(),
    noura: { code, expiresAt: invite.expiresAt.toISOString(), tammUrl: { ar: tammUrl('ar'), en: tammUrl('en') } },
  };
}
