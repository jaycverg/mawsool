import type { AdverseEvent, AdverseEventsResponse } from '@mawsool/types';
import { eq, getTableName } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import type { OffsetClock } from '../src/clock';
import { schema } from '../src/db/client';
import { ADVERSE_EVENT_MOVES, isLegalMove, moveAdverseEvent, recordAdverseEvent } from '../src/adverse-events/service';
import { pseudonymOf } from '../src/metrics/timeliness';
import { runSeed } from '../src/seed/run';
import { createTestApp, signIn, type TestApp } from './helpers/app';
import { TEST_CONFIG, TEST_ENCRYPTION_KEY } from './helpers/config';
import { createTestDb, type TestDb } from './helpers/db';
import { registerPerson } from './helpers/flow';

let testDb: TestDb;
let ctx: TestApp;
const tokens: Record<string, string> = {};
const as = (who: string) => ({ authorization: `Bearer ${tokens[who]}` });
const DAY = 86_400_000;
const REF = pseudonymOf('00000000-0000-4000-8000-0000000000aa', TEST_ENCRYPTION_KEY);

beforeAll(async () => {
  testDb = await createTestDb();
  await runSeed(testDb.db, testDb.cipher);
  ctx = await createTestApp(testDb.db, { demoMode: true });
  for (const [who, email] of Object.entries({ ops: 'ops@demo.mawsool.test', admin: 'admin@demo.mawsool.test', clinician: 'clinician.a@demo.mawsool.test', line: 'crisisline@demo.mawsool.test' })) tokens[who] = await signIn(ctx, email);
});

afterAll(async () => {
  await ctx.app.close();
  await testDb.close();
});

const record = async (who: string, payload: Record<string, unknown>) => ctx.app.inject({ method: 'POST', url: '/adverse-events', headers: as(who), payload });
const move = async (who: string, id: string, to: string) => ctx.app.inject({ method: 'POST', url: `/adverse-events/${id}/status`, headers: as(who), payload: { to } });
const list = async (query = '', who = 'ops') => ctx.app.inject({ method: 'GET', url: `/adverse-events${query}`, headers: as(who) });
const recordOk = async (payload: Record<string, unknown> = { type: 'wrong_routing', severity: 'moderate' }, who = 'ops'): Promise<AdverseEvent> => {
  const res = await record(who, payload);
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as AdverseEvent;
};

