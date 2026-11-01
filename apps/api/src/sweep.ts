import { and, inArray, lte } from 'drizzle-orm';
import type { Clock } from './clock';
import { schema, type Db } from './db/client';
import { appendEvent, lastEvent } from './tickets/events';
import { evaluate } from './tickets/transitions';

export type OverdueOutcome = 'marked' | 'lost_race' | 'skipped';

export interface SweepHooks {
  /** Runs after a ticket's last event was read and before the overdue event is written. Tests use it to let a rival in. */
  afterRead?: (ticketId: string) => Promise<void>;
}

/**
 * Moves one ticket to `overdue` if its last event still allows it. The write claims the next sequence number and the
 * unique constraint arbitrates: when another sweep appended first, this one inserts nothing and returns `lost_race`.
 * The return value exists so a test can tell a lost race from a skipped ticket; callers ignore it.
 */
export async function markOverdue(db: Db, clock: Clock, ticketId: string, hooks: SweepHooks = {}): Promise<OverdueOutcome> {
  const last = await lastEvent(db, ticketId);
  if (!last || evaluate(last.state, 'overdue', 'system') !== 'ok') return 'skipped';
  await hooks.afterRead?.(ticketId);
  const appended = await db.transaction((tx) =>
    appendEvent(tx, { ticketId, seq: last.seq + 1, from: last.state, to: 'overdue', actor: 'system', channel: 'job', at: clock.now() }),
  );
  return appended ? 'marked' : 'lost_race';
}

export interface SweepResult {
  marked: number;
  lostRace: number;
  skipped: number;
}

/**
 * Finds every ticket past its deadline that has not been seen and appends one `overdue` event to each. Safe to run
 * from several places at once and every minute: a ticket that is already overdue, or that another sweep got to first,
 * is left alone, so there is never a second `overdue` event.
 */
export async function sweep(db: Db, clock: Clock, hooks: SweepHooks = {}): Promise<SweepResult> {
  const due = await db
    .select({ id: schema.tickets.id })
    .from(schema.tickets)
    .where(and(inArray(schema.tickets.state, ['issued', 'acknowledged']), lte(schema.tickets.deadlineAt, clock.now())));
  const result: SweepResult = { marked: 0, lostRace: 0, skipped: 0 };
  for (const { id } of due) {
    const outcome = await markOverdue(db, clock, id, hooks);
    if (outcome === 'marked') result.marked += 1;
    else if (outcome === 'lost_race') result.lostRace += 1;
    else result.skipped += 1;
  }
  return result;
}
