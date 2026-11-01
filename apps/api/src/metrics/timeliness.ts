import { createHmac } from 'node:crypto';
import { TICKET_TIERS, type TimelinessCell, type TimelinessResponse, type MetricPeriod } from '@mawsool/types';
import { schema, type Db } from '../db/client';
import { eq } from 'drizzle-orm';
import { suppress } from '../suppress';
import type { TicketFact } from './facts';
import { cellOrSuppressed, hiddenCells, percentile, rateOrSuppressed } from './protect';

const DAY_MS = 86_400_000;

/** Most overdue tickets listed at once. The response says how many there are, so the cut is never silent. */
export const OVERDUE_LIST_LIMIT = 25;

/**
 * A ticket whose promise has been settled one way or the other: it reached `seen`, or it went overdue. Tickets still
 * waiting inside their window, and those the person declined, withdrew or moved on from without the clinic missing the
 * deadline, say nothing about the clinic's timeliness and are not counted.
 */
export function isSettled(ticket: TicketFact): boolean {
  return ticket.seen || ticket.overdue;
}

/** Seen on or before the ticket's own deadline: the window it promised (7 or 14 days, 23:59:59 on the target day). */
export function isSeenInTime(ticket: TicketFact): boolean {
  return ticket.firstSeenMs !== null && ticket.firstSeenMs <= ticket.deadlineAt.getTime();
}

interface Group {
  tickets: number;
  within: number;
  daysToSeen: number[];
}

function groupOf(tickets: readonly TicketFact[]): Group {
  const settled = tickets.filter(isSettled);
  return {
    tickets: settled.length,
    within: settled.filter(isSeenInTime).length,
    daysToSeen: settled.filter((ticket) => ticket.firstSeenMs !== null).map((ticket) => (ticket.firstSeenMs! - ticket.createdAt.getTime()) / DAY_MS),
  };
}

const ONE_DECIMAL = (value: number) => Math.round(value * 10) / 10;

/** Counts of a group that must all clear the threshold for it to be shown: the settled tickets, those in time, and those late. */
const countsOf = (group: Group): number[] => [group.tickets, group.within, group.tickets - group.within];

function cellOf(group: Group): TimelinessCell {
  return {
    tickets: group.tickets,
    withinTarget: rateOrSuppressed(group.within, group.tickets),
    // A median or a percentile stands on the tickets that reached seen, and is suppressed on its own count.
    medianDaysToSeen: suppress(group.daysToSeen.length, ONE_DECIMAL(percentile(group.daysToSeen, 0.5) ?? 0)),
    p90DaysToSeen: suppress(group.daysToSeen.length, ONE_DECIMAL(percentile(group.daysToSeen, 0.9) ?? 0)),
  };
}

/**
 * A ticket's pseudonymous id on the dashboard: a keyed hash of the ticket id. It is not the ticket id, the short code or
 * the person id, cannot be turned back into any of them without the key, and is the same every time so a programme lead
 * can follow one ticket from week to week.
 */
export function pseudonymOf(ticketId: string, encryptionKey: string): string {
  const key = createHmac('sha256', Buffer.from(encryptionKey, 'base64')).update('metrics-pseudonym-v1').digest();
  return `od_${createHmac('sha256', key).update(ticketId).digest('hex').slice(0, 12)}`;
}

export interface TimelinessInputs {
  tickets: readonly TicketFact[];
  since: Date | null;
  now: Date;
  encryptionKey: string;
}

/**
 * Timeliness by tier. The overall figure and the four tier cells are one table: if exactly one tier is hidden for being
 * small, the next smallest is hidden with it, so the overall cannot be used to recover it. The overdue list is current
 * (not tied to the period) and appears only when ten or more tickets are overdue; its ids are pseudonymous.
 */
export async function buildTimeliness(db: Db, period: MetricPeriod, inputs: TimelinessInputs): Promise<TimelinessResponse> {
  const inPeriod = inputs.tickets.filter((ticket) => inputs.since === null || ticket.createdAt >= inputs.since);
  const groups = new Map<string, Group>([['overall', groupOf(inPeriod)]]);
  for (const tier of TICKET_TIERS) groups.set(tier, groupOf(inPeriod.filter((ticket) => ticket.tier === tier)));
  const hidden = hiddenCells({
    cells: new Map([...groups].map(([key, group]) => [key, countsOf(group)])),
    relations: [{ total: 'overall', parts: [...TICKET_TIERS] }],
  });
  const cell = (key: string) => cellOrSuppressed(hidden, key, countsOf(groups.get(key)!), () => cellOf(groups.get(key)!));

  const overdue = inputs.tickets
    .filter((ticket) => ticket.state === 'overdue')
    .map((ticket) => ({ id: pseudonymOf(ticket.id, inputs.encryptionKey), daysOverdue: Math.max(0, Math.floor((inputs.now.getTime() - ticket.deadlineAt.getTime()) / DAY_MS)) }))
    .sort((a, b) => b.daysOverdue - a.daysOverdue || a.id.localeCompare(b.id));

  const services = await db
    .select({ name: schema.services.name, tier: schema.services.tier, days: schema.services.indicativeWaitDays, sample: schema.services.sample })
    .from(schema.services)
    .where(eq(schema.services.sample, true));

  return {
    period,
    overall: cell('overall'),
    tiers: TICKET_TIERS.map((tier) => ({ tier, cell: cell(tier) })),
    overdue: suppress(overdue.length, { count: overdue.length, shown: Math.min(overdue.length, OVERDUE_LIST_LIMIT), tickets: overdue.slice(0, OVERDUE_LIST_LIMIT) }),
    indicativeWait: services.sort((a, b) => a.name.localeCompare(b.name)).map((service) => ({ service: service.name, tier: service.tier, days: service.days, sample: true as const })),
  };
}
