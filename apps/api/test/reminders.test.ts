import { Writable } from 'node:stream';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { ManualClock } from '../src/clock';
import { schema } from '../src/db/client';
import { reminderPhoneContext } from '../src/reminders/service';
import { runSeed } from '../src/seed/run';
import { TEST_START, createTestApp, type TestApp } from './helpers/app';
import { TEST_CONFIG } from './helpers/config';
import { createTestDb, type TestDb } from './helpers/db';
import { cipher, registerPerson } from './helpers/flow';

const NUMBER = '+971501234567';
const OTHER_NUMBER = '+971559876543';

describe('the optional number for text reminders', () => {
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

  const put = (headers: Record<string, string>, payload: unknown) => ctx.app.inject({ method: 'PUT', url: '/me/reminder-phone', headers, payload: payload as object });
  const remove = (headers: Record<string, string>) => ctx.app.inject({ method: 'DELETE', url: '/me/reminder-phone', headers });
  const rows = (personId: string) => testDb.db.select().from(schema.reminderPhones).where(eq(schema.reminderPhones.personId, personId));

  it('stores the number as ciphertext bound to the person, and answers that it holds one without saying what', async () => {
    const person = await registerPerson(ctx);
    const res = await put(person.headers, { phone: NUMBER, intervalWeeks: 2 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ stored: true, intervalWeeks: 2 });
    expect(res.body).not.toContain('971');

    const [row] = await rows(person.id);
    expect(row).toMatchObject({ personId: person.id, intervalWeeks: 2, createdAt: TEST_START, updatedAt: TEST_START });
    expect(JSON.stringify(row)).not.toContain('971501234567');
    expect(row!.phoneCiphertext.startsWith('v1.')).toBe(true);
    expect(cipher.decrypt(row!.phoneCiphertext, reminderPhoneContext(person.id))).toBe(NUMBER);
  });

  it('does not decrypt when the ciphertext is moved to another person’s row', async () => {
    const mine = await registerPerson(ctx);
    const theirs = await registerPerson(ctx);
    await put(mine.headers, { phone: NUMBER, intervalWeeks: 4 });
    const [row] = await rows(mine.id);
    expect(() => cipher.decrypt(row!.phoneCiphertext, reminderPhoneContext(theirs.id))).toThrow();
  });

  it('keeps one row per person: a second save replaces the number and the interval', async () => {
    const person = await registerPerson(ctx);
    await put(person.headers, { phone: NUMBER, intervalWeeks: 4 });
    ctx.clock.advance(60_000);
    await put(person.headers, { phone: OTHER_NUMBER, intervalWeeks: 2 });
    const stored = await rows(person.id);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ intervalWeeks: 2 });
    expect(stored[0]!.updatedAt.getTime()).toBeGreaterThan(stored[0]!.createdAt.getTime());
    expect(cipher.decrypt(stored[0]!.phoneCiphertext, reminderPhoneContext(person.id))).toBe(OTHER_NUMBER);
  });

  it.each([
    ['a number without a plus', { phone: '971501234567', intervalWeeks: 4 }],
    ['a local number', { phone: '0501234567', intervalWeeks: 4 }],
    ['letters', { phone: '+97150abc4567', intervalWeeks: 4 }],
    ['too short', { phone: '+9715012', intervalWeeks: 4 }],
    ['too long', { phone: '+9715012345678901', intervalWeeks: 4 }],
    ['an interval that is not offered', { phone: NUMBER, intervalWeeks: 3 }],
    ['no interval', { phone: NUMBER }],
    ['an extra field', { phone: NUMBER, intervalWeeks: 4, name: 'Someone' }],
  ])('refuses %s and writes nothing', async (_name, payload) => {
    const person = await registerPerson(ctx);
    expect((await put(person.headers, payload)).statusCode).toBe(400);
    expect(await rows(person.id)).toEqual([]);
  });

  it('refuses an interval the database does not allow, even past the API', async () => {
    const person = await registerPerson(ctx);
    await expect(
      testDb.db.insert(schema.reminderPhones).values({ personId: person.id, intervalWeeks: 3, phoneCiphertext: 'x', createdAt: TEST_START, updatedAt: TEST_START }),
    ).rejects.toThrow();
  });

  it('deletes the row when the number is removed, and removing again is not an error', async () => {
    const person = await registerPerson(ctx);
    await put(person.headers, { phone: NUMBER, intervalWeeks: 4 });
    const removed = await remove(person.headers);
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual({ stored: false, intervalWeeks: null });
    expect(await rows(person.id)).toEqual([]);
    expect((await remove(person.headers)).statusCode).toBe(200);
  });

  it('removes only the caller’s own row', async () => {
    const mine = await registerPerson(ctx);
    const theirs = await registerPerson(ctx);
    await put(mine.headers, { phone: NUMBER, intervalWeeks: 4 });
    await put(theirs.headers, { phone: OTHER_NUMBER, intervalWeeks: 4 });
    await remove(mine.headers);
    expect(await rows(mine.id)).toEqual([]);
    expect(await rows(theirs.id)).toHaveLength(1);
  });

  it('Delete everything removes the row, as the raw table shows, and leaves other people’s rows', async () => {
    const mine = await registerPerson(ctx);
    const theirs = await registerPerson(ctx);
    await put(mine.headers, { phone: NUMBER, intervalWeeks: 4 });
    await put(theirs.headers, { phone: OTHER_NUMBER, intervalWeeks: 4 });
    expect(await rows(mine.id)).toHaveLength(1);
    const erased = await ctx.app.inject({ method: 'DELETE', url: '/me/data', headers: mine.headers });
    expect(erased.statusCode).toBe(200);
    expect(await rows(mine.id)).toEqual([]);
    expect(await rows(theirs.id)).toHaveLength(1);
  });

  it('keeps the number out of every table but its own', async () => {
    const person = await registerPerson(ctx);
    await put(person.headers, { phone: NUMBER, intervalWeeks: 4 });
    const dump = await testDb.db.execute(
      sql.raw(
        `SELECT 'persons' AS t, row_to_json(p)::text AS j FROM persons p WHERE id = '${person.id}'
       UNION ALL SELECT 'tickets', row_to_json(x)::text FROM tickets x WHERE person_id = '${person.id}'
       UNION ALL SELECT 'consents', row_to_json(x)::text FROM consents x WHERE person_id = '${person.id}'
       UNION ALL SELECT 'summary_logs', row_to_json(x)::text FROM summary_logs x WHERE person_id = '${person.id}'`,
      ),
    );
    expect(JSON.stringify(dump.rows)).not.toContain('971501234567');
  });
});

describe('what the server writes to its log', () => {
  it('holds neither the number nor the body of a reminder request', async () => {
    const testDb = await createTestDb();
    await runSeed(testDb.db, testDb.cipher);
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const app = await buildApp({ db: testDb.db, clock: new ManualClock(TEST_START), config: { ...TEST_CONFIG, demoMode: false }, logger: { level: 'trace', stream } });
    try {
      const person = await registerPerson({ app });
      const saved = await app.inject({ method: 'PUT', url: '/me/reminder-phone', headers: person.headers, payload: { phone: NUMBER, intervalWeeks: 4 } });
      expect(saved.statusCode).toBe(200);
      const refused = await app.inject({ method: 'PUT', url: '/me/reminder-phone', headers: person.headers, payload: { phone: 'not-a-number', intervalWeeks: 4 } });
      expect(refused.statusCode).toBe(400);
      await app.inject({ method: 'DELETE', url: '/me/reminder-phone', headers: person.headers });
      expect(lines.length).toBeGreaterThan(3);
      const log = lines.join('');
      expect(log).not.toContain('971501234567');
      expect(log).not.toContain('not-a-number');
    } finally {
      await app.close();
      await testDb.close();
    }
  });
});
