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
- An error is logged as its type, message and stack only. The default copies every own property of the error, and a database error carries the offending values in `detail` and `parameters`.

The serializers replace any a caller passes (`privateRequestLogger`), so the guarantee cannot be configured away. Credentials never travel in a URL: the clinic link and the staff sign-in send theirs in a body (the clinic link) or in the clinician app's page address (the staff sign-in link, which the API only issues). The notifier still writes the link it issues on purpose, as the mock delivery (`messaging.md`); that line is not a request line.

Not covered: the logs of whatever sits in front of the API (a proxy, a platform), which see the real URL.
