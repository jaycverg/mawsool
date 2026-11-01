import type { CrisisResponse, MetricPeriod } from '@mawsool/types';
import { suppress } from '../suppress';
import type { CrisisFact } from './facts';
import { percentile, rateOrSuppressed } from './protect';

const MINUTE_MS = 60_000;

/**
 * Crisis-response completion: screens shown, the share that tapped a number, the share with human contact confirmed, and
 * the median time from the trigger to that contact. Every number is suppressed under ten: the count of screens, each share
 * (which needs its part, its whole and what is left over to clear ten) and the median (on the contacts it is taken over).
 */
export function buildCrisis(period: MetricPeriod, facts: readonly CrisisFact[], since: Date | null): CrisisResponse {
  const inPeriod = facts.filter((fact) => since === null || fact.shownAt >= since);
  const contacts = inPeriod.filter((fact) => fact.contactConfirmed && fact.msToContact !== null).map((fact) => Math.max(0, fact.msToContact!) / MINUTE_MS);
  const median = percentile(contacts, 0.5);
  return {
    period,
    shown: suppress(inPeriod.length, inPeriod.length),
    calledALine: rateOrSuppressed(inPeriod.filter((fact) => fact.callTapped).length, inPeriod.length),
    contactConfirmed: rateOrSuppressed(inPeriod.filter((fact) => fact.contactConfirmed).length, inPeriod.length),
    medianMinutesToContact: suppress(contacts.length, Math.round((median ?? 0) * 10) / 10),
  };
}
