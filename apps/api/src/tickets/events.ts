import type { Actor, TicketState } from '@mawsool/types';
import { desc, eq } from 'drizzle-orm';
import { schema, type Db } from '../db/client';
import { evaluate, evaluateUnable, type Verdict } from './transitions';

/** Anything with the query surface of a database or an open transaction. */
export type Executor = Pick<Db, 'select' | 'insert' | 'update' | 'delete'>;

export interface LastEvent {
  seq: number;
  state: TicketState;
}

/** The newest event of a ticket: its sequence number and the state it left the ticket in. */
export async function lastEvent(executor: Executor, ticketId: string): Promise<LastEvent | null> {
  const [row] = await executor
    .select({ seq: schema.ticketEvents.seq, state: schema.ticketEvents.toState })
    .from(schema.ticketEvents)
    .where(eq(schema.ticketEvents.ticketId, ticketId))
    .orderBy(desc(schema.ticketEvents.seq))
    .limit(1);
  return row ?? null;
}

export interface NewEvent {
  ticketId: string;
  /** The sequence number being claimed: one past the last event the writer saw. */
  seq: number;
  from: TicketState | null;
  to: TicketState;
  actor: Actor;
  channel: string;
  reason?: string | null;
  selfConfirmed?: boolean;
  at: Date;
}

/**
 * Appends one event, claiming `seq`. The `(ticket_id, seq)` unique constraint is the only arbiter: a writer that
 * read the ticket before another writer appended finds the sequence number taken, inserts nothing and gets `false`,
 * and the ticket's cached state is then left alone. That makes a lost race a no-op for the sweep and a 409 for a request.
 */
export async function appendEvent(executor: Executor, event: NewEvent): Promise<boolean> {
  const inserted = await executor
    .insert(schema.ticketEvents)
    .values({
      ticketId: event.ticketId,
      seq: event.seq,
      fromState: event.from,
      toState: event.to,
      actor: event.actor,
      channel: event.channel,
      reason: event.reason ?? null,
      selfConfirmed: event.selfConfirmed ?? false,
      at: event.at,
    })
    .onConflictDoNothing({ target: [schema.ticketEvents.ticketId, schema.ticketEvents.seq] })
    .returning({ id: schema.ticketEvents.id });
  if (inserted.length === 0) return false;
  // The cached state moves only with the event that claimed the sequence number.
  await executor.update(schema.tickets).set({ state: event.to }).where(eq(schema.tickets.id, event.ticketId));
  return true;
}

export type MoveOutcome =
  | { result: 'moved'; seq: number }
  | { result: 'forbidden' | 'illegal' }
  /** Another writer appended first. */
  | { result: 'lost_race' };

/**
 * Validates and appends a state change for an actor: reads the ticket's last event, asks the state machine, and
 * appends in a transaction. `unable` is the same-state event with a reason.
 */
export async function moveTicket(
  db: Db,
  input: { ticketId: string; to: TicketState; actor: Actor; channel: string; reason?: string | null; selfConfirmed?: boolean; at: Date; unable?: boolean },
): Promise<MoveOutcome> {
  const last = await lastEvent(db, input.ticketId);
  if (!last) return { result: 'illegal' };
  const verdict: Verdict = input.unable ? evaluateUnable(last.state, input.actor) : evaluate(last.state, input.to, input.actor);
  if (verdict !== 'ok') return { result: verdict };
  const moved = await db.transaction((tx) =>
    appendEvent(tx, {
      ticketId: input.ticketId,
      seq: last.seq + 1,
      from: last.state,
      to: input.unable ? last.state : input.to,
      actor: input.actor,
      channel: input.channel,
      reason: input.reason,
      selfConfirmed: input.selfConfirmed,
      at: input.at,
    }),
  );
  return moved ? { result: 'moved', seq: last.seq + 1 } : { result: 'lost_race' };
}
