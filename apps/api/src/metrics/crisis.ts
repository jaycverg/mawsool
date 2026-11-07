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
export function buildCrisis(period: MetricPeriod, facts: readonly CrisisFact[], since: Date | null, countHidden = false): CrisisResponse {
  const inPeriod = facts.filter((fact) => since === null || fact.shownAt >= since);
  const contacts = inPeriod.filter((fact) => fact.contactConfirmed && fact.msToContact !== null).map((fact) => Math.max(0, fact.msToContact!) / MINUTE_MS);
  // When the funnel hides the crisis events of this period (to keep a small cell from being worked out), the count and every
  // share over it go too: a share names the count it divides, and the funnel's difference would give it back. The median is
  // hidden outright: the contacts are a part of those events and the funnel hides a count that is small, so the median would be
  // suppressed on its own count anyway; hiding it here keeps a computed-but-never-shown branch out of the code.
  if (countHidden) {
    const hidden = { suppressed: true } as const;
    return { period, shown: hidden, calledALine: hidden, contactConfirmed: hidden, medianMinutesToContact: hidden };
  }
  const median = percentile(contacts, 0.5);
  return {
    period,
    shown: suppress(inPeriod.length, inPeriod.length),
    calledALine: rateOrSuppressed(inPeriod.filter((fact) => fact.callTapped).length, inPeriod.length),
    contactConfirmed: rateOrSuppressed(inPeriod.filter((fact) => fact.contactConfirmed).length, inPeriod.length),
    medianMinutesToContact: suppress(contacts.length, Math.round((median ?? 0) * 10) / 10),
  };
}
