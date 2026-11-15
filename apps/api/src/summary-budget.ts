import type { Clock } from './clock';

/** A daily allowance of AI calls. */
export interface SummaryBudget {
  /** Spends one call from today's allowance. False when today's allowance is already spent, and then nothing is counted. */
  take(): boolean;
}

/**
 * Counts AI calls per UTC day, in memory, on the clock it is given (the wall clock: a demo clock jump must neither refill
 * nor drain it). After `limitPerDay` calls `take()` answers false until the next UTC day, so the caller drafts from the
 * template instead. The count restarts at zero when the process restarts; the backstop beyond it is the provider's own
 * prepaid credit and spend limit. A limit of 0 allows no AI call at all.
 */
export function createSummaryBudget(limitPerDay: number, clock: Clock): SummaryBudget {
  let day = '';
  let used = 0;
  return {
    take() {
      const today = clock.now().toISOString().slice(0, 10);
      if (today !== day) {
        day = today;
        used = 0;
      }
      if (used >= limitPerDay) return false;
      used += 1;
      return true;
    },
  };
}
