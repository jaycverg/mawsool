import { DrizzleQueryError } from 'drizzle-orm';
import type { FastifyServerOptions } from 'fastify';

/** What a request log line says about a route nobody registered (a 404): no part of the address the caller typed. */
export const UNMATCHED_ROUTE = '(unmatched)';

/** The shape of the request the logger is handed (Fastify passes its own request object). */
interface LoggedRequest {
  method?: string;
  routeOptions?: { url?: string };
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

/** The shape of the error the logger is handed. */
interface LoggedError {
  name: string;
  message: string;
  stack?: string;
  cause?: unknown;
}

/** What a log line says in place of a failed query's message, which carries its SQL and its bound values. */
export const DATABASE_ERROR_MESSAGE = 'database query failed';

const SQLSTATE = /^[0-9A-Z]{5}$/;
const MAX_CAUSE_DEPTH = 5;

/**
 * Whether an error comes from the database layer: drizzle's own wrapper (it carries the query and its params) or the
 * driver's error underneath it (it carries the server's severity and SQLSTATE).
 */
function isDatabaseError(error: unknown): boolean {
  if (error instanceof DrizzleQueryError) return true;
  if (typeof error !== 'object' || error === null) return false;
  const fields = error as { query?: unknown; params?: unknown; severity?: unknown; code?: unknown };
  return (typeof fields.query === 'string' && fields.params !== undefined) || (typeof fields.severity === 'string' && typeof fields.code === 'string');
}

/** The SQLSTATE (`23505`, `42P01`) of an error or of the nearest cause that has one, which names the failure and no value. */
function sqlStateOf(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof current === 'object' && current !== null; depth += 1) {
    const { code, cause } = current as { code?: unknown; cause?: unknown };
    if (typeof code === 'string' && SQLSTATE.test(code)) return code;
    current = cause;
  }
  return undefined;
}

/** The SQLSTATE of a database error, and undefined for any other error. */
export function databaseErrorCode(error: unknown): string | undefined {
  return isDatabaseError(error) ? sqlStateOf(error) : undefined;
}

/** The frame lines of a stack (`    at ...`); its header repeats the message, which may be the one that must not be logged. */
function stackFrames(stack: string | undefined): string {
  return (stack ?? '')
    .split('\n')
    .filter((line) => /^\s+at /.test(line))
    .join('\n');
}

/**
 * An error, reduced to its type, message, stack frames and, for a database error, its SQLSTATE. The default serializer
 * copies every own property of the error, and a database error carries the offending row's values there (`detail`,
 * `parameters`). A failed query is also rethrown by drizzle with the message `Failed query: <sql>` and `params: <values>`,
 * where the values are the ids and hashes the query was bound to; a database error therefore logs a fixed message and its
 * SQLSTATE instead. The stack's header line repeats the message, so only its frames are kept. The `cause` is never logged,
 * only read for the SQLSTATE.
 */
function serializeError(error: LoggedError): { type: string; message: string; code?: string; stack: string } {
  if (!isDatabaseError(error)) return { type: error.name, message: error.message, stack: stackFrames(error.stack) };
  const code = sqlStateOf(error);
  return { type: error.name, message: DATABASE_ERROR_MESSAGE, ...(code ? { code } : {}), stack: stackFrames(error.stack) };
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
