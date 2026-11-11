import type { AdverseEvent, AdverseEventStatus, AdverseEventsQuery, AdverseEventsResponse, RecordAdverseEventRequest } from '@mawsool/types';
import { ADVERSE_EVENT_SEVERITIES, ADVERSE_EVENT_STATUSES } from '@mawsool/types';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Clock } from '../clock';
import { schema, type Db } from '../db/client';

export interface AdverseEventDeps {
  db: Db;
  /** The care clock: when an event happened. */
  clock: Clock;
  /** The wall clock: when it was recorded, and when a move was made. */
  securityClock: Clock;
}

/** The staff member acting: ops or admin, the only roles that reach these routes. */
export interface Actor {
  staffUserId: string;
  role: 'ops' | 'admin';
}

/**
 * The legal moves of an adverse event's status: open to investigating, investigating to closed, and open straight to closed.
 * A closed event stays closed, and nothing moves back.
 */
export const ADVERSE_EVENT_MOVES: Record<AdverseEventStatus, readonly AdverseEventStatus[]> = {
  open: ['investigating', 'closed'],
  investigating: ['closed'],
  closed: [],
};

export function isLegalMove(from: AdverseEventStatus, to: AdverseEventStatus): boolean {
  return ADVERSE_EVENT_MOVES[from].includes(to);
}

export type RecordResult = { kind: 'recorded'; event: AdverseEvent } | { kind: 'in_the_future' };

/**
 * Records an adverse event with its first history row, in one transaction. It happened at `occurredAt` (the care clock's now
 * when left out; never later than that now) and is recorded at the wall clock's now. Nothing about a person is accepted: the
 * request schema is strict and holds a coded type, a severity, a time and an optional pseudonymous ticket id.
 */
export async function recordAdverseEvent(deps: AdverseEventDeps, actor: Actor, request: RecordAdverseEventRequest): Promise<RecordResult> {
  const occurredAt = request.occurredAt ? new Date(request.occurredAt) : deps.clock.now();
  if (occurredAt.getTime() > deps.clock.now().getTime()) return { kind: 'in_the_future' };
  const recordedAt = deps.securityClock.now();
  const id = await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .insert(schema.adverseEvents)
      .values({ type: request.type, severity: request.severity, status: 'open', occurredAt, recordedAt, ticketRef: request.ticketRef ?? null })
      .returning({ id: schema.adverseEvents.id });
    await tx.insert(schema.adverseEventHistory).values({ eventId: row!.id, seq: 1, fromStatus: null, toStatus: 'open', at: recordedAt, staffUserId: actor.staffUserId });
    return row!.id;
  });
  const [event] = await loadEvents(deps.db, [id]);
  return { kind: 'recorded', event: event! };
}

export type MoveResult = { kind: 'moved'; event: AdverseEvent } | { kind: 'not_found' } | { kind: 'illegal' } | { kind: 'lost_race' };

/**
 * Moves an event's status along a legal move, and records the move with its wall-clock time and who made it. The update
 * names the status it was read in, so two moves that start from the same status cannot both succeed: the one that loses
 * changes nothing and is a 409, like a lost race on a ticket.
 */
export async function moveAdverseEvent(deps: AdverseEventDeps, actor: Actor, id: string, to: AdverseEventStatus, hooks: { afterRead?: () => Promise<void> } = {}): Promise<MoveResult> {
  const [current] = await deps.db.select({ status: schema.adverseEvents.status }).from(schema.adverseEvents).where(eq(schema.adverseEvents.id, id)).limit(1);
  if (!current) return { kind: 'not_found' };
  const from = current.status as AdverseEventStatus;
  if (!isLegalMove(from, to)) return { kind: 'illegal' };
  await hooks.afterRead?.();
  const at = deps.securityClock.now();
  const moved = await deps.db.transaction(async (tx) => {
    const updated = await tx
      .update(schema.adverseEvents)
      .set({ status: to })
      .where(and(eq(schema.adverseEvents.id, id), eq(schema.adverseEvents.status, from)))
      .returning({ id: schema.adverseEvents.id });
    if (updated.length === 0) return false;
    // The update above holds the event's row until this transaction ends, so the next number is read without a rival.
    const [last] = await tx.select({ seq: sql<number>`max(${schema.adverseEventHistory.seq})::int` }).from(schema.adverseEventHistory).where(eq(schema.adverseEventHistory.eventId, id));
    await tx.insert(schema.adverseEventHistory).values({ eventId: id, seq: (last?.seq ?? 0) + 1, fromStatus: from, toStatus: to, at, staffUserId: actor.staffUserId });
    return true;
  });
  if (!moved) return { kind: 'lost_race' };
  const [event] = await loadEvents(deps.db, [id]);
  return { kind: 'moved', event: event! };
}

