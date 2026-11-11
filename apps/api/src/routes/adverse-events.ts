import { AdverseEventSchema, AdverseEventsQuerySchema, AdverseEventsResponseSchema, ErrorResponseSchema, MoveAdverseEventRequestSchema, RecordAdverseEventRequestSchema } from '@mawsool/types';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { listAdverseEvents, moveAdverseEvent, recordAdverseEvent, type Actor, type AdverseEventDeps } from '../adverse-events/service';
import { sendError } from '../plugins/auth';

/** The staff member behind the request. The auth hook has already refused every role but ops and admin on these routes. */
function actorOf(request: FastifyRequest): Actor {
  const principal = request.principal;
  if (principal?.kind !== 'staff' || (principal.role !== 'ops' && principal.role !== 'admin')) throw new Error('this route is not an ops route');
  return { staffUserId: principal.staffUserId, role: principal.role };
}

/**
 * The adverse-events log. Ops staff and admins record events (a coded type, a severity, when it happened, and optionally a
 * ticket by its pseudonymous id), list them by status and severity, and move a status along its legal moves. Nothing here
 * accepts or returns a person: no id, name, number, score, answer or note.
 */
export function registerAdverseEventRoutes(app: FastifyInstance, deps: AdverseEventDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const config = { access: 'ops', alsoAdmin: true } as const;

  typed.post('/adverse-events', { config, schema: { body: RecordAdverseEventRequestSchema, response: { 201: AdverseEventSchema, 400: ErrorResponseSchema } } }, async (request, reply) => {
    const result = await recordAdverseEvent(deps, actorOf(request), request.body);
    if (result.kind === 'in_the_future') return sendError(reply, 400, 'invalid_request', 'An event cannot have happened after the present');
    return reply.code(201).send(result.event);
  });

  typed.get('/adverse-events', { config, schema: { querystring: AdverseEventsQuerySchema, response: { 200: AdverseEventsResponseSchema } } }, async (request) => listAdverseEvents(deps.db, request.query));

  typed.post(
    '/adverse-events/:id/status',
    { config, schema: { params: z.object({ id: z.uuid() }), body: MoveAdverseEventRequestSchema, response: { 200: AdverseEventSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema } } },
    async (request, reply) => {
      const result = await moveAdverseEvent(deps, actorOf(request), request.params.id, request.body.to);
      if (result.kind === 'not_found') return sendError(reply, 404, 'not_found', 'No such adverse event');
      if (result.kind === 'illegal') return sendError(reply, 409, 'illegal_move', 'That status change is not allowed');
      if (result.kind === 'lost_race') return sendError(reply, 409, 'conflict', 'Another change was made first');
      return result.event;
    },
  );
}
