import type { Instrument, Screening } from '@mawsool/types';
import { RELIABLE_CHANGE } from './config';
import { isCompleteScreening } from './screenings';

export type ChangeKind = 'reliable_deterioration' | 'reliable_improvement' | 'no_reliable_change';

/** Instruments with a reliable-change threshold. The WHO-5 opener has none. */
export type TrackedInstrument = keyof typeof RELIABLE_CHANGE;

export interface Change {
  kind: ChangeKind;
  /** Current total minus previous total: positive means worse for the PHQ-9 and GAD-7. */
  delta: number;
}

export interface LatestChange extends Change {
  from: Screening;
  to: Screening;
}

/** True for an instrument that has a reliable-change threshold in `config.ts`. */
export function isTracked(instrument: Instrument): instrument is TrackedInstrument {
  return Object.hasOwn(RELIABLE_CHANGE, instrument);
}

/**
 * Classifies the change between two totals. A rise of at least the threshold is reliable deterioration and a fall
 * of at least the threshold is reliable improvement; anything smaller is within ordinary ups and downs.
 */
export function reliableChange(instrument: TrackedInstrument, previous: number, current: number): Change {
  const delta = current - previous;
  const threshold = RELIABLE_CHANGE[instrument];
  if (delta >= threshold) return { kind: 'reliable_deterioration', delta };
  if (-delta >= threshold) return { kind: 'reliable_improvement', delta };
  return { kind: 'no_reliable_change', delta };
}

/**
 * The finished check-ins for one instrument, oldest first. A check-in in progress, a damaged row and a row whose
 * date cannot be read are left out, so a half-finished check-in never reaches the trajectory.
 */
export function completedSeries(screenings: readonly Screening[], instrument: Instrument): Screening[] {
  return screenings
    .filter((screening) => screening.instrument === instrument && isCompleteScreening(screening) && !Number.isNaN(Date.parse(screening.takenAt)))
    .sort((a, b) => Date.parse(a.takenAt) - Date.parse(b.takenAt));
}

/**
 * The change between the two most recent finished check-ins of an instrument, or null when there is no threshold
 * for it or fewer than two finished check-ins.
 */
export function latestChange(screenings: readonly Screening[], instrument: Instrument): LatestChange | null {
  if (!isTracked(instrument)) return null;
  const series = completedSeries(screenings, instrument);
  if (series.length < 2) return null;
  const from = series[series.length - 2]!;
  const to = series[series.length - 1]!;
  return { ...reliableChange(instrument, from.total, to.total), from, to };
}
