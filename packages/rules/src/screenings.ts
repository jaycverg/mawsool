import { evaluateCrisisForAnswers } from '@mawsool/instruments';
import type { Instrument, Screening } from '@mawsool/types';
import { STEP_ROWS, type Range, type StepRow } from './config';

/** The most recent screening per instrument. On equal timestamps the later entry in the list wins. */
export function latestByInstrument(screenings: readonly Screening[]): Partial<Record<Instrument, Screening>> {
  const latest: Partial<Record<Instrument, Screening>> = {};
  for (const screening of screenings) {
    const current = latest[screening.instrument];
    if (!current || Date.parse(screening.takenAt) >= Date.parse(current.takenAt)) {
      latest[screening.instrument] = screening;
    }
  }
  return latest;
}

function inRange(total: number | undefined, range: Range | undefined): boolean {
  return total !== undefined && range !== undefined && total >= range.min && total <= range.max;
}

export interface RowSelection {
  row: StepRow;
  phq9Total: number | null;
  gad7Total: number | null;
}

/**
 * Picks the stepped-care row from the latest PHQ-9 and GAD-7 totals. Rows are checked from most to least
 * intensive and the first match wins. With neither score the last row (below 5) applies.
 */
export function selectRow(screenings: readonly Screening[]): RowSelection {
  const latest = latestByInstrument(screenings);
  const phq9 = latest.phq9?.total;
  const gad7 = latest.gad7?.total;
  const row =
    STEP_ROWS.find((candidate) => inRange(phq9, candidate.phq9) || inRange(gad7, candidate.gad7)) ??
    STEP_ROWS[STEP_ROWS.length - 1]!;
  return { row, phq9Total: phq9 ?? null, gad7Total: gad7 ?? null };
}

/**
 * True when a PHQ-9 item 9 or C-SSRS answer fired a crisis trigger that the person has not yet resolved.
 *
 * A screening whose answers fired before `crisisResolvedAt` stays resolved, so matching never re-fires on an old
 * item 9. A screening taken after the resolution fires anew. A timestamp that cannot be read counts as
 * unresolved: failing safe means showing help.
 */
export function hasUnresolvedCrisis(screenings: readonly Screening[], crisisResolvedAt: string | null): boolean {
  const resolvedMs = crisisResolvedAt === null ? Number.NaN : Date.parse(crisisResolvedAt);
  return screenings.some((screening) => {
    if (!evaluateCrisisForAnswers(screening.instrument, screening.answers).triggered) return false;
    return !(Date.parse(screening.takenAt) <= resolvedMs);
  });
}
