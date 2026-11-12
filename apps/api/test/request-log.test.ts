import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { ManualClock } from '../src/clock';
import { privateRequestLogger, REQUEST_LOG_SERIALIZERS, UNMATCHED_ROUTE } from '../src/plugins/request-log';
import { runSeed } from '../src/seed/run';
import { TEST_START } from './helpers/app';
import { TEST_CONFIG } from './helpers/config';
import { createTestDb, type TestDb } from './helpers/db';
import { handoffBody, registerPerson, sendCrisisEvent } from './helpers/flow';

type Line = Record<string, unknown> & { msg?: string; req?: Record<string, unknown>; res?: Record<string, unknown>; link?: unknown };

describe('the API request log', () => {
  let testDb: TestDb;
  let lines: Line[];
  let raw: string[];
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    testDb = await createTestDb();
    await runSeed(testDb.db, testDb.cipher);
    raw = [];
    lines = [];
    const stream = new Writable({
      write(chunk, _encoding, done) {
        raw.push(String(chunk));
        lines.push(JSON.parse(String(chunk)) as Line);
        done();
      },
    });
    // The real notifier and the same logger options as `main.ts` apart from the stream: every line goes where a test can read it.
    app = await buildApp({ db: testDb.db, clock: new ManualClock(TEST_START), config: { ...TEST_CONFIG, demoMode: false, notifierDriver: 'log' }, logger: { level: 'trace', stream } });
  });

  afterAll(async () => {
    await app.close();
    await testDb.close();
  });

  /** The lines the request log writes: the ones Fastify writes about a request or its reply, not the notifier's deliberate record. */
  const requestLines = () => lines.filter((line) => line.req !== undefined || line.res !== undefined);

  it('writes a hand-off stop and every other route by its pattern, with no id, query, host or client address in any line', async () => {
    const person = await registerPerson({ app });
    const eventId = await sendCrisisEvent({ app }, person);
    const handoffId = randomUUID();
    const sent = await app.inject({ method: 'POST', url: '/me/crisis-handoffs', headers: person.headers, payload: handoffBody(eventId, { handoffId }) });
    expect(sent.statusCode).toBe(201);
    const stopped = await app.inject({ method: 'DELETE', url: `/me/crisis-handoffs/${handoffId}`, headers: person.headers });
    expect(stopped.statusCode).toBe(200);
    const stoppedAgain = await app.inject({ method: 'DELETE', url: `/me/crisis-handoffs/${handoffId}`, headers: person.headers });
    expect(stoppedAgain.statusCode).toBe(404);
    const ticketId = randomUUID();
    const ticket = await app.inject({ method: 'GET', url: `/me/tickets/${ticketId}?locale=ar&marker=QUERY-MARKER-5513`, headers: person.headers });
    expect(ticket.statusCode).toBe(404);
    const unknown = await app.inject({ method: 'GET', url: `/nothing-here/${ticketId}?marker=QUERY-MARKER-5513` });
    expect(unknown.statusCode).toBe(404);

    expect(requestLines().length).toBeGreaterThan(10);
    const log = raw.join('');
    for (const secret of [handoffId, ticketId, eventId, person.id, person.headers.authorization, 'QUERY-MARKER-5513', '127.0.0.1', 'localhost']) {
      expect(log, `the log holds ${secret}`).not.toContain(secret);
    }

    const stops = requestLines().filter((line) => line.req?.method === 'DELETE' && line.req?.route === '/me/crisis-handoffs/:id');
    expect(stops.map((line) => line.msg)).toEqual(['incoming request', 'incoming request']);
    expect(requestLines().some((line) => line.req?.route === '/me/tickets/:id')).toBe(true);
    expect(requestLines().some((line) => line.req?.route === UNMATCHED_ROUTE)).toBe(true);
  });

  it('keeps a request line to the method and the route, and a reply line to the status and the time', async () => {
    await app.inject({ method: 'GET', url: '/health' });
    const requests = requestLines().filter((line) => line.req !== undefined);
    const replies = requestLines().filter((line) => line.res !== undefined);
    expect(requests.length).toBeGreaterThan(0);
    for (const line of requests) expect(Object.keys(line.req!).sort()).toEqual(['method', 'route']);
    for (const line of replies) expect(Object.keys(line.res!)).toEqual(['statusCode']);
    expect(replies.every((line) => typeof line.responseTime === 'number')).toBe(true);
  });

  it('never writes a staff sign-in token or a clinic-link credential into a request line; only the notifier writes the link it issues', async () => {
    const before = lines.length;
    const issued = await app.inject({ method: 'POST', url: '/auth/magic-link', payload: { email: 'ops@demo.mawsool.test' } });
    expect(issued.statusCode).toBe(202);
    const link = lines.slice(before).find((line) => typeof line.link === 'string')!.link as string;
    const token = new URL(link).searchParams.get('token')!;
    const verified = await app.inject({ method: 'POST', url: '/auth/verify', payload: { token } });
    expect(verified.statusCode).toBe(200);
    const sessionToken = verified.json().sessionToken as string;

    const ticketId = randomUUID();
    const clinicToken = 'CLINIC-TOKEN-MARKER-7741';
    const opened = await app.inject({ method: 'POST', url: '/clinic-link/open', payload: { ticketId, token: clinicToken } });
    expect(opened.statusCode).toBe(401);
    const acted = await app.inject({ method: 'POST', url: '/clinic-link/act', payload: { ticketId, token: clinicToken, to: 'acknowledged' } });
    expect(acted.statusCode).toBe(401);

    const written = lines.slice(before);
    const holdingToken = written.filter((line) => JSON.stringify(line).includes(token));
    expect(holdingToken).toHaveLength(1);
    expect(holdingToken[0]!.link).toBe(link);
    for (const secret of [sessionToken, clinicToken, ticketId]) {
      expect(written.filter((line) => JSON.stringify(line).includes(secret))).toEqual([]);
    }
    expect(written.filter((line) => line.req?.route === '/clinic-link/open')).toHaveLength(1);
  });

  it('reduces an error to its type, message and stack, so a database error cannot write the values it carries', () => {
    const databaseError = Object.assign(new Error('insert failed'), { detail: 'Key (id)=(ROW-VALUE-MARKER-3380) already exists', parameters: ['ROW-VALUE-MARKER-3380'] });
    const logged = REQUEST_LOG_SERIALIZERS.err(databaseError);
    expect(Object.keys(logged).sort()).toEqual(['message', 'stack', 'type']);
    expect(JSON.stringify(logged)).not.toContain('ROW-VALUE-MARKER-3380');
  });

  it('stays silent when logging is off, and takes the serializers whether the logger is given as true or as options', () => {
    expect(privateRequestLogger(false)).toBe(false);
    expect(privateRequestLogger(undefined)).toBe(false);
    for (const logger of [true as const, { level: 'info' as const }]) {
      const options = privateRequestLogger(logger) as unknown as { serializers: Record<string, unknown> };
      expect(Object.keys(options.serializers).sort()).toEqual(['err', 'req']);
    }
    const overridden = privateRequestLogger({ serializers: { req: () => ({ url: '/leak' }) } }) as unknown as { serializers: { req: (request: object) => object } };
    expect(overridden.serializers.req({ method: 'GET', routeOptions: { url: '/x' } })).toEqual({ method: 'GET', route: '/x' });
  });
});
