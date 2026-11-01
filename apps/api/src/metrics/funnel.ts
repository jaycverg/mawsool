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
 * Stages 1 and 2 as one table, with keys `s1:` and `s2:`. Every interior cell and every column of stage 1 is the same count
 * as in stage 2 (they hold the same journeys), a source's stage 1 row is its stage 2 row plus its open invites, and the
 * stage 1 grand total is the stage 2 one plus all open invites plus the crisis events. When a cell has to be hidden for
 * the others' sake, the stage 1 rows and total go first, so the ticket stages stay readable.
 */
export function openingTable(inputs: FunnelInputs): ProtectedTable {
  const one = stageTable('positive_screen', inputs);
  const two = stageTable('ticket_issued', inputs);
  const cells = new Map<string, number[]>();
  for (const [k, v] of one.cells) cells.set(`s1:${k}`, [...v]);
  for (const [k, v] of two.cells) cells.set(`s2:${k}`, [...v]);
  const relations: { total: string; parts: string[] }[] = [];
  for (const [prefix, table] of [['s1', one], ['s2', two]] as const) {
    for (const r of table.relations) relations.push({ total: `${prefix}:${r.total}`, parts: r.parts.map((p) => `${prefix}:${p}`) });
  }
  const equal: [string, string][] = [];
  for (const k of two.cells.keys()) {
    if (k === GRAND) continue;
    const invitesKey = k.startsWith('row:') ? invites(k.slice(4) as TicketSource) : null;
    if (invitesKey && one.cells.has(invitesKey)) relations.push({ total: `s1:${k}`, parts: [`s2:${k}`, `s1:${invitesKey}`] });
    else equal.push([`s1:${k}`, `s2:${k}`]);
  }
  relations.push({ total: `s1:${GRAND}`, parts: [`s2:${GRAND}`, ...SOURCES_WITH_INVITES.map((source) => `s1:${invites(source)}`), `s1:${CRISIS}`] });
  // Hide a stage 1 row or total before a stage 2 cell, and either before a cell the two stages share (an interior cell or a column).
  // The last resorts are the crisis count, then a cell the two stages share, then any stage 2 cell, then the stage 1 total.
  const prefer = (key: string): number =>
    key === `s1:${CRISIS}` ? 4 : key.startsWith('s1:i:') || key.startsWith('s1:col:') ? 3 : key.startsWith('s2:') ? 2 : key === `s1:${GRAND}` ? 1 : 0;
  return { cells, relations, equal, prefer };
}

/** Whether the crisis events are hidden from the funnel's first stage in this period, so the crisis figures must hide them too. */
export function crisisHiddenInFunnel(inputs: FunnelInputs): boolean {
  return hiddenCells(openingTable(inputs)).has(`s1:${CRISIS}`);
}

/**
 * The funnel for one filter choice. Each stage's count is the cell the filter asks for, after complementary suppression
 * over the whole table of filter values, so asking for every source or tier one at a time cannot rebuild a hidden cell
 * from the others and the total. A share is published only when both counts it divides are.
 *
 * The first two stages are protected as ONE table (`openingTable`), because the difference between them is exactly what
 * the first stage holds that the second does not (open invites and crisis events), and those are cells that must stay
 * hidden when they are small.
 *
 * The one exception, stated precisely: the difference between two LATER adjacent stages (issued to acknowledged,
 * acknowledged to seen, seen to re-measured) is published whatever its size, because the funnel is asked to give counts
 * and the share between stages and a drop-off is not a cell of its own. The first stage minus the second is not covered
 * by that exception.
 */
export function buildFunnel(query: FunnelQuery, inputs: FunnelInputs): FunnelResponse {
  const key = cellKeyOf(query.source ?? null, query.tier ?? null);
  const opening = openingTable(inputs);
  const openingHidden = hiddenCells(opening);
  const counts: (number | Suppressed)[] = FUNNEL_STAGES.map((stage, index) => {
    if (index < 2) {
      const prefixed = `${index === 0 ? 's1' : 's2'}:${key}`;
      return cellOrSuppressed(openingHidden, prefixed, opening.cells.get(prefixed)!, () => opening.cells.get(prefixed)![0]!);
    }
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
