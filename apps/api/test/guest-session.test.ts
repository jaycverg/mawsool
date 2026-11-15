import { and, eq } from 'drizzle-orm';
import { DEMO_GUEST_ACCOUNTS } from '@mawsool/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import { SESSION_TTL_MS } from '../src/routes/auth';
import { FACILITY_B_ID, STAFF } from '../src/seed/fixtures';
import { runSeed } from '../src/seed/run';
import { createTestApp, type TestApp } from './helpers/app';
import { createTestDb, type TestDb } from './helpers/db';
import { registerPerson } from './helpers/flow';

describe('POST /demo/guest-session', () => {
  let testDb: TestDb;
  let ctx: TestApp;

  beforeEach(async () => {
    testDb = await createTestDb();
    await runSeed(testDb.db, testDb.cipher);
    ctx = await createTestApp(testDb.db, { demoMode: true });
  });

  afterEach(async () => {
    await ctx.app.close();
    await testDb.close();
  });

  const guest = (app: TestApp['app'], payload: unknown) => app.inject({ method: 'POST', url: '/demo/guest-session', payload: payload as object });
  const sessionRows = async () => (await testDb.db.select().from(schema.staffSessions)).length;
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  it('lists only seeded, active staff users: every allowed account has a row, and the five roles are all there', async () => {
    for (const account of DEMO_GUEST_ACCOUNTS) {
      const [row] = await testDb.db.select().from(schema.staffUsers).where(eq(schema.staffUsers.email, account.email));
      expect(row, account.email).toBeDefined();
      expect(row!.active).toBe(true);
      expect(row!.role).toBe(account.role);
    }
    expect(DEMO_GUEST_ACCOUNTS.map((account) => account.email).sort()).toEqual(STAFF.map((staff) => staff.email).sort());
  });

  it('gives each demo account a session whose role and facility are the ones its seeded row holds', async () => {
    for (const account of DEMO_GUEST_ACCOUNTS) {
      const res = await guest(ctx.app, { email: account.email });
      expect(res.statusCode, account.email).toBe(200);
      const seeded = STAFF.find((staff) => staff.email === account.email)!;
      expect(res.json()).toMatchObject({ role: seeded.role, facilityId: seeded.facilityId });
      expect(res.json().expiresAt).toBe(new Date(ctx.clock.now().getTime() + SESSION_TTL_MS).toISOString());
    }
  });

  it('takes the address in any case, and opens a session the staff routes accept', async () => {
    const res = await guest(ctx.app, { email: 'Ops@Demo.Mawsool.Test' });
    expect(res.statusCode).toBe(200);
    const funnel = await ctx.app.inject({ method: 'GET', url: '/metrics/funnel', headers: bearer(res.json().sessionToken) });
    expect(funnel.statusCode).toBe(200);
  });

  it('answers 400 to a malformed body, an extra field and no body, and writes no session', async () => {
    for (const payload of [{}, { email: 'not-an-email' }, { email: 5 }, { email: 'ops@demo.mawsool.test', role: 'admin' }, undefined]) {
      const res = await guest(ctx.app, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(await sessionRows()).toBe(0);
  });

  it('takes the role from the seeded row, never from the request: a request that names another role is refused outright', async () => {
    const res = await guest(ctx.app, { email: 'clinician.a@demo.mawsool.test', role: 'admin', facilityId: FACILITY_B_ID });
    expect(res.statusCode).toBe(400);
    expect(await sessionRows()).toBe(0);
  });

  describe('refuses with the not-found handler’s own 404', () => {
    const offBody = async (email: string) => {
      const off = await createTestApp(testDb.db);
      try {
        const res = await guest(off.app, { email });
        return { status: res.statusCode, body: res.body };
      } finally {
        await off.app.close();
      }
    };

    it('an active staff user who is not a demo account, and writes no session row', async () => {
      const real = 'real.staff@example.test';
      await testDb.db.insert(schema.staffUsers).values({ id: crypto.randomUUID(), email: real, name: 'A real operator', role: 'admin', facilityId: null, active: true, createdAt: ctx.clock.now() });
      const res = await guest(ctx.app, { email: real });
      expect(res.statusCode).toBe(404);
      expect({ status: res.statusCode, body: res.body }).toEqual(await offBody(real));
      expect(await sessionRows()).toBe(0);
    });

    it('an address nobody holds', async () => {
      const res = await guest(ctx.app, { email: 'nobody@demo.mawsool.test' });
      expect({ status: res.statusCode, body: res.body }).toEqual(await offBody('nobody@demo.mawsool.test'));
      expect(await sessionRows()).toBe(0);
    });

    it('a deactivated demo user, and writes no session row', async () => {
      await testDb.db.update(schema.staffUsers).set({ active: false }).where(eq(schema.staffUsers.email, 'admin@demo.mawsool.test'));
      const res = await guest(ctx.app, { email: 'admin@demo.mawsool.test' });
      expect({ status: res.statusCode, body: res.body }).toEqual(await offBody('admin@demo.mawsool.test'));
      expect(res.statusCode).toBe(404);
      expect(await sessionRows()).toBe(0);
    });

    it('every address, with the demo off: the route does not exist', async () => {
      const off = await createTestApp(testDb.db);
      try {
        expect(off.app.routeRegistry.map((route) => `${route.method} ${route.url}`)).not.toContain('POST /demo/guest-session');
        const res = await guest(off.app, { email: 'admin@demo.mawsool.test' });
        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual({ message: 'Route POST:/demo/guest-session not found', error: 'Not Found', statusCode: 404 });
        expect(await sessionRows()).toBe(0);
      } finally {
        await off.app.close();
      }
    });

    it('and the 404 for a refused address is byte for byte the one the demo-off app gives', async () => {
      const res = await guest(ctx.app, { email: 'someone@example.test' });
      expect(res.json()).toEqual({ message: 'Route POST:/demo/guest-session not found', error: 'Not Found', statusCode: 404 });
    });
  });

  it('keeps a clinic A guest out of clinic B: a ticket addressed to B is a 404', async () => {
    const [ticketAtB] = await testDb.db
      .select({ id: schema.tickets.id })
      .from(schema.tickets)
      .innerJoin(schema.services, eq(schema.tickets.serviceId, schema.services.id))
      .where(and(eq(schema.services.facilityId, FACILITY_B_ID)))
      .orderBy(schema.tickets.id)
      .limit(1);
    const session = (await guest(ctx.app, { email: 'clinician.a@demo.mawsool.test' })).json();
    const res = await ctx.app.inject({ method: 'GET', url: `/tickets/${ticketAtB!.id}`, headers: bearer(session.sessionToken) });
    expect(res.statusCode).toBe(404);
    const own = await guest(ctx.app, { email: 'clinician.b@demo.mawsool.test' });
    const ownRes = await ctx.app.inject({ method: 'GET', url: `/tickets/${ticketAtB!.id}`, headers: bearer(own.json().sessionToken) });
    expect(ownRes.statusCode).toBe(200);
  });

  it('keeps its session through a six-week clock advance, and ends it after 8 hours on the wall clock', async () => {
    const admin = (await guest(ctx.app, { email: 'admin@demo.mawsool.test' })).json();
    const advance = () => ctx.app.inject({ method: 'POST', url: '/demo/clock/advance', headers: bearer(admin.sessionToken), payload: { by: '6w' } });
    expect((await advance()).statusCode).toBe(200);
    expect((await advance()).statusCode).toBe(200);
    ctx.clock.advance(SESSION_TTL_MS + 60_000);
    expect((await advance()).statusCode).toBe(401);
  });

  it('keeps a guest signed in through a reset', async () => {
    const admin = (await guest(ctx.app, { email: 'admin@demo.mawsool.test' })).json();
    const clinic = (await guest(ctx.app, { email: 'clinician.a@demo.mawsool.test' })).json();
    const reset = await ctx.app.inject({ method: 'POST', url: '/demo/reset', headers: bearer(admin.sessionToken) });
    expect(reset.statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: '/tickets', headers: bearer(clinic.sessionToken) })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'POST', url: '/demo/clock/advance', headers: bearer(admin.sessionToken), payload: { by: '7d' } })).statusCode).toBe(200);
  });

  it('lets a guest admin reach /demo/reset and refuses a guest ops session there', async () => {
    const admin = (await guest(ctx.app, { email: 'admin@demo.mawsool.test' })).json();
    const ops = (await guest(ctx.app, { email: 'ops@demo.mawsool.test' })).json();
    expect((await ctx.app.inject({ method: 'POST', url: '/demo/reset', headers: bearer(ops.sessionToken) })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'POST', url: '/demo/reset', headers: bearer(admin.sessionToken) })).statusCode).toBe(200);
  });

  it('is open with no credential at all, so a visitor needs nothing before it', async () => {
    const route = ctx.app.routeRegistry.find((entry) => `${entry.method} ${entry.url}` === 'POST /demo/guest-session');
    expect(route?.access).toBe('public');
    expect((await guest(ctx.app, { email: 'ops@demo.mawsool.test' })).statusCode).toBe(200);
  });
});

