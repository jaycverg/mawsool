import { describe, expect, it } from 'vitest';
import { calendarDaysLeft, calendarDaysUntil, formatDate } from '../src';

describe('formatDate', () => {
  it('writes a day in the deployment time zone with Latin digits in both languages', () => {
    // 20:30 UTC on 4 Nov is already 5 Nov in Dubai.
    expect(formatDate('2026-11-04T20:30:00Z', 'en')).toBe('5 Nov');
    expect(formatDate('2026-11-04T20:30:00Z', 'en', 'long')).toBe('Thu 5 Nov');
    expect(formatDate('2026-11-04T20:30:00Z', 'ar')).toMatch(/^5 /);
    expect(formatDate('2026-11-04T20:30:00Z', 'ar', 'long')).toMatch(/5/);
  });

  it('gives an empty string, not "Invalid Date", for an unreadable value', () => {
    expect(formatDate('not a date', 'en')).toBe('');
  });
});

describe('calendar days to a deadline in Dubai', () => {
  const deadline = '2026-11-05T23:59:59+04:00';

  it('counts the day an instant falls on, not the hours between', () => {
    expect(calendarDaysUntil(deadline, new Date('2026-11-05T00:00:01+04:00'))).toBe(0);
    expect(calendarDaysUntil(deadline, new Date('2026-11-04T23:59:59+04:00'))).toBe(1);
    expect(calendarDaysUntil(deadline, new Date('2026-10-29T08:00:00+04:00'))).toBe(7);
  });

  it('goes negative the day after, so a clinic can say how late a ticket is, and the person’s count stops at zero', () => {
    expect(calendarDaysUntil(deadline, new Date('2026-11-06T00:00:01+04:00'))).toBe(-1);
    expect(calendarDaysUntil(deadline, new Date('2026-11-08T12:00:00+04:00'))).toBe(-3);
    expect(calendarDaysLeft(deadline, new Date('2026-11-08T12:00:00+04:00'))).toBe(0);
    expect(calendarDaysLeft(deadline, new Date('2026-10-29T08:00:00+04:00'))).toBe(7);
  });
});
