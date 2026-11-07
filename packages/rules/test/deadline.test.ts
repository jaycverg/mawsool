import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { REMEASURE_DELAY_DAYS, computeDeadline, remeasureAvailableAt } from '../src';

const DAY_MS = 86_400_000;

describe('computeDeadline', () => {
  it('falls at 23:59:59 Asia/Dubai on the target day', () => {
    // Issued Sunday 1 Nov 2026 at 10:00 Dubai (06:00 UTC); +7 days is Sunday 8 Nov.
    expect(computeDeadline(new Date('2026-11-01T06:00:00Z'), 7).toISOString()).toBe('2026-11-08T19:59:59.000Z');
  });

  it('uses the Dubai calendar day, not the UTC day, as the issue day', () => {
    // 22:30 UTC on 1 Nov is 02:30 on 2 Nov in Dubai, so +7 lands on 9 Nov Dubai.
    expect(computeDeadline(new Date('2026-11-01T22:30:00Z'), 7).toISOString()).toBe('2026-11-09T19:59:59.000Z');
    // 19:30 UTC on 1 Nov is 23:30 on 1 Nov in Dubai, so +7 lands on 8 Nov Dubai.
    expect(computeDeadline(new Date('2026-11-01T19:30:00Z'), 7).toISOString()).toBe('2026-11-08T19:59:59.000Z');
  });

  it('crosses month and year ends', () => {
    expect(computeDeadline(new Date('2026-12-28T08:00:00Z'), 7).toISOString()).toBe('2027-01-04T19:59:59.000Z');
  });

  it('with a zero-day window ends the same Dubai day', () => {
    expect(computeDeadline(new Date('2026-11-01T06:00:00Z'), 0).toISOString()).toBe('2026-11-01T19:59:59.000Z');
  });

  it('is always after the issue time and a clock move of the window lands strictly before it', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2026-01-01T00:00:00Z'), max: new Date('2028-01-01T00:00:00Z'), noInvalidDate: true }),
        fc.constantFrom(7, 14),
        (issuedAt, windowDays) => {
          const deadline = computeDeadline(issuedAt, windowDays);
          expect(deadline.getTime()).toBeGreaterThan(issuedAt.getTime());
          expect(issuedAt.getTime() + windowDays * DAY_MS).toBeLessThan(deadline.getTime());
          // And a move of the window plus a day lands after it, so the deadline really is the end of a day.
          expect(issuedAt.getTime() + (windowDays + 1) * DAY_MS).toBeGreaterThan(deadline.getTime());
        },
      ),
    );
  });
});

describe('remeasureAvailableAt', () => {
  it('is six weeks to the millisecond after the seen event', () => {
    expect(REMEASURE_DELAY_DAYS).toBe(42);
    const seen = new Date('2026-11-09T10:15:30.250+04:00');
    expect(remeasureAvailableAt(seen).toISOString()).toBe(new Date('2026-12-21T10:15:30.250+04:00').toISOString());
    expect(remeasureAvailableAt(seen).getTime() - seen.getTime()).toBe(42 * 86_400_000);
  });
});
