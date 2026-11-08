import { CreateCrisisHandoffRequestSchema, CrisisHandoffListSchema, CrisisHandoffReceiptSchema, CrisisHandoffRevokedSchema, CrisisHandoffViewSchema, ErrorResponseSchema } from '@mawsool/types';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { createHandoff, listHandoffs, markContactMade, readHandoff, revokeHandoff, type CrisisHandoffDeps } from '../crisis-handoffs/service';
import { personIdOf, sendError } from '../plugins/auth';

const Id = z.object({ id: z.uuid() });

/**
 * The optional hand-off of a short template to the mock crisis line.
 *
 * The person's routes act on their own hand-off only. The console's routes (`crisis_line` access, all under
 * `/crisis-handoffs`) read a hand-off only while its consent is live: a revoked or deleted one is 404, the same as one
 * that never existed. The console sees the template and when it arrived; it is never given a person id or a crisis
 * event id. None of these routes is reachable by the crisis screen itself, which never waits on them.
 */
export function registerCrisisHandoffRoutes(app: FastifyInstance, deps: CrisisHandoffDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post(
    '/me/crisis-handoffs',
    {
      config: { access: 'person' },
      schema: { body: CreateCrisisHandoffRequestSchema, response: { 200: CrisisHandoffReceiptSchema, 201: CrisisHandoffReceiptSchema, 400: ErrorResponseSchema, 409: ErrorResponseSchema } },
    },
    async (request, reply) => {
      const result = await createHandoff(deps, personIdOf(request), request.body);
      if (result.kind === 'unknown_event') return sendError(reply, 409, 'crisis_event_unknown', 'The crisis record has not reached the server yet');
      if (result.kind === 'conflict') return sendError(reply, 409, 'conflict', 'This crisis record was already handed over');
      if (result.kind === 'stopped') return sendError(reply, 409, 'handoff_stopped', 'This hand-off was stopped');
      return reply.code(result.kind === 'created' ? 201 : 200).send(result.receipt);
    },
  );

  typed.delete(
    '/me/crisis-handoffs/:id',
    { config: { access: 'person' }, schema: { params: Id, response: { 200: CrisisHandoffRevokedSchema, 404: ErrorResponseSchema } } },
    async (request, reply) => {
      const result = await revokeHandoff(deps, personIdOf(request), request.params.id);
      if (result.kind === 'not_found') return sendError(reply, 404, 'not_found', 'Hand-off not found');
      return { revokedAt: result.revokedAt.toISOString() };
    },
  );

  typed.get('/crisis-handoffs', { config: { access: 'crisis_line' }, schema: { response: { 200: CrisisHandoffListSchema } } }, async () => ({ items: await listHandoffs(deps) }));

  typed.get(
    '/crisis-handoffs/:id',
    { config: { access: 'crisis_line' }, schema: { params: Id, response: { 200: CrisisHandoffViewSchema, 404: ErrorResponseSchema } } },
    async (request, reply) => {
      const handoff = await readHandoff(deps, request.params.id);
      return handoff ?? sendError(reply, 404, 'not_found', 'Hand-off not found');
    },
  );

  typed.post(
    '/crisis-handoffs/:id/contact',
    { config: { access: 'crisis_line' }, schema: { params: Id, response: { 200: CrisisHandoffViewSchema, 404: ErrorResponseSchema } } },
    async (request, reply) => {
      const handoff = await markContactMade(deps, request.params.id);
      return handoff ?? sendError(reply, 404, 'not_found', 'Hand-off not found');
    },
  );
}
