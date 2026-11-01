import {
  BundleReadViewSchema,
  CreateTicketRequestSchema,
  CreatedTicketSchema,
  ErrorResponseSchema,
  PersonTicketListSchema,
  PersonTicketViewSchema,
  RerouteRequestSchema,
  StaffBundleViewSchema,
  TicketEventRequestSchema,
  TicketEventResultSchema,
  type Actor,
  type TicketEventRequest,
  type TicketEventResult,
} from '@mawsool/types';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { readBundle, revokeConsent, type ConsentDeps } from '../consents/service';
import { schema } from '../db/client';
import { personIdOf, sendError } from '../plugins/auth';
import { facilityScopedTicket } from '../plugins/facility-scope';
import { ownedTicket } from '../plugins/ownership';
import { lastEvent, moveTicket } from '../tickets/events';
import { issueTicket, personTicketView, type IssueResult, type TicketDeps } from '../tickets/service';
import { evaluate, evaluateUnable } from '../tickets/transitions';

const Params = z.object({ id: z.uuid() });
const Errors = { 400: ErrorResponseSchema, 403: ErrorResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema, 410: ErrorResponseSchema };

function statusOf(verdict: 'forbidden' | 'illegal') {
  return verdict === 'forbidden'
    ? { status: 403, error: 'forbidden', message: 'This actor may not make that change' }
    : { status: 409, error: 'conflict', message: 'That change is not allowed from the current state' };
}

/**
 * Applies an event request for an actor. The state machine decides; this only maps its verdict to a status.
 *
 *  - "Unable to see" is its own request (`unable: true`, a reason from a fixed list). A move to the state the ticket is
 *    already in without it is refused (409), so a repeated acknowledge is never recorded.
 *  - A person withdrawing is a revoke, and a live `ticket` consent decides it before the state machine does: it ends
 *    the share and deletes the data from any state, and from a terminal state it changes no state.
 *  - `rerouted` is fired only by the reroute route, which also makes the child ticket and takes its consent.
 */
async function applyEvent(deps: ConsentDeps, reply: FastifyReply, ticket: { id: string; personId: string }, actor: Actor, body: TicketEventRequest) {
  const last = await lastEvent(deps.db, ticket.id);
  if (!last) return sendError(reply, 409, 'conflict', 'This ticket has no history');

  if ('unable' in body) {
    const verdict = evaluateUnable(last.state, actor);
    if (verdict !== 'ok') {
      const { status, error, message } = statusOf(verdict);
      return sendError(reply, status, error, message);
    }
    return finish(deps, reply, ticket.id, await moveTicket(deps.db, { ticketId: ticket.id, to: last.state, actor, channel: 'portal', reason: body.reason, at: deps.clock.now(), unable: true }));
  }

  // A move to the state the ticket is already in has no rule, so the state machine refuses it with 409.
  if (actor === 'person' && body.to === 'withdrawn') {
    const [live] = await deps.db
      .select({ id: schema.consents.id })
      .from(schema.consents)
      .where(and(eq(schema.consents.ticketId, ticket.id), eq(schema.consents.element, 'ticket'), isNull(schema.consents.revokedAt)))
      .limit(1);
    if (live) {
      await revokeConsent(deps, ticket.personId, live.id);
      return result(deps, ticket.id);
    }
  }
  if (actor === 'person' && body.to === 'rerouted') return sendError(reply, 409, 'conflict', 'That change is not allowed from the current state');

  return finish(
    deps,
    reply,
    ticket.id,
    await moveTicket(deps.db, { ticketId: ticket.id, to: body.to, actor, channel: actor === 'person' ? 'app' : 'portal', selfConfirmed: actor === 'person' && body.to === 'seen', at: deps.clock.now() }),
  );
}

async function finish(deps: ConsentDeps, reply: FastifyReply, ticketId: string, outcome: Awaited<ReturnType<typeof moveTicket>>) {
  if (outcome.result === 'forbidden' || outcome.result === 'illegal') {
    const { status, error, message } = statusOf(outcome.result);
    return sendError(reply, status, error, message);
  }
  if (outcome.result === 'lost_race') return sendError(reply, 409, 'conflict', 'The ticket changed; try again');
  return result(deps, ticketId);
}

async function result(deps: ConsentDeps, ticketId: string): Promise<TicketEventResult> {
  const [event] = await deps.db.select().from(schema.ticketEvents).where(eq(schema.ticketEvents.ticketId, ticketId)).orderBy(desc(schema.ticketEvents.seq)).limit(1);
  return {
    state: event!.toState,
    event: {
      seq: event!.seq,
      fromState: event!.fromState,
      toState: event!.toState,
      actor: event!.actor,
      reason: event!.reason,
      selfConfirmed: event!.selfConfirmed,
      at: event!.at.toISOString(),
    },
  };
}

