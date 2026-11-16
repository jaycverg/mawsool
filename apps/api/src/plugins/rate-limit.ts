import rateLimit, { normalizeIP } from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/** What the limiter needs to know. Off unless `enabled`: with it off no plugin is registered and every route's limit is inert. */
export interface RateLimitSettings {
  enabled: boolean;
  /** A header that carries the real client address (`cf-connecting-ip` behind Cloudflare). Unset: the socket address decides and any such header is ignored. */
  clientIpHeader?: string | undefined;
}

/** The longest header value read as an address; anything longer is not one. */
const MAX_ADDRESS_LENGTH = 64;

/**
 * Who a request counts as, for the per-client limits. With `clientIpHeader` set it is that header's value, falling back to the
 * socket address when the header is absent or empty; unset, it is the socket address and the header is never read. The value
 * goes through the limiter's own `normalizeIP`, so IPv6 addresses are grouped by /64 as the plugin's default key does.
 *
 * Trusting the header is safe only when the origin accepts traffic from nothing but the proxy that sets it. Fastify's
 * `trustProxy` stays off.
 */
export function clientKey(request: Pick<FastifyRequest, 'headers' | 'ip'>, clientIpHeader?: string): string {
  if (clientIpHeader) {
    const raw = request.headers[clientIpHeader];
    const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
    if (value && value.length <= MAX_ADDRESS_LENGTH) return normalizeIP(value);
  }
  return normalizeIP(request.ip);
}

/** The error the limiter throws on a 429: the app's error handler turns it into `{ error: 'rate_limited' }`. It names no client. */
function limited(): Error & { statusCode: number } {
  return Object.assign(new Error('Too many requests'), { statusCode: 429 });
}

/**
 * Registers `@fastify/rate-limit` with `global: false`, in memory, only when `RATE_LIMIT` is on. Only a route that declares
 * `config.rateLimit` is limited. The plugin does not log, and the request log writes the method and route pattern only, so a
 * limited request leaves no address anywhere. Must be registered before the routes it limits.
 */
export async function registerRateLimit(app: FastifyInstance, settings: RateLimitSettings): Promise<void> {
  if (!settings.enabled) return;
  await app.register(rateLimit, {
    global: false,
    keyGenerator: (request) => clientKey(request, settings.clientIpHeader),
    errorResponseBuilder: limited,
  });
}
