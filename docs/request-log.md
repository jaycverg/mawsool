# What the API's request log says

Code: `apps/api/src/plugins/request-log.ts`, wired in `buildApp`; test: `apps/api/test/request-log.test.ts`.

Fastify's default request logging writes, for every request, the full URL as typed (path with ids, and the query string), the host header, the client address and port and the version header. A hand-off stop (`DELETE /me/crisis-handoffs/:id`) would therefore put the hand-off id in the log next to the client's address and the time, which undoes "after a stop nothing the server keeps ties the person to that crisis".

The API now logs a request as **the method and the route pattern** (`DELETE /me/crisis-handoffs/:id`), for every route, with `(unmatched)` for a request no route took. The reply line carries the status code and the response time; every line also carries Fastify's own request counter (`req-N`, not an id from the caller), the level, the time, the process id and the host name of the machine the API runs on.

Dropped from the request line, compared with the default:

| Dropped | Why |
| ------- | --- |
| the URL as typed | path ids (hand-off, ticket, person) |
| the query string | for example the page language the person app sends |
| the `host` header | names the deployment the caller used |
| the client address and port | ties an id to a client |
| the `accept-version` header | not needed |

Also changed:

- Fastify's own 404 writes "Route GET:/the/typed/address not found" to the log. The API now answers an unmatched route itself with the same reply and writes nothing but the request line.
- An error is logged as its type, message and the stack's frame lines only. The default copies every own property of the error, and a database error carries the offending values in `detail` and `parameters`.
- A failed query is logged as the fixed message `database query failed` and its SQLSTATE (`code`, for example `42P01`), never as the message the database layer gives it. drizzle rethrows every failed query as `Failed query: <sql>` followed by `params: <the bound values>`, and those values are the ids and hashes the query was bound to (a hand-off, a person, a crisis event, a ticket, a token's hash); the same text is the first line of the error's stack, so the stack is cut to its `at ...` frames for every error. The error's `cause` is read for the SQLSTATE and never logged. This covers the request error handler, the clinic-link and staff sign-in delivery failures and the job queue's errors, which all log through the same serializer. `request-log.test.ts` drops a table under a real route on PGlite and reads the raw log lines.

**What the job queue stores when the sweep fails** (`apps/api/src/jobs.ts`, `sweepJob`; case 2b of `gate:postgres`). pg-boss writes the error a work handler throws into `pgboss.job.output` (name, message, stack and every own property, `cause` included), and no erase path reaches that table, so the raw error would leave the ids a failed query was bound to in a table nobody clears. The sweep's handler therefore logs the original error through the serializer above and throws a fresh `SweepFailedError` instead: the fixed message `ticket sweep failed` and, when the sweep failed with a database error, its SQLSTATE as `code` (`23514`), with no cause, query, bound value or part of the original's message. pg-boss serialises a thrown error with `serialize-error`, which uses an error's own `toJSON` when it has one, so `SweepFailedError.toJSON` makes what is stored exactly `{ message, code }`: no error name and no stack (no file path of this code); the case checks the stored `output` has those keys and nothing more. The gate makes the database refuse every overdue event, so the real error carries a ticket id in its failing row and in its bound values, and checks the stored `output` and every row of the queue's tables named for the sweep against the open tickets' ids, the query text and the constraint name. Rows written by earlier failures, before this change, are not rewritten (no migration; demo data only). Not examined: what pg-boss stores when it fails a job without the handler's error (for example one that runs out of time); that text is pg-boss's own.

The serializers replace any a caller passes (`privateRequestLogger`), so the guarantee cannot be configured away. Credentials never travel in a URL: the clinic link and the staff sign-in send theirs in a body (the clinic link) or in the clinician app's page address (the staff sign-in link, which the API only issues). The notifier still writes the link it issues on purpose, as the mock delivery (`messaging.md`); that line is not a request line.

Not covered: the logs of whatever sits in front of the API (a proxy, a platform), which see the real URL; and the message of an error that is not a database error (it is logged as written, so code that throws with a value in its message would log the value).
