import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManualClock, OffsetClock } from '../src/clock';
import { schema, type Db } from '../src/db/client';
import { createClockMover, readDemoOffset } from '../src/demo/clock-store';
import { resetDemo } from '../src/demo/reset';
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
    clock.setOffset(3 * DAY);
    expect(clock.offset).toBe(3 * DAY);
    expect(() => clock.setOffset(-1)).toThrow(/zero or more/);
    expect(() => clock.setOffset(Number.NaN)).toThrow(/zero or more/);
    expect(clock.offset).toBe(3 * DAY);
    clock.reset();
    expect(clock.offset).toBe(0);
    expect(clock.now().toISOString()).toBe('2026-11-02T00:00:00.000Z');
  });
});

describe('the clock mover', () => {
  it('writes the offset before it moves the clock, so a failed write leaves the clock where it was, and the next move still works', async () => {
    const clock = new OffsetClock(new ManualClock(new Date('2026-11-01T00:00:00Z')));
    let failNext = true;
    const writes: number[] = [];
    // Only the shape the mover calls: insert(...).values({ offsetMs }).onConflictDoUpdate(...).
    const db = {
      insert: () => ({
        values: ({ offsetMs }: { offsetMs: number }) => ({
          onConflictDoUpdate: async () => {
            if (failNext) {
              failNext = false;
              throw new Error('the database is down');
            }
            writes.push(offsetMs);
          },
        }),
      }),
    } as unknown as Db;
    const move = createClockMover(db, clock).advance;
    await expect(move(DAY)).rejects.toThrow('the database is down');
    expect(clock.offset).toBe(0);
    expect(await move(DAY)).toBe(DAY);
    expect(writes).toEqual([DAY]);
  });

  it('counts two moves made at once, each on top of the other', async () => {
    const clock = new OffsetClock(new ManualClock(new Date('2026-11-01T00:00:00Z')));
    const writes: number[] = [];
    const db = {
      insert: () => ({
        values: ({ offsetMs }: { offsetMs: number }) => ({
          onConflictDoUpdate: async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            writes.push(offsetMs);
          },
        }),
      }),
    } as unknown as Db;
    const move = createClockMover(db, clock).advance;
    await Promise.all([move(DAY), move(7 * DAY)]);
    expect(clock.offset).toBe(8 * DAY);
    expect(writes).toEqual([DAY, 8 * DAY]);
  });
});

describe('the clock mover with a reset', () => {
  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const slowDb = (order: string[]) =>
    ({
      insert: () => ({
        values: ({ offsetMs }: { offsetMs: number }) => ({
          onConflictDoUpdate: async () => {
            await delay(10);
            order.push(`write ${offsetMs / DAY}d`);
          },
        }),
      }),
    }) as unknown as Db;

  it('runs an exclusive task after the moves queued before it and holds the moves queued after it until it is done', async () => {
    const order: string[] = [];
    const mover = createClockMover(slowDb(order), new OffsetClock(new ManualClock(new Date('2026-11-01T00:00:00Z'))));
    await Promise.all([
      mover.advance(DAY),
      mover.exclusive(async () => {
        order.push('reset starts');
        await delay(10);
        order.push('reset ends');
      }),
      mover.advance(DAY),
    ]);
    expect(order).toEqual(['write 1d', 'reset starts', 'reset ends', 'write 2d']);
  });

  it('holds a task queued after an advance until that advance’s own follow-up (its sweep) is done', async () => {
    const order: string[] = [];
    const mover = createClockMover(slowDb(order), new OffsetClock(new ManualClock(new Date('2026-11-01T00:00:00Z'))));
    const answer = mover.advanceThen(DAY, async () => {
      order.push('sweep starts');
      await delay(10);
      order.push('sweep ends');
      return 'swept';
    });
    const reset = mover.exclusive(async () => void order.push('reset runs'));
    expect(await Promise.all([answer, reset])).toEqual(['swept', undefined]);
    expect(order).toEqual(['write 1d', 'sweep starts', 'sweep ends', 'reset runs']);
  });

  it('goes on after an exclusive task that failed', async () => {
    const clock = new OffsetClock(new ManualClock(new Date('2026-11-01T00:00:00Z')));
    const mover = createClockMover(slowDb([]), clock);
    await expect(mover.exclusive(async () => Promise.reject(new Error('the reset failed')))).rejects.toThrow('the reset failed');
    expect(await mover.advance(DAY)).toBe(DAY);
  });
});

