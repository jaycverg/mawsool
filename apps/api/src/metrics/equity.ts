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
 * can be missing, so each has a "no bucket given" group; language is the language the ticket was made in, which every
 * ticket has.
 */
const DIMENSIONS: { dimension: EquityDimension; values: readonly string[]; of: (ticket: TicketFact) => string | null }[] = [
  { dimension: 'age_band', values: [...AGE_BANDS, NOT_GIVEN], of: (ticket) => ticket.ageBand },
  { dimension: 'gender', values: [...GENDERS, NOT_GIVEN], of: (ticket) => ticket.gender },
  { dimension: 'language', values: CARE_LANGUAGES, of: (ticket) => ticket.language },
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
 * Each dimension is a table: its groups, "no bucket given" included, and the overall figure as their total. A group under
 * ten is hidden, and so is the next smallest when it would be the only one hidden, so no group can be taken out of the
 * overall figure. A hidden group carries nothing else: no flag and no gap, either of which would say it is large or small.
 * A group is flagged when its rate is 10 points or more from the overall rate, in either direction.
 */
export function buildEquity(period: MetricPeriod, tickets: readonly TicketFact[], since: Date | null): EquityResponse {
  const inPeriod = tickets.filter((ticket) => since === null || ticket.createdAt >= since);
  const overall = groupOf(inPeriod);

  const tables = DIMENSIONS.map((spec) => {
    const groups = new Map<string, Group>();
    for (const value of spec.values) groups.set(value, groupOf(inPeriod.filter((ticket) => (spec.of(ticket) ?? NOT_GIVEN) === value)));
    const cells = new Map<string, number[]>([['overall', countsOf(overall)]]);
    for (const [value, group] of groups) cells.set(value, countsOf(group));
    return { spec, groups, cells, hidden: hiddenCells({ cells, relations: [{ total: 'overall', parts: [...groups.keys()] }] }) };
  });
  // The overall figure is one number in every table; hidden in any of them, it is hidden in all.
  const overallHidden = tables.some((table) => table.hidden.has('overall'));
  const overallRate = percentOf(overall.closed, overall.tickets);

  return {
    period,
    flagPoints: EQUITY_FLAG_POINTS,
    overall: overallHidden ? { suppressed: true } : { tickets: overall.tickets, loopClosed: overall.closed, ratePercent: overallRate },
    dimensions: tables.map(({ spec, groups, cells, hidden }) => ({
      dimension: spec.dimension,
      rows: [...groups].map(([value, group]) => {
        const cell: EquityResponse['dimensions'][number]['rows'][number]['cell'] | Suppressed = overallHidden
          ? { suppressed: true }
          : cellOrSuppressed(hidden, value, cells.get(value)!, () => {
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
