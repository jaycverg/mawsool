import {
  EquityRequestSchema,
  EraseRequestSchema,
  ErrorResponseSchema,
  GrantConsentRequestSchema,
  ConsentRecordSchema,
  RevokeConsentResultSchema,
  SummaryDraftRequestSchema,
  SummaryDraftSchema,
  type ConsentElement,
} from '@mawsool/types';
import { draftSummary, type SummaryProvider } from '@mawsool/summary';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { eraseEverything, grantConsent, revokeConsent, type ConsentDeps } from '../consents/service';
import { schema } from '../db/client';
import { personIdOf, sendError } from '../plugins/auth';
import { summaryLogContext } from '../tickets/service';

const Errors = { 400: ErrorResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema, 410: ErrorResponseSchema };

export interface PersonDataDeps extends ConsentDeps {
  summary: { enabled: boolean; provider: SummaryProvider | null };
}

/**
 * The consent ledger, the summary draft, the equity opt-in and "delete everything": the routes where a person grants,
 * withdraws or erases what the server holds about them. Every one acts on the caller's own rows only.
 */
export function registerPersonDataRoutes(app: FastifyInstance, deps: PersonDataDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const personId = personIdOf;

  typed.post(
    '/consents',
    { config: { access: 'person' }, schema: { body: GrantConsentRequestSchema, response: { 201: ConsentRecordSchema, ...Errors } } },
    async (request, reply) => {
      if (request.body.element === 'ticket') return sendError(reply, 400, 'invalid_request', 'The ticket element is granted when the ticket is issued');
      const granted = await grantConsent(deps, personId(request), request.body);
      if (granted.kind === 'not_found') return sendError(reply, 404, 'not_found', 'Ticket not found');
      if (granted.kind === 'gone') return sendError(reply, 410, 'withdrawn', 'This share has ended');
      if (granted.kind === 'conflict') return sendError(reply, 409, 'conflict', 'That element is already shared');
      return reply.code(201).send(granted.consent);
    },
  );

  typed.delete(
    '/consents/:id',
    { config: { access: 'person' }, schema: { params: z.object({ id: z.uuid() }), response: { 200: RevokeConsentResultSchema, 404: ErrorResponseSchema } } },
    async (request, reply) => {
      const revoked = await revokeConsent(deps, personId(request), request.params.id);
      if (revoked.kind === 'not_found') return sendError(reply, 404, 'not_found', 'Consent not found');
      return { revoked: revoked.revoked, ticketState: revoked.ticketState, summaryRemoved: revoked.summaryRemoved };
    },
  );

  typed.delete(
    '/me/data',
    {
      config: { access: 'person' },
      schema: { response: { 200: z.object({ ticketsWithdrawn: z.number(), consentsRevoked: z.number(), summariesDeleted: z.number() }), 400: ErrorResponseSchema } },
    },
    async (request, reply) => {
      // The body is optional, so it is checked here: a phone that never handed anything over sends none at all.
      const body = EraseRequestSchema.optional().safeParse(request.body ?? undefined);
      if (!body.success) return sendError(reply, 400, 'invalid_request', 'The request did not match the expected shape');
      return eraseEverything(deps, personId(request), body.data?.handoffIds ?? []);
    },
  );

  typed.put(
    '/me/equity',
    { config: { access: 'person' }, schema: { body: EquityRequestSchema, response: { 200: z.object({ optIn: z.boolean() }), 400: ErrorResponseSchema } } },
    async (request, reply) => {
      const { optIn, buckets } = request.body;
      if (optIn && !buckets) return sendError(reply, 400, 'invalid_request', 'Buckets are required to opt in');
      await deps.db
        .update(schema.persons)
        .set(
          optIn
            ? { equityOptIn: true, ageBand: buckets!.ageBand, gender: buckets!.gender, language: buckets!.language, region: buckets!.region }
            : { equityOptIn: false, ageBand: null, gender: null, language: null, region: null },
        )
        .where(eq(schema.persons.id, personId(request)));
      return { optIn };
    },
  );

  typed.post(
    '/summary/draft',
    { config: { access: 'person' }, schema: { body: SummaryDraftRequestSchema, response: { 200: SummaryDraftSchema } } },
    async (request) => {
      const { requestId, locale, useAi, consented, content } = request.body;
      const draft = await draftSummary({ enabled: deps.summary.enabled, provider: deps.summary.provider, useAi, content, consented: consented as ConsentElement[], locale });
      await deps.db.insert(schema.summaryLogs).values({
        personId: personId(request),
        ticketId: null,
        requestId,
        kind: 'draft',
        ciphertext: deps.cipher.encrypt(draft.text, summaryLogContext(personIdOf(request), requestId, 'draft')),
        builtFrom: [...new Set(consented)],
        createdAt: deps.clock.now(),
      });
      return { source: draft.source, text: draft.text };
    },
  );
}
