// What PGlite cannot show, checked against the real Compose Postgres (`pnpm gate:postgres`):
//   1. several connections sweeping at once leave exactly one `overdue` event per ticket, and every due ticket gets one;
//   2. pg-boss starts, the sweep's schedule exists, and one fire of the queue runs the sweep;
//   2b. a sweep that fails leaves only a fixed message and the SQLSTATE in the job queue's tables, with no ticket id, query or constraint name;
//   3. every migration, through the invite tables, is applied and leaves the tables, checks and indexes the code relies on;
//   4. two connections spending the same signed-request nonce at once leave exactly one invite and one nonce;
//   5. one real "Stop sharing" through the app: the log rows made from the note go, the others and the approved summary stay;
//   6. "Delete everything" removes the invite a person claimed and keeps the ticket and its source;
//   6b. a hand-off send and a stop for the same id racing over two connections leave no hand-off and no ledger row, whoever wins;
//   6c. two presses of one no-login clinic link at once, over two connections, leave exactly one clinic move and one spent link;
//   6d. two moves of one adverse event's status at once over two connections leave one unbroken history ending on the stored status;
//   7. the demo's POST /demo/reset and one sweep (the +7 days step) leave the funnel and the Urdu row the dashboard reads
//      equal to the ones PGlite gives for the same steps, with the Urdu row flagged 18 to 22 points below overall, the
//      symptom-change figures equal too and showing numbers right after the reset, and the
//      step's stored clock offset (a bigint column) reads back as 7 days, also to an API started afterwards.
// It works in a database of its own, created here and dropped at the end, so the dev data is never touched.
import { randomUUID } from 'node:crypto';
import type { EquityCell, EquityResponse, FunnelResponse, OutcomesResponse } from '@mawsool/types';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, inArray, eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { ManualClock } from '../clock';
import { loadConfig } from '../config';
import { connect, schema, type Db } from '../db/client';
import { MIGRATIONS_FOLDER } from '../db/migrate';
import { SWEEP_FAILED_MESSAGE, SWEEP_QUEUE, startJobs } from '../jobs';
import { moveAdverseEvent, recordAdverseEvent } from '../adverse-events/service';
import { actOnClinicLink, type ClinicLinkDeps } from '../clinic-links/service';
import { acceptScreen, formatInviteCode } from '../inbound/service';
import { readDemoOffset } from '../demo/clock-store';
import { FACILITY_A_ID } from '../seed/fixtures';
import { runSeed } from '../seed/run';
import { sweep } from '../sweep';
import { createTestApp, signIn } from '../../test/helpers/app';
import { createTestDb } from '../../test/helpers/db';
import { FREE_TEXT, cipher, handoffBody, issue, rawBundle, registerPerson, sendCrisisEvent, serviceAt, ticketRequest } from '../../test/helpers/flow';

const POOLS = 8;
const config = loadConfig();
const problems: string[] = [];
const say = (message: string) => console.log(`[gate:postgres] ${message}`);
const check = (ok: boolean, message: string) => {
  say(`${ok ? 'ok     ' : 'FAILED '} ${message}`);
  if (!ok) problems.push(message);
};

/** What the dashboard reads from a database: the funnel for all time and for the last 90 days, and the Urdu row of the equity view. */
interface DemoFigures {
  funnel: FunnelResponse[];
  /** The symptom-change figures (the last 90 days, the only period they are served for): the seeded re-measured tickets that share their totals and opted in are included. */
  outcomes: OutcomesResponse;
  urdu: EquityCell | null;
}

/**
 * Runs the demo's steps against a database through the real routes, as the admin panel does: reset, read the dashboard's
 * figures, move the demo clock +7 days (which runs one sweep) and read them again. The same function runs on Compose
 * Postgres and on PGlite, so the two can be held to each other.
 */
