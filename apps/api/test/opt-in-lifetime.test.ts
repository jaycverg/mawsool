import { OPT_IN_IDLE_LIMIT_DAYS } from '@mawsool/rules';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ManualClock } from '../src/clock';
import { schema } from '../src/db/client';
import { dayOf, touchLastSeen } from '../src/persons/last-seen';
import { runSeed } from '../src/seed/run';
import { sweep } from '../src/sweep';
import { createTestApp, signIn, TEST_START, type TestApp } from './helpers/app';
import { createTestDb, type TestDb } from './helpers/db';
import { registerPerson, type TestPerson } from './helpers/flow';

const DAY = 86_400_000;
const BUCKETS = { ageBand: '25_34', gender: 'female', language: 'ur', region: 'al_ain' };

describe('an opt-in does not outlive the device that could turn it off', () => {
  let testDb: TestDb;
  let ctx: TestApp;

  beforeAll(async () => {
    testDb = await createTestDb();
    await runSeed(testDb.db, testDb.cipher);
    ctx = await createTestApp(testDb.db);
  });

  afterAll(async () => {
    await ctx.app.close();
    await testDb.close();
  });

  const row = async (person: TestPerson) => (await testDb.db.select().from(schema.persons).where(eq(schema.persons.id, person.id)))[0]!;
  const seenOn = async (person: TestPerson) => (await row(person)).lastSeenOn;
  const call = (person: TestPerson) => ctx.app.inject({ method: 'GET', url: '/me/tickets', headers: person.headers });

  /** A registered person who has turned both choices on. */
  async function optedIn(): Promise<TestPerson> {
    const person = await registerPerson(ctx);
    expect((await ctx.app.inject({ method: 'PUT', url: '/me/equity', headers: person.headers, payload: { optIn: true, buckets: BUCKETS } })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'PUT', url: '/me/outcome-statistics', headers: person.headers, payload: { optIn: true } })).statusCode).toBe(200);
    return person;
  }

  /** Puts the person's last day back, as if they had last been seen that many days before the test clock. */
  async function lastSeenDaysAgo(person: TestPerson, days: number) {
    await testDb.db.update(schema.persons).set({ lastSeenOn: dayOf(new Date(ctx.clock.now().getTime() - days * DAY)) }).where(eq(schema.persons.id, person.id));
  }

  it('has a limit of about six months, kept in the rules config', () => {
    expect(OPT_IN_IDLE_LIMIT_DAYS).toBe(180);
  });

  it('records the day a device registers, on the wall clock', async () => {
    const person = await registerPerson(ctx);
    expect(await seenOn(person)).toBe(dayOf(ctx.clock.now()));
  });

  it('moves the day when the device calls on a later day, and writes nothing on a day it was already seen', async () => {
    const person = await registerPerson(ctx);
    const first = dayOf(ctx.clock.now());
    expect((await call(person)).statusCode).toBe(200);
    expect(await seenOn(person)).toBe(first);
    expect(await touchLastSeen(testDb.db, person.id, ctx.clock.now())).toBe(false);
    ctx.clock.advance(3 * DAY);
    expect((await call(person)).statusCode).toBe(200);
    expect(await seenOn(person)).toBe(dayOf(new Date(TEST_START.getTime() + 3 * DAY)));
    expect(await touchLastSeen(testDb.db, person.id, ctx.clock.now())).toBe(false);
    ctx.clock.set(TEST_START);
  });

  it('never moves the day back, and a registration of the same device on a later day counts as being seen', async () => {
    const person = await registerPerson(ctx);
    ctx.clock.advance(5 * DAY);
    expect(await touchLastSeen(testDb.db, person.id, new Date(TEST_START.getTime() - 2 * DAY))).toBe(false);
    expect(await seenOn(person)).toBe(dayOf(TEST_START));
    const secret = person.headers.authorization.split('.')[1];
    const again = await ctx.app.inject({ method: 'POST', url: '/persons', payload: { id: person.id, secret, locale: 'en' } });
    expect(again.statusCode).toBe(200);
    expect(await seenOn(person)).toBe(dayOf(ctx.clock.now()));
    ctx.clock.set(TEST_START);
  });

  it('does not count a request that fails to authenticate', async () => {
    const person = await registerPerson(ctx);
    await lastSeenDaysAgo(person, 10);
    const before = await seenOn(person);
    const wrong = await ctx.app.inject({ method: 'GET', url: '/me/tickets', headers: { authorization: `Bearer ${person.id}.${'A'.repeat(43)}` } });
    expect(wrong.statusCode).toBe(401);
    expect(await seenOn(person)).toBe(before);
  });

  it('keeps both choices up to the day before the limit and turns both off, with the equity buckets, at the limit', async () => {
    const person = await optedIn();
    await lastSeenDaysAgo(person, OPT_IN_IDLE_LIMIT_DAYS - 1);
    expect((await sweep(testDb.db, ctx.clock)).optInsCleared).toBe(0);
    expect(await row(person)).toMatchObject({ equityOptIn: true, outcomeStatsOptIn: true, ageBand: '25_34', gender: 'female', language: 'ur', region: 'al_ain' });
    await lastSeenDaysAgo(person, OPT_IN_IDLE_LIMIT_DAYS);
    expect((await sweep(testDb.db, ctx.clock)).optInsCleared).toBe(1);
    expect(await row(person)).toMatchObject({ equityOptIn: false, outcomeStatsOptIn: false, ageBand: null, gender: null, language: null, region: null });
    expect((await sweep(testDb.db, ctx.clock)).optInsCleared).toBe(0);
  });

  it('clears a person who held only one of the two choices, and leaves the date alone', async () => {
    const person = await registerPerson(ctx);
    await ctx.app.inject({ method: 'PUT', url: '/me/outcome-statistics', headers: person.headers, payload: { optIn: true } });
    await lastSeenDaysAgo(person, OPT_IN_IDLE_LIMIT_DAYS + 40);
    const before = await seenOn(person);
    expect((await sweep(testDb.db, ctx.clock)).optInsCleared).toBe(1);
    expect(await row(person)).toMatchObject({ outcomeStatsOptIn: false, equityOptIn: false, lastSeenOn: before });
  });

  it('counts the one read the app makes when it starts (the person’s own tickets, no query) as the device being in use', async () => {
    const person = await optedIn();
    await lastSeenDaysAgo(person, OPT_IN_IDLE_LIMIT_DAYS - 1);
    const read = await ctx.app.inject({ method: 'GET', url: '/me/tickets', headers: person.headers });
    expect(read.statusCode).toBe(200);
    expect(await seenOn(person)).toBe(dayOf(ctx.clock.now()));
    ctx.clock.advance(2 * DAY);
    expect((await sweep(testDb.db, ctx.clock)).optInsCleared).toBe(0);
    expect(await row(person)).toMatchObject({ equityOptIn: true, outcomeStatsOptIn: true });
    ctx.clock.set(TEST_START);
    // Nobody is left on whom a later case's long clock jump would act.
    await testDb.db.update(schema.persons).set({ equityOptIn: false, outcomeStatsOptIn: false, ageBand: null, gender: null, language: null, region: null }).where(eq(schema.persons.id, person.id));
  });

  it('keeps the choices of a person whose device is in use, however long ago they chose', async () => {
    const person = await optedIn();
    ctx.clock.advance((OPT_IN_IDLE_LIMIT_DAYS - 1) * DAY);
    expect((await call(person)).statusCode).toBe(200);
    ctx.clock.advance((OPT_IN_IDLE_LIMIT_DAYS - 1) * DAY);
    expect((await call(person)).statusCode).toBe(200);
    expect((await sweep(testDb.db, ctx.clock)).optInsCleared).toBe(0);
    expect(await row(person)).toMatchObject({ equityOptIn: true, outcomeStatsOptIn: true });
    ctx.clock.set(TEST_START);
  });

  it('leaves a person with no date alone, as a seeded person with no device is', async () => {
    const optedInWithoutDate = () => testDb.db.select({ id: schema.persons.id }).from(schema.persons).where(and(isNull(schema.persons.lastSeenOn), eq(schema.persons.equityOptIn, true)));
    const before = await optedInWithoutDate();
    expect(before.length).toBeGreaterThan(100);
    ctx.clock.advance(900 * DAY);
    const swept = await sweep(testDb.db, ctx.clock);
    expect(swept.optInsCleared).toBeGreaterThan(0);
    expect(await optedInWithoutDate()).toEqual(before);
    ctx.clock.set(TEST_START);
  });

  it('reads the wall clock for the limit, so a jump of the care clock clears nobody', async () => {
    const person = await optedIn();
    await lastSeenDaysAgo(person, 10);
    const careClock = new ManualClock(new Date(ctx.clock.now().getTime() + 400 * DAY));
    expect((await sweep(testDb.db, careClock, {}, ctx.clock)).optInsCleared).toBe(0);
    expect(await row(person)).toMatchObject({ equityOptIn: true, outcomeStatsOptIn: true });
    expect((await sweep(testDb.db, ctx.clock, {}, careClock)).optInsCleared).toBeGreaterThanOrEqual(1);
    expect(await row(person)).toMatchObject({ equityOptIn: false, outcomeStatsOptIn: false });
  });
});

