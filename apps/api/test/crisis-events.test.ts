import { randomBytes, randomUUID } from 'node:crypto';
import { eq, getTableColumns } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import { mergeCrisisEvent } from '../src/routes/crisis-events';
import { createTestApp, type TestApp } from './helpers/app';
import { createTestDb, type TestDb } from './helpers/db';

const SHOWN = '2026-11-01T08:00:00+04:00';

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    trigger: 'phq9_item9',
    shownAt: SHOWN,
    callTapped: null,
    contextShared: false,
    humanContactConfirmed: false,
    contactSource: null,
    contactAt: null,
    resolvedAt: null,
    locale: 'en',
    ...overrides,
  };
}

describe('POST /crisis-events', () => {
  let testDb: TestDb;
  let ctx: TestApp;
  const personId = randomUUID();
  const secret = randomBytes(32).toString('base64url');
  const auth = { authorization: `Bearer ${personId}.${secret}` };

  beforeAll(async () => {
    testDb = await createTestDb();
    ctx = await createTestApp(testDb.db);
    await ctx.app.inject({ method: 'POST', url: '/persons', payload: { id: personId, secret, locale: 'en' } });
  });

  afterAll(async () => {
    await ctx.app.close();
    await testDb.close();
  });

  const post = (payload: unknown, headers: Record<string, string> = auth) =>
    ctx.app.inject({ method: 'POST', url: '/crisis-events', payload: payload as object, headers });
  const rows = (id: string) => testDb.db.select().from(schema.crisisEvents).where(eq(schema.crisisEvents.id, id));

  it('creates the event on the first snapshot and answers 201', async () => {
    const event = snapshot({ locale: 'ar' });
    const res = await post(event);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ id: event.id, created: true });
    const [row] = await rows(event.id);
    expect(row).toMatchObject({ trigger: 'phq9_item9', locale: 'ar', callTapped: null, humanContactConfirmed: false, followUpAt: null });
    expect(row!.shownAt.getTime()).toBe(new Date(SHOWN).getTime());
  });

  it('stores one row when the same snapshot arrives twice, and answers 200 the second time', async () => {
    const event = snapshot();
    expect((await post(event)).statusCode).toBe(201);
    const again = await post(event);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ id: event.id, created: false });
    expect(await rows(event.id)).toHaveLength(1);
  });

  it('folds a later snapshot into the same row: the tap, the confirmed contact and the resolution', async () => {
    const event = snapshot();
    await post(event);
    await post({ ...event, callTapped: '800725462' });
    await post({
      ...event,
      callTapped: '800725462',
      humanContactConfirmed: true,
      contactSource: 'self_report',
      contactAt: '2026-11-01T08:03:00+04:00',
    });
    await post({
      ...event,
      callTapped: '800725462',
      humanContactConfirmed: true,
      contactSource: 'self_report',
      contactAt: '2026-11-01T08:03:00+04:00',
      resolvedAt: '2026-11-01T08:05:00+04:00',
    });
    const stored = await rows(event.id);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ callTapped: '800725462', humanContactConfirmed: true, contactSource: 'self_report' });
    expect(stored[0]!.contactAt?.toISOString()).toBe(new Date('2026-11-01T08:03:00+04:00').toISOString());
    expect(stored[0]!.resolvedAt?.toISOString()).toBe(new Date('2026-11-01T08:05:00+04:00').toISOString());
  });

  it('never loses a recorded contact or resolution to a stale snapshot that arrives later', async () => {
    const event = snapshot();
    const confirmed = {
      ...event,
      callTapped: '999',
      humanContactConfirmed: true,
      contactSource: 'self_report',
      contactAt: '2026-11-01T08:03:00+04:00',
      resolvedAt: '2026-11-01T08:05:00+04:00',
    };
    await post(confirmed);
    await post(event);
    const [row] = await rows(event.id);
    expect(row).toMatchObject({ callTapped: '999', humanContactConfirmed: true, contactSource: 'self_report' });
    expect(row!.contactAt).not.toBeNull();
    expect(row!.resolvedAt).not.toBeNull();
  });

  it('keeps what was shown, when and in which language, whatever a later snapshot says', async () => {
    const event = snapshot();
    await post(event);
    await post({ ...event, trigger: 'cssrs', shownAt: '2026-11-02T08:00:00+04:00', locale: 'ar' });
    const [row] = await rows(event.id);
    expect(row).toMatchObject({ trigger: 'phq9_item9', locale: 'en' });
    expect(row!.shownAt.getTime()).toBe(new Date(SHOWN).getTime());
  });

  it('has no column for a person, an item answer or free text', () => {
    const columns = Object.keys(getTableColumns(schema.crisisEvents)).sort();
    expect(columns).toEqual([
      'callTapped',
      'contactAt',
      'contactSource',
      'contextShared',
      'followUpAt',
      'humanContactConfirmed',
      'id',
      'locale',
      'resolvedAt',
      'shownAt',
      'trigger',
    ]);
  });

  it('refuses a body that carries item answers, a person id or free text, and stores nothing', async () => {
    for (const extra of [{ answers: [0, 0, 0, 0, 0, 0, 0, 0, 2] }, { personId }, { note: 'free text' }, { item9: 2 }, { followUpAt: SHOWN }]) {
      const event = snapshot(extra);
      const res = await post(event);
      expect(res.statusCode, JSON.stringify(extra)).toBe(400);
      expect(await rows(event.id)).toHaveLength(0);
    }
  });

  it('stores the caller nowhere in the row', async () => {
    const event = snapshot();
    await post(event);
    expect(JSON.stringify(await rows(event.id))).not.toContain(personId);
  });

  it('refuses contact fields that disagree with the confirmed flag', async () => {
    expect((await post(snapshot({ humanContactConfirmed: true }))).statusCode).toBe(400);
    expect((await post(snapshot({ contactAt: SHOWN }))).statusCode).toBe(400);
    expect((await post(snapshot({ humanContactConfirmed: true, contactAt: SHOWN }))).statusCode).toBe(400);
    expect((await post(snapshot({ contactSource: 'self_report' }))).statusCode).toBe(400);
  });

  it('refuses an unknown trigger, number or locale, and a malformed id', async () => {
    expect((await post(snapshot({ trigger: 'other' }))).statusCode).toBe(400);
    expect((await post(snapshot({ callTapped: '911' }))).statusCode).toBe(400);
    expect((await post(snapshot({ locale: 'fr' }))).statusCode).toBe(400);
    expect((await post(snapshot({ id: 'nope' }))).statusCode).toBe(400);
  });

  it('needs a registered device: no credential, a wrong secret and an unknown id get 401', async () => {
    const event = snapshot();
    expect((await post(event, {})).statusCode).toBe(401);
    expect((await post(event, { authorization: `Bearer ${personId}.${randomBytes(32).toString('base64url')}` })).statusCode).toBe(401);
    expect((await post(event, { authorization: `Bearer ${randomUUID()}.${secret}` })).statusCode).toBe(401);
    expect(await rows(event.id)).toHaveLength(0);
  });
});

describe('mergeCrisisEvent', () => {
  const stored = {
    id: randomUUID(),
    trigger: 'phq9_item9' as const,
    shownAt: new Date(SHOWN),
    callTapped: null,
    contextShared: false,
    humanContactConfirmed: false,
    contactSource: null,
    contactAt: null,
    resolvedAt: null,
    followUpAt: null,
    locale: 'en' as const,
  };

  it('takes a later tap, and keeps an earlier one when the later snapshot has none', () => {
    const incoming = { ...snapshot(), callTapped: '998' } as never;
    expect(mergeCrisisEvent(stored, incoming).callTapped).toBe('998');
    expect(mergeCrisisEvent({ ...stored, callTapped: '999' }, snapshot() as never).callTapped).toBe('999');
  });

  it('keeps a shared-context flag once set', () => {
    expect(mergeCrisisEvent({ ...stored, contextShared: true }, snapshot() as never).contextShared).toBe(true);
  });
});
