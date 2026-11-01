import { ErrorResponseSchema, StaffQueueQuerySchema, StaffQueueSchema, StaffTicketDetailSchema, type StaffQueue, type TicketState } from '@mawsool/types';
import { and, asc, count, eq, inArray, not } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { schema, type Db } from '../db/client';
import { shareEnded, shareEndedSql } from '../consents/service';
import { sendError } from '../plugins/auth';
import { facilityScopedQueue, facilityScopedTicket } from '../plugins/facility-scope';
import { standingUnableReport } from '../tickets/events';

/** The states a ticket waits in before anyone has seen the person: what the clinic's queue shows by default. */
const OPEN_STATES: readonly TicketState[] = ['issued', 'acknowledged', 'overdue'];

type TicketRow = typeof schema.tickets.$inferSelect;

function staffTicketFields(ticket: TicketRow) {
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
}

/**
 * Staff ticket reads, minimal on purpose: ticket fields only, no bundle (that is `/tickets/:id/bundle`). Both apply the
 * facility scope, and both apply the same rule once the person has ended the share (`shareEndedSql`): the detail answers
 * 410, and the queue does not list the ticket at all, since even its code and deadline are no longer the clinic's to see.
 */
export function registerTicketRoutes(app: FastifyInstance, deps: { db: Db }): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get(
    '/tickets',
    {
      config: { access: 'clinician', facilityScoped: true },
      preHandler: facilityScopedQueue(deps.db),
      schema: { querystring: StaffQueueQuerySchema, response: { 200: StaffQueueSchema, 400: ErrorResponseSchema } },
    },
    async (request): Promise<StaffQueue> => {
      const facility = request.scopedFacility!;
      const { state, tier, limit } = request.query;
      // Everything the clinic may see: its own facility's tickets whose share has not ended. The same join serves the counts and the page.
      const visible = and(eq(schema.services.facilityId, facility.id), not(shareEndedSql(schema.tickets.id)));
      const matching = and(visible, state === 'open' ? inArray(schema.tickets.state, [...OPEN_STATES]) : eq(schema.tickets.state, state), tier ? eq(schema.tickets.tier, tier) : undefined);

      const [byState, [matched], rows] = await Promise.all([
        deps.db.select({ state: schema.tickets.state, n: count() }).from(schema.tickets).innerJoin(schema.services, eq(schema.tickets.serviceId, schema.services.id)).where(visible).groupBy(schema.tickets.state),
        deps.db.select({ n: count() }).from(schema.tickets).innerJoin(schema.services, eq(schema.tickets.serviceId, schema.services.id)).where(matching),
        deps.db
          .select({ ticket: schema.tickets })
          .from(schema.tickets)
          .innerJoin(schema.services, eq(schema.tickets.serviceId, schema.services.id))
          .where(matching)
          .orderBy(asc(schema.tickets.deadlineAt), asc(schema.tickets.createdAt), asc(schema.tickets.id))
          .limit(limit),
      ]);
      return {
        facility,
        total: matched!.n,
        counts: Object.fromEntries(byState.map((row) => [row.state, row.n])),
        items: rows.map((row) => staffTicketFields(row.ticket)),
      };
    },
  );

  typed.get(
    '/tickets/:id',
    {
      config: { access: 'clinician', facilityScoped: true },
      preHandler: facilityScopedTicket(deps.db),
      schema: {
        params: z.object({ id: z.uuid() }),
        response: { 200: StaffTicketDetailSchema, 404: ErrorResponseSchema, 410: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      const ticket = request.scopedTicket!;
      // Once the person has ended the share the clinic gets nothing about the ticket either: not even its code or deadline.
      if (await shareEnded(deps.db, ticket.id)) return sendError(reply, 410, 'withdrawn', 'Withdrawn by the person');
      const unable = await standingUnableReport(deps.db, ticket.id);
      return { ...staffTicketFields(ticket), unable: unable && { reason: unable.reason, at: unable.at.toISOString() } };
    },
  );
}
