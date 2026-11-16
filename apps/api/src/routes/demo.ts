import {
  AdvanceClockRequestSchema,
  AdvanceClockResultSchema,
  ClockStateSchema,
  DEMO_GUEST_ACCOUNTS,
  DemoResetResultSchema,
  ErrorResponseSchema,
  GuestSessionRequestSchema,
  NouraInviteResultSchema,
  RateLimitedSchema,
  ResetCooldownSchema,
  SessionSchema,
  type DemoAdvanceStep,
  type DemoResetResult,
} from '@mawsool/types';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Clock, OffsetClock } from '../clock';
import type { Cipher } from '../crypto';
import { schema, type Db } from '../db/client';
import { createClockMover } from '../demo/clock-store';
import { issueNouraInvite, resetDemo } from '../demo/reset';
import { sweep } from '../sweep';
import { issueStaffSession } from './auth';

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
  /** The wall clock the sweep purges security windows by, staff sessions live on, and the reset cool-down is read on. */
  securityClock: Clock;
  personAppUrl: string;
  /** Milliseconds after a reset during which a reset asked for through the route is refused. 0 (the default) means none. */
  resetCooldownMs?: number;
}

/** What a reset answers: the reset's result, or how long until a reset is allowed again. */
export type DemoResetOutcome = { kind: 'reset'; result: DemoResetResult } | { kind: 'cooldown'; retryAfterSeconds: number };

/**
 * One reset, as the route and the nightly job both run it. It closes over the reset's dependencies, the clock mover and the time
 * of the last reset, and reads, compares and sets that time inside the mover's queue, so two presses queued together give one
 * reset and one cool-down answer. With `cooldown: false` (the nightly job) the check is skipped but the time is still set.
 */
export type DemoReset = (options: { cooldown: boolean }) => Promise<DemoResetOutcome>;

const guestAccountEmails = new Set(DEMO_GUEST_ACCOUNTS.map((account) => account.email));

/**
 * The demo's write controls: move the clock, reset, make a fresh invite for Noura, and sign in as a demo guest. They are
 * registered only when `DEMO_MODE` is set, so with it unset these paths are 404 and nothing can move time or open a
 * session; with it set the first three are `admin` access and the guest sign-in is open to anyone, for the five seeded
 * demo accounts only. Advancing moves the care clock and then runs the sweep at the new time, so deadlines that have
 * passed turn overdue straight away. Returns the reset the nightly job runs.
 */
export function registerDemoRoutes(app: FastifyInstance, deps: DemoRouteDeps): DemoReset {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const mover = createClockMover(deps.db, deps.clock);
  const cooldownMs = deps.resetCooldownMs ?? 0;
  let lastResetAt: number | null = null;

  const demoReset: DemoReset = ({ cooldown }) =>
    mover.exclusive(async (): Promise<DemoResetOutcome> => {
      if (cooldown && cooldownMs > 0 && lastResetAt !== null) {
        const elapsed = deps.securityClock.now().getTime() - lastResetAt;
        if (elapsed < cooldownMs) return { kind: 'cooldown', retryAfterSeconds: Math.max(1, Math.ceil((cooldownMs - elapsed) / 1000)) };
      }
      const result = await resetDemo({ db: deps.db, cipher: deps.cipher, clock: deps.clock, securityClock: deps.securityClock, personAppUrl: deps.personAppUrl });
      lastResetAt = deps.securityClock.now().getTime();
      return { kind: 'reset', result };
    });

  typed.post(
    '/demo/guest-session',
    {
      config: { access: 'public', rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: { body: GuestSessionRequestSchema, response: { 200: SessionSchema, 429: RateLimitedSchema } },
    },
    async (request, reply) => {
      const email = request.body.email.toLowerCase();
      // Anything but a seeded, active demo account is the same 404 the router gives an unknown path, so the route reveals nothing.
      if (!guestAccountEmails.has(email)) return reply.callNotFound();
      const [user] = await deps.db
        .select({ id: schema.staffUsers.id, role: schema.staffUsers.role, facilityId: schema.staffUsers.facilityId, active: schema.staffUsers.active })
        .from(schema.staffUsers)
        .where(eq(schema.staffUsers.email, email))
        .limit(1);
      if (!user?.active) return reply.callNotFound();
      // Role and facility come from the row, never from the request.
      return issueStaffSession(deps.db, deps.securityClock, { id: user.id, role: user.role, facilityId: user.facilityId });
    },
  );

  typed.post(
    '/demo/clock/advance',
    {
      config: { access: 'admin', rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: { body: AdvanceClockRequestSchema, response: { 200: AdvanceClockResultSchema, 400: ErrorResponseSchema, 429: RateLimitedSchema } },
    },
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
    {
      config: { access: 'admin', rateLimit: { max: 3, timeWindow: '1 minute' } },
      schema: { response: { 200: DemoResetResultSchema, 429: z.union([ResetCooldownSchema, RateLimitedSchema]) } },
    },
    async (_request, reply) => {
      const outcome = await demoReset({ cooldown: true });
      // Sent directly, not thrown: only the limiter's thrown 429 is mapped to `rate_limited`, so the two stay distinct.
      if (outcome.kind === 'cooldown') {
        return reply.code(429).send({ error: 'reset_cooldown' as const, message: 'The demo was reset a moment ago', retryAfterSeconds: outcome.retryAfterSeconds });
      }
      return outcome.result;
    },
  );

  typed.post(
    '/demo/noura-invite',
    {
      config: { access: 'admin', rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: { response: { 200: NouraInviteResultSchema, 429: RateLimitedSchema } },
    },
    async () => mover.exclusive(() => issueNouraInvite(deps.db, deps.clock, deps.personAppUrl)),
  );

  return demoReset;
}
