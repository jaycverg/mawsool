import type { Instrument } from '@mawsool/types';
import type { ScoreResult } from './types';

/** Thrown when answers are missing, extra, non-integer or out of range. A partial instrument is never scored. */
export class InvalidAnswersError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAnswersError';
  }
}

interface InstrumentSpec {
  itemCount: number;
  maxValue: number;
}

const SPECS: Record<Instrument, InstrumentSpec> = {
  who5: { itemCount: 5, maxValue: 5 },
  phq9: { itemCount: 9, maxValue: 3 },
  gad7: { itemCount: 7, maxValue: 3 },
  cssrs: { itemCount: 6, maxValue: 1 },
};

/** Inclusive upper bound of each band, lowest band first. */
const PHQ9_BANDS = [
  { max: 4, band: 'minimal' },
  { max: 9, band: 'mild' },
  { max: 14, band: 'moderate' },
  { max: 19, band: 'moderately_severe' },
  { max: 27, band: 'severe' },
] as const;

const GAD7_BANDS = [
  { max: 4, band: 'minimal' },
  { max: 9, band: 'mild' },
  { max: 14, band: 'moderate' },
  { max: 21, band: 'severe' },
] as const;

/** A WHO-5 score at or below this offers the PHQ-9 and GAD-7. */
export const WHO5_FOLLOW_UP_MAX_SCORE = 50;

function validate(instrument: Instrument, answers: readonly number[]): void {
  const { itemCount, maxValue } = SPECS[instrument];
  if (answers.length !== itemCount) {
    throw new InvalidAnswersError(`${instrument} needs ${itemCount} answers, got ${answers.length}`);
  }
  // An indexed loop, not forEach: forEach skips the empty slots of a sparse array, which would score a
  // half-answered check-in as if the missing items were zero.
  for (let index = 0; index < itemCount; index += 1) {
    const value = answers[index];
    if (!Number.isInteger(value) || value! < 0 || value! > maxValue) {
      throw new InvalidAnswersError(`${instrument} item ${index + 1}: ${String(value)} is not an integer from 0 to ${maxValue}`);
    }
  }
}

/**
 * True when `answers` is an array holding one in-range whole number for every item of the instrument. An empty
 * slot (a hole, undefined, null, NaN) or a short, long or out-of-range list is false. This is the completeness
 * test for a stored check-in: a check-in in progress has empty slots and so is never scored.
 */
export function hasCompleteAnswers(instrument: Instrument, answers: unknown): boolean {
  if (!Array.isArray(answers)) return false;
  try {
    validate(instrument, answers as number[]);
    return true;
  } catch {
    return false;
  }
}

function sum(answers: readonly number[]): number {
  return answers.reduce((total, value) => total + value, 0);
}

/** Maps a PHQ-9 or GAD-7 total to its severity band id. */
export function severityBand(instrument: 'phq9' | 'gad7', total: number): string {
  const bands = instrument === 'phq9' ? PHQ9_BANDS : GAD7_BANDS;
  const found = bands.find((entry) => total <= entry.max);
  if (!found) throw new InvalidAnswersError(`${instrument} total ${total} is above the maximum`);
  return found.band;
}

/** WHO-5: five items scored 0-5. The raw total (0-25) times 4 gives the 0-100 score. */
export function scoreWho5(answers: readonly number[]): ScoreResult {
  validate('who5', answers);
  return { instrument: 'who5', total: sum(answers) * 4, band: null, item9Flag: false };
}

/** PHQ-9: nine items scored 0-3, total 0-27. `item9Flag` is true when item 9 is above 0. */
export function scorePhq9(answers: readonly number[]): ScoreResult {
  validate('phq9', answers);
  const total = sum(answers);
  return { instrument: 'phq9', total, band: severityBand('phq9', total), item9Flag: Number(answers[8]) > 0 };
}

/** GAD-7: seven items scored 0-3, total 0-21. */
export function scoreGad7(answers: readonly number[]): ScoreResult {
  validate('gad7', answers);
  const total = sum(answers);
  return { instrument: 'gad7', total, band: severityBand('gad7', total), item9Flag: false };
}

/** C-SSRS screener: six yes (1) or no (0) answers. The total counts yes answers; any yes is positive. */
export function scoreCssrs(answers: readonly number[]): ScoreResult {
  validate('cssrs', answers);
  const total = sum(answers);
  return { instrument: 'cssrs', total, band: total > 0 ? 'positive' : 'negative', item9Flag: false };
}

/** Scores any instrument by id. */
export function scoreInstrument(instrument: Instrument, answers: readonly number[]): ScoreResult {
  switch (instrument) {
    case 'who5':
      return scoreWho5(answers);
    case 'phq9':
      return scorePhq9(answers);
    case 'gad7':
      return scoreGad7(answers);
    case 'cssrs':
      return scoreCssrs(answers);
  }
}

/** True when a WHO-5 score (0-100) offers the PHQ-9 and GAD-7. A person may also choose them directly. */
export function offersFollowUp(who5Score: number): boolean {
  return who5Score <= WHO5_FOLLOW_UP_MAX_SCORE;
}

/** Number of items on each instrument, for callers that build forms. */
export function itemCount(instrument: Instrument): number {
  return SPECS[instrument].itemCount;
}
