const DAY_MS = 86_400_000;

// Dates are formatted by the same code in every app, so the person and the clinic read the same day.
export { calendarDaysLeft, formatDate } from '@mawsool/ui';

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
