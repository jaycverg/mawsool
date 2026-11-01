import { and, eq, gt } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { StaffRole } from '@mawsool/types';
import type { Clock } from '../clock';
import { schema, type Db } from '../db/client';
import { hashesEqual, sha256Hex } from '../security';

export type Principal =
  | { kind: 'person'; personId: string }
  | { kind: 'staff'; staffUserId: string; role: StaffRole; facilityId: string | null };

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
}

/** Matches `Authorization: Bearer <token>` and returns the token. */
function bearerToken(header: string | undefined): string | null {
  const match = /^Bearer ([^\s]+)$/.exec(header ?? '');
  return match?.[1] ?? null;
}

const PERSON_CREDENTIAL = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;

/** The caller's person id on a route declared `person`. Throws if called on any other route, which would be a bug. */
export function personIdOf(request: FastifyRequest): string {
  if (request.principal?.kind !== 'person') throw new Error('this route is not a person route');
  return request.principal.personId;
}

export function sendError(reply: FastifyReply, status: number, error: string, message: string) {
  return reply.code(status).send({ error, message });
}

async function authenticatePerson(db: Db, token: string): Promise<Principal | null> {
  const parts = PERSON_CREDENTIAL.exec(token);
  if (!parts) return null;
  const [, personId, secret] = parts as unknown as [string, string, string];
  const [person] = await db
    .select({ id: schema.persons.id, secretHash: schema.persons.secretHash })
    .from(schema.persons)
    .where(eq(schema.persons.id, personId))
    .limit(1);
  if (!person || !hashesEqual(person.secretHash, sha256Hex(secret))) return null;
  return { kind: 'person', personId: person.id };
}

async function authenticateStaff(db: Db, clock: Clock, token: string): Promise<Principal | null> {
  const [row] = await db
    .select({
      staffUserId: schema.staffUsers.id,
      role: schema.staffUsers.role,
      facilityId: schema.staffUsers.facilityId,
      active: schema.staffUsers.active,
    })
    .from(schema.staffSessions)
    .innerJoin(schema.staffUsers, eq(schema.staffSessions.staffUserId, schema.staffUsers.id))
    .where(and(eq(schema.staffSessions.tokenHash, sha256Hex(token)), gt(schema.staffSessions.expiresAt, clock.now())))
    .limit(1);
  if (!row || !row.active) return null;
  return { kind: 'staff', staffUserId: row.staffUserId, role: row.role, facilityId: row.facilityId };
}

/**
 * Authenticates by the route's declared access value, before body validation runs.
 *
 * - `public`: nothing required.
 * - `person`: a device credential. A staff token is not one, and fails with 401.
 * - `clinician`, `ops`, `admin`: a live staff session whose role equals the declared one, else 403.
 * - `inbound`: a signed request from a connector. It is checked later, once the body has been read (see
 *   `registerInboundAuth`), because the signature covers the body; a bearer token is never accepted on it.
 */
export function registerAuth(app: FastifyInstance, deps: { db: Db; /** The wall clock: a staff session lives in real time, so a demo clock jump never signs anyone out. */ clock: Clock }): void {
  app.decorateRequest('principal', null);
  app.addHook('onRequest', async (request, reply) => {
    const access = request.routeOptions?.config?.access;
    if (access === undefined || access === 'public' || access === 'inbound') return;

    const token = bearerToken(request.headers.authorization);
    if (token === null) return sendError(reply, 401, 'unauthorized', 'Authentication required');

    if (access === 'person') {
      const principal = await authenticatePerson(deps.db, token);
      if (!principal) return sendError(reply, 401, 'unauthorized', 'Authentication required');
      request.principal = principal;
      return;
    }

    const principal = await authenticateStaff(deps.db, deps.clock, token);
    if (principal?.kind !== 'staff') return sendError(reply, 401, 'unauthorized', 'Authentication required');
    if (principal.role !== access) return sendError(reply, 403, 'forbidden', 'This role may not use this route');
    request.principal = principal;
  });
}
