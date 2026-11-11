import { remeasureAvailableAt, type TrackedInstrument } from '@mawsool/rules';
import type { BundleContent, ScoreEntry } from '@mawsool/types';
import { createRng, type Rng } from './prng';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * How many of the seeded re-measured tickets share both totals of the repeat check with the clinic and have their person opted
 * in to the anonymous statistics. With the seed's 47 re-measured tickets that leaves 11 excluded and 36 included, so the
 * symptom-change tile has ten or more on every side that needs it, and the two instruments are included in the same 36 (their
 * counts do not differ by 1 to 9, so the tie hides nothing).
 */
export const SEED_OUTCOME_SHARES = 36;

/** How the 36 changes split per instrument: reliable improvement, reliable deterioration, and neither. */
export const SEED_OUTCOME_QUOTAS: Record<TrackedInstrument, { improved: number; deteriorated: number; unchanged: number }> = {
  phq9: { improved: 15, deteriorated: 4, unchanged: 17 },
  gad7: { improved: 13, deteriorated: 4, unchanged: 19 },
};

type Kind = 'improved' | 'deteriorated' | 'unchanged';

/** The ranges a referral total and a change are drawn from for each kind, chosen so the change classifies as that kind. */
const RANGES: Record<TrackedInstrument, { max: number; kinds: Record<Kind, { referral: [number, number]; change: [number, number] }> }> = {
  phq9: {
    max: 27,
    kinds: {
      improved: { referral: [13, 22], change: [-12, -6] },
      deteriorated: { referral: [8, 15], change: [6, 8] },
      unchanged: { referral: [8, 20], change: [-5, 5] },
    },
  },
  gad7: {
    max: 21,
    kinds: {
      improved: { referral: [10, 18], change: [-9, -4] },
      deteriorated: { referral: [6, 13], change: [4, 6] },
      unchanged: { referral: [6, 16], change: [-3, 3] },
    },
  },
};

/** The inclusive upper bound of each severity band, lowest first, as the instruments score them (see `packages/instruments/src/scoring.ts`). */
const BANDS: Record<TrackedInstrument, readonly [number, string][]> = {
  phq9: [[4, 'minimal'], [9, 'mild'], [14, 'moderate'], [19, 'moderately_severe'], [27, 'severe']],
  gad7: [[4, 'minimal'], [9, 'mild'], [14, 'moderate'], [21, 'severe']],
};

const bandOf = (instrument: TrackedInstrument, total: number): string => BANDS[instrument].find(([max]) => total <= max)![1];

/** A re-measured ticket as the share needs to know it. */
export interface RemeasuredTicket {
  ticketId: string;
  personId: string;
  serviceId: string;
  createdAt: Date;
  /** When the ticket was seen, and when it was re-measured, in epoch milliseconds. */
  seenAt: number;
  remeasuredAt: number;
}

/** One seeded ticket whose person shared both repeat totals and opted in to the statistics: the ids of its rows and the bundle's plain content. */
export interface SeededOutcomeShare {
  ticketId: string;
  personId: string;
  consentIds: { ticket: string; scores: string };
  recipient: string;
  bundleId: string;
  createdAt: Date;
  content: BundleContent;
}

/** A shuffled list of kinds with the instrument's quota of each, so the split is exact whatever the draw. */
function kindsFor(rng: Rng, instrument: TrackedInstrument): Kind[] {
  const quota = SEED_OUTCOME_QUOTAS[instrument];
  return rng.shuffle([
    ...Array<Kind>(quota.improved).fill('improved'),
    ...Array<Kind>(quota.deteriorated).fill('deteriorated'),
    ...Array<Kind>(quota.unchanged).fill('unchanged'),
  ]);
}

/** A referral and a repeat total of the given kind, both inside the instrument's scale; the change classifies as the kind (checked by `reliableChange` in the tests). */
function totalsOfKind(rng: Rng, instrument: TrackedInstrument, kind: Kind): { referral: number; repeat: number } {
  const range = RANGES[instrument];
  const spec = range.kinds[kind];
  const referral = rng.int(spec.referral[0], spec.referral[1]);
  const repeat = Math.min(range.max, Math.max(0, referral + rng.int(spec.change[0], spec.change[1])));
  return { referral, repeat };
}

/**
 * The seeded tickets that carry consented, counted statistics: the demo's symptom-change tile needs ten or more re-measured
 * tickets whose person shared both repeat totals and opted in, and a seeded ticket otherwise has no consent at all.
 *
 * Drawn from a stream of its own, so nothing the main seed draws moves, and pure: the same tickets give the same shares. The
 * tickets chosen are the first `SEED_OUTCOME_SHARES` of the re-measured ones in a shuffled order; each shares a referral and a
 * repeat total for the PHQ-9 and the GAD-7, taken when a real referral and a real repeat check would have been (a few hours
 * before the ticket was issued, and a few minutes before the repeat check was finished but not before it opened).
 */
export function buildOutcomeShares(seedName: string, tickets: readonly RemeasuredTicket[]): SeededOutcomeShare[] {
  const rng = createRng(`${seedName}:outcome-shares`);
  const ordered = [...tickets].sort((a, b) => a.ticketId.localeCompare(b.ticketId));
  const chosen = rng.shuffle(ordered).slice(0, SEED_OUTCOME_SHARES);
  const phqKinds = kindsFor(rng, 'phq9');
  const gadKinds = kindsFor(rng, 'gad7');
  return chosen.map((ticket, index): SeededOutcomeShare => {
    const phq = totalsOfKind(rng, 'phq9', phqKinds[index]!);
    const gad = totalsOfKind(rng, 'gad7', gadKinds[index]!);
    const referralAt = ticket.createdAt.getTime() - rng.int(1, 6) * HOUR;
    const opens = remeasureAvailableAt(new Date(ticket.seenAt)).getTime();
    const repeatAt = (minutesBefore: number) => Math.max(opens, ticket.remeasuredAt - minutesBefore * MINUTE);
    const entry = (instrument: TrackedInstrument, total: number, takenAt: number): ScoreEntry => ({ instrument, total, band: bandOf(instrument, total), takenAt: new Date(takenAt).toISOString() });
    return {
      ticketId: ticket.ticketId,
      personId: ticket.personId,
      consentIds: { ticket: rng.uuid(), scores: rng.uuid() },
      recipient: ticket.serviceId,
      bundleId: rng.uuid(),
      createdAt: ticket.createdAt,
      content: {
        scores: [
          entry('phq9', phq.referral, referralAt),
          entry('gad7', gad.referral, referralAt),
          entry('phq9', phq.repeat, repeatAt(20)),
          entry('gad7', gad.repeat, repeatAt(10)),
        ],
      },
    };
  });
}
