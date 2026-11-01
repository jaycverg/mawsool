import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManualClock, OffsetClock } from '../src/clock';
import { schema } from '../src/db/client';
import { signInbound } from '../src/inbound/signing';
import { INVITE_TTL_MS, inviteCodeHash } from '../src/inbound/service';
import { runSeed } from '../src/seed/run';
import { SEED_ANCHOR } from '../src/seed/fixtures';
import { createTestApp, signIn, TEST_START, type TestApp } from './helpers/app';
import { TEST_INBOUND_KEYS } from './helpers/config';
import { createTestDb, type TestDb } from './helpers/db';
import { issue, registerPerson, serviceAt, ticketRequest } from './helpers/flow';

const DAY = 86_400_000;
const BODY = JSON.stringify({ result: 'positive', screenedAt: '2026-11-01T08:00:00+04:00', locale: 'ar' });

describe('OffsetClock', () => {
  it('is its base clock plus an offset that only moves forward and can be put back', () => {
    const base = new ManualClock(new Date('2026-11-01T00:00:00Z'));
    const clock = new OffsetClock(base);
    expect(clock.now().toISOString()).toBe('2026-11-01T00:00:00.000Z');
    clock.advance(7 * DAY);
    expect(clock.offset).toBe(7 * DAY);
    expect(clock.now().toISOString()).toBe('2026-11-08T00:00:00.000Z');
    base.advance(DAY);
    expect(clock.now().toISOString()).toBe('2026-11-09T00:00:00.000Z');
    expect(() => clock.advance(-1)).toThrow(/forward/);
    expect(() => clock.advance(Number.NaN)).toThrow(/forward/);
    expect(clock.offset).toBe(7 * DAY);
    clock.reset();
    expect(clock.offset).toBe(0);
    expect(clock.now().toISOString()).toBe('2026-11-02T00:00:00.000Z');
  });
});

