import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import { FACILITY_A_ID, FACILITY_B_ID } from '../src/seed/fixtures';
import { runSeed } from '../src/seed/run';
import { createTestApp, signIn, type TestApp } from './helpers/app';
import { createTestDb, type TestDb } from './helpers/db';

const CLINICIAN_A = 'clinician.a@demo.mawsool.test';
const CLINICIAN_B = 'clinician.b@demo.mawsool.test';

describe('clinician facility scoping', () => {
  let testDb: TestDb;
  let ctx: TestApp;
  let ticketA: string;
  let ticketB: string;
  let tokenA: string;
  let tokenB: string;

  async function firstTicketAt(facilityId: string): Promise<string> {
    const [row] = await testDb.db
      .select({ id: schema.tickets.id })
      .from(schema.tickets)
      .innerJoin(schema.services, eq(schema.tickets.serviceId, schema.services.id))
      .where(and(eq(schema.services.facilityId, facilityId)))
      .orderBy(schema.tickets.id)
      .limit(1);
    return row!.id;
  }

  beforeAll(async () => {
    testDb = await createTestDb();
    await runSeed(testDb.db);
    ctx = await createTestApp(testDb.db);
    ticketA = await firstTicketAt(FACILITY_A_ID);
    ticketB = await firstTicketAt(FACILITY_B_ID);
    tokenA = await signIn(ctx, CLINICIAN_A);
    tokenB = await signIn(ctx, CLINICIAN_B);
  });

  afterAll(async () => {
    await ctx.app.close();
    await testDb.close();
  });

  const get = (id: string, token?: string) =>
    ctx.app.inject({ method: 'GET', url: `/tickets/${id}`, headers: token ? { authorization: `Bearer ${token}` } : {} });

  it('lets a clinician read a ticket addressed to their own facility', async () => {
    const res = await get(ticketA, tokenA);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: ticketA });
  });

  it('answers 404 to a clinician at facility A for a ticket addressed to facility B', async () => {
    const res = await get(ticketB, tokenA);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found', message: 'Ticket not found' });
  });

  it('answers the same 404 body for a ticket that does not exist, so ids cannot be probed', async () => {
    const missing = await get('00000000-0000-4000-8000-ffffffffffff', tokenA);
    const otherFacility = await get(ticketB, tokenA);
    expect(missing.statusCode).toBe(404);
    expect(missing.body).toBe(otherFacility.body);
  });

  it('is symmetric: facility B reads B and gets 404 for A', async () => {
    expect((await get(ticketB, tokenB)).statusCode).toBe(200);
    expect((await get(ticketA, tokenB)).statusCode).toBe(404);
  });

  it('returns ticket fields only: no person id, no bundle, no free text', async () => {
    const body = (await get(ticketA, tokenA)).json();
    expect(Object.keys(body).sort()).toEqual(
      ['createdAt', 'deadlineAt', 'id', 'language', 'serviceId', 'shortCode', 'source', 'state', 'tier'],
    );
  });

  it('requires a session: 401 without a token and with a made-up one', async () => {
    expect((await get(ticketA)).statusCode).toBe(401);
    expect((await get(ticketA, 'not-a-real-session-token')).statusCode).toBe(401);
  });

  it('refuses a role other than clinician with 403, and an ops user cannot read tickets', async () => {
    const ops = await signIn(ctx, 'ops@demo.mawsool.test');
    const admin = await signIn(ctx, 'admin@demo.mawsool.test');
    expect((await get(ticketA, ops)).statusCode).toBe(403);
    expect((await get(ticketA, admin)).statusCode).toBe(403);
  });

  it('rejects a malformed ticket id with 400 before any lookup', async () => {
    expect((await get('not-a-uuid', tokenA)).statusCode).toBe(400);
  });

  it('loses access when the session expires', async () => {
    const fresh = await signIn(ctx, CLINICIAN_A);
    expect((await get(ticketA, fresh)).statusCode).toBe(200);
    ctx.clock.advance(8 * 60 * 60 * 1000 + 1000);
    expect((await get(ticketA, fresh)).statusCode).toBe(401);
    ctx.clock.advance(-(8 * 60 * 60 * 1000 + 1000));
  });

  it('loses access when the staff user is deactivated', async () => {
    const token = await signIn(ctx, CLINICIAN_B);
    await testDb.db.update(schema.staffUsers).set({ active: false }).where(eq(schema.staffUsers.email, CLINICIAN_B));
    try {
      expect((await get(ticketB, token)).statusCode).toBe(401);
    } finally {
      await testDb.db.update(schema.staffUsers).set({ active: true }).where(eq(schema.staffUsers.email, CLINICIAN_B));
    }
  });
});
