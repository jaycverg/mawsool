// Serves the real Ticket API on an in-process Postgres (PGlite) seeded with the deterministic seed, for end-to-end
// checks. No Docker. Every route, schema and migration is the production one; only the database driver differs.
//
// A second, read-only listener lets a test look at what the API stored without going through the API: the rows of
// a crisis event and the number of registered devices. It is part of this harness, not of the product API.
//
// Usage: tsx src/cli/serve-e2e.ts   (E2E_API_PORT, E2E_INSPECT_PORT, E2E_ORIGIN)
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { createServer } from 'node:http';
import { buildApp } from '../app';
import { schema, type Db } from '../db/client';
import { MIGRATIONS_FOLDER } from '../db/migrate';
import { runSeed } from '../seed/run';

// A fixed key for the throwaway end-to-end database; it protects nothing.
const E2E_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
const apiPort = Number(process.env.E2E_API_PORT ?? 4450);
const inspectPort = Number(process.env.E2E_INSPECT_PORT ?? 4451);
const origin = process.env.E2E_ORIGIN ?? 'http://localhost:3450';

const client = new PGlite();
const db = drizzle(client, { schema }) as unknown as Db;
await migrate(drizzle(client, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });
await runSeed(db);

const app = await buildApp({
  db,
  config: { corsOrigins: [origin], clinicianAppUrl: 'http://localhost:3001', opsAppUrl: 'http://localhost:3002', encryptionKey: E2E_ENCRYPTION_KEY, summaryLlmEnabled: false },
  logger: false,
});
await app.listen({ port: apiPort, host: '127.0.0.1' });

const inspect = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  response.setHeader('content-type', 'application/json');
  const crisis = /^\/crisis-events\/([0-9a-f-]{36})$/.exec(url.pathname);
  if (crisis) {
    const rows = await db.select().from(schema.crisisEvents).where(eq(schema.crisisEvents.id, crisis[1]!));
    response.end(JSON.stringify(rows));
  } else if (url.pathname === '/persons/count') {
    response.end(JSON.stringify({ count: (await db.select({ id: schema.persons.id }).from(schema.persons)).length }));
  } else {
    response.statusCode = 404;
    response.end('{}');
  }
});
inspect.listen(inspectPort, '127.0.0.1');

console.log(`e2e api ready on http://127.0.0.1:${apiPort}, inspect on http://127.0.0.1:${inspectPort}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    inspect.close();
    void app.close().then(() => client.close()).then(() => process.exit(0));
  });
}
