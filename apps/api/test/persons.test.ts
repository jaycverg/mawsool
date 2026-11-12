import { randomBytes, randomUUID } from 'node:crypto';
import { eq, getTableColumns } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import { sha256Hex } from '../src/security';
import { createTestApp, TEST_START, type TestApp } from './helpers/app';
import { createTestDb, type TestDb } from './helpers/db';
import { TEST_CONFIG } from './helpers/config';

const newSecret = () => randomBytes(32).toString('base64url');

describe('person identity', () => {
  let testDb: TestDb;
  let ctx: TestApp;

  beforeAll(async () => {
    testDb = await createTestDb();
    ctx = await createTestApp(testDb.db);
    // A route that needs the person credential, so the bearer path can be exercised before person routes exist.
  });

  afterAll(async () => {
    await ctx.app.close();
    await testDb.close();
  });

  const register = (payload: unknown) => ctx.app.inject({ method: 'POST', url: '/persons', payload: payload as object });

  it('registers a device with an id, a secret and a locale, and returns 201', async () => {
    const id = randomUUID();
    const res = await register({ id, secret: newSecret(), locale: 'ar' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ id, created: true });
  });

  it('stores only the hash of the secret, the locale and the registration time', async () => {
    const id = randomUUID();
    const secret = newSecret();
    await register({ id, secret, locale: 'en' });
    const [row] = await testDb.db.select().from(schema.persons).where(eq(schema.persons.id, id));
    expect(row).toMatchObject({
      id,
      secretHash: sha256Hex(secret),
      locale: 'en',
      equityOptIn: false,
      outcomeStatsOptIn: false,
      ageBand: null,
      gender: null,
      language: null,
      region: null,
    });
    expect(row!.createdAt.getTime()).toBe(TEST_START.getTime());
    expect(JSON.stringify(row)).not.toContain(secret);
  });

  it('has no column that could hold a name, email, Emirates ID or phone number', () => {
    const columns = Object.keys(getTableColumns(schema.persons)).sort();
    expect(columns).toEqual(['ageBand', 'createdAt', 'equityOptIn', 'gender', 'id', 'language', 'lastSeenOn', 'locale', 'outcomeStatsOptIn', 'region', 'secretHash']);
  });

  it('ignores a phone number or name sent along, and never stores it', async () => {
    const id = randomUUID();
    const res = await register({ id, secret: newSecret(), locale: 'en', phone: '+971500000000', name: 'Someone', email: 'a@b.c' });
    expect(res.statusCode).toBe(201);
    const [row] = await testDb.db.select().from(schema.persons).where(eq(schema.persons.id, id));
    expect(JSON.stringify(row)).not.toMatch(/971500000000|Someone|a@b\.c/);
  });

  it('is idempotent for the same id and secret: 200 and one row', async () => {
    const id = randomUUID();
    const secret = newSecret();
    expect((await register({ id, secret, locale: 'ar' })).statusCode).toBe(201);
    const again = await register({ id, secret, locale: 'ar' });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ id, created: false });
    const rows = await testDb.db.select().from(schema.persons).where(eq(schema.persons.id, id));
    expect(rows).toHaveLength(1);
  });

  it('refuses a second secret for a registered id with 409, and leaves the first untouched', async () => {
    const id = randomUUID();
    const secret = newSecret();
    await register({ id, secret, locale: 'ar' });
    const hijack = await register({ id, secret: newSecret(), locale: 'en' });
    expect(hijack.statusCode).toBe(409);
    const [row] = await testDb.db.select().from(schema.persons).where(eq(schema.persons.id, id));
    expect(row).toMatchObject({ secretHash: sha256Hex(secret), locale: 'ar' });
  });

  it('rejects a malformed id, a short secret and an unknown locale with 400', async () => {
    expect((await register({ id: 'nope', secret: newSecret(), locale: 'ar' })).statusCode).toBe(400);
    expect((await register({ id: randomUUID(), secret: 'short', locale: 'ar' })).statusCode).toBe(400);
    expect((await register({ id: randomUUID(), secret: newSecret(), locale: 'fr' })).statusCode).toBe(400);
    expect((await register({})).statusCode).toBe(400);
  });

  it('needs no authentication, so a device can register at its first server write', async () => {
    const res = await register({ id: randomUUID(), secret: newSecret(), locale: 'ar' });
    expect(res.statusCode).toBe(201);
  });
});

describe('person bearer authentication', () => {
  let testDb: TestDb;
  let ctx: TestApp;
  const id = randomUUID();
  const secret = newSecret();

  beforeAll(async () => {
    testDb = await createTestDb();
    ctx = await createTestApp(testDb.db);
    await ctx.app.inject({ method: 'POST', url: '/persons', payload: { id, secret, locale: 'ar' } });
  });

  afterAll(async () => {
    await ctx.app.close();
    await testDb.close();
  });

  /** Builds a throwaway app with one person route, because the person routes themselves arrive later. */
  async function appWithPersonRoute() {
    const { buildApp } = await import('../src/app');
    return buildApp({
      db: testDb.db,
      clock: ctx.clock,
      notifier: ctx.notifier,
      config: { ...TEST_CONFIG, corsOrigins: [] },
      extraRoutes: (app) => {
        app.get('/whoami', { config: { access: 'person' } }, async (request) => request.principal);
      },
    });
  }

  it('accepts the registered id and secret', async () => {
    const app = await appWithPersonRoute();
    const res = await app.inject({ method: 'GET', url: '/whoami', headers: { authorization: `Bearer ${id}.${secret}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ kind: 'person', personId: id });
    await app.close();
  });

  it('refuses a wrong secret, an unknown id, a malformed credential and no credential with 401', async () => {
    const app = await appWithPersonRoute();
    const call = (authorization?: string) =>
      app.inject({ method: 'GET', url: '/whoami', headers: authorization ? { authorization } : {} });
    expect((await call(`Bearer ${id}.${newSecret()}`)).statusCode).toBe(401);
    expect((await call(`Bearer ${randomUUID()}.${secret}`)).statusCode).toBe(401);
    expect((await call(`Bearer ${id}`)).statusCode).toBe(401);
    expect((await call(`Bearer ${secret}`)).statusCode).toBe(401);
    expect((await call()).statusCode).toBe(401);
    expect((await call(`Basic ${id}.${secret}`)).statusCode).toBe(401);
    await app.close();
  });
});
