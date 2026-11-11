import type { AgeBand, CareLanguage, Gender, MetricPeriod, Region, TicketSource, TicketTier } from '@mawsool/types';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { schema, type Db } from '../db/client';

const DAY_MS = 86_400_000;
/** Dubai is UTC+4 all year, so a calendar day starts at 20:00 UTC the evening before. */
const DUBAI_OFFSET_MS = 4 * 3_600_000;

/** The instant the Dubai calendar day of `at` began. */
export function startOfDubaiDay(at: Date): Date {
  return new Date(Math.floor((at.getTime() + DUBAI_OFFSET_MS) / DAY_MS) * DAY_MS - DUBAI_OFFSET_MS);
}

/**
 * Where a period begins, counted back from the Dubai day the clock is on, or null for all time. Whole days, so "the
 * last 90 days" always contains the whole of its first day.
 */
export function periodStart(period: MetricPeriod, now: Date): Date | null {
  if (period === 'all') return null;
  return daysBack(period === '90d' ? 90 : 30, now);
}

/**
 * Where the one period the equity view and the symptom-change figures are served for (`EQUITY_PERIOD`, the last 90 days)
 * begins: the same moment `periodStart('90d', now)` gives, so the funnel asked for 90 days and these figures stand on the same
 * tickets.
 */
export function onePeriodStart(now: Date): Date {
  return daysBack(90, now);
}

function daysBack(days: number, now: Date): Date {
  return startOfDubaiDay(new Date(now.getTime() - days * DAY_MS));
}

/**
 * One ticket, with everything the metrics need and nothing that names anyone: when it was issued and due, where it came
 * from, which stages its `TicketEvent` rows show it reached, and the person's equity buckets if they opted in.
 *
 * The stages are read from the events, never from the ticket's current state, so a later state never drops a ticket from
 * a stage it already reached. They are cumulative: a ticket that went `overdue` and then `seen` without ever being
 * acknowledged still counts as having reached "acknowledged or later".
 */
export interface TicketFact {
  id: string;
  parentId: string | null;
  source: TicketSource;
  tier: TicketTier;
  language: CareLanguage;
  createdAt: Date;
  deadlineAt: Date;
  state: string;
  /** Reached `acknowledged`, `seen`, `remeasured` or `closed`. */
  acknowledged: boolean;
  /** Reached `seen`, `remeasured` or `closed`: the loop is closed. A ticket withdrawn after `seen` still counts. */
  seen: boolean;
  remeasured: boolean;
  /** Went overdue at some point. */
  overdue: boolean;
  /** When it first reached `seen` or later, in epoch milliseconds. */
  firstSeenMs: number | null;
  ageBand: AgeBand | null;
  gender: Gender | null;
  region: Region | null;
  /** The language the person chose to share as an equity bucket; null for anyone who did not opt in. Not the ticket's language. */
  bucketLanguage: CareLanguage | null;
  /** Whether the person opted in to counting their shared totals in the anonymous symptom-change figures, as it stands now. Read by no other metric. */
  outcomeStatsOptIn: boolean;
}

type EventRow = {
  id: string;
  acknowledged: boolean;
  seen: boolean;
  remeasured: boolean;
  overdue: boolean;
  first_seen_ms: number | null;
};

/**
 * Every ticket with its reached stages. The loop-closed definition lives here, in one place: a ticket is loop closed when
 * any of its events moved it to `seen`, `remeasured` or `closed`.
 */
