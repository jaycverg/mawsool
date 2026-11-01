import type { Locale } from '@mawsool/types';

const DAY_MS = 86_400_000;

/**
 * Formats a date in the reader's language and the deployment time zone. Latin digits in both languages, like the
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

/** The calendar day an instant falls on in the deployment time zone, as a day number (UTC+4, no daylight saving). */
function dubaiDay(ms: number): number {
  return Math.floor((ms + 4 * 3_600_000) / DAY_MS);
}

/**
 * Calendar days from `now` to a deadline in Asia/Dubai, negative once the deadline's day is past: the day an instant
 * falls on is what counts, not the hours in between.
 */
export function calendarDaysUntil(deadlineIso: string, now: Date): number {
  return dubaiDay(Date.parse(deadlineIso)) - dubaiDay(now.getTime());
}

/**
 * Days left until a deadline, counted as calendar days in Asia/Dubai: the day it is issued on is day 0, so a 7-day
 * promise issued this morning reads 7, not 8, and the deadline day itself reads 0. Never negative.
 */
export function calendarDaysLeft(deadlineIso: string, now: Date): number {
  return Math.max(0, calendarDaysUntil(deadlineIso, now));
}
