import { RELIABLE_CHANGE, reliableChange, remeasureAvailableAt, type TrackedInstrument } from '@mawsool/rules';
import { BundleContentSchema, EQUITY_PERIOD, OUTCOME_INSTRUMENTS, type OutcomesResponse, type ScoreEntry } from '@mawsool/types';
import { and, desc, inArray, isNull } from 'drizzle-orm';
import { SUPPRESSION_THRESHOLD } from '@mawsool/rules';
import type { Cipher } from '../crypto';
import { schema, type Db } from '../db/client';
import { bundleContext } from '../tickets/service';
import type { TicketFact } from './facts';
import { rootOf } from './funnel';
import { cellOrSuppressed, hiddenCells, rateOrSuppressed, type ProtectedTable } from './protect';

const ONE_DECIMAL = (value: number) => Math.round(value * 10) / 10;

/** A re-measured ticket's totals for one instrument: the referral's and the repeat check's. Null when either is missing or was not shared. */
export type TotalsPair = { referral: number; remeasure: number } | null;

/**
 * One ticket that reached re-measured, reduced to what the symptom-change figures need and nothing that names anyone: the
 * root of its journey's creation time (the funnel's period), and per instrument the two totals the person actually shared.
 */
export interface OutcomeFact {
  rootCreatedAt: Date;
  totals: Record<TrackedInstrument, TotalsPair>;
}

/**
 * Splits a bundle's shared totals into the referral's and the repeat check's, for one instrument. The repeat check's totals
 * are accepted only when taken once the check opened (six weeks after the ticket was seen), so a total taken before that
 * moment is the referral's and one taken at or after it is the repeat's. The newest of each is used.
 */
export function totalsPair(scores: readonly ScoreEntry[], instrument: TrackedInstrument, seenAt: Date): TotalsPair {
  const opens = remeasureAvailableAt(seenAt).getTime();
  const own = scores.filter((score) => score.instrument === instrument);
  const newest = (list: ScoreEntry[]) => list.sort((a, b) => Date.parse(b.takenAt) - Date.parse(a.takenAt))[0];
  const referral = newest(own.filter((score) => Date.parse(score.takenAt) < opens));
  const remeasure = newest(own.filter((score) => Date.parse(score.takenAt) >= opens));
  return referral && remeasure ? { referral: referral.total, remeasure: remeasure.total } : null;
}

/**
 * The facts for every re-measured ticket. A ticket's totals are read only while its person has the anonymous-statistics choice
 * on, as it stands now, and its `ticket` and `scores` consents are both live and its bundle is not deleted: a ticket whose
 * person turned the choice off, stopped sharing scores, or withdrew, counts as re-measured with no totals, never with the
 * totals it once had, and its bundle is not even opened. Nothing here is a staff read of a bundle, so no `bundle_reads` row is
 * written, and nothing per ticket leaves this function except the two numbers per instrument.
 *
 * A bundle that cannot be read (damaged or moved) leaves its ticket without totals rather than failing the dashboard.
 */
export async function loadOutcomeFacts(db: Db, cipher: Cipher, tickets: readonly TicketFact[]): Promise<OutcomeFact[]> {
  const remeasured = tickets.filter((ticket) => ticket.remeasured);
  if (remeasured.length === 0) return [];
  const ids = remeasured.filter((ticket) => ticket.outcomeStatsOptIn).map((ticket) => ticket.id);
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  const none: Record<TrackedInstrument, TotalsPair> = { phq9: null, gad7: null };
  if (ids.length === 0) return remeasured.map((ticket) => ({ rootCreatedAt: rootOf(byId, ticket).createdAt, totals: none }));

  const live = new Map<string, Set<string>>();
  for (const row of await db
    .select({ ticketId: schema.consents.ticketId, element: schema.consents.element })
    .from(schema.consents)
    .where(and(inArray(schema.consents.ticketId, ids), isNull(schema.consents.revokedAt)))) {
    if (row.ticketId === null) continue;
    (live.get(row.ticketId) ?? live.set(row.ticketId, new Set()).get(row.ticketId)!).add(row.element);
  }
  const bundles = new Map<string, string | null>();
  for (const row of await db
    .select({ ticketId: schema.sharedBundles.ticketId, content: schema.sharedBundles.contentCiphertext })
    .from(schema.sharedBundles)
    .where(and(inArray(schema.sharedBundles.ticketId, ids), isNull(schema.sharedBundles.deletedAt)))) {
    bundles.set(row.ticketId, row.content);
  }
  // The newest event that moved each ticket into `seen` (a same-state event does not count), the way the repeat check reads it.
  const seenAt = new Map<string, Date>();
  for (const row of await db
    .select({ ticketId: schema.ticketEvents.ticketId, at: schema.ticketEvents.at, from: schema.ticketEvents.fromState })
    .from(schema.ticketEvents)
    .where(and(inArray(schema.ticketEvents.ticketId, ids), inArray(schema.ticketEvents.toState, ['seen'])))
    .orderBy(desc(schema.ticketEvents.seq))) {
    if (row.from !== 'seen' && !seenAt.has(row.ticketId)) seenAt.set(row.ticketId, row.at);
  }

  return remeasured.map((ticket): OutcomeFact => {
    const rootCreatedAt = rootOf(byId, ticket).createdAt;
    const elements = live.get(ticket.id);
    const ciphertext = bundles.get(ticket.id);
    const seen = seenAt.get(ticket.id);
    if (!ticket.outcomeStatsOptIn || !elements?.has('ticket') || !elements.has('scores') || !ciphertext || !seen) return { rootCreatedAt, totals: none };
    let scores: ScoreEntry[];
    try {
      scores = BundleContentSchema.parse(JSON.parse(cipher.decrypt(ciphertext, bundleContext(ticket.id)))).scores ?? [];
    } catch {
      return { rootCreatedAt, totals: none };
    }
    return { rootCreatedAt, totals: { phq9: totalsPair(scores, 'phq9', seen), gad7: totalsPair(scores, 'gad7', seen) } };
  });
}