describe('resetting the demo', () => {
  let testDb: TestDb;
  let clock: OffsetClock;
  beforeEach(async () => {
    testDb = await createTestDb();
    await runSeed(testDb.db, testDb.cipher);
    clock = new OffsetClock(new ManualClock(TEST_START));
    await createClockMover(testDb.db, clock).advance(21 * DAY);
  });
  afterEach(async () => {
    await testDb.close();
  });

  /** The same database with its reload (a transaction) replaced by `onReload`. */
  const withReload = (onReload: () => Promise<never>) => Object.assign(Object.create(testDb.db), { transaction: onReload }) as Db;

  it('leaves the clock and the stored offset both at the previous value when the reload fails', async () => {
    const failing = withReload(async () => {
      throw new Error('the reload failed');
    });
    await expect(resetDemo({ db: failing, cipher: testDb.cipher, clock, securityClock: new ManualClock(TEST_START), personAppUrl: 'http://localhost:3000' })).rejects.toThrow('the reload failed');
    expect(clock.offset).toBe(21 * DAY);
    expect(await readDemoOffset(testDb.db)).toBe(21 * DAY);
  });

  it('has the clock at zero while the reload runs, so a sweep that starts then cannot read the new tickets at a demo date', async () => {
    let seenDuringReload: number | null = null;
    const watching = withReload(async () => {
      seenDuringReload = clock.offset;
      throw new Error('stop after looking');
    });
    await expect(resetDemo({ db: watching, cipher: testDb.cipher, clock, securityClock: new ManualClock(TEST_START), personAppUrl: 'http://localhost:3000' })).rejects.toThrow('stop after looking');
    expect(seenDuringReload).toBe(0);
  });

  it('serves a reset asked for while an advance is being written over HTTP after it: zero in the clock and the row, and no overdue event the advance’s sweep made on tickets the reset reloaded', async () => {
    // Every write of the clock offset after `armed` is slow, and says when it has begun, so the reset is asked for with the
    // advance's write under way.
    let armed = false;
    let writeBegan: () => void = () => undefined;
    const began = new Promise<void>((resolve) => (writeBegan = resolve));
    const slow = Object.assign(Object.create(testDb.db), {
      insert: (table: unknown) => {
        const real = testDb.db.insert(table as never) as unknown as { values: (row: unknown) => { onConflictDoUpdate: (config: unknown) => Promise<unknown> } };
        if (table !== schema.demoClock || !armed) return real;
        return {
          values: (row: unknown) => ({
            onConflictDoUpdate: async (config: unknown) => {
              writeBegan();
              await new Promise((resolve) => setTimeout(resolve, 50));
              return real.values(row).onConflictDoUpdate(config);
            },
          }),
        };
      },
    }) as Db;
    const overdueEvents = async () => (await testDb.db.select().from(schema.ticketEvents)).filter((event) => event.toState === 'overdue').length;
    const ctx = await createTestApp(slow, { demoMode: true });
    try {
      expect((await ctx.app.inject({ method: 'GET', url: '/clock' })).json().offsetMs).toBe(21 * DAY);
      const headers = { authorization: `Bearer ${await signIn(ctx, 'admin@demo.mawsool.test')}` };
      // A reset on its own: the overdue events the reloaded seed has. The same seed, reloaded after the advance below, must have the same.
      expect((await ctx.app.inject({ method: 'POST', url: '/demo/reset', headers })).statusCode).toBe(200);
      const clean = await overdueEvents();
      armed = true;
      const advance = ctx.app.inject({ method: 'POST', url: '/demo/clock/advance', headers, payload: { by: '6w' } });
      await began;
      const reset = ctx.app.inject({ method: 'POST', url: '/demo/reset', headers });
      const [advanced, reloaded] = [await advance, await reset];
      expect([advanced.statusCode, reloaded.statusCode]).toEqual([200, 200]);
      expect(advanced.json().markedOverdue, 'the advance’s sweep did mark tickets, so there is something for the reset to lose').toBeGreaterThan(0);
      expect((await ctx.app.inject({ method: 'GET', url: '/clock' })).json().offsetMs).toBe(0);
      expect(await readDemoOffset(testDb.db)).toBe(0);
      expect(await overdueEvents(), 'overdue events after the reset, against a reset on its own').toBe(clean);
    } finally {
      await ctx.app.close();
    }
  });

  it('ends at zero in the clock and in the stored row when it follows an advance that is still being written', async () => {
    const order: string[] = [];
    // The write of the advance is slow, as a loaded database's can be; the reset is asked for while it is under way.
    const slow = Object.assign(Object.create(testDb.db), {
      insert: (table: unknown) => {
        const real = testDb.db.insert(table as never) as unknown as { values: (row: { offsetMs: number }) => { onConflictDoUpdate: (config: unknown) => Promise<unknown> } };
        if (table !== schema.demoClock) return real;
        return {
          values: (row: { offsetMs: number }) => ({
            onConflictDoUpdate: async (config: unknown) => {
              await new Promise((resolve) => setTimeout(resolve, 50));
              order.push(`write ${row.offsetMs / DAY}d`);
              return real.values(row).onConflictDoUpdate(config);
            },
          }),
        };
      },
    }) as Db;
    const mover = createClockMover(slow, clock);
    const advance = mover.advance(7 * DAY);
    const reset = mover.exclusive(() => resetDemo({ db: testDb.db, cipher: testDb.cipher, clock, securityClock: new ManualClock(TEST_START), personAppUrl: 'http://localhost:3000' }));
    await Promise.all([advance, reset]);
    expect(order).toEqual(['write 28d']);
    expect(clock.offset).toBe(0);
    expect(await readDemoOffset(testDb.db)).toBe(0);
  });
});

