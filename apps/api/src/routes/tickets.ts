import { ErrorResponseSchema, StaffTicketViewSchema } from '@mawsool/types';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../db/client';
import { shareEnded } from '../consents/service';
import { sendError } from '../plugins/auth';
import { facilityScopedTicket } from '../plugins/facility-scope';

/**
 * Staff ticket read, minimal on purpose: ticket fields only, no bundle. A ticket whose share the person ended answers 410. The clinician detail view extends it.
 * Facility scoping is applied by the preHandler, so a clinician only ever reaches tickets addressed to their
 * own facility.
 */
export function registerTicketRoutes(app: FastifyInstance, deps: { db: Db }): void {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/tickets/:id',
    {
      config: { access: 'clinician', facilityScoped: true },
      preHandler: facilityScopedTicket(deps.db),
      schema: {
        params: z.object({ id: z.uuid() }),
        response: { 200: StaffTicketViewSchema, 404: ErrorResponseSchema, 410: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      const ticket = request.scopedTicket!;
      // Once the person has ended the share the clinic gets nothing about the ticket either: not even its code or deadline.
      if (await shareEnded(deps.db, ticket.id)) return sendError(reply, 410, 'withdrawn', 'Withdrawn by the person');
      return {
        id: ticket.id,
        shortCode: ticket.shortCode,
        tier: ticket.tier,
        state: ticket.state,
        language: ticket.language,
        deadlineAt: ticket.deadlineAt.toISOString(),
        source: ticket.source,
        serviceId: ticket.serviceId,
        createdAt: ticket.createdAt.toISOString(),
      };
    },
  );
}