/** The cells of the symptom-change table of one period: how many of the re-measured tickets each figure counts. */
export interface OutcomeCounts {
  remeasured: number;
  perInstrument: Record<TrackedInstrument, { included: number; improved: number; deteriorated: number; unchanged: number; sumChange: number }>;
}

/** Counts the tickets of the period (by the root of their journey, as the funnel's period does) and classifies each included change. */
export function countOutcomes(facts: readonly OutcomeFact[], since: Date | null): OutcomeCounts {
  const emptySlot = () => ({ included: 0, improved: 0, deteriorated: 0, unchanged: 0, sumChange: 0 });
  const counts: OutcomeCounts = { remeasured: 0, perInstrument: { phq9: emptySlot(), gad7: emptySlot() } };
  for (const fact of facts) {
    if (since !== null && fact.rootCreatedAt < since) continue;
    counts.remeasured += 1;
    for (const instrument of OUTCOME_INSTRUMENTS) {
      const pair = fact.totals[instrument];
      if (!pair) continue;
      const slot = counts.perInstrument[instrument];
      const change = reliableChange(instrument, pair.referral, pair.remeasure);
      slot.included += 1;
      slot.sumChange += change.delta;
      if (change.kind === 'reliable_improvement') slot.improved += 1;
      else if (change.kind === 'reliable_deterioration') slot.deteriorated += 1;
      else slot.unchanged += 1;
    }
  }
  return counts;
}

/**
 * The symptom-change table: the re-measured tickets, per instrument split into included and excluded, and the included split
 * into improved, deteriorated and unchanged. Each split is a relation (the parts add up to the whole), so `hiddenCells` hides
 * enough that no small number, an excluded handful or an unchanged remainder, can be worked out from what is published.
 * The cells hold the counts of one thing each; the figures published are these cells, the shares of them, and the mean of
 * the included changes (shown only while the included count is).
 *
 * The two instruments' included counts are tied, as equity ties its "no bucket given" groups: they count different (overlapping)
 * sets of the same re-measured tickets, and when they differ by 1 to 9 the two published figures subtract into a small group (25
 * included for one and 22 for the other leaves 3 people with one total only). So when the difference is under ten, and not zero,
 * both included cells are hidden, and with them (by the relations) both excluded cells, the shares and the means. A difference of
 * ten or more, or none, publishes nothing small and leaves them independent.
 */
