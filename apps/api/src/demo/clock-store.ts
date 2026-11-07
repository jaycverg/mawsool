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

/** What moves the demo clock: one queue, so no two moves overlap. */
export interface ClockMover {
  /** Moves the care clock forward by `ms` and stores the new offset; resolves to the new offset. */
  advance(ms: number): Promise<number>;
  /** Runs a task (the reset) after every move queued before it, and holds every move queued after it until it is done. */
  exclusive<T>(task: () => Promise<T>): Promise<T>;
}

/**
 * Moves the care clock forward and stores the new offset. The write comes first, so a failed write leaves the clock where
 * it was. Moves and exclusive tasks run one at a time, so two moves at once both count and an advance cannot interleave
 * with a reset and leave the stored row and the clock disagreeing (the stored offset is a copy of this clock's offset, not
 * a counter of its own). A task or move that fails does not stop the queue.
 */
export function createClockMover(db: Db, clock: OffsetClock): ClockMover {
  let tail: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task);
    tail = run.catch(() => undefined);
    return run;
  };
  return {
    exclusive,
    advance: (ms) =>
      exclusive(async () => {
        const next = clock.offset + ms;
        await writeDemoOffset(db, next);
        clock.advance(ms);
        return clock.offset;
      }),
  };
}
