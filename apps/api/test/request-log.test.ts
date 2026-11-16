import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { DrizzleQueryError, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { ManualClock } from '../src/clock';
import { schema } from '../src/db/client';
import { DATABASE_ERROR_MESSAGE, privateRequestLogger, REQUEST_LOG_SERIALIZERS, UNMATCHED_ROUTE } from '../src/plugins/request-log';
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

  it('writes a failed query as a fixed message and its SQLSTATE, with no SQL, no bound value and no stack header', async () => {
    // A database of its own, so dropping a table cannot spoil the other cases.
    const broken = await createTestDb();
    await runSeed(broken.db, broken.cipher);
    const brokenRaw: string[] = [];
    const brokenLines: Line[] = [];
    const brokenApp = await buildApp({
      db: broken.db,
      clock: new ManualClock(TEST_START),
      config: { ...TEST_CONFIG, demoMode: false },
      logger: {
        level: 'trace',
        stream: new Writable({
          write(chunk, _encoding, done) {
            brokenRaw.push(String(chunk));
            brokenLines.push(JSON.parse(String(chunk)) as Line);
            done();
          },
        }),
      },
    });
    try {
      const person = await registerPerson({ app: brokenApp });
      await broken.db.execute(sql.raw('DROP TABLE crisis_handoffs CASCADE'));
      const handoffId = randomUUID();
      const failed = await brokenApp.inject({ method: 'DELETE', url: `/me/crisis-handoffs/${handoffId}`, headers: person.headers });
      expect(failed.statusCode).toBe(500);

      const log = brokenRaw.join('');
      for (const secret of [handoffId, person.id, person.headers.authorization, 'Failed query', 'params:', 'crisis_handoffs"']) {
        expect(log, `the log holds ${secret}`).not.toContain(secret);
      }
      const failures = brokenLines.filter((line) => line.msg === 'request failed');
      expect(failures).toHaveLength(1);
      const logged = failures[0]!.err as { type: string; message: string; code: string; stack: string };
      expect(logged.message).toBe(DATABASE_ERROR_MESSAGE);
      expect(logged.code).toBe('42P01');
      expect(logged.stack.split('\n').every((line) => /^\s+at /.test(line))).toBe(true);
      expect(brokenLines.some((line) => line.req?.route === '/me/crisis-handoffs/:id')).toBe(true);
    } finally {
      await brokenApp.close();
      await broken.close();
    }
  });

  it('reduces a real failed query to its SQLSTATE whether it is the wrapper or the driver error beneath it, and keeps other errors to type, message and frames', async () => {
    const probe = await createTestDb();
    try {
      const marker = 'BOUND-VALUE-MARKER-3380';
      const wrapped = await probe.db.insert(schema.revokedHandoffs).values({ handoffId: marker, revokedAt: new Date() }).then(
        () => null,
        (error: unknown) => error as Error & { cause: Error },
      );
      expect(wrapped).toBeInstanceOf(DrizzleQueryError);
      expect(wrapped!.message).toContain(marker);
      for (const error of [wrapped!, wrapped!.cause]) {
        const logged = REQUEST_LOG_SERIALIZERS.err(error);
        expect(logged.message).toBe(DATABASE_ERROR_MESSAGE);
        expect(logged.code).toBe('22P02');
        expect(JSON.stringify(logged)).not.toContain(marker);
      }
      const plain = REQUEST_LOG_SERIALIZERS.err(new TypeError('x is not a function'));
      expect(plain).toMatchObject({ type: 'TypeError', message: 'x is not a function' });
      expect('code' in plain).toBe(false);
      expect(plain.stack).not.toContain('TypeError');
    } finally {
      await probe.close();
    }
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

describe('the request log on a rate-limited request', () => {
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
    app = await buildApp({
      db: testDb.db,
      clock: new ManualClock(TEST_START),
      config: { ...TEST_CONFIG, demoMode: false, notifierDriver: 'console', rateLimit: true, clientIpHeader: 'cf-connecting-ip' },
      logger: { level: 'trace', stream },
    });
  });

  afterAll(async () => {
    await app.close();
    await testDb.close();
  });

  it('writes a provoked 429 as the method and the route pattern only, with no address, header value or body', async () => {
    const send = () =>
      app.inject({
        method: 'POST',
        url: '/auth/magic-link',
        remoteAddress: '203.0.113.77',
        headers: { 'cf-connecting-ip': '198.51.100.88' },
        payload: { email: 'nobody-marker-5521@example.test' },
      });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) statuses.push((await send()).statusCode);
    expect(statuses).toEqual([202, 202, 202, 202, 202, 429]);

    const log = raw.join('');
    for (const secret of ['203.0.113.77', '198.51.100.88', 'nobody-marker-5521', 'cf-connecting-ip']) expect(log, secret).not.toContain(secret);
    const limited = lines.filter((line) => line.res?.statusCode === 429);
    expect(limited).toHaveLength(1);
    const requests = lines.filter((line) => line.req?.route === '/auth/magic-link');
    expect(requests).toHaveLength(6);
    for (const line of requests) expect(Object.keys(line.req!).sort()).toEqual(['method', 'route']);
    expect(lines.filter((line) => line.err !== undefined)).toEqual([]);
  });
});
