import type { FastifyInstance } from 'fastify';

/**
 * What every API response says to the browser that reads it. The API only ever answers JSON, so the policy is the
 * tightest there is: nothing may load or run from a response, and it cannot be framed. The staff screens read
 * wellbeing data from here with a bearer token in the tab, so the replies are also never stored (`no-store`) by the
 * browser or a proxy, and never sniffed into another type. These are the staff apps' counterpart to their own page
 * policy (`staffContentSecurityPolicy` in `@mawsool/ui`).
 */
export const API_SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
} as const;

/** Adds `API_SECURITY_HEADERS` to every response, errors and CORS preflights included. */
export function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook('onSend', async (_request, reply) => {
    for (const [name, value] of Object.entries(API_SECURITY_HEADERS)) reply.header(name, value);
  });
}