function issueReply(reply: FastifyReply, issued: IssueResult, deps: TicketDeps) {
  switch (issued.kind) {
    case 'invalid':
      return sendError(reply, 400, 'invalid_request', issued.message);
    case 'conflict':
      return sendError(reply, 409, 'conflict', issued.message);
    case 'not_found':
      return sendError(reply, 404, 'not_found', 'Ticket not found');
    case 'created':
    case 'replayed':
      return personTicketView(deps.db, issued.ticketId).then((ticket) => reply.code(issued.kind === 'created' ? 201 : 200).send({ created: issued.kind === 'created', ticket: ticket! }));
  }
}

/**
 * Ticket routes. Person routes read and write only the caller's own tickets (a stranger's id is a 404). Staff routes
 * are facility-scoped. State changes go through the state machine, which answers 409 for a move that does not exist
 * from the current state and 403 for a move the actor may not make; the bundle read checks live consent each time.
 */
export function registerTicketFlowRoutes(app: FastifyInstance, deps: ConsentDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post(
    '/tickets',
    { config: { access: 'person' }, schema: { body: CreateTicketRequestSchema, response: { 200: CreatedTicketSchema, 201: CreatedTicketSchema, ...Errors } } },
    async (request, reply) => {
      const issued = await issueTicket(deps, personIdOf(request), request.body);
      return issueReply(reply, issued, deps);
    },
  );

  typed.get(
    '/me/tickets',
    { config: { access: 'person' }, schema: { response: { 200: PersonTicketListSchema } } },
    async (request) => {
      const personId = personIdOf(request);
      const rows = await deps.db.select({ id: schema.tickets.id }).from(schema.tickets).where(eq(schema.tickets.personId, personId)).orderBy(asc(schema.tickets.createdAt));
      return (await Promise.all(rows.map((row) => personTicketView(deps.db, row.id)))).flatMap((view) => (view ? [view] : []));
    },
  );

  typed.get(
    '/me/tickets/:id',
    { config: { access: 'person' }, preHandler: ownedTicket(deps.db), schema: { params: Params, response: { 200: PersonTicketViewSchema, ...Errors } } },
    async (request) => (await personTicketView(deps.db, request.ownTicket!.id))!,
  );

  typed.get(
    '/me/tickets/:id/reads',
    { config: { access: 'person' }, preHandler: ownedTicket(deps.db), schema: { params: Params, response: { 200: z.array(BundleReadViewSchema), ...Errors } } },
    async (request) => {
      const rows = await deps.db
        .select({ at: schema.bundleReads.at, facilityName: schema.facilities.name })
        .from(schema.bundleReads)
        .innerJoin(schema.facilities, eq(schema.facilities.id, schema.bundleReads.facilityId))
        .where(eq(schema.bundleReads.ticketId, request.ownTicket!.id))
        .orderBy(asc(schema.bundleReads.at));
      return rows.map((row) => ({ at: row.at.toISOString(), role: 'clinician' as const, facilityName: row.facilityName }));
    },
  );

  typed.post(
    '/me/tickets/:id/events',
    { config: { access: 'person' }, preHandler: ownedTicket(deps.db), schema: { params: Params, body: TicketEventRequestSchema, response: { 200: TicketEventResultSchema, ...Errors } } },
    async (request, reply) => applyEvent(deps, reply, request.ownTicket!, 'person', request.body),
  );

  typed.post(
    '/me/tickets/:id/reroute',
    { config: { access: 'person' }, preHandler: ownedTicket(deps.db), schema: { params: Params, body: RerouteRequestSchema, response: { 200: CreatedTicketSchema, 201: CreatedTicketSchema, ...Errors } } },
    async (request, reply) => {
      const { reason, ...rest } = request.body;
      const issued = await issueTicket(deps, request.ownTicket!.personId, rest, { parent: { ticketId: request.ownTicket!.id, reason } });
      return issueReply(reply, issued, deps);
    },
  );

  typed.post(
    '/tickets/:id/events',
    {
      config: { access: 'clinician', facilityScoped: true },
      preHandler: facilityScopedTicket(deps.db),
      schema: { params: Params, body: TicketEventRequestSchema, response: { 200: TicketEventResultSchema, ...Errors } },
    },
    async (request, reply) => applyEvent(deps, reply, request.scopedTicket!, 'clinic', request.body),
  );

  typed.get(
    '/tickets/:id/bundle',
    {
      config: { access: 'clinician', facilityScoped: true },
      preHandler: facilityScopedTicket(deps.db),
      schema: { params: Params, response: { 200: StaffBundleViewSchema, ...Errors } },
    },
    async (request, reply) => {
      const principal = request.principal!;
      const read = await readBundle(deps, request.scopedTicket!.id, {
        staffUserId: principal.kind === 'staff' ? principal.staffUserId : '',
        facilityId: principal.kind === 'staff' ? principal.facilityId! : '',
      });
      if (read.kind === 'withdrawn') return sendError(reply, 410, 'withdrawn', 'Withdrawn by the person');
      if (read.kind === 'none') return sendError(reply, 404, 'not_found', 'Nothing was shared for this ticket');
      return read.view;
    },
  );
}
