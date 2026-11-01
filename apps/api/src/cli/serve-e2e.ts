// Serves the real Ticket API on an in-process Postgres (PGlite) seeded with the deterministic seed, for end-to-end
// checks. No Docker. Every route, schema and migration is the production one; only the database driver differs.
//
// A second, read-only listener lets a test look at what the API stored without going through the API: the rows of a
// crisis event, the raw bundle of a ticket (as stored, and decrypted with this harness's own key), its events and
// consents, a person's equity buckets and the number of registered devices. It is part of this harness, not of the
// product API. It also returns the sign-in link the API logged for an address (the product never sends it), read from
// the API's own log lines, and counts invites and nonces.
//
// Usage: tsx src/cli/serve-e2e.ts   (E2E_API_PORT, E2E_INSPECT_PORT, E2E_ORIGIN, E2E_CLINICIAN_URL, E2E_OPS_URL)
import { PGlite } from '@electric-sql/pglite';
import { asc, eq } from 'drizzle-orm';
import { validateFhir } from '@mawsool/fhir/validate';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { createServer } from 'node:http';
import { buildApp } from '../app';
import { createCipher } from '../crypto';
import { schema, type Db } from '../db/client';
import { MIGRATIONS_FOLDER } from '../db/migrate';
import { runSeed } from '../seed/run';
import { E2E_INBOUND_KEYS } from './e2e-keys';
import { FACILITY_A_ID, STAFF } from '../seed/fixtures';
import { sha256Hex } from '../security';

// A fixed key for the throwaway end-to-end database; it protects nothing.
const E2E_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
const cipher = createCipher(E2E_ENCRYPTION_KEY);
const apiPort = Number(process.env.E2E_API_PORT ?? 4450);
const inspectPort = Number(process.env.E2E_INSPECT_PORT ?? 4451);
const origin = process.env.E2E_ORIGIN ?? 'http://localhost:3450';
const clinicianUrl = process.env.E2E_CLINICIAN_URL ?? 'http://localhost:3001';
const opsUrl = process.env.E2E_OPS_URL ?? 'http://localhost:3002';

/**
 * The API's own log, kept in memory instead of printed: the staff sign-in link is "logged, not sent", so the end-to-end
 * run reads it from the log line the real notifier writes. Errors are also printed.
 */
const logLines: string[] = [];
const logStream = {
  write(line: string) {
    logLines.push(line);
    if (/"level":(50|60)/.test(line)) process.stdout.write(line);
  },
};

/** The newest link the API logged for an address, or null. */
function loggedSignInLink(to: string): string | null {
  for (const line of [...logLines].reverse()) {
    if (!line.includes('staff sign-in link (logged, not sent)')) continue;
    const entry = JSON.parse(line) as { to?: string; link?: string };
    if (entry.to === to && entry.link) return entry.link;
  }
  return null;
}

const client = new PGlite();
const db = drizzle(client, { schema }) as unknown as Db;
await migrate(drizzle(client, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });
await runSeed(db);

// One staff session per seeded clinician, so a test can ask what the clinic at a ticket's facility would be told.
const clinicTokens = new Map<string, string>();
for (const staff of STAFF.filter((member) => member.role === 'clinician')) {
  const token = `e2e-clinic-${staff.facilityId}`;
  clinicTokens.set(staff.facilityId!, token);
  await db.insert(schema.staffSessions).values({ staffUserId: staff.id, tokenHash: sha256Hex(token), createdAt: new Date(0), expiresAt: new Date('2100-01-01T00:00:00Z') });
}

const app = await buildApp({
  db,
  config: {
    corsOrigins: [origin, clinicianUrl, opsUrl],
    clinicianAppUrl: clinicianUrl,
    opsAppUrl: opsUrl,
    personAppUrl: origin,
    inboundKeys: E2E_INBOUND_KEYS,
    encryptionKey: E2E_ENCRYPTION_KEY,
    summaryLlmEnabled: false,
    // Only the demo gate sets this; every other end-to-end run keeps the demo routes unregistered.
    demoMode: process.env.E2E_DEMO_MODE === '1',
  },
  logger: { level: 'info', stream: logStream },
});
await app.listen({ port: apiPort, host: '127.0.0.1' });

