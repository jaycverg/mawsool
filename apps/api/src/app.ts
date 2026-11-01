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
import { systemClock, type Clock } from './clock';
import type { AppConfig } from './config';
import { createCipher } from './crypto';
import type { Db } from './db/client';
import { LogMagicLinkNotifier, type MagicLinkNotifier } from './notifier';
import { registerAuth } from './plugins/auth';
import { registerRouteRegistry } from './plugins/route-registry';
import { registerAuthRoutes } from './routes/auth';
import { registerCrisisEventRoutes } from './routes/crisis-events';
import { registerHealthRoutes } from './routes/health';
import { registerPersonDataRoutes } from './routes/person-data';
import { registerPersonRoutes } from './routes/persons';
import { registerServiceRoutes } from './routes/services';
import { registerTicketFlowRoutes } from './routes/ticket-routes';
import { registerTicketRoutes } from './routes/tickets';

export interface AppDeps {
  db: Db;
  config: Pick<AppConfig, 'corsOrigins' | 'clinicianAppUrl' | 'opsAppUrl' | 'encryptionKey' | 'summaryLlmEnabled'>;
  /** The summary provider. Null (or the flag off) means no text ever leaves the API. */
  summaryProvider?: SummaryProvider | null;
  clock?: Clock;
  notifier?: MagicLinkNotifier;
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
  const clock = deps.clock ?? systemClock;
  const cipher = createCipher(deps.config.encryptionKey);
  const app = Fastify({ logger: deps.logger ?? false });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // CORS registers its own preflight route, so it goes in before the registry starts checking routes.
  await app.register(cors, { origin: deps.config.corsOrigins, methods: ['GET', 'POST', 'DELETE', 'OPTIONS'] });
  await app.register(swagger, {
    openapi: { openapi: '3.0.3', info: { title: 'Mawsool Ticket API', version: '0.0.0', description: 'Closed-loop referral tickets, consent and metrics.' } },
    transform: jsonSchemaTransform,
  });
  registerRouteRegistry(app);
  registerAuth(app, { db: deps.db, clock });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.code(400).send({ error: 'invalid_request', message: 'The request did not match the expected shape' });
    }
    const status = typeof error.statusCode === 'number' && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) request.log.error({ err: error }, 'request failed');
    return reply.code(status).send({ error: status >= 500 ? 'internal_error' : 'bad_request', message: status >= 500 ? 'Something went wrong' : error.message });
  });

  const notifier = deps.notifier ?? new LogMagicLinkNotifier(app.log);
  registerHealthRoutes(app);
  registerPersonRoutes(app, { db: deps.db, clock });
  registerAuthRoutes(app, {
    db: deps.db,
    clock,
    notifier,
    staffApps: { clinician: deps.config.clinicianAppUrl, ops: deps.config.opsAppUrl },
    log: app.log,
  });
  registerServiceRoutes(app, { db: deps.db });
  registerCrisisEventRoutes(app, { db: deps.db });
  registerTicketRoutes(app, { db: deps.db });
  const consentDeps = { db: deps.db, cipher, clock };
  registerTicketFlowRoutes(app, consentDeps);
  registerPersonDataRoutes(app, { ...consentDeps, summary: { enabled: deps.config.summaryLlmEnabled, provider: deps.summaryProvider ?? null } });
  // The OpenAPI document is generated from the routes' Zod schemas, so it cannot drift from what the API accepts.
  app.get('/docs', { config: { access: 'public' } }, async () => app.swagger());
  deps.extraRoutes?.(app);

  await app.ready();
  return app;
}