describe('the demo clock in the API', () => {
  let testDb: TestDb;
  let ctx: TestApp;
  let admin: string;
  const adminHeaders = () => ({ authorization: `Bearer ${admin}` });

  beforeEach(async () => {
    testDb = await createTestDb();
    await runSeed(testDb.db, testDb.cipher);
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

  describe('across a restart', () => {
    /** A second API on the same database: the first one's process is gone, so it starts from the stored offset alone. */
    const restart = async (options: { demoMode: boolean }) => {
      await ctx.app.close();
      ctx = await createTestApp(testDb.db, options);
    };

    it('keeps the demo date: the offset the clock was moved to is the offset the next API starts with', async () => {
      await advance('3w');
      await advance('7d');
      await restart({ demoMode: true });
      expect((await ctx.app.inject({ method: 'GET', url: '/clock' })).json()).toEqual({ demoMode: true, offsetMs: 28 * DAY });
      expect(ctx.app.careClock.now().toISOString()).toBe(new Date(TEST_START.getTime() + 28 * DAY).toISOString());
      admin = await signIn(ctx, 'admin@demo.mawsool.test');
      expect((await advance('7d')).json().offsetMs).toBe(35 * DAY);
    });

    it('starts at zero after a reset, because the reload empties the stored offset with the rest', async () => {
      await advance('6w');
      await ctx.app.inject({ method: 'POST', url: '/demo/reset', headers: adminHeaders() });
      expect(await testDb.db.select().from(schema.demoClock)).toEqual([]);
      await restart({ demoMode: true });
      expect((await ctx.app.inject({ method: 'GET', url: '/clock' })).json()).toEqual({ demoMode: true, offsetMs: 0 });
    });

    it('leaves the stored offset alone when DEMO_MODE is unset, and picks it up again when it is set', async () => {
      await advance('3w');
      await restart({ demoMode: false });
      expect((await ctx.app.inject({ method: 'GET', url: '/clock' })).json()).toEqual({ demoMode: false, offsetMs: 0 });
      expect(ctx.app.careClock.now().toISOString()).toBe(TEST_START.toISOString());
      await restart({ demoMode: true });
      expect((await ctx.app.inject({ method: 'GET', url: '/clock' })).json().offsetMs).toBe(21 * DAY);
    });
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
    await runSeed(testDb.db, testDb.cipher);
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
