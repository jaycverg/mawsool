import { SUPPRESSION_THRESHOLD } from '@mawsool/rules';

/** What an aggregate returns in place of a number when too few people stand behind it. */
export interface Suppressed {
  suppressed: true;
}

/**
 * Small-number suppression for every aggregate the ops routes return: a count under the threshold (k = 10) is replaced
 * by `{ suppressed: true }`, so it cannot be used to single out a group. A zero count is also under the threshold and is
 * suppressed. Complementary suppression across the cells of one row is the caller's job when it publishes totals.
 */
export function suppress<T>(count: number, value: T, threshold: number = SUPPRESSION_THRESHOLD): T | Suppressed {
  return count < threshold ? { suppressed: true } : value;
}
