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
  /**
   * `advance`, then `then()` (the sweep at the new date), as one task: a reset queued meanwhile starts only when both are
   * done. Resolves to what `then` resolves to.
   */
  advanceThen<T>(ms: number, then: () => Promise<T>): Promise<T>;
  /**
   * Runs a task (the reset) after every move queued before it, and holds every move queued after it until it is done. The
   * task runs on the queue, so it must not call `advance`, `advanceThen` or `exclusive` itself: it would wait for itself.
   */
  exclusive<T>(task: () => Promise<T>): Promise<T>;
}

/**
 * Moves the care clock forward and stores the new offset. The write comes first, so a failed write leaves the clock where
 * it was. Moves, the sweep an advance runs at its new date, and exclusive tasks run one at a time, so two moves at once
 * both count and a reset cannot start between an advance and its sweep or interleave with its write (the stored offset is a
 * copy of this clock's offset, not a counter of its own). A task or move that fails does not stop the queue. Not covered:
 * the sweep pg-boss runs every minute is not on this queue and can still straddle a reset.
 */
export function createClockMover(db: Db, clock: OffsetClock): ClockMover {
  let tail: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task);
    tail = run.catch(() => undefined);
    return run;
  };
  /** The move itself, for tasks already on the queue. */
  const moveNow = async (ms: number): Promise<number> => {
    const next = clock.offset + ms;
    await writeDemoOffset(db, next);
    clock.advance(ms);
    return clock.offset;
  };
  return {
    exclusive,
    advance: (ms) => exclusive(() => moveNow(ms)),
    advanceThen: (ms, then) =>
      exclusive(async () => {
        await moveNow(ms);
        return then();
      }),
  };
}
