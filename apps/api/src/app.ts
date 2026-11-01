import cors from '@fastify/cors';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { systemClock, type Clock } from './clock';
import type { AppConfig } from './config';
import type { Db } from './db/client';
import { LogMagicLinkNotifier, type MagicLinkNotifier } from './notifier';
import { registerAuth } from './plugins/auth';
import { registerRouteRegistry } from './plugins/route-registry';
import { registerAuthRoutes } from './routes/auth';
import { registerHealthRoutes } from './routes/health';
import { registerPersonRoutes } from './routes/persons';
import { registerTicketRoutes } from './routes/tickets';

export interface AppDeps {
  db: Db;
  config: Pick<AppConfig, 'corsOrigins' | 'staffLinkBaseUrl'>;
  clock?: Clock;
  notifier?: MagicLinkNotifier;
  /** Fastify logger options; false silences it (tests). */
  logger?: boolean;
  /** Extra route registrations, used by tests to prove the registry refuses an undeclared route. */
  extraRoutes?: (app: FastifyInstance) => void;
}

/**
 * Builds the Ticket API. Startup throws if any route lacks a `config.access` declaration.
 * Nothing here reads the wall clock directly: time comes from the injected `Clock`.
 */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const clock = deps.clock ?? systemClock;
  const app = Fastify({ logger: deps.logger ?? false });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // CORS registers its own preflight route, so it goes in before the registry starts checking routes.
  await app.register(cors, { origin: deps.config.corsOrigins, methods: ['GET', 'POST', 'DELETE', 'OPTIONS'] });
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
    staffLinkBaseUrl: deps.config.staffLinkBaseUrl,
    log: app.log,
  });
  registerTicketRoutes(app, { db: deps.db });
  deps.extraRoutes?.(app);

  await app.ready();
  return app;
}
