import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { DrizzleQueryError, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ManualClock } from '../src/clock';
import { schema } from '../src/db/client';
import { SWEEP_FAILED_MESSAGE, SweepFailedError, sweepFailure, sweepJob } from '../src/jobs';
import { runSeed } from '../src/seed/run';
import { createTestDb, type TestDb } from './helpers/db';

/** Every field a queue could store of an error: its own properties (enumerable or not), its stack and, one level down, its cause. */
function everythingOf(error: Error): string {
  const fields = (value: object) => Object.fromEntries(Object.getOwnPropertyNames(value).map((name) => [name, (value as Record<string, unknown>)[name]]));
  return JSON.stringify({ ...fields(error), cause: error.cause === undefined ? undefined : fields(error.cause as object), string: String(error) });
}

/**
 * What pg-boss writes into `pgboss.job.output` for a handler that threw `error`: its own serialiser (`serialize-error`, resolved from pg-boss so it is the
 * version pg-boss uses), the call `mapCompletionDataArg` makes for an object. Not a copy of pg-boss's rules, the library itself.
 */
async function storedByPgBoss(error: Error): Promise<Record<string, unknown>> {
  const fromPgBoss = createRequire(createRequire(import.meta.url).resolve('pg-boss'));
  const { serializeError } = (await import(pathToFileURL(fromPgBoss.resolve('serialize-error')).href)) as { serializeError: (value: object) => Record<string, unknown> };
  return JSON.parse(JSON.stringify(serializeError(error))) as Record<string, unknown>;
}

describe('what a failed sweep hands the job queue', () => {
  let testDb: TestDb;
  const clock = new ManualClock(new Date('2030-01-01T00:00:00Z'));

  beforeAll(async () => {
    testDb = await createTestDb();
    await runSeed(testDb.db, testDb.cipher);
    // Every open ticket is due at this clock, and the overdue event of each is refused by the database with the row (a ticket id) in its detail.
    await testDb.db.execute(sql.raw("ALTER TABLE ticket_events ADD CONSTRAINT no_overdue_events CHECK (to_state <> 'overdue') NOT VALID"));
  });

  afterAll(async () => {
    await testDb.close();
  });

  /** The error a real failing sweep throws, with the ids it carries. */
  async function realFailure() {
    const open = (await testDb.db.select({ id: schema.tickets.id }).from(schema.tickets)).map((row) => row.id);
    const log = { error: vi.fn(), info: vi.fn() };
    const rejected = await sweepJob({ db: testDb.db, clock, log: log as never })().then(
      () => null,
      (error: unknown) => error as Error,
    );
    return { open, log, rejected };
  }

  it('is a fixed message and the database error code, with nothing of the query, the bound ids or the original error', async () => {
    const { open, rejected } = await realFailure();
    expect(rejected).toBeInstanceOf(SweepFailedError);
    expect(rejected!.message).toBe(SWEEP_FAILED_MESSAGE);
    expect((rejected as SweepFailedError).code).toBe('23514');
    expect(rejected!.cause).toBeUndefined();
    const stored = everythingOf(rejected!);
    for (const marker of [...open.slice(0, 5), 'Failed query', 'params:', 'ticket_events', 'overdue', 'no_overdue_events', 'Failing row']) {
      expect(stored, `what the queue would store holds ${marker}`).not.toContain(marker);
    }
  });

  it('is stored by pg-boss as exactly the fixed message and the code: no error name, no stack, nothing else', async () => {
    const { rejected } = await realFailure();
    expect(await storedByPgBoss(rejected!)).toEqual({ message: SWEEP_FAILED_MESSAGE, code: '23514' });
  });

  it('shows the original error to the log through the request log’s serializer, which keeps no bound value either', async () => {
    const { log, rejected } = await realFailure();
    expect(log.error).toHaveBeenCalledTimes(1);
    const [fields, message] = log.error.mock.calls[0]!;
    expect(message).toBe('ticket sweep failed');
    expect((fields as { err: unknown }).err, 'the log gets the original, which the serializer reduces').toBeInstanceOf(DrizzleQueryError);
    expect(rejected).toBeInstanceOf(SweepFailedError);
  });

  it('carries no code for an error that is not a database error, and still no part of its message', async () => {
    const failure = sweepFailure(new TypeError('cannot read the ticket 5f0d0f0e-0000-4000-8000-000000000000'));
    expect(failure.message).toBe(SWEEP_FAILED_MESSAGE);
    expect('code' in failure).toBe(false);
    expect(everythingOf(failure)).not.toContain('5f0d0f0e');
    expect(everythingOf(sweepFailure('a string, not an error'))).not.toContain('a string');
    expect(await storedByPgBoss(failure), 'a failure with no code is stored as the message alone').toEqual({ message: SWEEP_FAILED_MESSAGE });
  });

  it('runs a sweep that succeeds without an error and says how many it marked', async () => {
    const fine = await createTestDb();
    try {
      await runSeed(fine.db, fine.cipher);
      const log = { error: vi.fn(), info: vi.fn() };
      await expect(sweepJob({ db: fine.db, clock, log: log as never })()).resolves.toBeUndefined();
      expect(log.error).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledTimes(1);
    } finally {
      await fine.close();
    }
  });
});
