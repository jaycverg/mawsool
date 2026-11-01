import type { Coverage, InsuranceClass, Tier } from '@mawsool/types';
import { SAMPLE_COVERAGE } from './config';

/**
 * Indicative coverage for an insurance class and tier, from the sample table in `config.ts`.
 * Always presented as "Indicative only"; it is not an eligibility check.
 */
export function indicativeCoverage(insurance: InsuranceClass, tier: Tier): Coverage {
  return SAMPLE_COVERAGE[insurance][tier];
}
