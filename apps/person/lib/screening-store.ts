import { hasCompleteAnswers, itemCount, scoreInstrument, wordingFor } from '@mawsool/instruments';
import { isCompleteScreening } from '@mawsool/rules';
import type { Instrument, Screening } from '@mawsool/types';
import type { StorageAdapter } from '@mawsool/ui';
import type { NewId, Now } from './clock';
import { KEYS } from './keys';
import { withStoreLock } from './lock';

/** Every check-in on the device, finished or not. A row that is not an array of rows reads as none. */
export async function loadScreenings(storage: StorageAdapter): Promise<Screening[]> {
  const stored = await storage.get<unknown>(KEYS.screenings);
  return Array.isArray(stored) ? (stored as Screening[]) : [];
}

/**
 * The check-in in progress for an instrument, if one was left part-answered. With `notBefore` (epoch ms), only one started at or
 * after that moment counts: the repeat check uses it so an old unfinished check-in is never finished and sent as the new one.
 */
export function findDraft(screenings: readonly Screening[], instrument: Instrument, notBefore?: number): Screening | undefined {
  return screenings.findLast((screening) => screening.instrument === instrument && !isCompleteScreening(screening) && (notBefore === undefined || Date.parse(screening.takenAt) >= notBefore));
}

/** How many questions of the instrument are answered in a row from the first. */
export function answeredCount(screening: Screening | undefined): number {
  return screening?.answers.length ?? 0;
}

export interface AnswerInput {
  instrument: Instrument;
  /** 0-based position of the question. At most one past the last answered, so answers never leave a gap. */
  index: number;
  value: number;
  /**
   * The check-in the screen is holding, if it has one. The answer then edits that row, finished or not, so changing
   * an answer after the last one rescores the same check-in instead of failing or starting a second one. Without it,
   * the check-in in progress for the instrument is used, or a new one opened.
   */
  screeningId?: string | null;
  /** Epoch ms: a check-in in progress that was started before it is not resumed, and a new one is opened (see `findDraft`). */
  notBefore?: number;
}

/**
 * Records one answer and saves the check-in at once, so a check-in left half done is still there on return.
 *
 * The first answer opens a new check-in stamped with the time it was started; later answers join the one in
 * progress. Its `takenAt` never changes after that: a crisis resolved at a later moment then covers every answer in
 * it, and finishing the check-in cannot make an old item 9 answer fire again. Answers form an unbroken run from
 * the first question, with no empty slots. The last answer completes the check-in and fills in its total, band and
 * item 9 flag; an answer changed afterwards rescores all three. Returns the saved check-in.
 */
export function saveAnswer(storage: StorageAdapter, input: AnswerInput, deps: { now: Now; newId: NewId }): Promise<Screening> {
  return withStoreLock(storage, () => saveAnswerNow(storage, input, deps));
}

async function saveAnswerNow(storage: StorageAdapter, input: AnswerInput, deps: { now: Now; newId: NewId }): Promise<Screening> {
  const { instrument, index, value } = input;
  if (!wordingFor(instrument, 'en').options.some((option) => option.value === value)) {
    throw new RangeError(`${String(value)} is not an answer to ${instrument}`);
  }
  const all = await loadScreenings(storage);
  const held = input.screeningId ? all.find((screening) => screening.id === input.screeningId && screening.instrument === instrument) : undefined;
  const draft = held ?? findDraft(all, instrument, input.notBefore);
  const answers = [...(draft?.answers ?? [])];
  if (!Number.isInteger(index) || index < 0 || index > answers.length || index >= itemCount(instrument)) {
    throw new RangeError(`question ${index + 1} of ${instrument} cannot be answered before the ones above it`);
  }
  answers[index] = value;

  const base: Screening = draft ?? { id: deps.newId(), instrument, answers: [], total: 0, band: null, item9Flag: false, takenAt: deps.now().toISOString() };
  let saved: Screening;
  if (hasCompleteAnswers(instrument, answers)) {
    const score = scoreInstrument(instrument, answers);
    saved = { ...base, answers, total: score.total, band: score.band, item9Flag: score.item9Flag };
  } else {
    const total = answers.reduce((sum, answer) => sum + answer, 0);
    saved = { ...base, answers, total, band: null, item9Flag: instrument === 'phq9' && Number(answers[8]) > 0 };
  }

  await storage.set(KEYS.screenings, [...all.filter((screening) => screening.id !== saved.id), saved]);
  return saved;
}