/** The events with these ids, with their history, newest occurrence first. */
async function loadEvents(db: Db, ids: string[]): Promise<AdverseEvent[]> {
  if (ids.length === 0) return [];
  const rows = await db.select().from(schema.adverseEvents).where(inArray(schema.adverseEvents.id, ids)).orderBy(desc(schema.adverseEvents.occurredAt), schema.adverseEvents.id);
  return withHistory(db, rows);
}

async function withHistory(db: Db, rows: (typeof schema.adverseEvents.$inferSelect)[]): Promise<AdverseEvent[]> {
  if (rows.length === 0) return [];
  const moves = await db
    .select({ eventId: schema.adverseEventHistory.eventId, from: schema.adverseEventHistory.fromStatus, to: schema.adverseEventHistory.toStatus, at: schema.adverseEventHistory.at, role: schema.staffUsers.role })
    .from(schema.adverseEventHistory)
    .innerJoin(schema.staffUsers, eq(schema.staffUsers.id, schema.adverseEventHistory.staffUserId))
    .where(inArray(schema.adverseEventHistory.eventId, rows.map((row) => row.id)))
    .orderBy(schema.adverseEventHistory.eventId, schema.adverseEventHistory.seq);
  return rows.map((row) => ({
    id: row.id,
    type: row.type as AdverseEvent['type'],
    severity: row.severity as AdverseEvent['severity'],
    status: row.status as AdverseEventStatus,
    occurredAt: row.occurredAt.toISOString(),
    recordedAt: row.recordedAt.toISOString(),
    ticketRef: row.ticketRef,
    history: moves
      .filter((move) => move.eventId === row.id)
      .map((move) => ({ from: move.from as AdverseEventStatus | null, to: move.to as AdverseEventStatus, at: move.at.toISOString(), by: move.role === 'admin' ? ('admin' as const) : ('ops' as const) })),
  }));
}

/** The log, filtered by status and severity, with the counts of the whole log by status and by severity. */
export async function listAdverseEvents(db: Db, query: AdverseEventsQuery): Promise<AdverseEventsResponse> {
  const filter = and(query.status ? eq(schema.adverseEvents.status, query.status) : undefined, query.severity ? eq(schema.adverseEvents.severity, query.severity) : undefined);
  const rows = await db.select().from(schema.adverseEvents).where(filter).orderBy(desc(schema.adverseEvents.occurredAt), schema.adverseEvents.id);
  const grouped = await db
    .select({ status: schema.adverseEvents.status, severity: schema.adverseEvents.severity, n: sql<number>`count(*)::int` })
    .from(schema.adverseEvents)
    .groupBy(schema.adverseEvents.status, schema.adverseEvents.severity);
  const byStatus = Object.fromEntries(ADVERSE_EVENT_STATUSES.map((status) => [status, 0])) as AdverseEventsResponse['counts']['byStatus'];
  const bySeverity = Object.fromEntries(ADVERSE_EVENT_SEVERITIES.map((severity) => [severity, 0])) as AdverseEventsResponse['counts']['bySeverity'];
  for (const row of grouped) {
    byStatus[row.status as AdverseEventStatus] += row.n;
    bySeverity[row.severity as keyof typeof bySeverity] += row.n;
  }
  return { items: await withHistory(db, rows), counts: { byStatus, bySeverity } };
}
