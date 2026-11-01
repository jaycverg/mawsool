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
