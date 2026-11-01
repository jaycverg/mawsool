import { FUNNEL_STAGES, TICKET_SOURCES, TICKET_TIERS, type FunnelQuery, type FunnelResponse, type FunnelStage, type TicketSource, type TicketTier } from '@mawsool/types';
import type { Suppressed } from '../suppress';
import { cellOrSuppressed, hiddenCells, percentOf, type ProtectedTable } from './protect';
import type { CrisisFact, InviteFact, TicketFact } from './facts';

/**
 * One person's way through the system. A parentless ticket and every reroute that followed it are one journey. It reaches
 * a stage when any of its tickets reached that stage or a later one, so the stages are cumulative and a share can never
 * pass 100%. A reroute child's own `source` is `app` (the child is a new ticket made in the app), so the journey takes the
 * source and tier of its ROOT ticket: a TAMM journey stays TAMM through a reroute and sits in one row only.
 */
export interface Journey {
  source: TicketSource;
  tier: TicketTier;
  createdAt: Date;
  acknowledged: boolean;
  seen: boolean;
  remeasured: boolean;
}

/** Groups tickets into journeys by following each reroute up to its root. */
export function journeysOf(tickets: readonly TicketFact[]): Journey[] {
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  const journeys = new Map<string, Journey>();
  for (const ticket of tickets) {
    if (ticket.parentId === null) {
      journeys.set(ticket.id, { source: ticket.source, tier: ticket.tier, createdAt: ticket.createdAt, acknowledged: false, seen: false, remeasured: false });
    }
  }
  for (const ticket of tickets) {
    let root = ticket;
    for (let hops = 0; root.parentId !== null && hops < 1000; hops += 1) root = byId.get(root.parentId) ?? root;
    const journey = journeys.get(root.id);
    if (!journey) continue; // a chain whose root is missing cannot be placed
    journey.acknowledged ||= ticket.acknowledged;
    journey.seen ||= ticket.seen;
    journey.remeasured ||= ticket.remeasured;
  }
  return [...journeys.values()];
}

const SOURCES_WITH_INVITES = TICKET_SOURCES.filter((source): source is Exclude<TicketSource, 'app'> => source !== 'app');

const interior = (source: TicketSource, tier: TicketTier) => `i:${source}:${tier}`;
const invites = (source: TicketSource) => `n:${source}`;
const row = (source: TicketSource) => `row:${source}`;
const column = (tier: TicketTier) => `col:${tier}`;
const GRAND = 'grand';
const CRISIS = 'crisis';

/** The stage a journey must have reached, as a test on the journey. */
const REACHED: Record<FunnelStage, (journey: Journey) => boolean> = {
  positive_screen: () => true,
  ticket_issued: () => true,
  acknowledged: (journey) => journey.acknowledged,
  seen: (journey) => journey.seen,
  remeasured: (journey) => journey.remeasured,
};

export interface FunnelInputs {
  journeys: readonly Journey[];
  /** Invites that are unclaimed and unexpired at the care clock's now (see `loadOpenInvites`). */
  openInvites: readonly InviteFact[];
  crisis: readonly CrisisFact[];
  /** Where the period begins, or null for all time. */
  since: Date | null;
}

/**
 * The counts of one stage as a table of cells, and how they add up.
 *
 * The cells are the funnel's filter values: one per (source, tier) of a journey, the row for each source (the tier filter
 * left open), the column for each tier (the source filter left open) and the grand total. On the first stage a source's
 * row also holds its open invites, and the grand total the crisis events; neither carries a tier, so a tier filter drops
 * them, and a crisis event carries no source either, so a source filter drops it too. Those parts are cells of the table
 * as well, because a reader who can ask for every filter value can otherwise subtract.
 */
export function stageTable(stage: FunnelStage, inputs: FunnelInputs): ProtectedTable {
  const inPeriod = (at: Date) => inputs.since === null || at >= inputs.since;
  const cells = new Map<string, number[]>();
  const relations: { total: string; parts: string[] }[] = [];

  for (const source of TICKET_SOURCES) for (const tier of TICKET_TIERS) cells.set(interior(source, tier), [0]);
  for (const journey of inputs.journeys) {
    if (!inPeriod(journey.createdAt) || !REACHED[stage](journey)) continue;
    cells.get(interior(journey.source, journey.tier))![0]! += 1;
  }

  const first = stage === 'positive_screen';
  const sum = (keys: string[]) => keys.reduce((total, key) => total + cells.get(key)![0]!, 0);
  for (const source of TICKET_SOURCES) {
    const parts = TICKET_TIERS.map((tier) => interior(source, tier));
    if (first && source !== 'app') {
      cells.set(invites(source), [inputs.openInvites.filter((invite) => invite.source === source && inPeriod(invite.createdAt)).length]);
      parts.push(invites(source));
    }
    cells.set(row(source), [sum(parts)]);
    relations.push({ total: row(source), parts });
  }
  for (const tier of TICKET_TIERS) {
    const parts = TICKET_SOURCES.map((source) => interior(source, tier));
    cells.set(column(tier), [sum(parts)]);
    relations.push({ total: column(tier), parts });
  }
  const rows = TICKET_SOURCES.map(row);
  if (first) {
    cells.set(CRISIS, [inputs.crisis.filter((event) => inPeriod(event.shownAt)).length]);
    cells.set(GRAND, [sum(rows) + cells.get(CRISIS)![0]!]);
    relations.push({ total: GRAND, parts: [...rows, CRISIS] });
    relations.push({ total: GRAND, parts: [...TICKET_TIERS.map(column), ...SOURCES_WITH_INVITES.map(invites), CRISIS] });
  } else {
    cells.set(GRAND, [sum(rows)]);
    relations.push({ total: GRAND, parts: rows });
    relations.push({ total: GRAND, parts: TICKET_TIERS.map(column) });
  }
  return { cells, relations };
}

/** The key of the cell a filter asks for. */
export function cellKeyOf(source: TicketSource | null, tier: TicketTier | null): string {
  if (source && tier) return interior(source, tier);
  if (source) return row(source);
  if (tier) return column(tier);
  return GRAND;
}

/**
 * The funnel for one filter choice. Each stage's count is the cell the filter asks for, after complementary suppression
 * over the whole table of filter values, so asking for every source or tier one at a time cannot rebuild a hidden cell
 * from the others and the total. A share is published only when both counts it divides are.
 *
 * Not suppressed, and said so: two stage counts that are both published give their difference, the people who stopped
 * between them, whatever its size.
 */
export function buildFunnel(query: FunnelQuery, inputs: FunnelInputs): FunnelResponse {
  const key = cellKeyOf(query.source ?? null, query.tier ?? null);
  const counts: (number | Suppressed)[] = FUNNEL_STAGES.map((stage) => {
    const table = stageTable(stage, inputs);
    return cellOrSuppressed(hiddenCells(table), key, table.cells.get(key)!, () => table.cells.get(key)![0]!);
  });
  return {
    period: query.period,
    source: query.source ?? null,
    tier: query.tier ?? null,
    stages: FUNNEL_STAGES.map((stage, index) => {
      const count = counts[index]!;
      const next = counts[index + 1];
      let carriedOn: number | Suppressed | null = null;
      if (next !== undefined) carriedOn = typeof count === 'number' && typeof next === 'number' ? percentOf(next, count) : { suppressed: true };
      return { stage, count, carriedOn };
    }),
    notCounted: { appOnlyScreens: true, crisisEventsUnmatched: true },
  };
}