describe('recording an adverse event', () => {
  it('records a coded type, a severity, a time and an optional pseudonymous ticket id, open, with the recording as the first history row', async () => {
    const event = await recordOk({ type: 'missed_crisis_follow_up', severity: 'high', ticketRef: REF, occurredAt: '2026-10-30T09:00:00+04:00' });
    expect(event).toMatchObject({ type: 'missed_crisis_follow_up', severity: 'high', status: 'open', ticketRef: REF, occurredAt: '2026-10-30T05:00:00.000Z' });
    expect(event.history).toEqual([{ from: null, to: 'open', at: event.recordedAt, by: 'ops' }]);
  });

  it('lets an admin record too, and says so in the history', async () => {
    const event = await recordOk({ type: 'data_incident', severity: 'critical' }, 'admin');
    expect(event.history[0]).toMatchObject({ by: 'admin' });
  });

  it('takes the time it happened from the care clock and the time it was recorded from the wall clock, which differ while the demo clock is moved on', async () => {
    const care = ctx.app.careClock as OffsetClock;
    const before = care.offset;
    care.advance(7 * DAY);
    try {
      const event = await recordOk({ type: 'wrong_routing', severity: 'low' });
      expect(Date.parse(event.occurredAt) - Date.parse(event.recordedAt)).toBe(7 * DAY + before);
      expect(event.recordedAt).toBe(ctx.clock.now().toISOString());
      // A move is stamped with the wall clock, too.
      const moved = (await move('ops', event.id, 'investigating')).json() as AdverseEvent;
      expect(moved.history.at(-1)!.at).toBe(ctx.clock.now().toISOString());
    } finally {
      care.setOffset(before);
    }
  });

  it('refuses an event that happened after the care clock\'s now, and writes nothing', async () => {
    const countBefore = (await testDb.db.select().from(schema.adverseEvents)).length;
    const res = await record('ops', { type: 'wrong_routing', severity: 'low', occurredAt: new Date(ctx.app.careClock.now().getTime() + 60_000).toISOString() });
    expect(res.statusCode).toBe(400);
    expect((await testDb.db.select().from(schema.adverseEvents)).length).toBe(countBefore);
  });

  it('accepts an event that happened at exactly the care clock\'s now', async () => {
    const res = await record('ops', { type: 'wrong_routing', severity: 'low', occurredAt: ctx.app.careClock.now().toISOString() });
    expect(res.statusCode).toBe(201);
  });

  it('refuses a type, severity or ticket id outside the fixed lists and shapes, and anything about a person: no field is accepted that is not in the schema', async () => {
    const bad: Record<string, unknown>[] = [
      { type: 'other', severity: 'low' },
      { type: 'wrong_routing', severity: 'medium' },
      { type: 'wrong_routing', severity: 'low', ticketRef: '00000000-0000-4000-8000-0000000000aa' }, // a real ticket id is not a pseudonym
      { type: 'wrong_routing', severity: 'low', ticketRef: 'od_XYZ' },
      { type: 'wrong_routing', severity: 'low', note: 'free text about someone' },
      { type: 'wrong_routing', severity: 'low', personId: '00000000-0000-4000-8000-0000000000bb' },
      { type: 'wrong_routing', severity: 'low', phone: '+971501234567' },
      { type: 'wrong_routing', severity: 'low', occurredAt: 'yesterday' },
      { severity: 'low' },
    ];
    for (const payload of bad) expect((await record('ops', payload)).statusCode, JSON.stringify(payload)).toBe(400);
  });

  it('stores nothing that could be tied to a person: the row holds the coded fields and the pseudonym, and the history only a staff id', async () => {
    const event = await recordOk({ type: 'wrong_routing', severity: 'low', ticketRef: REF });
    const [row] = await testDb.db.select().from(schema.adverseEvents).where(eq(schema.adverseEvents.id, event.id));
    expect(Object.keys(row!).sort()).toEqual(['id', 'occurredAt', 'recordedAt', 'severity', 'status', 'ticketRef', 'type']);
    expect(Object.keys((await testDb.db.select().from(schema.adverseEventHistory))[0]!).sort()).toEqual(['at', 'eventId', 'fromStatus', 'id', 'seq', 'staffUserId', 'toStatus']);
  });
});

describe('what the log is linked to', () => {
  it('has no foreign key to a person, a ticket or a crisis event, so nothing in it can be tied to anyone or needs an erase path', () => {
    const linked = (table: Parameters<typeof getTableConfig>[0]) =>
      getTableConfig(table)
        .foreignKeys.map((fk) => getTableName(fk.reference().foreignTable))
        .sort();
    expect(linked(schema.adverseEvents)).toEqual([]);
    expect(linked(schema.adverseEventHistory)).toEqual(['adverse_events', 'staff_users']);
  });
});

