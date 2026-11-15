import {
  ErrorResponseSchema,
  MagicLinkRequestSchema,
  RateLimitedSchema,
  SessionSchema,
  VerifyMagicLinkRequestSchema,
  type Session,
} from '@mawsool/types';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Clock } from '../clock';
import { schema, type Db } from '../db/client';
import type { Notifier } from '../notifier';
import { sendError } from '../plugins/auth';
import { randomToken, sha256Hex } from '../security';
import { STAFF_LINK_LOCALE, staffSignInLink, type StaffAppUrls } from '../staff-links';

/** A sign-in link works once, for 15 minutes. */
export const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;
/** A staff session lasts one working day. */
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export interface AuthRouteDeps {
  db: Db;
  /** The wall clock: a sign-in link and a session live in real time, never the demo clock. */
  clock: Clock;
  notifier: Notifier;
  /** Where each role's sign-in link points. */
  staffApps: StaffAppUrls;
  log: { error(object: Record<string, unknown>, message: string): void };
}

/**
 * Staff magic-link sign-in.
 *
 * POST /auth/magic-link always answers 202 whether or not the address is a staff user, so it cannot be used
 * to find out who has an account. For a known active user it stores only the SHA-256 of a random token and
 * hands the link to the notifier, which logs it. A notifier failure is logged and still answers 202.
 *
 * POST /auth/verify consumes a link in one atomic update, so a link works once, and only before it expires.
 */
export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post(
    '/auth/magic-link',
    {
      config: { access: 'public', rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: { body: MagicLinkRequestSchema, response: { 202: z.object({ status: z.literal('accepted') }), 429: RateLimitedSchema } },
    },
    async (request, reply) => {
      const email = request.body.email.toLowerCase();
      const [user] = await deps.db
        .select({ id: schema.staffUsers.id, role: schema.staffUsers.role })
        .from(schema.staffUsers)
        .where(and(eq(schema.staffUsers.email, email), eq(schema.staffUsers.active, true)))
        .limit(1);
      if (user) {
        const now = deps.clock.now();
        const token = randomToken();
        const expiresAt = new Date(now.getTime() + MAGIC_LINK_TTL_MS);
        await deps.db.insert(schema.staffMagicLinks).values({
          staffUserId: user.id,
          tokenHash: sha256Hex(token),
          createdAt: now,
          expiresAt,
        });
        try {
          await deps.notifier.send({ template: 'staff_sign_in', locale: STAFF_LINK_LOCALE, to: email, link: staffSignInLink(user.role, token, deps.staffApps), expiresAt });
        } catch (error) {
          deps.log.error({ err: error }, 'could not deliver the staff sign-in link');
        }
      }
      return reply.code(202).send({ status: 'accepted' as const });
    },
  );

  typed.post(
    '/auth/verify',
    {
      config: { access: 'public' },
      schema: {
        body: VerifyMagicLinkRequestSchema,
        response: { 200: SessionSchema, 401: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      const now = deps.clock.now();
      const [link] = await deps.db
        .update(schema.staffMagicLinks)
        .set({ usedAt: now })
        .where(
          and(
            eq(schema.staffMagicLinks.tokenHash, sha256Hex(request.body.token)),
            isNull(schema.staffMagicLinks.usedAt),
            gt(schema.staffMagicLinks.expiresAt, now),
          ),
        )
        .returning({ staffUserId: schema.staffMagicLinks.staffUserId });
      if (!link) return sendError(reply, 401, 'invalid_link', 'This link is invalid, expired or already used');

      const [user] = await deps.db
        .select({ role: schema.staffUsers.role, facilityId: schema.staffUsers.facilityId, active: schema.staffUsers.active })
        .from(schema.staffUsers)
        .where(eq(schema.staffUsers.id, link.staffUserId))
        .limit(1);
      if (!user?.active) return sendError(reply, 401, 'invalid_link', 'This link is invalid, expired or already used');

      return reply.code(200).send(await issueStaffSession(deps.db, deps.clock, { id: link.staffUserId, role: user.role, facilityId: user.facilityId }));
    },
  );
}

/**
 * Opens a staff session for a user and returns what the front end stores. The session is a random token whose SHA-256 is the
 * only thing kept, and it lives `SESSION_TTL_MS` from now on the wall clock (`clock` is the security clock, never the demo
 * clock). Shared by the sign-in link's verify route and the demo's guest sign-in, so the two cannot issue different sessions.
 */
export async function issueStaffSession(
  db: Db,
  clock: Clock,
  user: { id: string; role: Session['role']; facilityId: string | null },
): Promise<Session> {
  const now = clock.now();
  const sessionToken = randomToken();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await db.insert(schema.staffSessions).values({ staffUserId: user.id, tokenHash: sha256Hex(sessionToken), createdAt: now, expiresAt });
  return { sessionToken, expiresAt: expiresAt.toISOString(), role: user.role, facilityId: user.facilityId };
}
