import { AdvanceClockRequestSchema, AdvanceClockResultSchema, ClockStateSchema, DemoResetResultSchema, ErrorResponseSchema, type DemoAdvanceStep } from '@mawsool/types';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Clock, OffsetClock } from '../clock';
import type { Db } from '../db/client';
import { createClockMover } from '../demo/clock-store';
import { resetDemo } from '../demo/reset';
import { sweep } from '../sweep';

const DAY_MS = 86_400_000;

/** How far each demo step moves the clock. */
export const ADVANCE_MS: Record<DemoAdvanceStep, number> = { '7d': 7 * DAY_MS, '3w': 21 * DAY_MS, '6w': 42 * DAY_MS };

/**
 * `GET /clock`: the demo clock's offset, for the apps that must agree with the API about "now" (the person app's check-in
 * dates, the clinic queue's overdue marks). It is always registered and open to anyone, because a browser logs a console
 * error for a 404 and the apps must be able to ask whether a demo is running; it holds no person data. With `DEMO_MODE`
 * unset the offset is zero and `demoMode` is false. Moving the clock is a different matter: see `registerDemoRoutes`.
 */
export function registerClockRoute(app: FastifyInstance, deps: { demoClock: OffsetClock | null }): void {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/clock',
    { config: { access: 'public' }, schema: { response: { 200: ClockStateSchema } } },
    async () => ({ demoMode: deps.demoClock !== null, offsetMs: deps.demoClock?.offset ?? 0 }),
  );
}

export interface DemoRouteDeps {
  db: Db;
  clock: OffsetClock;
  /** The wall clock the sweep purges security windows by. */
  securityClock: Clock;
  personAppUrl: string;
}

/**
 * The demo's write controls: move the clock and reset. They are registered only when `DEMO_MODE` is set, so with it unset
 * these paths are 404 and nothing can move time; with it set they are `admin` access. Advancing moves the care clock and
 * then runs the sweep at the new time, so deadlines that have passed turn overdue straight away.
 */
export function registerDemoRoutes(app: FastifyInstance, deps: DemoRouteDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const move = createClockMover(deps.db, deps.clock);

  typed.post(
    '/demo/clock/advance',
    { config: { access: 'admin' }, schema: { body: AdvanceClockRequestSchema, response: { 200: AdvanceClockResultSchema, 400: ErrorResponseSchema } } },
    async (request) => {
      await move(ADVANCE_MS[request.body.by]);
      const swept = await sweep(deps.db, deps.clock, {}, deps.securityClock);
      return { demoMode: true, offsetMs: deps.clock.offset, now: deps.clock.now().toISOString(), markedOverdue: swept.marked };
    },
  );

  typed.post(
    '/demo/reset',
    { config: { access: 'admin' }, schema: { response: { 200: DemoResetResultSchema } } },
    async () => resetDemo({ db: deps.db, clock: deps.clock, personAppUrl: deps.personAppUrl }),
  );
}