const inspect = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  response.setHeader('content-type', 'application/json');
  const crisis = /^\/crisis-events\/([0-9a-f-]{36})$/.exec(url.pathname);
  if (request.method === 'POST' && url.pathname === '/fhir/validate') {
    // The official R4 schema check (the same one the package tests use), for a bundle the end-to-end run exported.
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    response.end(JSON.stringify(validateFhir(JSON.parse(Buffer.concat(chunks).toString('utf8')))));
  } else if (crisis) {
    const rows = await db.select().from(schema.crisisEvents).where(eq(schema.crisisEvents.id, crisis[1]!));
    response.end(JSON.stringify(rows));
  } else if (/^\/tickets\/[0-9a-f-]{36}$/.test(url.pathname)) {
    const id = url.pathname.split('/')[2]!;
    const [ticket] = await db.select().from(schema.tickets).where(eq(schema.tickets.id, id));
    const [bundle] = await db.select().from(schema.sharedBundles).where(eq(schema.sharedBundles.ticketId, id));
    const events = await db.select().from(schema.ticketEvents).where(eq(schema.ticketEvents.ticketId, id)).orderBy(asc(schema.ticketEvents.seq));
    const consents = await db.select().from(schema.consents).where(eq(schema.consents.ticketId, id));
    const logs = await db.select().from(schema.summaryLogs).where(eq(schema.summaryLogs.ticketId, id));
    const children = await db.select({ id: schema.tickets.id }).from(schema.tickets).where(eq(schema.tickets.parentTicketId, id));
    response.end(
      JSON.stringify({
        ticket,
        events,
        consents,
        summaryLogs: logs.length,
        bundleReads: (await db.select({ id: schema.bundleReads.id }).from(schema.bundleReads).where(eq(schema.bundleReads.ticketId, id))).length,
        children: children.map((child) => child.id),
        bundle: bundle && {
          contentCiphertext: bundle.contentCiphertext,
          approvedSummaryCiphertext: bundle.approvedSummaryCiphertext,
          summaryBuiltFrom: bundle.summaryBuiltFrom,
          deletedAt: bundle.deletedAt,
          content: bundle.contentCiphertext ? JSON.parse(cipher.decrypt(bundle.contentCiphertext, `bundle:${id}`)) : null,
        },
      }),
    );
  } else if (/^\/clinic-read\/[0-9a-f-]{36}$/.test(url.pathname)) {
    const id = url.pathname.split('/')[2]!;
    const [row] = await db
      .select({ facilityId: schema.services.facilityId })
      .from(schema.tickets)
      .innerJoin(schema.services, eq(schema.services.id, schema.tickets.serviceId))
      .where(eq(schema.tickets.id, id));
    const headers = { authorization: `Bearer ${clinicTokens.get(row?.facilityId ?? FACILITY_A_ID)}` };
    const [bundle, ticket] = await Promise.all([
      app.inject({ method: 'GET', url: `/tickets/${id}/bundle`, headers }),
      app.inject({ method: 'GET', url: `/tickets/${id}`, headers }),
    ]);
    response.end(JSON.stringify({ bundle: bundle.statusCode, ticket: ticket.statusCode, body: bundle.body }));
  } else if (/^\/persons\/[0-9a-f-]{36}$/.test(url.pathname)) {
    const [person] = await db.select().from(schema.persons).where(eq(schema.persons.id, url.pathname.split('/')[2]!));
    response.end(JSON.stringify(person && { equityOptIn: person.equityOptIn, ageBand: person.ageBand, gender: person.gender, language: person.language, region: person.region }));
  } else if (url.pathname === '/logged-sign-in-link') {
    response.end(JSON.stringify({ link: loggedSignInLink(url.searchParams.get('to') ?? '') }));
  } else if (url.pathname === '/inbound/counts') {
    const [invites, nonces] = await Promise.all([db.select().from(schema.inboundInvites), db.select().from(schema.inboundNonces)]);
    response.end(JSON.stringify({ invites: invites.length, nonces: nonces.length }));
  } else if (/^\/invites\/[0-9a-f-]{36}$/.test(url.pathname)) {
    const [invite] = await db.select().from(schema.inboundInvites).where(eq(schema.inboundInvites.id, url.pathname.split('/')[2]!));
    response.end(JSON.stringify(invite ?? null));
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
