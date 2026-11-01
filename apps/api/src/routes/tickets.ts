import { ErrorResponseSchema, StaffTicketViewSchema } from '@mawsool/types';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../db/client';
import { facilityScopedTicket } from '../plugins/facility-scope';

/**
 * Staff ticket read, minimal on purpose: ticket fields only, no bundle. The clinician detail view extends it.
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
        response: { 200: StaffTicketViewSchema, 404: ErrorResponseSchema },
      },
    },
    async (request) => {
      const ticket = request.scopedTicket!;
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
