import { ClockStateSchema } from '@mawsool/types';

/**
 * The demo clock as an app sees it. The API owns the offset (`GET /clock`); a browser app that shows or compares dates
 * (the person app's check-in dates and countdowns, the clinic queue's overdue marks) adds it to the device clock so it
 * agrees with the API about "now". With no demo running the offset is zero and nothing here changes anything.
 *
 * Reading the offset is a best-effort side read: callers never wait for it, and nothing that matters for a person's
 * safety (the crisis path, matching) depends on it. The last offset an app saw is kept by the app, so it still works
 * when the phone is offline.
 */
let offsetMs = 0;
const listeners = new Set<() => void>();

/** How far the demo clock is ahead of the device clock, in milliseconds. */
export function demoOffsetMs(): number {
  return offsetMs;
}

/** Sets the offset and tells whatever is showing a date. A value that is not a whole, non-negative number is ignored. */
export function setDemoOffsetMs(next: number): void {
  if (!Number.isInteger(next) || next < 0 || next === offsetMs) return;
  offsetMs = next;
  for (const listener of listeners) listener();
}

/** The current time on the demo clock: the device clock plus the offset. */
export function demoNow(): Date {
  return new Date(Date.now() + offsetMs);
}

/** Calls `listener` whenever the offset changes. Returns the way to stop. */
export function subscribeDemoOffset(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Asks the API for the demo clock's offset. Returns the offset, or null when the answer is missing, unreadable or the
 * server cannot be reached. It never throws, and the endpoint is always there (a 404 would log a console error), so a
 * null is a real failure and the caller keeps what it had.
 */
export async function fetchDemoOffsetMs(options: { fetch: typeof fetch; apiUrl: string }): Promise<number | null> {
  try {
    const response = await options.fetch(`${options.apiUrl}/clock`, { method: 'GET', signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return null;
    const parsed = ClockStateSchema.safeParse(await response.json());
    return parsed.success ? parsed.data.offsetMs : null;
  } catch {
    return null;
  }
}
