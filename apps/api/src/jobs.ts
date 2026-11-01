import type { FastifyBaseLogger } from 'fastify';
import { PgBoss } from 'pg-boss';
import type { Clock } from './clock';
import type { Db } from './db/client';
import { sweep } from './sweep';

export const SWEEP_QUEUE = 'ticket-sweep';

export interface Jobs {
  /** The queue itself, for a check that needs to see its schedule or fire it. */
  boss: PgBoss;
  stop(): Promise<void>;
}

/**
 * Starts pg-boss and runs `sweep` every minute. The sweep is idempotent and arbitrated by the event sequence
 * constraint, so it does not matter that several API processes each run the schedule.
 */
export async function startJobs(options: { databaseUrl: string; db: Db; clock: Clock; securityClock?: Clock; log: FastifyBaseLogger }): Promise<Jobs> {
  const boss = new PgBoss(options.databaseUrl);
  boss.on('error', (error) => options.log.error({ err: error }, 'job queue error'));
  await boss.start();
  await boss.createQueue(SWEEP_QUEUE);
  await boss.schedule(SWEEP_QUEUE, '* * * * *');
  await boss.work(SWEEP_QUEUE, async () => {
    const result = await sweep(options.db, options.clock, {}, options.securityClock);
    if (result.marked > 0) options.log.info(result, 'tickets marked overdue');
  });
  return { boss, stop: () => boss.stop({ graceful: true, timeout: 10_000 }) };
}
