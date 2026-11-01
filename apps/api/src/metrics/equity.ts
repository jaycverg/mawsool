import {
  AGE_BANDS,
  CARE_LANGUAGES,
  EQUITY_FLAG_POINTS,
  GENDERS,
  NOT_GIVEN,
  REGIONS,
  type EquityDimension,
  type EquityValue,
  type EquityResponse,
  type MetricPeriod,
} from '@mawsool/types';
import type { Suppressed } from '../suppress';
import { cellOrSuppressed, hiddenCells, percentOf, percentile } from './protect';
import type { TicketFact } from './facts';

const DAY_MS = 86_400_000;

/**
 * The four buckets, and nothing else: age band, gender, language and region. There is no nationality dimension, by
 * decision, until the programme team picks buckets. Age band, gender and region are the person's own opt-in buckets and
 * can be missing, so each has a "no bucket given" group. Language is the same: the language the person chose to share
 * under the equity opt-in, never the language the ticket was made in, so a person who did not opt in appears in no
 * language row and sits in "no bucket given" like the other three.
 */
const DIMENSIONS: { dimension: EquityDimension; values: readonly string[]; of: (ticket: TicketFact) => string | null }[] = [
  { dimension: 'age_band', values: [...AGE_BANDS, NOT_GIVEN], of: (ticket) => ticket.ageBand },
  { dimension: 'gender', values: [...GENDERS, NOT_GIVEN], of: (ticket) => ticket.gender },
  { dimension: 'language', values: [...CARE_LANGUAGES, NOT_GIVEN], of: (ticket) => ticket.bucketLanguage },
  { dimension: 'region', values: [...REGIONS, NOT_GIVEN], of: (ticket) => ticket.region },
];

interface Group {
  tickets: number;
  closed: number;
  daysToSeen: number[];
}

function groupOf(tickets: readonly TicketFact[]): Group {
  return {
    tickets: tickets.length,
    closed: tickets.filter((ticket) => ticket.seen).length,
    daysToSeen: tickets.filter((ticket) => ticket.firstSeenMs !== null).map((ticket) => (ticket.firstSeenMs! - ticket.createdAt.getTime()) / DAY_MS),
  };
}

/** What a group must clear ten on to be shown: the tickets, those that closed the loop, and those that did not (a rate gives away the other side). */
const countsOf = (group: Group): number[] => [group.tickets, group.closed, group.tickets - group.closed];

/**
 * Loop-closed rate and time to seen by age band, gender, language and region.
 *
 * The rate counts every ticket, per ticket, the way the seed's planted Urdu gap is measured: closed means the ticket
 * reached `seen`, `remeasured` or `closed`, and "overall" is every ticket in the period. (The funnel counts journeys; this
 * stays per ticket.)
 *
 * Every dimension's groups, "no bucket given" included, and the overall figure as their total, are one table (see
 * `hiddenCells`). A group under ten is hidden, and enough of its neighbours go with it that what is hidden holds at least
 * two non-empty groups adding up to ten or more, in every dimension and across the ones that share their "no bucket given"
 * tickets, so no group can be taken out of the overall figure. A hidden group carries nothing else: no flag and no gap,
 * either of which would say it is large or small.
 * A group is flagged when its rate is 10 points or more from the overall rate, in either direction.
 */
export function buildEquity(period: MetricPeriod, tickets: readonly TicketFact[], since: Date | null): EquityResponse {
  const inPeriod = tickets.filter((ticket) => since === null || ticket.createdAt >= since);
  const overall = groupOf(inPeriod);

  // One table for every dimension: a group is named `${dimension}:${value}`. "No bucket given" is the same tickets in
  // several dimensions, so those cells are tied together (when they hold the same tickets) and shown or hidden as one;
  // protected one dimension at a time, a hidden group comes back as the total minus the other dimensions' shared cell.
  const cells = new Map<string, number[]>([['overall', countsOf(overall)]]);
  const relations: { total: string; parts: string[] }[] = [];
  const groups = new Map<string, Group>();
  const notGivenTickets = new Map<string, string>();
  const tables = DIMENSIONS.map((spec) => {
    const rows: [string, Group][] = [];
    for (const value of spec.values) {
      const members = inPeriod.filter((ticket) => (spec.of(ticket) ?? NOT_GIVEN) === value);
      const group = groupOf(members);
      rows.push([value, group]);
      groups.set(`${spec.dimension}:${value}`, group);
      cells.set(`${spec.dimension}:${value}`, countsOf(group));
      if (value === NOT_GIVEN) notGivenTickets.set(spec.dimension, members.map((ticket) => ticket.id).sort().join(','));
    }
    relations.push({ total: 'overall', parts: rows.map(([value]) => `${spec.dimension}:${value}`) });
    return { spec, rows };
  });
  const equal: [string, string][] = [];
  const firstWithSet = new Map<string, string>();
  for (const [dimension, ids] of notGivenTickets) {
    const first = firstWithSet.get(ids);
    if (first === undefined) firstWithSet.set(ids, dimension);
    else equal.push([`${first}:${NOT_GIVEN}`, `${dimension}:${NOT_GIVEN}`]);
  }
  const hidden = hiddenCells({ cells, relations, equal });
  const overallHidden = hidden.has('overall');
  const overallRate = percentOf(overall.closed, overall.tickets);

  return {
    period,
    flagPoints: EQUITY_FLAG_POINTS,
    overall: overallHidden ? { suppressed: true } : { tickets: overall.tickets, loopClosed: overall.closed, ratePercent: overallRate },
    dimensions: tables.map(({ spec, rows: dimensionRows }) => ({
      dimension: spec.dimension,
      rows: dimensionRows.map(([value, group]) => {
        const key = `${spec.dimension}:${value}`;
        const cell: EquityResponse['dimensions'][number]['rows'][number]['cell'] | Suppressed = overallHidden
          ? { suppressed: true }
          : cellOrSuppressed(hidden, key, cells.get(key)!, () => {
              const rate = percentOf(group.closed, group.tickets);
              const gap = Math.round((rate - overallRate) * 10) / 10;
              return {
                tickets: group.tickets,
                loopClosed: group.closed,
                ratePercent: rate,
                medianDaysToSeen: Math.round((percentile(group.daysToSeen, 0.5) ?? 0) * 10) / 10,
                gapPoints: gap,
                flagged: Math.abs(gap) >= EQUITY_FLAG_POINTS,
              };
            });
        return { value: value as EquityValue, cell };
      }),
    })),
  };
}
