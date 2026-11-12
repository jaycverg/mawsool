import type { FastifyServerOptions } from 'fastify';

/** What a request log line says about a route nobody registered (a 404): no part of the address the caller typed. */
export const UNMATCHED_ROUTE = '(unmatched)';

/** The shape of the request the logger is handed (Fastify passes its own request object). */
interface LoggedRequest {
  method?: string;
  routeOptions?: { url?: string };
}

/** The shape of the error the logger is handed. */
interface LoggedError {
  name: string;
  message: string;
  stack?: string;
}

/**
 * What a request log line may say: the method and the route pattern (`/me/crisis-handoffs/:id`), never the address as
 * typed. The default serializer also writes the full URL, its query string, the host, the client address and port and
 * the version header; the first two can carry an id (a hand-off, a ticket, a person) and the next two tie it to a client.
 * The status code and the response time are added by Fastify's own `res` and `responseTime` fields.
 */
function serializeRequest(request: LoggedRequest): { method?: string; route: string } {
  return { method: request.method, route: request.routeOptions?.url ?? UNMATCHED_ROUTE };
}

/**
 * An error, reduced to its type, message and stack. The default serializer copies every own property of the error,
 * and a database error carries the offending row's values there (`detail`, `parameters`).
 */
function serializeError(error: LoggedError): { type: string; message: string; stack: string } {
  return { type: error.name, message: error.message, stack: error.stack ?? '' };
}

/** The serializers the API's request log runs on. They replace the defaults and any a caller passes. */
export const REQUEST_LOG_SERIALIZERS = { req: serializeRequest, err: serializeError } as const;

/**
 * Turns the `logger` option into one that logs requests by route pattern. `true` and an options object both get the
 * serializers (they win over any the caller passes, so the guarantee cannot be configured away); `false` stays silent.
 */
export function privateRequestLogger(logger: FastifyServerOptions['logger']): FastifyServerOptions['logger'] {
  if (!logger) return false;
  const options = logger === true ? {} : logger;
  return { ...options, serializers: { ...('serializers' in options ? options.serializers : undefined), ...REQUEST_LOG_SERIALIZERS } };
}