describe('POST /demo/noura-invite', () => {
  let testDb: TestDb;
  let ctx: TestApp;
  let tokens: { admin: string; ops: string; clinician: string; crisisLine: string };

  beforeEach(async () => {
    testDb = await createTestDb();
    await runSeed(testDb.db, testDb.cipher);
    ctx = await createTestApp(testDb.db, { demoMode: true });
    const session = async (email: string) => ((await ctx.app.inject({ method: 'POST', url: '/demo/guest-session', payload: { email } })).json().sessionToken as string);
    tokens = {
      admin: await session('admin@demo.mawsool.test'),
      ops: await session('ops@demo.mawsool.test'),
      clinician: await session('clinician.a@demo.mawsool.test'),
      crisisLine: await session('crisisline@demo.mawsool.test'),
    };
  });

  afterEach(async () => {
    await ctx.app.close();
    await testDb.close();
  });

  const invite = (token?: string) => ctx.app.inject({ method: 'POST', url: '/demo/noura-invite', headers: token ? { authorization: `Bearer ${token}` } : {} });
  const claim = (person: { headers: { authorization: string } }, code: string) => ctx.app.inject({ method: 'POST', url: '/me/invites/claim', headers: person.headers, payload: { code } });

  it('gives an admin a code a person can claim, and the TAMM page address for it in both languages', async () => {
    const res = await invite(tokens.admin);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(['code', 'expiresAt', 'tammUrl']);
    expect(body.tammUrl.en).toBe(`http://localhost:3000/en/tamm/?code=${encodeURIComponent(body.code)}`);
    expect(body.tammUrl.ar).toBe(`http://localhost:3000/ar/tamm/?code=${encodeURIComponent(body.code)}`);
    const person = await registerPerson(ctx);
    const claimed = await claim(person, body.code);
    expect(claimed.statusCode).toBe(200);
    expect(claimed.json().source).toBe('tamm');
  });

  it('gives a different code on a second call, and the first still works', async () => {
    const first = (await invite(tokens.admin)).json();
    const second = (await invite(tokens.admin)).json();
    expect(second.code).not.toBe(first.code);
    expect((await claim(await registerPerson(ctx), first.code)).statusCode).toBe(200);
    expect((await claim(await registerPerson(ctx), second.code)).statusCode).toBe(200);
  });

  it('is refused to ops, clinician, crisis-line and no credential', async () => {
    expect((await invite(tokens.ops)).statusCode).toBe(403);
    expect((await invite(tokens.clinician)).statusCode).toBe(403);
    expect((await invite(tokens.crisisLine)).statusCode).toBe(403);
    expect((await invite()).statusCode).toBe(401);
    expect([401, 403]).toContain((await ctx.app.inject({ method: 'POST', url: '/demo/noura-invite', headers: (await registerPerson(ctx)).headers })).statusCode);
  });

  it('adds one open invite to the table for each press, and nothing else', async () => {
    const before = (await testDb.db.select().from(schema.inboundInvites)).length;
    await invite(tokens.admin);
    await invite(tokens.admin);
    expect((await testDb.db.select().from(schema.inboundInvites)).length).toBe(before + 2);
  });

  it('is a 404 with the demo off', async () => {
    const off = await createTestApp(testDb.db);
    try {
      const res = await off.app.inject({ method: 'POST', url: '/demo/noura-invite', headers: { authorization: `Bearer ${tokens.admin}` } });
      expect(res.statusCode).toBe(404);
    } finally {
      await off.app.close();
    }
  });
});

