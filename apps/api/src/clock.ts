/**
 * The single source of "now" for the API. Every other module reads the time through a `Clock` it is given,
 * and a lint rule forbids `Date.now()` and `new Date()` anywhere else under `src/`, so a sweep, a deadline and
 * a person app can never disagree about the time.
 */
export interface Clock {
  now(): Date;
}

/** The wall clock. */
export const systemClock: Clock = {
  now: () => new Date(),
};

/**
 * A clock that only moves when told to. Tests use it directly; the demo clock builds on it.
 * Nothing here is reachable from a route.
 */
export class ManualClock implements Clock {
  private current: Date;

  constructor(start: Date) {
    this.current = new Date(start.getTime());
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  set(to: Date): void {
    this.current = new Date(to.getTime());
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}