export function outcomeTable(counts: OutcomeCounts): ProtectedTable {
  const cells = new Map<string, number[]>([['remeasured', [counts.remeasured]]]);
  const relations: { total: string; parts: string[] }[] = [];
  for (const instrument of OUTCOME_INSTRUMENTS) {
    const slot = counts.perInstrument[instrument];
    cells.set(`${instrument}:included`, [slot.included]);
    cells.set(`${instrument}:excluded`, [counts.remeasured - slot.included]);
    cells.set(`${instrument}:improved`, [slot.improved]);
    cells.set(`${instrument}:deteriorated`, [slot.deteriorated]);
    cells.set(`${instrument}:unchanged`, [slot.unchanged]);
    relations.push({ total: 'remeasured', parts: [`${instrument}:included`, `${instrument}:excluded`] });
    relations.push({ total: `${instrument}:included`, parts: [`${instrument}:improved`, `${instrument}:deteriorated`, `${instrument}:unchanged`] });
  }
  // What goes first when a cell has to be hidden for the others' sake: the unpublished remainder, then the shares' parts, then the counts.
  const prefer = (key: string): number => (key.endsWith(':unchanged') ? 0 : key.endsWith(':improved') || key.endsWith(':deteriorated') ? 1 : key.endsWith(':excluded') ? 2 : key.endsWith(':included') ? 3 : 4);
  const [phq9, gad7] = OUTCOME_INSTRUMENTS.map((instrument) => counts.perInstrument[instrument].included) as [number, number];
  const apart = Math.abs(phq9 - gad7);
  const forceHidden = new Set<string>(apart > 0 && apart < SUPPRESSION_THRESHOLD ? OUTCOME_INSTRUMENTS.map((instrument) => `${instrument}:included`) : []);
  return { cells, relations, prefer, forceHidden };
}

const SUPPRESSED = { suppressed: true } as const;

/**
 * The cells to hide. Every one if the funnel hides its re-measured stage; otherwise what `hiddenCells` hides, except that
 * `remeasured` is never hidden here: the funnel publishes the same count, so hiding it would protect nothing, and the relations
 * (remeasured = included + excluded) could only reach it by hiding it for another cell's sake. Leaving it shown does not make a hidden
 * cell derivable: a hidden cell is then one of at least two unknowns of its relation, or empty (`pinnedCells` over this set finds
 * no non-empty hidden cell pinned, which `metrics-outcomes.test.ts` checks).
 */
export function hiddenOutcomeCells(table: ProtectedTable, funnelHidesRemeasured: boolean): Set<string> {
  if (funnelHidesRemeasured) return new Set(table.cells.keys());
  const hidden = hiddenCells(table);
  hidden.delete('remeasured');
  return hidden;
}

/**
 * Symptom and functioning change among re-measured tickets, for ONE period: the last 90 days (`EQUITY_PERIOD`), counted from
 * `since` (`periodStart(EQUITY_PERIOD, now)`). The route refuses every other period, so no two responses are ever for different windows of the
 * same people, and a figure cannot be subtracted from the same figure of a longer or shorter period.
 *
 * The figures stand on the same people as the funnel's last stage for those 90 days (the funnel with no source or tier filter),
 * so when the funnel hides that stage for that window (`funnelHidesRemeasured`, computed over the same `since`) every figure
 * here is hidden too: nothing published here can then be used with the funnel to work out a number the funnel hid. Otherwise
 * each count is a cell of `outcomeTable`, a share needs its part, its whole and what is left over to reach ten
 * (`rateOrSuppressed`) as well as both cells being shown, and the mean needs the included count shown.
 *
 * Not covered, by decision: the window slides with the care clock, so two responses taken on different days (or either side of a
 * demo clock step) can still subtract, as with equity.
 */
export function buildOutcomes(facts: readonly OutcomeFact[], since: Date, funnelHidesRemeasured: boolean): OutcomesResponse {
  const counts = countOutcomes(facts, since);
  const table = outcomeTable(counts);
  const hidden = hiddenOutcomeCells(table, funnelHidesRemeasured);
  const cell = (key: string): number | typeof SUPPRESSED => cellOrSuppressed(hidden, key, table.cells.get(key)!, () => table.cells.get(key)![0]!);
  const share = (instrument: TrackedInstrument, part: 'improved' | 'deteriorated') => {
    const slot = counts.perInstrument[instrument];
    if (hidden.has(`${instrument}:${part}`) || hidden.has(`${instrument}:included`)) return SUPPRESSED;
    return rateOrSuppressed(slot[part], slot.included);
  };
  return {
    period: EQUITY_PERIOD,
    reliableChangePoints: { ...RELIABLE_CHANGE },
    remeasured: cell('remeasured'),
    instruments: OUTCOME_INSTRUMENTS.map((instrument) => {
      const slot = counts.perInstrument[instrument];
      return {
        instrument,
        included: cell(`${instrument}:included`),
        excluded: cell(`${instrument}:excluded`),
        meanChange: cellOrSuppressed(hidden, `${instrument}:included`, [slot.included], () => ONE_DECIMAL(slot.sumChange / slot.included)),
        reliableImprovement: share(instrument, 'improved'),
        reliableDeterioration: share(instrument, 'deteriorated'),
      };
    }),
  };
}