describe('a reset keeps only staff sign-ins that are still good', () => {
  let testDb: TestDb;
  let ctx: TestApp;

  beforeEach(async () => {
    testDb = await createTestDb();
    await runSeed(testDb.db, testDb.cipher);
    ctx = await createTestApp(testDb.db, { demoMode: true });
  });

  afterEach(async () => {
    await ctx.app.close();
    await testDb.close();
  });

  const adminId = STAFF.find((staff) => staff.role === 'admin')!.id;
  const row = (index: number, expiresAt: Date) => ({ staffUserId: adminId, tokenHash: `hash-${index}-${expiresAt.getTime()}`, createdAt: new Date(0), expiresAt });
  const reset = async () => {
    const admin = (await ctx.app.inject({ method: 'POST', url: '/demo/guest-session', payload: { email: 'admin@demo.mawsool.test' } })).json();
    const res = await ctx.app.inject({ method: 'POST', url: '/demo/reset', headers: { authorization: `Bearer ${admin.sessionToken}` } });
    expect(res.statusCode).toBe(200);
    return admin;
  };

  async function insertMany<T>(rows: T[], insert: (chunk: T[]) => Promise<unknown>) {
    for (let i = 0; i < rows.length; i += 1000) await insert(rows.slice(i, i + 1000));
  }

  it('drops 14,000 expired sessions and keeps exactly the 100 live ones (and the caller’s own)', async () => {
    const live = new Date(ctx.clock.now().getTime() + 3_600_000);
    const dead = new Date(ctx.clock.now().getTime() - 3_600_000);
    await insertMany(Array.from({ length: 14_000 }, (_, i) => row(i, dead)), (chunk) => testDb.db.insert(schema.staffSessions).values(chunk));
    await insertMany(Array.from({ length: 100 }, (_, i) => row(i, live)), (chunk) => testDb.db.insert(schema.staffSessions).values(chunk));
    await reset();
    const kept = await testDb.db.select().from(schema.staffSessions);
    expect(kept.filter((session) => session.expiresAt.getTime() === dead.getTime())).toHaveLength(0);
    expect(kept.filter((session) => session.expiresAt.getTime() === live.getTime())).toHaveLength(100);
    expect(kept).toHaveLength(101);
  }, 120_000);

  it('succeeds with 14,000 live sessions and keeps all of them: a single insert would pass the 65,535-parameter limit', async () => {
    const live = new Date(ctx.clock.now().getTime() + 3_600_000);
    await insertMany(Array.from({ length: 14_000 }, (_, i) => row(i, live)), (chunk) => testDb.db.insert(schema.staffSessions).values(chunk));
    await reset();
    expect((await testDb.db.select().from(schema.staffSessions)).length).toBe(14_001);
  }, 120_000);

  it('drops spent and expired links and keeps an unspent, unexpired one', async () => {
    const now = ctx.clock.now();
    const link = (name: string, expiresAt: Date, usedAt: Date | null) => ({ staffUserId: adminId, tokenHash: name, createdAt: new Date(0), expiresAt, usedAt });
    await testDb.db.insert(schema.staffMagicLinks).values([
      link('fresh', new Date(now.getTime() + 600_000), null),
      link('spent', new Date(now.getTime() + 600_000), new Date(now.getTime() - 1000)),
      link('expired', new Date(now.getTime() - 1000), null),
    ]);
    await reset();
    expect((await testDb.db.select().from(schema.staffMagicLinks)).map((l) => l.tokenHash)).toEqual(['fresh']);
  });

  it('judges the sessions on the wall clock, not the demo clock: a session that the demo clock has passed is still kept', async () => {
    const admin = (await ctx.app.inject({ method: 'POST', url: '/demo/guest-session', payload: { email: 'admin@demo.mawsool.test' } })).json();
    await ctx.app.inject({ method: 'POST', url: '/demo/clock/advance', headers: { authorization: `Bearer ${admin.sessionToken}` }, payload: { by: '6w' } });
    const res = await ctx.app.inject({ method: 'POST', url: '/demo/reset', headers: { authorization: `Bearer ${admin.sessionToken}` } });
    expect(res.statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'POST', url: '/demo/clock/advance', headers: { authorization: `Bearer ${admin.sessionToken}` }, payload: { by: '7d' } })).statusCode).toBe(200);
  });
});