describe('the demo clock does not move the day a device was last seen', () => {
  it('keeps the wall day after the demo clock is advanced, and the sweep at the demo time clears nobody', async () => {
    const testDb = await createTestDb();
    await runSeed(testDb.db, testDb.cipher);
    const ctx = await createTestApp(testDb.db, { demoMode: true });
    try {
      const admin = { authorization: `Bearer ${await signIn(ctx, 'admin@demo.mawsool.test')}` };
      const person = await registerPerson(ctx);
      await ctx.app.inject({ method: 'PUT', url: '/me/outcome-statistics', headers: person.headers, payload: { optIn: true } });
      const registered = dayOf(ctx.clock.now());
      for (let i = 0; i < 5; i += 1) {
        const advanced = await ctx.app.inject({ method: 'POST', url: '/demo/clock/advance', headers: admin, payload: { by: '6w' } });
        expect(advanced.statusCode).toBe(200);
      }
      expect(ctx.app.careClock.now().getTime() - ctx.clock.now().getTime()).toBeGreaterThan(OPT_IN_IDLE_LIMIT_DAYS * DAY);
      expect((await ctx.app.inject({ method: 'GET', url: '/me/tickets', headers: person.headers })).statusCode).toBe(200);
      const [after] = await testDb.db.select().from(schema.persons).where(eq(schema.persons.id, person.id));
      expect(after).toMatchObject({ lastSeenOn: registered, outcomeStatsOptIn: true });
    } finally {
      await ctx.app.close();
      await testDb.close();
    }
  });
});