describe('moving an adverse event along its statuses', () => {
  it('allows open to investigating, investigating to closed, and open straight to closed, and records each move with its time', async () => {
    const walk = await recordOk();
    const investigating = (await move('ops', walk.id, 'investigating')).json() as AdverseEvent;
    expect(investigating.status).toBe('investigating');
    const closed = (await move('ops', walk.id, 'closed')).json() as AdverseEvent;
    expect(closed.status).toBe('closed');
    expect(closed.history.map((entry) => [entry.from, entry.to])).toEqual([[null, 'open'], ['open', 'investigating'], ['investigating', 'closed']]);
    for (const entry of closed.history) expect(Number.isNaN(Date.parse(entry.at))).toBe(false);

    const quick = await recordOk();
    const direct = (await move('admin', quick.id, 'closed')).json() as AdverseEvent;
    expect(direct.history.map((entry) => [entry.from, entry.to, entry.by])).toEqual([[null, 'open', 'ops'], ['open', 'closed', 'admin']]);
  });

  it('answers 409 for every other move and changes nothing: back, sideways, out of closed, and to the same status', async () => {
    const illegal: [string, string][] = [['open', 'open'], ['investigating', 'open'], ['investigating', 'investigating'], ['closed', 'open'], ['closed', 'investigating'], ['closed', 'closed']];
    for (const [from, to] of illegal) {
      const event = await recordOk();
      if (from !== 'open') await move('ops', event.id, from === 'closed' ? 'closed' : 'investigating');
      const before = (await list()).json() as AdverseEventsResponse;
      const res = await move('ops', event.id, to);
      expect(res.statusCode, `${from} to ${to}`).toBe(409);
      expect(res.json().error).toBe('illegal_move');
      expect((await list()).json()).toEqual(before);
    }
    expect(Object.entries(ADVERSE_EVENT_MOVES).flatMap(([from, tos]) => tos.map((to) => `${from}>${to}`))).toEqual(['open>investigating', 'open>closed', 'investigating>closed']);
    expect(isLegalMove('closed', 'open')).toBe(false);
  });

  it('answers 404 for an event that does not exist, and 400 for a status that is not one', async () => {
    expect((await move('ops', '00000000-0000-4000-8000-0000000000cc', 'closed')).statusCode).toBe(404);
    const event = await recordOk();
    expect((await move('ops', event.id, 'reviewed')).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: 'POST', url: '/adverse-events/not-an-id/status', headers: as('ops'), payload: { to: 'closed' } })).statusCode).toBe(400);
  });

  it('lets one of two moves from the same status win, and answers 409 to the other without writing its history row', async () => {
    const event = await recordOk();
    const deps = { db: testDb.db, clock: ctx.app.careClock, securityClock: ctx.clock };
    const actor = { staffUserId: (await testDb.db.select().from(schema.staffUsers)).find((user) => user.role === 'ops')!.id, role: 'ops' as const };
    // The first move reads the status, then waits while a rival gets in and closes the event.
    const slow = moveAdverseEvent(deps, actor, event.id, 'investigating', { afterRead: async () => void (await moveAdverseEvent(deps, actor, event.id, 'closed')) });
    expect(await slow).toEqual({ kind: 'lost_race' });
    const after = ((await list()).json() as AdverseEventsResponse).items.find((item) => item.id === event.id)!;
    expect(after.status).toBe('closed');
    expect(after.history.map((entry) => entry.to)).toEqual(['open', 'closed']);
  });
});

describe('the answer to a record or a move is what was stored', () => {
  /** A database whose own reads fail once `blocked` is set: only the transaction's connection still answers, so any read after the commit throws. */
  function blockedAfter() {
    const state = { blocked: false };
    const db = new Proxy(testDb.db, {
      get(target, property, receiver) {
        if (property === 'select' && state.blocked) return () => { throw new Error('a read after the commit'); };
        return Reflect.get(target, property, receiver);
      },
    });
    return { state, deps: { db, clock: ctx.app.careClock, securityClock: ctx.clock } };
  }
  const opsActor = async () => ({ staffUserId: (await testDb.db.select().from(schema.staffUsers)).find((user) => user.role === 'ops')!.id, role: 'ops' as const });

  it('records and answers with no read after the commit, and the answer equals the stored event', async () => {
    const { state, deps } = blockedAfter();
    state.blocked = true;
    const recorded = await recordAdverseEvent(deps, await opsActor(), { type: 'data_incident', severity: 'high', ticketRef: REF });
    expect(recorded.kind).toBe('recorded');
    const stored = ((await list()).json() as AdverseEventsResponse).items.find((item) => recorded.kind === 'recorded' && item.id === recorded.event.id);
    expect(recorded.kind === 'recorded' ? recorded.event : null).toEqual(stored);
  });

  it('moves and answers with no read after the commit, and the answer equals the stored event with the move in its history', async () => {
    const { state, deps } = blockedAfter();
    const event = await recordOk();
    const moved = await moveAdverseEvent(deps, await opsActor(), event.id, 'investigating', { afterRead: async () => void (state.blocked = true) });
    expect(moved.kind).toBe('moved');
    const stored = ((await list()).json() as AdverseEventsResponse).items.find((item) => item.id === event.id);
    expect(moved.kind === 'moved' ? moved.event : null).toEqual(stored);
    expect(stored!.history.map((entry) => entry.to)).toEqual(['open', 'investigating']);
  });
});

