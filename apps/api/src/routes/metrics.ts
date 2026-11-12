import { CrisisResponseSchema, EQUITY_PERIOD, EquityQuerySchema, EquityResponseSchema, FunnelQuerySchema, FunnelResponseSchema, OutcomesQuerySchema, OutcomesResponseSchema, PeriodQuerySchema, TimelinessResponseSchema } from '@mawsool/types';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Clock } from '../clock';
import type { Cipher } from '../crypto';
import type { Db } from '../db/client';
import { loadCrisisFacts, loadOpenInvites, loadTicketFacts, periodStart } from '../metrics/facts';
import { buildCrisis } from '../metrics/crisis';
import { buildEquity } from '../metrics/equity';
import { buildFunnel, crisisHiddenInFunnel, journeysOf, remeasuredHiddenInFunnel } from '../metrics/funnel';
import { buildOutcomes, loadOutcomeFacts } from '../metrics/outcomes';
import { buildTimeliness } from '../metrics/timeliness';

export interface MetricsRouteDeps {
  db: Db;
  /** The care clock: the period, the invite expiry and the overdue list read the demo clock, as the sweep does. */
  clock: Clock;
  /** Keys the pseudonymous ids on the overdue list. */
  encryptionKey: string;
  /** Opens the shared totals the symptom-change figures are made from. */
  cipher: Cipher;
}

/**
 * The ops dashboard's numbers. Every route is `ops` access (a clinician, a person and an anonymous caller are refused)
 * and every number it returns has gone through `suppress`: a count under ten is `{ suppressed: true }`, and so is a cell
 * that would let a hidden one be worked out from its row total. Responses name no person and carry no free text.
 */
export function registerMetricsRoutes(app: FastifyInstance, deps: MetricsRouteDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get('/metrics/funnel', { config: { access: 'ops' }, schema: { querystring: FunnelQuerySchema, response: { 200: FunnelResponseSchema } } }, async (request) => {
    const now = deps.clock.now();
    const [tickets, openInvites, crisis] = await Promise.all([loadTicketFacts(deps.db), loadOpenInvites(deps.db, now), loadCrisisFacts(deps.db)]);
    return buildFunnel(request.query, { journeys: journeysOf(tickets), openInvites, crisis, since: periodStart(request.query.period, now) });
  });

  typed.get('/metrics/timeliness', { config: { access: 'ops' }, schema: { querystring: PeriodQuerySchema, response: { 200: TimelinessResponseSchema } } }, async (request) => {
    const now = deps.clock.now();
    return buildTimeliness(deps.db, request.query.period, { tickets: await loadTicketFacts(deps.db), since: periodStart(request.query.period, now), now, encryptionKey: deps.encryptionKey });
  });

  typed.get('/metrics/crisis', { config: { access: 'ops' }, schema: { querystring: PeriodQuerySchema, response: { 200: CrisisResponseSchema } } }, async (request) => {
    const now = deps.clock.now();
    const since = periodStart(request.query.period, now);
    const [tickets, openInvites, crisis] = await Promise.all([loadTicketFacts(deps.db), loadOpenInvites(deps.db, now), loadCrisisFacts(deps.db)]);
    // The same decision as the funnel's first stage for this period: what it hides, this hides.
    return buildCrisis(request.query.period, crisis, since, crisisHiddenInFunnel({ journeys: journeysOf(tickets), openInvites, crisis, since }));
  });

  // Symptom change among re-measured tickets. It reads the totals the person shared (live consent only) and only for a person
  // who also opted in to anonymous statistics, per ticket and never returned per ticket. It is served for one period only
  // (`EQUITY_PERIOD`): any other `period` is a 400 with no figures, since the same figure in two periods subtracts into a small
  // group's results. It hides everything when the funnel hides its re-measured stage for that same 90-day window.
  typed.get('/metrics/outcomes', { config: { access: 'ops' }, schema: { querystring: OutcomesQuerySchema, response: { 200: OutcomesResponseSchema } } }, async () => {
    const now = deps.clock.now();
    const since = periodStart(EQUITY_PERIOD, now);
    const [tickets, openInvites, crisis] = await Promise.all([loadTicketFacts(deps.db), loadOpenInvites(deps.db, now), loadCrisisFacts(deps.db)]);
    const hides = remeasuredHiddenInFunnel({ journeys: journeysOf(tickets), openInvites, crisis, since });
    return buildOutcomes(await loadOutcomeFacts(deps.db, deps.cipher, tickets), since, hides);
  });

  // Equity is served for one period only (`EQUITY_PERIOD`): any other `period` is a 400 with no figures, and with none the
  // answer is that period's. Two periods of one group subtract into a small count of named people, which the guardrail forbids.
  typed.get('/metrics/equity', { config: { access: 'ops' }, schema: { querystring: EquityQuerySchema, response: { 200: EquityResponseSchema } } }, async (request) =>
    buildEquity(request.query.period, await loadTicketFacts(deps.db), periodStart(request.query.period, deps.clock.now())),
  );
}