describe('the demo clock in the API', () => {
  let testDb: TestDb;
  let ctx: TestApp;
  let admin: string;
  const adminHeaders = () => ({ authorization: `Bearer ${admin}` });

  beforeEach(async () => {
    testDb = await createTestDb();
    await runSeed(testDb.db);
    ctx = await createTestApp(testDb.db, { demoMode: true });
    admin = await signIn(ctx, 'admin@demo.mawsool.test');
  });

  afterEach(async () => {
    await ctx.app.close();
    await testDb.close();
  });

  const advance = (by: '7d' | '3w' | '6w') => ctx.app.inject({ method: 'POST', url: '/demo/clock/advance', headers: adminHeaders(), payload: { by } });
  const sendScreen = (timestampMs: number) => {
    const headers = signInbound({ key: TEST_INBOUND_KEYS.tamm, source: 'tamm', timestamp: Math.floor(timestampMs / 1000), nonce: randomBytes(18).toString('base64url'), body: BODY });
    return ctx.app.inject({ method: 'POST', url: '/inbound/screens', headers: { ...headers, 'content-type': 'application/json' }, payload: BODY });
  };

  it('answers GET /clock to anyone with the offset, and 0 until it is moved', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: '/clock' })).json()).toEqual({ demoMode: true, offsetMs: 0 });
    const step = await advance('3w');
    expect(step.statusCode).toBe(200);
    expect(step.json()).toMatchObject({ demoMode: true, offsetMs: 21 * DAY, now: new Date(TEST_START.getTime() + 21 * DAY).toISOString() });
    expect((await ctx.app.inject({ method: 'GET', url: '/clock' })).json()).toEqual({ demoMode: true, offsetMs: 21 * DAY });
  });

  it('takes only the three steps, and each adds to the last', async () => {
    expect((await ctx.app.inject({ method: 'POST', url: '/demo/clock/advance', headers: adminHeaders(), payload: { by: '2w' } })).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: 'POST', url: '/demo/clock/advance', headers: adminHeaders(), payload: { by: '-7d' } })).statusCode).toBe(400);
    await advance('7d');
    await advance('3w');
    expect((await advance('6w')).json().offsetMs).toBe((7 + 21 + 42) * DAY);
  });

  it('runs the sweep at the new time: a ticket past its deadline turns overdue as the clock moves, and not before', async () => {
    const person = await registerPerson(ctx);
    const ticket = await issue(ctx, person, ticketRequest(await serviceAt(testDb.db, 'A', 'gp'), { windowDays: 7 }));
    await advance('7d'); // 7 days lands before the 23:59:59 deadline of a 7-day window issued mid-morning
    const [row] = await testDb.db.select().from(schema.tickets).where(eq(schema.tickets.id, ticket.id));
    expect(row!.state).toBe('issued');
    const after = await advance('3w');
    expect(after.json().markedOverdue).toBeGreaterThanOrEqual(1); // the seeded open tickets also pass their deadlines by then
    const [overdue] = await testDb.db.select().from(schema.tickets).where(eq(schema.tickets.id, ticket.id));
    expect(overdue!.state).toBe('overdue');
  });

  it('keeps a staff session on the wall clock: signed in before a six-week jump, still signed in after', async () => {
    await advance('6w');
    expect((await advance('7d')).statusCode).toBe(200); // the same admin token, 7 weeks of demo time later
    // And a session is good for its real 8 hours, not for a demo-clock stretch: it ends when the wall clock says so.
    ctx.clock.advance(9 * 3_600_000);
    expect((await advance('7d')).statusCode).toBe(401);
  });

  it('keeps a sign-in link on the wall clock: requested before the jump, spent after it, and 15 real minutes still end it', async () => {
    const request = await ctx.app.inject({ method: 'POST', url: '/auth/magic-link', payload: { email: 'ops@demo.mawsool.test' } });
    expect(request.statusCode).toBe(202);
    await advance('3w');
    const verify = await ctx.app.inject({ method: 'POST', url: '/auth/verify', payload: { token: ctx.notifier.lastToken() } });
    expect(verify.statusCode).toBe(200);
    await ctx.app.inject({ method: 'POST', url: '/auth/magic-link', payload: { email: 'ops@demo.mawsool.test' } });
    ctx.clock.advance(16 * 60_000);
    expect((await ctx.app.inject({ method: 'POST', url: '/auth/verify', payload: { token: ctx.notifier.lastToken() } })).statusCode).toBe(401);
  });

  it('reads the inbound timestamp window from the wall clock: a front door signing with real time is accepted after a jump, one signing with demo time is refused', async () => {
    await advance('3w');
    const wall = ctx.clock.now().getTime();
    expect((await sendScreen(wall)).statusCode).toBe(201);
    const demoNow = wall + 21 * DAY;
    const refused = await sendScreen(demoNow);
    expect(refused.statusCode).toBe(401);
    expect(refused.json().error).toBe('unauthorized');
  });

  it('keeps a spent nonce for its real hour, so the sweep a demo jump runs cannot let a captured request be replayed', async () => {
    const headers = { ...signInbound({ key: TEST_INBOUND_KEYS.tamm, source: 'tamm', timestamp: Math.floor(ctx.clock.now().getTime() / 1000), nonce: 'q'.repeat(24), body: BODY }), 'content-type': 'application/json' };
    expect((await ctx.app.inject({ method: 'POST', url: '/inbound/screens', headers, payload: BODY })).statusCode).toBe(201);
    await advance('6w'); // runs a sweep six weeks on; a purge by the demo clock would delete the nonce here
    const replay = await ctx.app.inject({ method: 'POST', url: '/inbound/screens', headers, payload: BODY });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error).toBe('replayed');
    // After a real hour the nonce is purged, as before (and the timestamp is long out of its window anyway).
    expect((await testDb.db.select().from(schema.inboundNonces)).length).toBe(1);
    ctx.clock.advance(61 * 60_000);
    await advance('7d');
    expect((await testDb.db.select().from(schema.inboundNonces)).length).toBe(0);
  });

  it('expires an invite by the care clock: claimable now, not after the clock passes its 30 days', async () => {
    const sent = await sendScreen(ctx.clock.now().getTime());
    const code = sent.json().code.replace('-', '');
    const early = await registerPerson(ctx);
    const claimable = await ctx.app.inject({ method: 'POST', url: '/me/invites/claim', headers: early.headers, payload: { code } });
    expect(claimable.statusCode).toBe(200);

    const second = (await sendScreen(ctx.clock.now().getTime())).json().code.replace('-', '');
    await advance('6w'); // 42 days > INVITE_TTL_MS (30 days)
    expect(INVITE_TTL_MS).toBeLessThan(42 * DAY);
    const late = await registerPerson(ctx);
    expect((await ctx.app.inject({ method: 'POST', url: '/me/invites/claim', headers: late.headers, payload: { code: second } })).statusCode).toBe(404);
  });

  it('resets to the seed: the offset goes to zero, the clock reads the wall again, and Noura gets an invite she can claim', async () => {
    await advance('3w');
    const reset = await ctx.app.inject({ method: 'POST', url: '/demo/reset', headers: adminHeaders() });
    expect(reset.statusCode).toBe(200);
    const body = reset.json();
    expect(body.offsetMs).toBe(0);
    expect((await ctx.app.inject({ method: 'GET', url: '/clock' })).json().offsetMs).toBe(0);
    expect(body.noura.code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/);
    expect(body.noura.tammUrl.ar).toBe(`http://localhost:3000/ar/tamm/?code=${body.noura.code}`);
    expect(body.noura.tammUrl.en).toBe(`http://localhost:3000/en/tamm/?code=${body.noura.code}`);

    // The code is real: it was made by the invite service, so a phone can claim it as a TAMM invite.
    const noura = await registerPerson(ctx);
    const claim = await ctx.app.inject({ method: 'POST', url: '/me/invites/claim', headers: noura.headers, payload: { code: body.noura.code } });
    expect(claim.statusCode).toBe(200);
    expect(claim.json().source).toBe('tamm');
    const [invite] = await testDb.db.select().from(schema.inboundInvites).where(eq(schema.inboundInvites.codeHash, inviteCodeHash(body.noura.code.replace('-', ''))));
    expect(invite!.claimedBy).toBe(noura.id);
  });

  it('reloads the seed anchored on today, deterministically, and leaves the staff who are signed in signed in', async () => {
    ctx.clock.advance(10 * DAY + 5 * 3_600_000); // the wall is now ten days after the fixed seed anchor, at 13:00
    admin = await signIn(ctx, 'admin@demo.mawsool.test'); // the first session ended with its real 8 hours
    const first = (await ctx.app.inject({ method: 'POST', url: '/demo/reset', headers: adminHeaders() })).json();
    expect(first.seededAt).toBe(ctx.clock.now().toISOString());
    // Signed in before the reset, signed in after: the session row came back with the same token hash.
    expect((await advance('7d')).statusCode).toBe(200);
    const rowsAfterFirst = (await testDb.db.select({ id: schema.tickets.id, createdAt: schema.tickets.createdAt }).from(schema.tickets)).map((t) => `${t.id}@${t.createdAt.toISOString()}`).sort();
    await ctx.app.inject({ method: 'POST', url: '/demo/reset', headers: adminHeaders() });
    const rowsAfterSecond = (await testDb.db.select({ id: schema.tickets.id, createdAt: schema.tickets.createdAt }).from(schema.tickets)).map((t) => `${t.id}@${t.createdAt.toISOString()}`).sort();
    expect(rowsAfterSecond).toEqual(rowsAfterFirst);
    expect(rowsAfterFirst).toHaveLength(500);
    // The anchor is the start of the Dubai day of "now" (2026-11-11 00:00 +04), not the fixed seed anchor: the history ends there.
    const anchor = Date.parse('2026-11-11T00:00:00+04:00');
    const latest = Math.max(...(await testDb.db.select({ at: schema.ticketEvents.at }).from(schema.ticketEvents)).map((e) => e.at.getTime()));
    expect(latest).toBeLessThanOrEqual(anchor);
    expect(latest).toBeGreaterThan(anchor - 3 * DAY);
    expect(SEED_ANCHOR.getTime()).toBeLessThan(anchor - 9 * DAY);
  });

  it('wipes tickets a person made before the reset: the person is gone, so their credential is refused', async () => {
    const person = await registerPerson(ctx);
    expect((await ctx.app.inject({ method: 'GET', url: '/me/tickets', headers: person.headers })).statusCode).toBe(200);
    await ctx.app.inject({ method: 'POST', url: '/demo/reset', headers: adminHeaders() });
    expect((await ctx.app.inject({ method: 'GET', url: '/me/tickets', headers: person.headers })).statusCode).toBe(401);
    // Registering the same id and secret again is how the phone recovers: it creates the person afresh (201).
    const [id, secret] = person.headers.authorization.replace('Bearer ', '').split('.');
    expect((await ctx.app.inject({ method: 'POST', url: '/persons', payload: { id, secret, locale: 'en' } })).statusCode).toBe(201);
    expect((await ctx.app.inject({ method: 'GET', url: '/me/tickets', headers: person.headers })).json()).toEqual([]);
  });
});

describe('with DEMO_MODE unset', () => {
  it('the offset the API reports is zero, care time is the wall clock, and nothing can move it', async () => {
    const testDb = await createTestDb();
    await runSeed(testDb.db);
    const ctx = await createTestApp(testDb.db);
    try {
      expect((await ctx.app.inject({ method: 'GET', url: '/clock' })).json()).toEqual({ demoMode: false, offsetMs: 0 });
      const person = await registerPerson(ctx);
      const ticket = await issue(ctx, person, ticketRequest(await serviceAt(testDb.db, 'A', 'gp')));
      const [row] = await testDb.db.select().from(schema.tickets).where(eq(schema.tickets.id, ticket.id));
      expect(row!.createdAt.toISOString()).toBe(TEST_START.toISOString());
    } finally {
      await ctx.app.close();
      await testDb.close();
    }
  });
});
