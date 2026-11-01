import type { InboundSource } from '@mawsool/types';
import type { FastifyInstance } from 'fastify';
import type { Clock } from '../clock';
import type { Db } from '../db/client';
import { checkInbound } from '../inbound/signing';
import { takeNonce } from '../inbound/service';
import { sendError } from './auth';

declare module 'fastify' {
  interface FastifyRequest {
    /** The exact body bytes of a signed inbound request, kept so the signature is checked against what was sent. */
    rawBody?: string;
    /** Set once a signed inbound request has passed: the front door it came from. */
    inboundSource?: InboundSource;
  }
}

export interface InboundAuthDeps {
  db: Db;
  clock: Clock;
  /** The signing key of each front door. A source with no key here is refused. */
  keys: Partial<Record<InboundSource, string>>;
}

/**
 * Authenticates every route declared `inbound`, after the body is read and before it is validated, so nothing in the
 * body can be learned by a caller who is not signed. In order: the source has a key, the timestamp is inside the
 * window, the signature matches the exact body bytes, and the nonce has not been used. Only then is the nonce stored,
 * so an unsigned request writes nothing. A bad or missing signature, a stale time and an unknown source all get the
 * same 401; a replay gets a 401 of its own that a signed sender can act on. No invite row exists after either.
 */
export function registerInboundAuth(app: FastifyInstance, deps: InboundAuthDeps): void {
  app.addHook('preValidation', async (request, reply) => {
    if (request.routeOptions?.config?.access !== 'inbound') return;
    const checked = checkInbound({
      headers: request.headers,
      body: request.rawBody ?? '',
      keys: deps.keys,
      nowSeconds: Math.floor(deps.clock.now().getTime() / 1000),
    });
    if (!checked.ok) return sendError(reply, 401, 'unauthorized', 'The signed request was refused');
    if ((await takeNonce(deps.db, deps.clock, checked.source, checked.nonce)) === 'replayed') {
      return sendError(reply, 401, 'replayed', 'That request was already received');
    }
    request.inboundSource = checked.source;
  });
}
