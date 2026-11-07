import { describe, expect, it } from 'vitest';
import { buildCrisis } from '../src/metrics/crisis';
import type { CrisisFact } from '../src/metrics/facts';

const SUPPRESSED = { suppressed: true } as const;
/** Twenty-four screens, the first twelve with a number tapped and a confirmed contact five minutes after: ten or more contacts, and a count and shares that clear ten. */
const facts: CrisisFact[] = Array.from({ length: 24 }, (_, i) => ({
  shownAt: new Date(Date.UTC(2026, 0, 1, 0, i)),
  callTapped: i < 12,
  contactConfirmed: i < 12,
  msToContact: i < 12 ? 5 * 60_000 : null,
}));

describe('buildCrisis when the funnel hides the crisis events of the period', () => {
  it('hides the count, both shares and the median, even when ten contacts stand behind the median', () => {
    expect(buildCrisis('all', facts, null, true)).toEqual({
      period: 'all',
      shown: SUPPRESSED,
      calledALine: SUPPRESSED,
      contactConfirmed: SUPPRESSED,
      medianMinutesToContact: SUPPRESSED,
    });
  });

  it('publishes the same events in full when the funnel does not hide them', () => {
    expect(buildCrisis('all', facts, null, false)).toEqual({
      period: 'all',
      shown: 24,
      calledALine: { count: 12, of: 24, percent: 50 },
      contactConfirmed: { count: 12, of: 24, percent: 50 },
      medianMinutesToContact: 5,
    });
  });
});
