import { and, eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { schema, type Db } from '../db/client';
import { sendError } from './auth';

type TicketRow = typeof schema.tickets.$inferSelect;

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `ownedTicket`: the ticket, already known to belong to the caller. */
    ownTicket?: TicketRow;
  }
}

/**
 * PreHandler for every person route that takes a ticket id in `:id`. A ticket that belongs to someone else is
 * indistinguishable from one that does not exist: both answer 404 with the same body, so ids cannot be probed.
 */
export function ownedTicket(db: Db) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = request.principal;
    if (principal?.kind !== 'person') return sendError(reply, 403, 'forbidden', 'This role may not use this route');
    const { id } = request.params as { id: string };
    const [ticket] = await db.select().from(schema.tickets).where(and(eq(schema.tickets.id, id), eq(schema.tickets.personId, principal.personId))).limit(1);
    if (!ticket) return sendError(reply, 404, 'not_found', 'Ticket not found');
    request.ownTicket = ticket;
  };
}