describe('listing the log', () => {
  it('lists by status and by severity, with the counts of the whole log whatever the filter, newest occurrence first', async () => {
    const all = (await list()).json() as AdverseEventsResponse;
    expect(all.items.length).toBeGreaterThan(5);
    const occurred = all.items.map((item) => item.occurredAt);
    expect(occurred).toEqual([...occurred].sort().reverse());
    expect(all.counts.byStatus.open + all.counts.byStatus.investigating + all.counts.byStatus.closed).toBe(all.items.length);
    expect(Object.values(all.counts.bySeverity).reduce((a, b) => a + b, 0)).toBe(all.items.length);

    const open = (await list('?status=open')).json() as AdverseEventsResponse;
    expect(open.items.length).toBe(all.counts.byStatus.open);
    expect(open.items.every((item) => item.status === 'open')).toBe(true);
    expect(open.counts).toEqual(all.counts);

    const critical = (await list('?severity=critical&status=open')).json() as AdverseEventsResponse;
    expect(critical.items.every((item) => item.severity === 'critical' && item.status === 'open')).toBe(true);
    expect((await list('?status=reviewed')).statusCode).toBe(400);
  });

  it('is readable by an admin as well as ops', async () => {
    expect((await list('', 'admin')).statusCode).toBe(200);
  });
});

describe('the log is not a way to reach a person', () => {
  it('returns no person field, no free text and nothing but the pseudonym for a ticket', async () => {
    const person = await registerPerson(ctx);
    expect(person.id).toBeTruthy();
    await recordOk({ type: 'missed_crisis_follow_up', severity: 'critical', ticketRef: REF });
    const body = (await list()).body;
    expect(body).not.toContain(person.id);
    expect(Object.keys((JSON.parse(body) as AdverseEventsResponse).items[0]!).sort()).toEqual(['history', 'id', 'occurredAt', 'recordedAt', 'severity', 'status', 'ticketRef', 'type']);
  });
});

describe('who may use the adverse-events routes', () => {
  it('refuses every other principal on every route, with nothing recorded and nothing returned', async () => {
    const person = await registerPerson(ctx);
    const event = await recordOk();
    const before = (await testDb.db.select().from(schema.adverseEvents)).length;
    const outsiders: [string, Record<string, string>][] = [
      ['no credential', {}],
      ['a person', person.headers],
      ['a clinician', as('clinician')],
      ['the crisis line', as('line')],
    ];
    const calls: [string, string, object | undefined][] = [
      ['POST', '/adverse-events', { type: 'wrong_routing', severity: 'low' }],
      ['GET', '/adverse-events', undefined],
      ['POST', `/adverse-events/${event.id}/status`, { to: 'closed' }],
    ];
    for (const [name, headers] of outsiders) {
      for (const [method, url, payload] of calls) {
        const res = await ctx.app.inject({ method: method as 'GET', url, headers, payload });
        expect([401, 403], `${name} ${method} ${url}`).toContain(res.statusCode);
        expect(res.body).not.toContain(event.id);
      }
    }
    expect((await testDb.db.select().from(schema.adverseEvents)).length).toBe(before);
    expect(((await list()).json() as AdverseEventsResponse).items.find((item) => item.id === event.id)!.status).toBe('open');
  });

  it('refuses a route that declares alsoAdmin without being an ops route when the app starts', async () => {
    await expect(
      buildApp({ db: testDb.db, clock: ctx.clock, config: { ...TEST_CONFIG, corsOrigins: [] }, extraRoutes: (app) => app.get('/x', { config: { access: 'clinician', alsoAdmin: true } }, async () => ({})) }),
    ).rejects.toThrow(/alsoAdmin/);
  });
});
