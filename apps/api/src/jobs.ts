import type { FastifyBaseLogger } from 'fastify';
import { PgBoss } from 'pg-boss';
import type { Clock } from './clock';
import type { Db } from './db/client';
import { databaseErrorCode } from './plugins/request-log';
import { sweep } from './sweep';

export const SWEEP_QUEUE = 'ticket-sweep';

/** What the job queue's tables say when the sweep fails: this message and, for a database error, its SQLSTATE, and nothing else. */
export const SWEEP_FAILED_MESSAGE = 'ticket sweep failed';

/** The only error the job queue is ever given for a failed sweep. It carries no cause, query, bound value or message of the original, and stores only what `toJSON` returns. */
export class SweepFailedError extends Error {
  /** The SQLSTATE of the database error the sweep failed with, when it was one. */
  declare readonly code?: string;

  constructor(code: string | undefined) {
    super(SWEEP_FAILED_MESSAGE);
    this.name = 'SweepFailedError';
    if (code) this.code = code;
  }

  /**
   * What the job queue stores. pg-boss serialises a thrown error with `serialize-error`, which writes its name, message, stack (our file paths) and
   * every own property, but calls an error's `toJSON` instead when it has one. This is therefore exactly what lands in `pgboss.job.output`:
   * the fixed message and, for a database error, its SQLSTATE; no name, no stack.
   */
  toJSON(): { message: string; code?: string } {
    return this.code ? { message: this.message, code: this.code } : { message: this.message };
  }
}

/**
 * Reduces whatever a failed sweep threw to the one error pg-boss may store. pg-boss writes the thrown error (name, message, stack and every own
 * property, `cause` and a database error's `detail` and bound values included, unless the error has a `toJSON`) into `pgboss.job.output`, which no erase path reaches, and a failed query's
 * message carries the ids it was bound to. The original is logged by the caller through the request log's serializer, never handed to the queue.
 */
export function sweepFailure(error: unknown): SweepFailedError {
  return new SweepFailedError(databaseErrorCode(error));
}

interface SweepJobOptions {
  db: Db;
  clock: Clock;
  securityClock?: Clock;
  log: FastifyBaseLogger;
}

/**
 * The work handler pg-boss runs for the sweep queue: one sweep, whose failure is logged through the request log's serializer and rethrown
 * as a `SweepFailedError`, so the queue keeps no query, id or value.
 */
export function sweepJob(options: SweepJobOptions): () => Promise<void> {
  return async () => {
    const result = await sweep(options.db, options.clock, {}, options.securityClock).catch((error: unknown) => {
      options.log.error({ err: error }, 'ticket sweep failed');
      throw sweepFailure(error);
    });
    if (result.marked > 0) options.log.info(result, 'tickets marked overdue');
  };
}

export interface Jobs {
  /** The queue itself, for a check that needs to see its schedule or fire it. */
  boss: PgBoss;
  stop(): Promise<void>;
}

/**
 * Starts pg-boss and runs `sweep` every minute. The sweep is idempotent and arbitrated by the event sequence
 * constraint, so it does not matter that several API processes each run the schedule (`sweepJob` is the handler).
 */
export async function startJobs(options: { databaseUrl: string; db: Db; clock: Clock; securityClock?: Clock; log: FastifyBaseLogger }): Promise<Jobs> {
  const boss = new PgBoss(options.databaseUrl);
  boss.on('error', (error) => options.log.error({ err: error }, 'job queue error'));
  await boss.start();
  await boss.createQueue(SWEEP_QUEUE);
  await boss.schedule(SWEEP_QUEUE, '* * * * *');
  await boss.work(SWEEP_QUEUE, sweepJob(options));
  return { boss, stop: () => boss.stop({ graceful: true, timeout: 10_000 }) };
}
