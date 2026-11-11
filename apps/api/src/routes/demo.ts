import { AdvanceClockRequestSchema, AdvanceClockResultSchema, ClockStateSchema, DemoResetResultSchema, ErrorResponseSchema, type DemoAdvanceStep } from '@mawsool/types';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Clock, OffsetClock } from '../clock';
import type { Cipher } from '../crypto';
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
  /** The bundle cipher the reset's seed stores the shared totals of its re-measured tickets with. */
  cipher: Cipher;
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
  const mover = createClockMover(deps.db, deps.clock);

  typed.post(
    '/demo/clock/advance',
    { config: { access: 'admin' }, schema: { body: AdvanceClockRequestSchema, response: { 200: AdvanceClockResultSchema, 400: ErrorResponseSchema } } },
    async (request) => {
      // The move and its sweep are one task on the queue, and the answer is read inside it, so a reset waits for both and
      // the figures in the answer are the ones this advance made.
      return mover.advanceThen(ADVANCE_MS[request.body.by], async () => {
        const swept = await sweep(deps.db, deps.clock, {}, deps.securityClock);
        return { demoMode: true as const, offsetMs: deps.clock.offset, now: deps.clock.now().toISOString(), markedOverdue: swept.marked };
      });
    },
  );

  typed.post(
    '/demo/reset',
    { config: { access: 'admin' }, schema: { response: { 200: DemoResetResultSchema } } },
    async () => mover.exclusive(() => resetDemo({ db: deps.db, cipher: deps.cipher, clock: deps.clock, personAppUrl: deps.personAppUrl })),
  );
}
