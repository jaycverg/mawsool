import {
  ErrorResponseSchema,
  RegisterPersonRequestSchema,
  RegisterPersonResponseSchema,
} from '@mawsool/types';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Clock } from '../clock';
import { schema, type Db } from '../db/client';
import { sendError } from '../plugins/auth';
import { hashesEqual, sha256Hex } from '../security';

/**
 * POST /persons registers a device. The device generates the id and secret on first run and registers at
 * its first server write, so check-in needs no network. The server stores only the secret's hash and the
 * locale: no name, email, Emirates ID or phone is collected, and the body schema strips anything else.
 *
 * Registering the same id with the same secret is idempotent (200); the same id with a different secret is
 * refused (409) so a stranger cannot take over a registered id.
 */
export function registerPersonRoutes(app: FastifyInstance, deps: { db: Db; clock: Clock }): void {
  app.withTypeProvider<ZodTypeProvider>().post(
    '/persons',
    {
      config: { access: 'public' },
      schema: {
        body: RegisterPersonRequestSchema,
        response: { 200: RegisterPersonResponseSchema, 201: RegisterPersonResponseSchema, 409: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      const { id, secret, locale } = request.body;
      const secretHash = sha256Hex(secret);
      const inserted = await deps.db
        .insert(schema.persons)
        .values({ id, secretHash, locale, equityOptIn: false, createdAt: deps.clock.now() })
        .onConflictDoNothing({ target: schema.persons.id })
        .returning({ id: schema.persons.id });
      if (inserted.length > 0) return reply.code(201).send({ id, created: true });

      const [existing] = await deps.db
        .select({ secretHash: schema.persons.secretHash })
        .from(schema.persons)
        .where(eq(schema.persons.id, id))
        .limit(1);
      if (existing && hashesEqual(existing.secretHash, secretHash)) return reply.code(200).send({ id, created: false });
      return sendError(reply, 409, 'conflict', 'This id is already registered');
    },
  );
}
