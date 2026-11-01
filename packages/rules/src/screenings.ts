import { evaluateCrisisForAnswers, itemCount } from '@mawsool/instruments';
import type { Instrument, Screening } from '@mawsool/types';
import { STEP_ROWS, type Range, type StepRow } from './config';

/** True when every item of the instrument has an answer. A partial screening has no meaningful total. */
export function isCompleteScreening(screening: Screening): boolean {
  return screening.answers.length === itemCount(screening.instrument);
}

/**
 * The most recent screening per instrument. A screening whose `takenAt` cannot be read never beats one whose
 * `takenAt` can; on equal timestamps, or when neither can be read, the later entry in the list wins.
 */
export function latestByInstrument(screenings: readonly Screening[]): Partial<Record<Instrument, Screening>> {
  const latest: Partial<Record<Instrument, Screening>> = {};
  for (const screening of screenings) {
    const current = latest[screening.instrument];
    if (!current) {
      latest[screening.instrument] = screening;
      continue;
    }
    const candidateMs = Date.parse(screening.takenAt);
    const currentMs = Date.parse(current.takenAt);
    const newer = Number.isNaN(currentMs) || (!Number.isNaN(candidateMs) && candidateMs >= currentMs);
    if (newer) latest[screening.instrument] = screening;
  }
  return latest;
}

/**
 * True when a finite total reaches the row's lower bound. Only the lower bound is used, and rows are tried most
 * intensive first, so a total above the instrument's maximum still lands on the top row instead of falling through.
 */
function reaches(total: number | undefined, range: Range | undefined): boolean {
  return total !== undefined && Number.isFinite(total) && range !== undefined && total >= range.min;
}

export interface RowSelection {
  row: StepRow;
  phq9Total: number | null;
  gad7Total: number | null;
}

/**
 * Picks the stepped-care row from the latest complete PHQ-9 and GAD-7 totals. Incomplete screenings are skipped
 * here, so a half-finished check-in never replaces a finished one; they still count for crisis detection.
 * Rows are checked from most to least intensive and the first match wins. With neither score the last row
 * (below 5) applies.
 */
export function selectRow(screenings: readonly Screening[]): RowSelection {
  const latest = latestByInstrument(screenings.filter(isCompleteScreening));
  const phq9 = latest.phq9?.total;
  const gad7 = latest.gad7?.total;
  const row =
    STEP_ROWS.find((candidate) => reaches(phq9, candidate.phq9) || reaches(gad7, candidate.gad7)) ??
    STEP_ROWS[STEP_ROWS.length - 1]!;
  return { row, phq9Total: phq9 ?? null, gad7Total: gad7 ?? null };
}

/**
 * True when a PHQ-9 item 9 or C-SSRS answer fired a crisis trigger that the person has not yet resolved.
 * Every screening counts, complete or not.
 *
 * A screening whose answers fired before `crisisResolvedAt` stays resolved, so matching never re-fires on an old
 * item 9. A screening taken after the resolution fires anew. A timestamp that cannot be read counts as
 * unresolved: failing safe means showing help.
 */
export function hasUnresolvedCrisis(screenings: readonly Screening[], crisisResolvedAt: string | null): boolean {
  const resolvedMs = crisisResolvedAt === null ? Number.NaN : Date.parse(crisisResolvedAt);
  return screenings.some((screening) => {
    // The stored flag counts as a trigger on its own, so a screening that lost its answers cannot hide item 9.
    const fired = screening.item9Flag || evaluateCrisisForAnswers(screening.instrument, screening.answers).triggered;
    if (!fired) return false;
    return !(Date.parse(screening.takenAt) <= resolvedMs);
  });
}
