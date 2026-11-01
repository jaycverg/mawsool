import { CrisisEventReceiptSchema, CrisisEventSubmissionSchema, ErrorResponseSchema, type CrisisEventSubmission } from '@mawsool/types';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { schema, type Db } from '../db/client';

type CrisisRow = typeof schema.crisisEvents.$inferSelect;

/**
 * Folds a later snapshot of the same crisis event into the stored one. Facts only accumulate: what was shown,
 * when and in which language never changes; a confirmed contact or a resolution, once recorded, is kept; the
 * latest number tapped wins. Replaying any snapshot, in any order, leaves the row as it was.
 */
export function mergeCrisisEvent(existing: CrisisRow, incoming: CrisisEventSubmission): Omit<CrisisRow, 'id' | 'trigger' | 'shownAt' | 'locale' | 'followUpAt'> {
  const contactKept = existing.humanContactConfirmed;
  return {
    callTapped: incoming.callTapped ?? existing.callTapped,
    contextShared: existing.contextShared || incoming.contextShared,
    humanContactConfirmed: contactKept || incoming.humanContactConfirmed,
    contactSource: contactKept ? existing.contactSource : incoming.contactSource,
    contactAt: contactKept ? existing.contactAt : incoming.contactAt ? new Date(incoming.contactAt) : null,
    resolvedAt: existing.resolvedAt ?? (incoming.resolvedAt ? new Date(incoming.resolvedAt) : null),
  };
}

/**
 * POST /crisis-events records that a crisis screen was shown and what happened on it. It is idempotent on the id
 * the device generated: the first snapshot creates the row (201), later ones fold into it (200), so a queued
 * event that is sent twice arrives once.
 *
 * The caller must be a registered device, but the handler never reads who it is: the row has no person column, no
 * item answers and no free text, so a crisis can never be traced to a person or a ticket. The body schema is
 * strict, so a request that adds any of those is refused.
 */
export function registerCrisisEventRoutes(app: FastifyInstance, deps: { db: Db }): void {
  app.withTypeProvider<ZodTypeProvider>().post(
    '/crisis-events',
    {
      config: { access: 'person' },
      schema: {
        body: CrisisEventSubmissionSchema,
        response: { 200: CrisisEventReceiptSchema, 201: CrisisEventReceiptSchema, 400: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      const event = request.body;
      const created = await deps.db.transaction(async (tx) => {
        const inserted = await tx
          .insert(schema.crisisEvents)
          .values({
            id: event.id,
            trigger: event.trigger,
            shownAt: new Date(event.shownAt),
            callTapped: event.callTapped,
            contextShared: event.contextShared,
            humanContactConfirmed: event.humanContactConfirmed,
            contactSource: event.contactSource,
            contactAt: event.contactAt ? new Date(event.contactAt) : null,
            resolvedAt: event.resolvedAt ? new Date(event.resolvedAt) : null,
            locale: event.locale,
          })
          .onConflictDoNothing({ target: schema.crisisEvents.id })
          .returning({ id: schema.crisisEvents.id });
        if (inserted.length > 0) return true;

        const [existing] = await tx.select().from(schema.crisisEvents).where(eq(schema.crisisEvents.id, event.id)).for('update');
        await tx.update(schema.crisisEvents).set(mergeCrisisEvent(existing!, event)).where(eq(schema.crisisEvents.id, event.id));
        return false;
      });
      return reply.code(created ? 201 : 200).send({ id: event.id, created });
    },
  );
}
