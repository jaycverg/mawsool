import { and, eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { schema, type Db } from '../db/client';
import { sendError } from './auth';

type TicketRow = typeof schema.tickets.$inferSelect;

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `facilityScopedTicket`: the ticket, already known to be addressed to the caller's facility. */
    scopedTicket?: TicketRow;
  }
}

/**
 * Facility-scoping preHandler for every staff route that takes a ticket id in `:id`.
 *
 * It looks the ticket up only through the staff member's own facility (ticket, then its service, then the
 * service's facility). A ticket addressed to another facility is therefore indistinguishable from one that does
 * not exist: both answer 404 with the same body, so ids cannot be probed across facilities.
 */
export function facilityScopedTicket(db: Db) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = request.principal;
    if (principal?.kind !== 'staff' || principal.facilityId === null) {
      return sendError(reply, 403, 'forbidden', 'This role may not use this route');
    }
    const { id } = request.params as { id: string };
    const [row] = await db
      .select({ ticket: schema.tickets })
      .from(schema.tickets)
      .innerJoin(schema.services, eq(schema.tickets.serviceId, schema.services.id))
      .where(and(eq(schema.tickets.id, id), eq(schema.services.facilityId, principal.facilityId)))
      .limit(1);
    if (!row) return sendError(reply, 404, 'not_found', 'Ticket not found');
    request.scopedTicket = row.ticket;
  };
}
