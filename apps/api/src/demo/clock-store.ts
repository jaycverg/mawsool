import { eq } from 'drizzle-orm';
import type { OffsetClock } from '../clock';
import type { Db } from '../db/client';
import { demoClock } from '../db/schema';

const ROW_ID = 1;

/** The demo clock's stored offset in milliseconds; zero when the clock has never moved or was reset. */
export async function readDemoOffset(db: Db): Promise<number> {
  const [row] = await db.select({ offsetMs: demoClock.offsetMs }).from(demoClock).where(eq(demoClock.id, ROW_ID));
  return row?.offsetMs ?? 0;
}

async function writeDemoOffset(db: Db, offsetMs: number): Promise<void> {
  await db.insert(demoClock).values({ id: ROW_ID, offsetMs }).onConflictDoUpdate({ target: demoClock.id, set: { offsetMs } });
}

/**
 * Loads the stored offset into the care clock when the API starts, so a restart keeps the demo's date. Only called when
 * `DEMO_MODE` is on; with it unset no clock exists and the row is left as it is.
 */
export async function restoreDemoClock(db: Db, clock: OffsetClock): Promise<void> {
  clock.setOffset(await readDemoOffset(db));
}

/**
 * Moves the care clock forward and stores the new offset. The write comes first, so a failed write leaves the clock where
 * it was; the moves run one at a time, so two requests at once both count (the stored offset is a copy of this clock's
 * offset, not a counter of its own).
 */
export function createClockMover(db: Db, clock: OffsetClock): (ms: number) => Promise<number> {
  let tail: Promise<unknown> = Promise.resolve();
  return (ms) => {
    const move = tail.then(async () => {
      const next = clock.offset + ms;
      await writeDemoOffset(db, next);
      clock.advance(ms);
      return clock.offset;
    });
    tail = move.catch(() => undefined);
    return move;
  };
}
