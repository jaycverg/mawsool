import {
  EquityRequestSchema,
  EraseRequestSchema,
  ErrorResponseSchema,
  GrantConsentRequestSchema,
  ConsentRecordSchema,
  OptInsSchema,
  OutcomeStatisticsRequestSchema,
  RateLimitedSchema,
  RevokeConsentResultSchema,
  SummaryAvailabilitySchema,
  SummaryDraftRequestSchema,
  SummaryDraftSchema,
  type ConsentElement,
  type SummaryAvailability,
  type SummaryUnavailableReason,
} from '@mawsool/types';
import { draftSummary, type SummaryProvider } from '@mawsool/summary';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { eraseEverything, grantConsent, revokeConsent, type ConsentDeps } from '../consents/service';
import { schema } from '../db/client';
import { personIdOf, sendError } from '../plugins/auth';
import type { SummaryBudget } from '../summary-budget';
import { summaryLogContext } from '../tickets/service';

/** Whether an AI draft can be asked for at all: the flag is on and a provider is configured. */
function aiIsConfigured(summary: PersonDataDeps['summary']): boolean {
  return summary.enabled && summary.provider !== null;
}

const Errors = { 400: ErrorResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema, 410: ErrorResponseSchema };

export interface PersonDataDeps extends ConsentDeps {
  summary: {
    enabled: boolean;
    provider: SummaryProvider | null;
    /** A daily allowance of AI calls: once spent, drafts come from the template. Unset means no cap. */
    budget?: SummaryBudget | undefined;
  };
}

/**
 * The consent ledger, the summary draft, the equity and statistics opt-ins and "delete everything": the routes where a person grants,
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

  // The separate, default-off choice to count the totals shared with the clinic in the anonymous symptom-change figures. It is
  // the caller's own row only, and read by the metrics at the moment they are made, so turning it off takes effect on the next read.
  typed.put(
    '/me/outcome-statistics',
    { config: { access: 'person' }, schema: { body: OutcomeStatisticsRequestSchema, response: { 200: z.object({ optIn: z.boolean() }), 400: ErrorResponseSchema } } },
    async (request) => {
      await deps.db.update(schema.persons).set({ outcomeStatsOptIn: request.body.optIn }).where(eq(schema.persons.id, personId(request)));
      return { optIn: request.body.optIn };
    },
  );

  // The caller's own two choices as the server holds them now. It is how a phone learns that the idle limit turned one off; it
  // changes nothing, carries no bucket and no figure, and the phone never turns a choice on from the answer.
  typed.get(
    '/me/opt-ins',
    { config: { access: 'person' }, schema: { response: { 200: OptInsSchema } } },
    async (request) => {
      const [row] = await deps.db
        .select({ equityOptIn: schema.persons.equityOptIn, outcomeStatsOptIn: schema.persons.outcomeStatsOptIn })
        .from(schema.persons)
        .where(eq(schema.persons.id, personId(request)))
        .limit(1);
      return { equityOptIn: row?.equityOptIn ?? false, outcomeStatsOptIn: row?.outcomeStatsOptIn ?? false };
    },
  );

  // Public and free of data about anyone: it only says whether the AI can write a draft right now, in this order: off (the flag is
  // unset or no provider), then daily_cap (today's allowance is spent), then available. Reading it spends nothing.
  typed.get(
    '/summary/availability',
    { config: { access: 'public' }, schema: { response: { 200: SummaryAvailabilitySchema } } },
    async (): Promise<SummaryAvailability> => {
      if (!aiIsConfigured(deps.summary)) return { ai: 'off' };
      if (deps.summary.budget?.isSpent()) return { ai: 'daily_cap' };
      return { ai: 'available' };
    },
  );

  typed.post(
    '/summary/draft',
    {
      config: { access: 'person', rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: { body: SummaryDraftRequestSchema, response: { 200: SummaryDraftSchema, 429: RateLimitedSchema } },
    },
    async (request) => {
      const { requestId, locale, useAi, consented, content } = request.body;
      // The rate limit runs first (a route hook), then the daily cap. Only a draft that will really call the provider spends the allowance.
      let allowAi = useAi;
      let aiUnavailable: SummaryUnavailableReason | undefined;
      if (useAi && !aiIsConfigured(deps.summary)) aiUnavailable = 'off';
      else if (allowAi && deps.summary.budget && !deps.summary.budget.take()) {
        allowAi = false;
        aiUnavailable = 'daily_cap';
      }
      const draft = await draftSummary({ enabled: deps.summary.enabled, provider: deps.summary.provider, useAi: allowAi, content, consented: consented as ConsentElement[], locale });
      await deps.db.insert(schema.summaryLogs).values({
        personId: personId(request),
        ticketId: null,
        requestId,
        kind: 'draft',
        ciphertext: deps.cipher.encrypt(draft.text, summaryLogContext(personIdOf(request), requestId, 'draft')),
        builtFrom: [...new Set(consented)],
        createdAt: deps.clock.now(),
      });
      return aiUnavailable === undefined ? { source: draft.source, text: draft.text } : { source: draft.source, text: draft.text, aiUnavailable };
    },
  );
}
