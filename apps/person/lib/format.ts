import type { Locale } from '@mawsool/types';

const DAY_MS = 86_400_000;

/**
 * Formats a date in the person's language and the deployment time zone. Latin digits in both languages, like the
 * boards. An unreadable date gives an empty string rather than "Invalid Date".
 */
export function formatDate(iso: string, locale: Locale, style: 'short' | 'long' = 'short'): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '';
  const tag = locale === 'ar' ? 'ar-AE-u-nu-latn' : 'en-GB';
  const options: Intl.DateTimeFormatOptions =
    style === 'long' ? { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Dubai' } : { day: 'numeric', month: 'short', timeZone: 'Asia/Dubai' };
  return new Intl.DateTimeFormat(tag, options).format(time);
}

export type Span = { unit: 'week' | 'day'; count: number };

/** The time between two check-ins in the unit a person would say it: whole weeks from a week up, else days. */
export function spanBetween(fromIso: string, toIso: string): Span {
  const days = Math.max(1, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / DAY_MS));
  return days >= 7 ? { unit: 'week', count: Math.round(days / 7) } : { unit: 'day', count: days };
}

/** Adds whole weeks to an instant. */
export function addWeeks(iso: string, weeks: number): string {
  return new Date(Date.parse(iso) + weeks * 7 * DAY_MS).toISOString();
}

export type Part = 'morning' | 'afternoon' | 'evening';

/** Part of the day for the greeting, from the hour in the deployment time zone. */
export function partOfDay(date: Date): Part {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: 'Asia/Dubai' }).format(date));
  if (hour < 12) return 'morning';
  return hour < 17 ? 'afternoon' : 'evening';
}

/** The calendar day an instant falls on in the deployment time zone, as a day number (UTC+4, no daylight saving). */
function dubaiDay(ms: number): number {
  return Math.floor((ms + 4 * 3_600_000) / DAY_MS);
}

/**
 * Days left until a deadline, counted as calendar days in Asia/Dubai: the day it is issued on is day 0, so a 7-day
 * promise issued this morning reads 7, not 8, and the deadline day itself reads 0. Never negative.
 */
export function calendarDaysLeft(deadlineIso: string, now: Date): number {
  return Math.max(0, dubaiDay(Date.parse(deadlineIso)) - dubaiDay(now.getTime()));
}
