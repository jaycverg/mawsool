import { describe, expect, it } from 'vitest';
import { ManualClock, systemClock } from '../src/clock';

describe('clock', () => {
  it('systemClock returns the current time', () => {
    const before = Date.now();
    const now = systemClock.now().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });

  it('ManualClock only moves when told to, and hands out copies', () => {
    const clock = new ManualClock(new Date('2026-11-01T00:00:00Z'));
    const first = clock.now();
    first.setUTCFullYear(1999);
    expect(clock.now().toISOString()).toBe('2026-11-01T00:00:00.000Z');
    clock.advance(7 * 86_400_000);
    expect(clock.now().toISOString()).toBe('2026-11-08T00:00:00.000Z');
    clock.set(new Date('2030-01-01T00:00:00Z'));
    expect(clock.now().toISOString()).toBe('2030-01-01T00:00:00.000Z');
  });

  it('does not alias the start date it was given', () => {
    const start = new Date('2026-11-01T00:00:00Z');
    const clock = new ManualClock(start);
    start.setUTCFullYear(1999);
    expect(clock.now().getUTCFullYear()).toBe(2026);
  });
});
