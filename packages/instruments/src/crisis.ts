import type { CrisisEvaluation, ItemAnswer } from './types';

const NOT_TRIGGERED: CrisisEvaluation = { triggered: false, trigger: null, reason: 'no_trigger' };
const NOT_A_TRIGGER_ITEM: CrisisEvaluation = { triggered: false, trigger: null, reason: 'not_a_trigger_item' };

/**
 * Evaluates one answer the moment it is given. Deterministic and pure: no network, no clock, no AI.
 *
 * Fires on PHQ-9 item 9 above 0 and on a yes to any C-SSRS screener item. Item numbers are 1-based, as printed.
 * An invalid value on a trigger item fires, because failing safe means showing help; it is reported as
 * `invalid_answer` so callers can tell it apart. Answers to every other item never fire.
 */
export function evaluateCrisis(answer: ItemAnswer): CrisisEvaluation {
  const { instrument, itemNumber, value } = answer;

  if (instrument === 'phq9' && itemNumber === 9) {
    if (value === 0) return NOT_TRIGGERED;
    if (Number.isInteger(value) && value >= 1 && value <= 3) {
      return { triggered: true, trigger: 'phq9_item9', reason: 'item9_positive' };
    }
    return { triggered: true, trigger: 'phq9_item9', reason: 'invalid_answer' };
  }

  if (instrument === 'cssrs' && Number.isInteger(itemNumber) && itemNumber >= 1 && itemNumber <= 6) {
    if (value === 0) return NOT_TRIGGERED;
    if (value === 1) return { triggered: true, trigger: 'cssrs', reason: 'cssrs_yes' };
    return { triggered: true, trigger: 'cssrs', reason: 'invalid_answer' };
  }

  return NOT_A_TRIGGER_ITEM;
}

/**
 * Evaluates a full set of answers for one instrument, as when a stored check-in is re-read.
 * Returns the first triggering answer, or the not-triggered result when none fires.
 *
 * A stored row that lost its answers altogether (null or missing, as a damaged row can be) fails safe the way an invalid
 * trigger answer does, where the answers are the only record of a trigger: a C-SSRS row has no stored flag (every yes is an
 * answer), so with its answers gone it fires as `invalid_answer` and the person is shown help, which one tap resolves. A
 * PHQ-9 row does not fire: the store sets its item 9 flag whenever item 9 is answered above 0, so a row whose flag is
 * false and whose answers are gone has no recorded trigger, and a row with the flag true fires from the flag where rows
 * are read (`hasUnresolvedCrisis`).
 */
export function evaluateCrisisForAnswers(instrument: ItemAnswer['instrument'], answers: readonly number[] | null | undefined): CrisisEvaluation {
  if (!Array.isArray(answers)) return instrument === 'cssrs' ? { triggered: true, trigger: 'cssrs', reason: 'invalid_answer' } : NOT_TRIGGERED;
  for (const [index, value] of answers.entries()) {
    const result = evaluateCrisis({ instrument, itemNumber: index + 1, value });
    if (result.triggered) return result;
  }
  return NOT_TRIGGERED;
}
