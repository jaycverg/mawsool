import { remeasureAvailableAt, type TrackedInstrument } from '@mawsool/rules';
import type { BundleContent, ScoreEntry } from '@mawsool/types';
import { createRng, type Rng } from './prng';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const DAY = 24 * HOUR;

/**
 * The latest position of the demo clock, after the reset, that the dashboard step is shown at: 28 days (the +7 days and +3 weeks
 * steps) and 23 hours into the last Dubai day. Which seeded tickets get a repeat check is decided by it: parentless tickets the
 * seed left `seen` whose root is still inside "the last 90 days" at that moment, so the symptom-change tile shows numbers at every
 * position from the reset to then.
 */
export const LAST_DASHBOARD_POSITION_MS = 28 * DAY + 23 * HOUR;
/** They were also seen at least this many days before the reference time, so six weeks have passed and a repeat check fits before it. */
export const SHARE_SEEN_AT_LEAST_DAYS_AGO = 45;

/**
 * How many tickets get a repeat check, both totals shared with the clinic and a person opted in to the anonymous statistics. The
 * seed has exactly this many parentless `seen` tickets in the window above; all of them are used, so at every position of the
 * demo clock from the reset to 28 days and 23 hours later the symptom-change tile has this many counted for both instruments (the
 * two counts are equal, so the tie hides nothing), and none excluded among them. None of them is old enough to leave the window
 * before the six-week step of the browser gate.
 */
export const SEED_OUTCOME_SHARES = 35;

/** How the changes split per instrument: reliable improvement, reliable deterioration, and neither. */
export const SEED_OUTCOME_QUOTAS: Record<TrackedInstrument, { improved: number; deteriorated: number; unchanged: number }> = {
  phq9: { improved: 15, deteriorated: 4, unchanged: 16 },
  gad7: { improved: 13, deteriorated: 4, unchanged: 18 },
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

/** A seeded ticket that was seen and could be given a repeat check, as the share needs to know it. */
export interface SeenTicket {
  ticketId: string;
  personId: string;
  serviceId: string;
  createdAt: Date;
  /** When the clinic saw the person, in epoch milliseconds. */
  seenAt: number;
}

/**
 * One seeded ticket that has had its repeat check: when it was re-measured and closed (care clock, before the reference time),
 * the ids of its consent and bundle rows, and the bundle's plain content, whose person shared both repeat totals and opted in to
 * the statistics.
 */
export interface SeededOutcomeShare {
  ticketId: string;
  personId: string;
  remeasuredAt: number;
  closedAt: number;
  eventIds: { remeasured: string; closed: string };
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
 * The seeded tickets that carry a repeat check with consented, counted statistics: the demo's symptom-change tile needs ten or
 * more re-measured tickets whose person shared both repeat totals and opted in, still inside the last 90 days when the dashboard
 * is shown 28 days into the demo, and a seeded ticket otherwise has no consent and no repeat check at all.
 *
 * Drawn from a stream of its own, so nothing the main seed draws moves, and pure: the same tickets give the same shares. The
 * tickets chosen are the first `SEED_OUTCOME_SHARES` of `seen` in a shuffled order (it throws if there are fewer); each is
 * re-measured between six and eight weeks after it was seen and before `anchorMs` (the seed's reference time), and closed a day
 * or two later, and shares a referral and a repeat total for the PHQ-9 and the GAD-7, taken when a real referral and a real repeat
 * check would have been (a few hours before the ticket was issued, and a few minutes before the repeat check was finished but
 * not before it opened).
 */
export function buildOutcomeShares(seedName: string, anchorMs: number, tickets: readonly SeenTicket[]): SeededOutcomeShare[] {
  if (tickets.length < SEED_OUTCOME_SHARES) throw new Error(`the seed has ${tickets.length} tickets for a repeat check, ${SEED_OUTCOME_SHARES} are needed`);
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
    const remeasuredAt = rng.int(opens, Math.min(opens + 14 * DAY, anchorMs - 3 * DAY));
    const closedAt = remeasuredAt + rng.int(DAY, 2 * DAY);
    const repeatAt = (minutesBefore: number) => Math.max(opens, remeasuredAt - minutesBefore * MINUTE);
    const entry = (instrument: TrackedInstrument, total: number, takenAt: number): ScoreEntry => ({ instrument, total, band: bandOf(instrument, total), takenAt: new Date(takenAt).toISOString() });
    return {
      ticketId: ticket.ticketId,
      personId: ticket.personId,
      remeasuredAt,
      closedAt,
      eventIds: { remeasured: rng.uuid(), closed: rng.uuid() },
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