export async function loadTicketFacts(db: Db): Promise<TicketFact[]> {
  const tickets = await db
    .select({
      id: schema.tickets.id,
      parentId: schema.tickets.parentTicketId,
      source: schema.tickets.source,
      tier: schema.tickets.tier,
      language: schema.tickets.language,
      createdAt: schema.tickets.createdAt,
      deadlineAt: schema.tickets.deadlineAt,
      state: schema.tickets.state,
      optedIn: schema.persons.equityOptIn,
      outcomeStatsOptIn: schema.persons.outcomeStatsOptIn,
      ageBand: schema.persons.ageBand,
      gender: schema.persons.gender,
      region: schema.persons.region,
      bucketLanguage: schema.persons.language,
    })
    .from(schema.tickets)
    .innerJoin(schema.persons, eq(schema.persons.id, schema.tickets.personId));
  const events = await db.execute<EventRow>(sql`
    SELECT e.ticket_id AS id,
           bool_or(e.to_state IN ('acknowledged', 'seen', 'remeasured', 'closed')) AS acknowledged,
           bool_or(e.to_state IN ('seen', 'remeasured', 'closed')) AS seen,
           bool_or(e.to_state = 'remeasured') AS remeasured,
           bool_or(e.to_state = 'overdue') AS overdue,
           (extract(epoch FROM min(e.at) FILTER (WHERE e.to_state IN ('seen', 'remeasured', 'closed'))) * 1000)::float8 AS first_seen_ms
    FROM ticket_events e
    GROUP BY e.ticket_id
  `);
  const reached = new Map((events.rows as EventRow[]).map((row) => [row.id, row]));
  return tickets.map((ticket): TicketFact => {
    const row = reached.get(ticket.id);
    return {
      id: ticket.id,
      parentId: ticket.parentId,
      source: ticket.source,
      tier: ticket.tier as TicketTier,
      language: ticket.language,
      createdAt: ticket.createdAt,
      deadlineAt: ticket.deadlineAt,
      state: ticket.state,
      acknowledged: row?.acknowledged ?? false,
      seen: row?.seen ?? false,
      remeasured: row?.remeasured ?? false,
      overdue: row?.overdue ?? false,
      firstSeenMs: row?.first_seen_ms ?? null,
      // The buckets are read only for a person who opted in; the table also refuses buckets without the opt-in.
      ageBand: ticket.optedIn ? ticket.ageBand : null,
      gender: ticket.optedIn ? ticket.gender : null,
      region: ticket.optedIn ? ticket.region : null,
      bucketLanguage: ticket.optedIn ? ticket.bucketLanguage : null,
      outcomeStatsOptIn: ticket.outcomeStatsOptIn,
    };
  });
}

/** Positive screens that are in the system but not (yet) a ticket: invites nobody has claimed and that are still open. */
export interface InviteFact {
  source: Exclude<TicketSource, 'app'>;
  createdAt: Date;
}

/**
 * Invites that count as a positive screen at `now`: not claimed and not expired. An invite whose person claimed it is
 * left out (its ticket, if one is issued, counts as a parentless ticket instead), and so is one that has expired, so a
 * screen that can no longer be claimed stops counting. `now` is the care clock, so the count moves with the demo clock.
 */
export async function loadOpenInvites(db: Db, now: Date): Promise<InviteFact[]> {
  const rows = await db
    .select({ source: schema.inboundInvites.source, createdAt: schema.inboundInvites.createdAt })
    .from(schema.inboundInvites)
    .where(and(isNull(schema.inboundInvites.claimedBy), gt(schema.inboundInvites.expiresAt, now)));
  return rows.map((row) => ({ source: row.source as InviteFact['source'], createdAt: row.createdAt }));
}

/** What a crisis event tells the dashboard. It names no one and has no ticket. */
export interface CrisisFact {
  shownAt: Date;
  callTapped: boolean;
  contactConfirmed: boolean;
  /** Milliseconds from the trigger to the confirmed contact. */
  msToContact: number | null;
}

export async function loadCrisisFacts(db: Db): Promise<CrisisFact[]> {
  const rows = await db
    .select({
      shownAt: schema.crisisEvents.shownAt,
      callTapped: schema.crisisEvents.callTapped,
      confirmed: schema.crisisEvents.humanContactConfirmed,
      contactAt: schema.crisisEvents.contactAt,
    })
    .from(schema.crisisEvents);
  return rows.map((row) => ({
    shownAt: row.shownAt,
    callTapped: row.callTapped !== null,
    contactConfirmed: row.confirmed,
    msToContact: row.contactAt ? row.contactAt.getTime() - row.shownAt.getTime() : null,
  }));
}
