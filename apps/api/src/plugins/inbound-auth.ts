import type { InboundSource } from '@mawsool/types';
import type { FastifyInstance } from 'fastify';
import type { Clock } from '../clock';
import { checkInbound } from '../inbound/signing';
import { sendError } from './auth';

declare module 'fastify' {
  interface FastifyRequest {
    /** The exact body bytes of a signed inbound request, kept so the signature is checked against what was sent. */
    rawBody?: string;
    /** Set once a signed inbound request has passed: the front door it came from. */
    inboundSource?: InboundSource;
    /** The nonce it carried. It is spent by the route, in the same transaction as what the route writes. */
    inboundNonce?: string;
  }
}

export interface InboundAuthDeps {
  clock: Clock;
  /** The signing key of each front door. A source with no key here is refused. */
  keys: Partial<Record<InboundSource, string>>;
}

/**
 * Authenticates every route declared `inbound`, after the body is read and before it is validated, so nothing in the
 * body can be learned by a caller who is not signed. In order: the source has a key, the timestamp is inside the
 * window and the signature matches the exact body bytes. A bad or missing signature, a stale time and an unknown source
 * all get the same 401, and nothing is written. The nonce is spent by the route (`acceptScreen`), in the same
 * transaction as what it stores, so a write that fails leaves the request retriable; an inbound route must do the same.
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
    request.inboundSource = checked.source;
    request.inboundNonce = checked.nonce;
  });
}
