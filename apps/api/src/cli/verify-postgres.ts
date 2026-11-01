// What PGlite cannot show, checked against the real Compose Postgres (`pnpm gate:postgres`):
//   1. several connections sweeping at once leave exactly one `overdue` event per ticket, and every due ticket gets one;
//   2. pg-boss starts, the sweep's schedule exists, and one fire of the queue runs the sweep.
// It works in a database of its own, created here and dropped at the end, so the dev data is never touched.
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { inArray, eq } from 'drizzle-orm';
import pg from 'pg';
import { ManualClock } from '../clock';
import { loadConfig } from '../config';
import { connect, schema } from '../db/client';
import { MIGRATIONS_FOLDER } from '../db/migrate';
import { SWEEP_QUEUE, startJobs } from '../jobs';
import { runSeed } from '../seed/run';
import { sweep } from '../sweep';

const POOLS = 8;
const config = loadConfig();
const problems: string[] = [];
const say = (message: string) => console.log(`[gate:postgres] ${message}`);
const check = (ok: boolean, message: string) => {
  say(`${ok ? 'ok     ' : 'FAILED '} ${message}`);
  if (!ok) problems.push(message);
};

const databaseName = `gate_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const adminUrl = new URL(config.databaseUrl);
const gateUrl = new URL(config.databaseUrl);
gateUrl.pathname = `/${databaseName}`;

const admin = new pg.Client({ connectionString: adminUrl.toString() });
await admin.connect();
await admin.query(`CREATE DATABASE ${databaseName}`);
const pools = Array.from({ length: POOLS }, () => connect(gateUrl.toString()));
const { db } = pools[0]!;
const migrationPool = new pg.Pool({ connectionString: gateUrl.toString() });
// Far enough ahead that every ticket the seed left open is past its deadline.
const clock = new ManualClock(new Date('2030-01-01T00:00:00Z'));

try {
  await migrate(drizzle(migrationPool, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });
  await runSeed(db);
  const open = async () => (await db.select({ id: schema.tickets.id }).from(schema.tickets).where(inArray(schema.tickets.state, ['issued', 'acknowledged']))).map((row) => row.id);
  const overdue = async () => db.select({ ticketId: schema.ticketEvents.ticketId }).from(schema.ticketEvents).where(eq(schema.ticketEvents.toState, 'overdue'));

  // 1. Parallel sweeps over separate connections.
  const due = await open();
  const before = (await overdue()).length;
  const results = await Promise.all(pools.map((pool) => sweep(pool.db, clock)));
  const events = await overdue();
  const perTicket = new Map<string, number>();
  for (const event of events) perTicket.set(event.ticketId, (perTicket.get(event.ticketId) ?? 0) + 1);
  const marked = results.reduce((sum, result) => sum + result.marked, 0);
  const lostRace = results.reduce((sum, result) => sum + result.lostRace, 0);
  say(`${POOLS} connections: ${due.length} tickets due, ${marked} marked, ${lostRace} lost races, ${events.length - before} new overdue events`);
  check(due.length > 20, 'the seed left enough open tickets for the sweeps to compete over');
  check([...perTicket.values()].every((count) => count === 1), 'no ticket has more than one overdue event');
  check(events.length - before === due.length && marked === due.length, 'every due ticket got exactly one overdue event, and the sweeps agree on the count');

  // 2. pg-boss: starts, schedule exists, one fire runs the sweep.
  await runSeed(db);
  const dueAgain = (await open()).length;
  const eventsBefore = (await overdue()).length;
  const jobs = await startJobs({ databaseUrl: gateUrl.toString(), db, clock, log: { error: console.error, info: () => undefined } as never });
  try {
    const schedules = await jobs.boss.getSchedules();
    check(schedules.some((schedule) => schedule.name === SWEEP_QUEUE && schedule.cron === '* * * * *'), 'the sweep is scheduled every minute');
    await jobs.boss.send(SWEEP_QUEUE, {});
    const deadline = performance.now() + 40_000;
    while (performance.now() < deadline && (await overdue()).length - eventsBefore < dueAgain) await new Promise((resolve) => setTimeout(resolve, 500));
    check((await overdue()).length - eventsBefore === dueAgain, `one fire of the queue ran the sweep: ${dueAgain} tickets marked overdue by the worker`);
  } finally {
    await jobs.stop();
  }
} catch (error) {
  problems.push(`threw: ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  await Promise.all([...pools.map((pool) => pool.close()), migrationPool.end()]);
  // Let every connection close on its own (pg-boss closes its pool a moment after `stop` returns) before the database goes.
  for (let wait = 0; wait < 20; wait += 1) {
    const { rows } = await admin.query('SELECT count(*)::int AS open FROM pg_stat_activity WHERE datname = $1', [databaseName]);
    if (rows[0].open === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
  await admin.end();
}
for (const problem of problems) say(`PROBLEM ${problem}`);
process.exit(problems.length === 0 ? 0 : 1);
