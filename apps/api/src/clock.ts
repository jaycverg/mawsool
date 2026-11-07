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

/**
 * The demo clock: another clock's time plus a movable offset. It is the only way the API's idea of "care time"
 * (deadlines, the sweep, the day-7 check, ticket events, invite expiry) can differ from the wall, and it exists only
 * when `DEMO_MODE` is set; with the flag unset nothing builds one and the offset the API reports is always zero.
 * Security windows (staff sessions, sign-in links, the signed-request timestamp window and nonce retention) never
 * read this clock, because a front door signs with real time and a three-week jump must not sign staff out.
 */
export class OffsetClock implements Clock {
  private offsetMs = 0;

  constructor(private readonly base: Clock) {}

  now(): Date {
    return new Date(this.base.now().getTime() + this.offsetMs);
  }

  /** How far ahead of the base clock this one is, in milliseconds. */
  get offset(): number {
    return this.offsetMs;
  }

  /** Moves time forward. A negative step is refused: the demo only ever goes forward until it is reset. */
  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw new Error('the demo clock only moves forward');
    this.offsetMs += ms;
  }

  /** Puts the offset back to a value stored earlier, when the API starts. */
  setOffset(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw new Error('the demo clock offset must be zero or more');
    this.offsetMs = ms;
  }

  /** The base clock's time, without the offset. */
  baseNow(): Date {
    return this.base.now();
  }

  /** Back to the base clock's time. */
  reset(): void {
    this.offsetMs = 0;
  }
}
