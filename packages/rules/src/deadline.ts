import { DEPLOYMENT_UTC_OFFSET_MINUTES } from './config';

const MINUTE_MS = 60_000;

/**
 * The deadline for a hand-off: 23:59:59 Asia/Dubai on the day `windowDays` after the issue day.
 * The deadline falls at the end of a local day, so a clock move of exactly `windowDays` days from the issue
 * instant always lands before it.
 */
export function computeDeadline(issuedAt: Date, windowDays: number): Date {
  const local = new Date(issuedAt.getTime() + DEPLOYMENT_UTC_OFFSET_MINUTES * MINUTE_MS);
  const endOfLocalDayUtcMs = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate() + windowDays,
    23,
    59,
    59,
  );
  return new Date(endOfLocalDayUtcMs - DEPLOYMENT_UTC_OFFSET_MINUTES * MINUTE_MS);
}

/** Days after a ticket is seen at which the person is asked for a repeat PHQ-9 and GAD-7: six weeks. */
export const REMEASURE_DELAY_DAYS = 42;

const DAY_MS = 24 * 60 * MINUTE_MS;

/**
 * The first moment a repeat PHQ-9 and GAD-7 is asked for and accepted: six weeks to the millisecond after the ticket was
 * marked `seen`. It is counted from that event, not from the issue date, and the API and the person app both read it.
 */
export function remeasureAvailableAt(seenAt: Date): Date {
  return new Date(seenAt.getTime() + REMEASURE_DELAY_DAYS * DAY_MS);
}
