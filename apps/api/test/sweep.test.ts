import { computeDeadline } from '@mawsool/rules';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import { runSeed } from '../src/seed/run';
import { markOverdue, sweep } from '../src/sweep';
import { createTestApp, type TestApp } from './helpers/app';
import { createTestDb, type TestDb } from './helpers/db';
import { eventStates, issue, registerPerson, serviceAt, ticketRequest, type TestPerson } from './helpers/flow';

/** A fixed far-off start, so the seed's own tickets (anchored 2026-11-01) never fall due inside these tests. */
describe('the overdue sweep', () => {
  let testDb: TestDb;
  let ctx: TestApp;
  let person: TestPerson;
  let gp: string;

  beforeAll(async () => {
    testDb = await createTestDb();
    await runSeed(testDb.db, testDb.cipher);
    ctx = await createTestApp(testDb.db);
    person = await registerPerson(ctx);
    gp = await serviceAt(testDb.db, 'A', 'gp');
    // Move every seeded ticket out of the sweep's reach: only the tickets these tests create are due.
    await testDb.db.update(schema.tickets).set({ state: 'closed' });
  });

  afterAll(async () => {
    await ctx.app.close();
    await testDb.close();
  });

  const overdueEvents = async (ticketId: string) => (await eventStates(testDb.db, ticketId)).filter((event) => event.to === 'overdue');
  const fresh = async (windowDays = 7) => (await issue(ctx, person, ticketRequest(gp, { windowDays }))).id;

  it('marks a ticket overdue exactly at its deadline and not a millisecond before', async () => {
    const id = await fresh();
    const [row] = await testDb.db.select({ deadlineAt: schema.tickets.deadlineAt }).from(schema.tickets).where(eq(schema.tickets.id, id));
    ctx.clock.set(new Date(row!.deadlineAt.getTime() - 1));
    expect(await sweep(testDb.db, ctx.clock)).toMatchObject({ marked: 0 });
    expect(await overdueEvents(id)).toHaveLength(0);
    ctx.clock.set(row!.deadlineAt);
    expect(await sweep(testDb.db, ctx.clock)).toMatchObject({ marked: 1 });
    expect(await overdueEvents(id)).toEqual([expect.objectContaining({ from: 'issued', actor: 'system' })]);
  });

  it('is idempotent: running it again appends nothing', async () => {
    const id = await fresh();
    ctx.clock.advance(30 * 24 * 3600 * 1000);
    await sweep(testDb.db, ctx.clock);
    const again = await sweep(testDb.db, ctx.clock);
    expect(again).toEqual({ marked: 0, lostRace: 0, skipped: 0, draftsDeleted: 0, noncesDeleted: 0, stopsForgotten: 0, linksDeleted: 0, optInsCleared: 0 });
    expect(await overdueEvents(id)).toHaveLength(1);
  });

  it('marks an acknowledged ticket and leaves a seen one alone', async () => {
    const acknowledged = await fresh();
    const seen = await fresh();
    await testDb.db.update(schema.tickets).set({ state: 'acknowledged' }).where(eq(schema.tickets.id, acknowledged));
    await testDb.db.insert(schema.ticketEvents).values({ ticketId: acknowledged, seq: 2, fromState: 'issued', toState: 'acknowledged', actor: 'clinic', channel: 'portal', at: ctx.clock.now() });
    await ctx.app.inject({ method: 'POST', url: `/me/tickets/${seen}/events`, headers: person.headers, payload: { to: 'seen' } });
    ctx.clock.advance(60 * 24 * 3600 * 1000);
    await sweep(testDb.db, ctx.clock);
    expect(await overdueEvents(acknowledged)).toHaveLength(1);
    expect(await overdueEvents(seen)).toHaveLength(0);
  });

  it('yields one overdue event when two sweeps run at the same time', async () => {
    const ids = await Promise.all([fresh(), fresh(), fresh()]);
    ctx.clock.advance(60 * 24 * 3600 * 1000);
    await Promise.all([sweep(testDb.db, ctx.clock), sweep(testDb.db, ctx.clock)]);
    for (const id of ids) expect(await overdueEvents(id)).toHaveLength(1);
  });

  it('is a no-op for a sweep that loses the race: it appends nothing and reports lost_race', async () => {
    const id = await fresh();
    ctx.clock.advance(60 * 24 * 3600 * 1000);
    let rival: string | undefined;
    const outcome = await markOverdue(testDb.db, ctx.clock, id, {
      afterRead: async () => {
        // A second sweep appends first, between this one's read and its write.
        rival = await markOverdue(testDb.db, ctx.clock, id);
      },
    });
    expect(rival).toBe('marked');
    expect(outcome).toBe('lost_race');
    expect(await overdueEvents(id)).toHaveLength(1);
    const [row] = await testDb.db.select({ state: schema.tickets.state }).from(schema.tickets).where(eq(schema.tickets.id, id));
    expect(row!.state).toBe('overdue');
  });

  it('skips a ticket that is no longer open to it', async () => {
    const id = await fresh();
    await ctx.app.inject({ method: 'POST', url: `/me/tickets/${id}/events`, headers: person.headers, payload: { to: 'declined' } });
    expect(await markOverdue(testDb.db, ctx.clock, id)).toBe('skipped');
    expect(await markOverdue(testDb.db, ctx.clock, '00000000-0000-4000-8000-000000000001')).toBe('skipped');
  });

  it('puts the deadline at the end of the target day in Dubai', async () => {
    const id = await fresh(14);
    const [row] = await testDb.db.select({ deadlineAt: schema.tickets.deadlineAt, createdAt: schema.tickets.createdAt }).from(schema.tickets).where(eq(schema.tickets.id, id));
    expect(row!.deadlineAt.toISOString()).toBe(computeDeadline(row!.createdAt, 14).toISOString());
  });
});
