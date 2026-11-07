import { remeasureAvailableAt } from '@mawsool/rules';
import type { ConsentRecord, RemeasureRequest, TicketEventView } from '@mawsool/types';
import { desc, eq } from 'drizzle-orm';
import { shareRemeasureScores, type ConsentDeps } from '../consents/service';
import { schema } from '../db/client';
import { appendEvent, lastEntryInto, lastEvent } from './events';
import { evaluate } from './transitions';

export type RemeasureOutcome =
  | { kind: 'done'; scoresShared: boolean; consent: ConsentRecord | null; events: TicketEventView[] }
  /** The ticket is not in `seen`, so a repeat check has no place: 409. */
  | { kind: 'illegal' }
  /** Six weeks have not passed since the ticket was seen: 409. */
  | { kind: 'too_early'; availableAt: Date }
  /** The person chose to send totals but nothing is shared for the ticket any more: 409, and nothing moved. */
  | { kind: 'no_share' }
  /** Another request moved the ticket first: 409. */
  | { kind: 'lost_race' };

export interface RemeasureHooks {
  /** Test seam: runs after the ticket's newest event was read and before the transaction starts, so a test can let a rival in. */
  afterRead?: () => Promise<void>;
}

class Abandon extends Error {
  constructor(readonly outcome: 'no_share' | 'lost_race') {
    super(outcome);
  }
}

/**
 * The repeat check at six weeks. In one transaction the ticket moves `seen` to `remeasured` (the person) and straight on to
 * `closed` (the system), the next two sequence numbers, so the loop is never left half done; if the person chose to send the
 * totals they join the bundle in the same transaction, and if that cannot be done nothing moves at all.
 *
 * It is refused unless the newest state is `seen` and six weeks have passed since the event that made it `seen`, on the
 * care clock. The state machine alone would allow the move at any time from `seen`, so this is the only way to fire it.
 */
export async function remeasureTicket(deps: ConsentDeps, ticket: { id: string; personId: string }, request: RemeasureRequest, hooks: RemeasureHooks = {}): Promise<RemeasureOutcome> {
  const { db, cipher, clock } = deps;
  const last = await lastEvent(db, ticket.id);
  if (!last || evaluate(last.state, 'remeasured', 'person') !== 'ok') return { kind: 'illegal' };
  const seenAt = await lastEntryInto(db, ticket.id, 'seen');
  const now = clock.now();
  if (!seenAt) return { kind: 'illegal' };
  const availableAt = remeasureAvailableAt(seenAt);
  if (now.getTime() < availableAt.getTime()) return { kind: 'too_early', availableAt };

  await hooks.afterRead?.();
  try {
    return await db.transaction(async (tx) => {
      const consent = request.scores.length > 0 ? await shareRemeasureScores(tx, cipher, { personId: ticket.personId, ticketId: ticket.id, scores: request.scores, now }) : null;
      if (consent === 'none') throw new Abandon('no_share');
      if (!(await appendEvent(tx, { ticketId: ticket.id, seq: last.seq + 1, from: last.state, to: 'remeasured', actor: 'person', channel: 'app', at: now }))) throw new Abandon('lost_race');
      if (!(await appendEvent(tx, { ticketId: ticket.id, seq: last.seq + 2, from: 'remeasured', to: 'closed', actor: 'system', channel: 'app', at: now }))) throw new Abandon('lost_race');
      const rows = await tx.select().from(schema.ticketEvents).where(eq(schema.ticketEvents.ticketId, ticket.id)).orderBy(desc(schema.ticketEvents.seq)).limit(2);
      const events = rows.reverse().map((event) => ({
        seq: event.seq,
        fromState: event.fromState,
        toState: event.toState,
        actor: event.actor,
        reason: event.reason,
        selfConfirmed: event.selfConfirmed,
        at: event.at.toISOString(),
      }));
      return { kind: 'done' as const, scoresShared: request.scores.length > 0, consent, events };
    });
  } catch (error) {
    if (error instanceof Abandon) return { kind: error.outcome };
    throw error;
  }
}
