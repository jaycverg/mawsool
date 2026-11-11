import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import type { SummaryProvider } from '@mawsool/summary';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyServerOptions } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { OffsetClock, systemClock, type Clock } from './clock';
import { restoreDemoClock } from './demo/clock-store';
import type { AppConfig } from './config';
import { createCipher } from './crypto';
import type { Db } from './db/client';
import { issueClinicLink } from './clinic-links/service';
import { createDriver, createNotifier, type Notifier } from './notifier';
import { registerClinicLinkRoutes } from './routes/clinic-links';
import { registerAuth } from './plugins/auth';
import { registerInboundAuth } from './plugins/inbound-auth';
import { registerRouteRegistry } from './plugins/route-registry';
import { registerSecurityHeaders } from './plugins/security-headers';
import { registerAuthRoutes } from './routes/auth';
import { registerClockRoute, registerDemoRoutes } from './routes/demo';
import { registerAdverseEventRoutes } from './routes/adverse-events';
import { registerMetricsRoutes } from './routes/metrics';
import { registerCrisisEventRoutes } from './routes/crisis-events';
import { registerCrisisHandoffRoutes } from './routes/crisis-handoffs';
import { registerHealthRoutes } from './routes/health';
import { registerInboundRoutes } from './routes/inbound';
import { registerPersonDataRoutes } from './routes/person-data';
import { registerPersonRoutes } from './routes/persons';
import { registerReminderRoutes } from './routes/reminders';
import { registerServiceRoutes } from './routes/services';
import { registerTicketFlowRoutes } from './routes/ticket-routes';
import { registerTicketRoutes } from './routes/tickets';

declare module 'fastify' {
  interface FastifyInstance {
    /** The clock the API runs care time on: the demo clock when `DEMO_MODE` is set, otherwise the wall clock. The sweep job uses it. */
    careClock: Clock;
  }
}

export interface AppDeps {
  db: Db;
  config: Pick<AppConfig, 'corsOrigins' | 'clinicianAppUrl' | 'opsAppUrl' | 'encryptionKey' | 'summaryLlmEnabled'> & Partial<Pick<AppConfig, 'personAppUrl' | 'inboundKeys' | 'demoMode' | 'notifierDriver'>>;
  /** The summary provider. Null (or the flag off) means no text ever leaves the API. */
  summaryProvider?: SummaryProvider | null;
  /**
   * The wall clock. With `demoMode` on, care time (deadlines, the sweep, ticket events, invite expiry) runs on a demo clock
   * built on this one; security windows (staff sessions, sign-in links, the signed-request window, nonce retention) always
   * read this one, so a demo clock jump cannot sign staff out or refuse a good signature.
   */
  clock?: Clock;
  notifier?: Notifier;
  /** Fastify logger options; false silences it (tests). */
  logger?: FastifyServerOptions['logger'];
  /** Extra route registrations, used by tests to prove the registry refuses an undeclared route. */
  extraRoutes?: (app: FastifyInstance) => void;
}

/**
 * Builds the Ticket API. Startup throws if any route lacks a `config.access` declaration, and if the bundle encryption
 * key is missing or not 256 bits: the API never runs able to store a bundle in the clear.
 * Nothing here reads the wall clock directly: time comes from the injected `Clock`.
 */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const securityClock = deps.clock ?? systemClock;
  const demoClock = deps.config.demoMode === true ? new OffsetClock(securityClock) : null;
  // A demo that was restarted keeps its date: the offset written by the clock controls is read once, here.
  if (demoClock) await restoreDemoClock(deps.db, demoClock);
  const clock: Clock = demoClock ?? securityClock;
  const cipher = createCipher(deps.config.encryptionKey);
  const app = Fastify({ logger: deps.logger ?? false });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // CORS registers its own preflight route, so it goes in before the registry starts checking routes.
  await app.register(cors, { origin: deps.config.corsOrigins, methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] });
  await app.register(swagger, {
    openapi: { openapi: '3.0.3', info: { title: 'Mawsool Ticket API', version: '0.0.0', description: 'Closed-loop referral tickets, consent and metrics.' } },
    transform: jsonSchemaTransform,
  });
  registerRouteRegistry(app);
  registerSecurityHeaders(app);
  registerAuth(app, { db: deps.db, clock: securityClock });
  registerInboundAuth(app, { clock: securityClock, keys: deps.config.inboundKeys ?? {} });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.code(400).send({ error: 'invalid_request', message: 'The request did not match the expected shape' });
    }
    const status = typeof error.statusCode === 'number' && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) request.log.error({ err: error }, 'request failed');
    return reply.code(status).send({ error: status >= 500 ? 'internal_error' : 'bad_request', message: status >= 500 ? 'Something went wrong' : error.message });
  });

  // Every outbound message goes through the notifier, whose driver is a mock (`NOTIFIER_DRIVER`): nothing is sent.
  const notifier = deps.notifier ?? createNotifier(createDriver(deps.config.notifierDriver ?? 'log', { log: app.log, encryptionKey: deps.config.encryptionKey }));
  registerHealthRoutes(app);
  registerPersonRoutes(app, { db: deps.db, clock });
  registerAuthRoutes(app, {
    db: deps.db,
    clock: securityClock,
    notifier,
    staffApps: { clinician: deps.config.clinicianAppUrl, ops: deps.config.opsAppUrl },
    log: app.log,
  });
  registerServiceRoutes(app, { db: deps.db });
  registerCrisisEventRoutes(app, { db: deps.db });
  registerTicketRoutes(app, { db: deps.db });
  registerInboundRoutes(app, { db: deps.db, clock, securityClock, personAppUrl: deps.config.personAppUrl ?? 'http://localhost:3000' });
  const clinicLinks = { db: deps.db, clock, securityClock, notifier, clinicianAppUrl: deps.config.clinicianAppUrl, log: app.log };
  // A ticket for a clinic without the portal gets its one-time link, logged, once the ticket is made. It can never fail the request.
  const consentDeps = { db: deps.db, cipher, clock, securityClock, onTicketIssued: async (ticketId: string) => void (await issueClinicLink(clinicLinks, ticketId)) };
  registerTicketFlowRoutes(app, consentDeps);
  registerReminderRoutes(app, { ...consentDeps, notifier });
  registerCrisisHandoffRoutes(app, consentDeps);
  registerClinicLinkRoutes(app, clinicLinks);
  registerPersonDataRoutes(app, { ...consentDeps, summary: { enabled: deps.config.summaryLlmEnabled, provider: deps.summaryProvider ?? null } });
  registerClockRoute(app, { demoClock });
  registerMetricsRoutes(app, { db: deps.db, clock, encryptionKey: deps.config.encryptionKey, cipher });
  registerAdverseEventRoutes(app, { db: deps.db, clock, securityClock });
  // The write controls exist only in a demo; with `DEMO_MODE` unset these paths are 404.
  if (demoClock) registerDemoRoutes(app, { db: deps.db, cipher, clock: demoClock, securityClock, personAppUrl: deps.config.personAppUrl ?? 'http://localhost:3000' });
  // The OpenAPI document is generated from the routes' Zod schemas, so it cannot drift from what the API accepts.
  app.get('/docs', { config: { access: 'public' } }, async () => app.swagger());
  deps.extraRoutes?.(app);

  app.decorate('careClock', clock);
  await app.ready();
  return app;
}