async function demoFigures(database: Db): Promise<{ resetStatus: number; advanceStatus: number; markedOverdue: number; storedOffsetMs: number; restartedOffsetMs: number; afterReset: DemoFigures; afterSweep: DemoFigures }> {
  // Staff have to exist to sign in; the reset below reloads the seed anyway and keeps these sign-ins.
  await runSeed(database, cipher);
  const demo = await createTestApp(database, { demoMode: true });
  try {
    const admin = { authorization: `Bearer ${await signIn(demo, 'admin@demo.mawsool.test')}` };
    const ops = { authorization: `Bearer ${await signIn(demo, 'ops@demo.mawsool.test')}` };
    const read = async <T>(url: string): Promise<T> => {
      const res = await demo.app.inject({ method: 'GET', url, headers: ops });
      if (res.statusCode !== 200) throw new Error(`${url} answered ${res.statusCode}`);
      return res.json() as T;
    };
    const figures = async (): Promise<DemoFigures> => {
      const equity = await read<EquityResponse>('/metrics/equity');
      const urdu = equity.dimensions.find((entry) => entry.dimension === 'language')?.rows.find((row) => row.value === 'ur')?.cell;
      return { funnel: [await read<FunnelResponse>('/metrics/funnel?period=all'), await read<FunnelResponse>('/metrics/funnel?period=90d')], outcomes: await read<OutcomesResponse>('/metrics/outcomes?period=90d'), urdu: urdu && !('suppressed' in urdu) ? urdu : null };
    };
    const reset = await demo.app.inject({ method: 'POST', url: '/demo/reset', headers: admin });
    const afterReset = await figures();
    const advance = await demo.app.inject({ method: 'POST', url: '/demo/clock/advance', headers: admin, payload: { by: '7d' } });
    const afterSweep = await figures();
    const storedOffsetMs = await readDemoOffset(database);
    // A second API on the same database starts from the stored offset alone, as after a restart.
    await demo.app.close();
    const restarted = await createTestApp(database, { demoMode: true });
    try {
      const restartedOffsetMs = (await restarted.app.inject({ method: 'GET', url: '/clock' })).json().offsetMs as number;
      return { resetStatus: reset.statusCode, advanceStatus: advance.statusCode, markedOverdue: advance.json().markedOverdue as number, storedOffsetMs, restartedOffsetMs, afterReset, afterSweep };
    } finally {
      await restarted.app.close();
    }
  } finally {
    await demo.app.close().catch(() => undefined);
  }
}

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
  await runSeed(db, cipher);
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
  await runSeed(db, cipher);
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

  // 2b. A sweep that fails leaves only the fixed message and the SQLSTATE in pg-boss's tables: the database refuses every overdue event, with the ticket
  // id in the failing row and in the bound values, and no table of the queue's schema holds an id or a query afterwards.
  await runSeed(db, cipher);
  const dueForFailure = await open();
  await db.execute(sql.raw("ALTER TABLE ticket_events ADD CONSTRAINT gate_no_overdue_events CHECK (to_state <> 'overdue') NOT VALID"));
  const failureLog: unknown[] = [];
  const failing = await startJobs({ databaseUrl: gateUrl.toString(), db, clock, log: { error: (...args: unknown[]) => failureLog.push(args), info: () => undefined } as never });
  try {
    await failing.boss.send(SWEEP_QUEUE, {});
    const deadline = performance.now() + 40_000;
    const stored = async () => (await migrationPool.query("SELECT output::text AS output FROM pgboss.job WHERE name = $1 AND output IS NOT NULL", [SWEEP_QUEUE])).rows.map((row) => row.output as string);
    while (performance.now() < deadline && (await stored()).length === 0) await new Promise((resolve) => setTimeout(resolve, 500));
    const outputs = await stored();
    check(outputs.length > 0, 'the failed sweep left an output on its job row');
    const queueTables = (await migrationPool.query("SELECT table_name FROM information_schema.columns WHERE table_schema = 'pgboss' AND column_name = 'output'")).rows.map((row) => row.table_name as string);
    const queueText = (await Promise.all(queueTables.map(async (table) => (await migrationPool.query(`SELECT t::text AS row FROM pgboss."${table}" t WHERE t.name = $1`, [SWEEP_QUEUE])).rows.map((row) => row.row as string)))).flat().join('\n');
    say(`failed sweep: ${outputs.length} job output(s), ${queueTables.join(', ')} searched, ${due.length} ticket ids looked for`);
    check(outputs.every((output) => JSON.parse(output).message === SWEEP_FAILED_MESSAGE && JSON.parse(output).code === '23514' && JSON.parse(output).name === 'SweepFailedError'), 'every stored output is the fixed message, the error name and the SQLSTATE 23514');
    check(!dueForFailure.some((id) => queueText.includes(id)), 'no table of the job queue holds a ticket id');
    check(!/Failed query|params:|ticket_events|gate_no_overdue_events|Failing row/.test(queueText), 'and none holds a query, a table or constraint name or a failing row');
    check(failureLog.length > 0, 'the failure was logged for the operator, through the logger the API gives the queue');
  } finally {
    await failing.stop();
    await db.execute(sql.raw('ALTER TABLE ticket_events DROP CONSTRAINT gate_no_overdue_events'));
  }

  // 3. Migrations: all of them applied, the invite tables and their checks in place.
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as { entries: { tag: string }[] };
  const applied = (await migrationPool.query('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations')).rows[0].n as number;
  check(journal.entries.length >= 5 && applied === journal.entries.length, `all ${journal.entries.length} migrations are applied (${journal.entries.map((entry) => entry.tag.slice(0, 4)).join(', ')})`);
  const constraints = (await migrationPool.query("SELECT conname FROM pg_constraint WHERE conrelid = 'inbound_invites'::regclass")).rows.map((row) => row.conname as string);
  for (const name of ['inbound_invites_not_app', 'inbound_invites_claim_pair', 'inbound_invites_ticket_needs_claim']) check(constraints.includes(name), `inbound_invites carries the ${name} check`);
  check((await migrationPool.query("SELECT 1 FROM pg_indexes WHERE tablename = 'inbound_invites' AND indexdef ILIKE '%code_hash%'")).rowCount === 1, 'the invite code hash is unique');
  check((await migrationPool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'inbound_nonces' AND column_name = 'seen_at'")).rowCount === 1, 'the nonce table has its timestamp');

  // 4. The same nonce spent at once over two connections: one invite, one nonce, one winner.
  await runSeed(db, cipher);
  const screen = { result: 'positive' as const, screenedAt: '2026-11-01T08:00:00+04:00', locale: 'ar' as const };
  const invitesBefore = (await db.select({ id: schema.inboundInvites.id }).from(schema.inboundInvites)).length;
  const raced = await Promise.all([acceptScreen(pools[0]!.db, clock, 'tamm', 'nonce-spent-at-once-0123456789', screen), acceptScreen(pools[1]!.db, clock, 'tamm', 'nonce-spent-at-once-0123456789', screen)]);
  check(raced.filter((outcome) => outcome.kind === 'created').length === 1 && raced.filter((outcome) => outcome.kind === 'replayed').length === 1, 'two connections with one nonce: one creates, one is told it is a replay');
  check((await db.select({ id: schema.inboundInvites.id }).from(schema.inboundInvites)).length === invitesBefore + 1, 'and exactly one invite was written');
  check((await db.select({ nonce: schema.inboundNonces.nonce }).from(schema.inboundNonces).where(eq(schema.inboundNonces.nonce, 'nonce-spent-at-once-0123456789'))).length === 1, 'and exactly one nonce');

  // 5 and 6. The app on real Postgres.
  await runSeed(db, cipher);
  const ctx = await createTestApp(db, { summaryLlmEnabled: true, summaryProvider: { complete: async () => 'PROVIDER-WORDS-FROM-THE-NOTE' } as never });
  try {
    const gp = await serviceAt(db, 'A', 'gp');
    const person = await registerPerson(ctx);
    const requestId = randomUUID();
    const draft = async (consented: string[]) => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/summary/draft',
        headers: person.headers,
        payload: { requestId, locale: 'en', useAi: true, consented, content: { free_text: FREE_TEXT, scores: [{ instrument: 'phq9', total: 12, band: 'moderate', takenAt: '2026-10-29T08:00:00+04:00' }] } },
      });
      check(res.statusCode === 200 && res.json().source === 'ai', `a draft made from ${consented.join(', ')} is logged`);
    };
    await draft(['ticket', 'scores', 'free_text']);
    await draft(['ticket', 'scores']);
    const ticket = await issue(ctx, person, ticketRequest(gp, { clientRequestId: requestId, summaryRequestId: requestId, approvedSummary: 'APPROVED-WITHOUT-THE-NOTE', summaryBuiltFrom: ['ticket', 'scores'], consents: ['ticket', 'scores', 'free_text'] }));
    const logs = () => db.select().from(schema.summaryLogs).where(and(eq(schema.summaryLogs.personId, person.id), eq(schema.summaryLogs.requestId, requestId)));
    check((await logs()).length === 3, 'three summary log rows exist before the stop');
    const stop = await ctx.app.inject({ method: 'DELETE', url: `/consents/${ticket.consents.find((consent) => consent.element === 'free_text')!.id}`, headers: person.headers });
    check(stop.statusCode === 200 && stop.json().summaryRemoved === false, 'the stop answers 200 and keeps the approved summary, which was not written from the note');
    const after = await logs();
    check(after.length === 2 && !after.some((row) => row.builtFrom.includes('free_text')), 'the log row that held the note is gone and the other two stay (the built_from array test ran on real Postgres)');
    check((await rawBundle(db, ticket.id)).approvedSummaryCiphertext !== null, 'the approved summary is still on the bundle');

    // 6. Delete everything on the invite a person claimed.
    const invite = await acceptScreen(db, clock, 'tamm', 'nonce-for-the-erase-case-0123456', screen);
    if (invite.kind !== 'created') throw new Error('could not make an invite');
    const claimer = await registerPerson(ctx);
    const claimed = await ctx.app.inject({ method: 'POST', url: '/me/invites/claim', headers: claimer.headers, payload: { code: formatInviteCode(invite.code) } });
    check(claimed.statusCode === 200, 'an invite is claimed');
    const fromInvite = await issue(ctx, claimer, ticketRequest(gp, { inviteId: claimed.json().inviteId, consents: ['ticket'] }));
    check(fromInvite.source === 'tamm', 'the ticket made from it carries the source tamm');
    const erased = await ctx.app.inject({ method: 'DELETE', url: '/me/data', headers: claimer.headers });
    check(erased.statusCode === 200, 'Delete everything answers 200');
    check((await db.select({ id: schema.inboundInvites.id }).from(schema.inboundInvites).where(eq(schema.inboundInvites.claimedBy, claimer.id))).length === 0, 'the invite the person claimed is gone');
    check((await db.select({ source: schema.tickets.source }).from(schema.tickets).where(eq(schema.tickets.id, fromInvite.id)))[0]?.source === 'tamm', 'the ticket keeps its source');
    check((await db.execute(sql`SELECT count(*)::int AS n FROM inbound_invites WHERE ticket_id = ${fromInvite.id}`)).rows[0]!.n === 0, 'and no invite still points at it');

    // 6b. A hand-off send and a stop for the same id at once, over two connections. Whoever wins, the person ends with no
    // hand-off and no ledger row: the send must see a stop that is committing, and the stop must see a hand-off being written.
    const ROUNDS = 40;
    let leftBehind = 0;
    for (let round = 0; round < ROUNDS; round += 1) {
      const racer = await registerPerson(ctx);
      const body = handoffBody(await sendCrisisEvent(ctx, racer));
      await Promise.all([
        ctx.app.inject({ method: 'POST', url: '/me/crisis-handoffs', headers: racer.headers, payload: body }),
        ctx.app.inject({ method: 'DELETE', url: `/me/crisis-handoffs/${body.handoffId}`, headers: racer.headers }),
      ]);
      const rows = (await db.select({ id: schema.crisisHandoffs.id }).from(schema.crisisHandoffs).where(eq(schema.crisisHandoffs.personId, racer.id))).length;
      const ledger = (await db.select({ id: schema.consents.id }).from(schema.consents).where(and(eq(schema.consents.personId, racer.id), eq(schema.consents.element, 'crisis_handoff')))).length;
      if (rows + ledger > 0) leftBehind += 1;
    }
    check(leftBehind === 0, `a hand-off send and a stop racing for the same id, ${ROUNDS} times over two connections, left no hand-off and no ledger row`);

    // 6c. One no-login clinic link pressed twice at once, over two connections: the link is spent by one update that only matches
    // an unspent link, so exactly one press moves the ticket and spends it, and the other is the same refusal with nothing written.
    await db.update(schema.facilities).set({ portalAccess: false }).where(eq(schema.facilities.id, FACILITY_A_ID));
    const LINK_ROUNDS = 30;
    const linkDeps = (connection: Db): ClinicLinkDeps => ({ db: connection, clock: ctx.clock, securityClock: ctx.clock, notifier: ctx.notifier, clinicianAppUrl: config.clinicianAppUrl, log: { error: () => undefined } });
    let linkProblems = 0;
    for (let round = 0; round < LINK_ROUNDS; round += 1) {
      const presser = await registerPerson(ctx);
      const linked = await issue(ctx, presser, ticketRequest(gp));
      const credential = ctx.notifier.lastClinicCredential();
      const outcomes = await Promise.all([actOnClinicLink(linkDeps(pools[0]!.db), credential, 'acknowledged'), actOnClinicLink(linkDeps(pools[1]!.db), credential, 'acknowledged')]);
      const moves = await db.select({ toState: schema.ticketEvents.toState, actor: schema.ticketEvents.actor }).from(schema.ticketEvents).where(eq(schema.ticketEvents.ticketId, linked.id)).orderBy(schema.ticketEvents.seq);
      const links = await db.select({ usedAt: schema.clinicLinks.usedAt }).from(schema.clinicLinks).where(eq(schema.clinicLinks.ticketId, linked.id));
      const ok =
        outcomes.filter((outcome) => outcome.kind === 'done').length === 1 &&
        outcomes.filter((outcome) => outcome.kind === 'invalid').length === 1 &&
        moves.map((move) => `${move.toState}:${move.actor}`).join(',') === 'issued:person,acknowledged:clinic' &&
        links.filter((link) => link.usedAt !== null).length === 1 &&
        links.length === 2; // the spent one, and the fresh link logged for the move that is left
      if (!ok) linkProblems += 1;
    }
    check(linkProblems === 0, `two presses of one clinic link at once, ${LINK_ROUNDS} times over two connections, left exactly one acknowledge by the clinic, one spent link and the other press refused as an invalid link`);
    await db.update(schema.facilities).set({ portalAccess: true }).where(eq(schema.facilities.id, FACILITY_A_ID));

    // 6d. Two moves of one adverse event's status at once, over two connections: the update names the status it was read in and the
    // history's (event, seq) pair is unique, so exactly one of two identical moves lands, the other is refused with nothing
    // written, and a pair of different moves leaves a history that is one unbroken chain ending on the stored status.
    const [opsUser] = await db.select({ id: schema.staffUsers.id }).from(schema.staffUsers).where(eq(schema.staffUsers.role, 'ops')).limit(1);
    const actor = { staffUserId: opsUser!.id, role: 'ops' as const };
    const eventDeps = (connection: Db) => ({ db: connection, clock: ctx.clock, securityClock: ctx.clock });
    const EVENT_ROUNDS = 30;
    let eventProblems = 0;
    for (let round = 0; round < EVENT_ROUNDS; round += 1) {
      const recorded = await recordAdverseEvent(eventDeps(db), actor, { type: 'wrong_routing', severity: 'low' });
      if (recorded.kind !== 'recorded') throw new Error('could not record an adverse event');
      const id = recorded.event.id;
      const identical = round % 2 === 0;
      const outcomes = await Promise.all([moveAdverseEvent(eventDeps(pools[0]!.db), actor, id, 'closed'), moveAdverseEvent(eventDeps(pools[1]!.db), actor, id, identical ? 'closed' : 'investigating')]);
      const history = await db.select({ seq: schema.adverseEventHistory.seq, from: schema.adverseEventHistory.fromStatus, to: schema.adverseEventHistory.toStatus }).from(schema.adverseEventHistory).where(eq(schema.adverseEventHistory.eventId, id)).orderBy(schema.adverseEventHistory.seq);
      const [row] = await db.select({ status: schema.adverseEvents.status }).from(schema.adverseEvents).where(eq(schema.adverseEvents.id, id));
      const chained = history.every((entry, index) => entry.seq === index + 1 && entry.from === (index === 0 ? null : history[index - 1]!.to)) && history.at(-1)!.to === row!.status;
      const moved = outcomes.filter((outcome) => outcome.kind === 'moved').length;
      const ok = chained && (identical ? moved === 1 && history.length === 2 : moved >= 1 && history.length === moved + 1);
      if (!ok) eventProblems += 1;
    }
    check(eventProblems === 0, `two moves of one adverse event at once, ${EVENT_ROUNDS} times over two connections, left an unbroken history that ends on the stored status, and one of two identical moves refused`);
  } finally {
    await ctx.app.close();
  }

  // 7. The demo on real Postgres: the reset reloads the seed, one sweep runs (the +7 days step runs one), and the figures the
  // dashboard reads (the funnel and the Urdu row) are the ones PGlite gives for the same steps.
  const onPostgres = await demoFigures(db);
  const pglite = await createTestDb();
  const onPglite = await demoFigures(pglite.db).finally(() => pglite.close());
  check(onPostgres.resetStatus === 200 && onPostgres.advanceStatus === 200, 'POST /demo/reset and the +7 days step answer 200 on Postgres');
  const SEVEN_DAYS_MS = 7 * 86_400_000;
  check(onPostgres.storedOffsetMs === SEVEN_DAYS_MS && onPglite.storedOffsetMs === SEVEN_DAYS_MS, 'the +7 days step stored an offset of 7 days (a bigint column read back as a number) on Postgres, as on PGlite');
  check(onPostgres.restartedOffsetMs === SEVEN_DAYS_MS, 'an API started on the same database after the step reports the 7 days: the demo date survives a restart on Postgres');
  check(onPostgres.markedOverdue > 0 && onPostgres.markedOverdue === onPglite.markedOverdue, `the sweep after the step marked ${onPostgres.markedOverdue} tickets overdue on Postgres, as it did on PGlite (${onPglite.markedOverdue})`);
  for (const when of ['afterReset', 'afterSweep'] as const) {
    const urdu = onPostgres[when].urdu;
    check(urdu !== null && urdu.flagged && urdu.gapPoints <= -18 && urdu.gapPoints >= -22, `the Urdu row ${when === 'afterReset' ? 'after the reset' : 'after the sweep'} is flagged 18 to 22 points below overall (${urdu?.gapPoints ?? 'missing'})`);
    check(JSON.stringify(onPostgres[when].urdu) === JSON.stringify(onPglite[when].urdu), `the Urdu row ${when === 'afterReset' ? 'after the reset' : 'after the sweep'} is the same on Postgres and PGlite`);
    check(JSON.stringify(onPostgres[when].funnel) === JSON.stringify(onPglite[when].funnel), `the funnel ${when === 'afterReset' ? 'after the reset' : 'after the sweep'} is the same on Postgres and PGlite`);
    check(JSON.stringify(onPostgres[when].outcomes) === JSON.stringify(onPglite[when].outcomes) && typeof onPostgres[when].outcomes.remeasured === 'number', `the symptom-change figures ${when === 'afterReset' ? 'after the reset' : 'after the sweep'} are the same on Postgres and PGlite, with the seeded re-measured tickets counted`);
    check(onPostgres[when].funnel.every((view) => typeof view.stages[0]?.count === 'number'), `the funnel's first stage is a figure, not a suppressed cell, ${when === 'afterReset' ? 'after the reset' : 'after the sweep'} on Postgres`);
  }
  // On the default view at the demo's start (the reset, offset 0) the seeded shares are counted and the tile shows numbers.
  const [phq9] = onPostgres.afterReset.outcomes.instruments;
  check(typeof phq9?.included === 'number' && typeof phq9.excluded === 'number' && typeof phq9.meanChange === 'number', 'the symptom-change figures after the reset show the included count, the excluded count and the mean change on Postgres');
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
