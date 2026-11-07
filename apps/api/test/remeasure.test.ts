import { randomUUID } from 'node:crypto';
import { REMEASURE_DELAY_DAYS } from '@mawsool/rules';
import type { ConsentElement, TicketState } from '@mawsool/types';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import { loadTicketFacts } from '../src/metrics/facts';
import { runSeed } from '../src/seed/run';
import { sweep } from '../src/sweep';
import { remeasureTicket } from '../src/tickets/remeasure';
import { createTestApp, signIn, type TestApp } from './helpers/app';
import { createTestDb, type TestDb } from './helpers/db';
import { ONE_DAY, cipher, eventStates, issue, rawBundle, registerPerson, serviceAt, storedContent, ticketRequest, type TestPerson } from './helpers/flow';

const SIX_WEEKS = REMEASURE_DELAY_DAYS * ONE_DAY;
// The totals a repeat check sends. Their `takenAt` is refreshed to the test clock whenever the clock is set with `at`, since the API accepts a total only from a check taken after the repeat check opened and not after now.
const PHQ = { instrument: 'phq9' as const, total: 7, band: 'mild', takenAt: '2026-12-20T09:00:00+04:00' };
const GAD = { instrument: 'gad7' as const, total: 5, band: 'mild', takenAt: '2026-12-20T09:05:00+04:00' };

describe('the repeat check at six weeks', () => {
  let testDb: TestDb;
  let ctx: TestApp;
  let person: TestPerson;
  let other: TestPerson;
  let gpA: string;
  let specialistB: string;

  beforeAll(async () => {
    testDb = await createTestDb();
    await runSeed(testDb.db);
    ctx = await createTestApp(testDb.db);
    person = await registerPerson(ctx);
    other = await registerPerson(ctx);
    gpA = await serviceAt(testDb.db, 'A', 'gp');
    specialistB = await serviceAt(testDb.db, 'B', 'specialist');
  });

  afterAll(async () => {
    await ctx.app.close();
    await testDb.close();
  });

  // A fresh sign-in each time: these tests move the shared clock by months, and a staff session ends after hours.
  const clinicHeaders = async () => ({ authorization: `Bearer ${await signIn(ctx, 'clinician.a@demo.mawsool.test')}` });
  const asPerson = (id: string, body: object, who: TestPerson = person) => ctx.app.inject({ method: 'POST', url: `/me/tickets/${id}/events`, headers: who.headers, payload: body });
  const asClinic = async (id: string, body: object) => ctx.app.inject({ method: 'POST', url: `/tickets/${id}/events`, headers: await clinicHeaders(), payload: body });
  const remeasure = (id: string, body: object = {}, who: TestPerson = person) => ctx.app.inject({ method: 'POST', url: `/me/tickets/${id}/remeasure`, headers: who.headers, payload: body });
  const stateOf = async (id: string) => (await testDb.db.select({ state: schema.tickets.state }).from(schema.tickets).where(eq(schema.tickets.id, id)))[0]!.state;
  const ledger = (id: string) => testDb.db.select().from(schema.consents).where(eq(schema.consents.ticketId, id)).orderBy(schema.consents.grantedAt, schema.consents.element);

  /** A ticket the clinic marks seen right now, on the test clock. Returns its id and the moment it was seen. */
  async function seen(consents: ConsentElement[] = ['ticket', 'scores', 'free_text'], who: TestPerson = person) {
    const ticket = await issue(ctx, who, ticketRequest(gpA, { consents }));
    expect((await asClinic(ticket.id, { to: 'seen' })).statusCode).toBe(200);
    return { id: ticket.id, seenAt: ctx.clock.now() };
  }
  const at = (seenAt: Date, offsetMs: number) => {
    ctx.clock.set(new Date(seenAt.getTime() + offsetMs));
    PHQ.takenAt = ctx.clock.now().toISOString();
    GAD.takenAt = ctx.clock.now().toISOString();
  };

  describe('a repeat check moves the ticket to remeasured and then to closed', () => {
    it('does both in one request: the person fires remeasured, the system fires closed, on the next two sequence numbers at one moment', async () => {
      const { id, seenAt } = await seen();
      at(seenAt, SIX_WEEKS);
      const res = await remeasure(id);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ state: 'closed', scoresShared: false });
      const events = await eventStates(testDb.db, id);
      expect(events.map((event) => [event.seq, event.from, event.to, event.actor])).toEqual([
        [1, null, 'issued', 'person'],
        [2, 'issued', 'seen', 'clinic'],
        [3, 'seen', 'remeasured', 'person'],
        [4, 'remeasured', 'closed', 'system'],
      ]);
      expect(await stateOf(id)).toBe('closed');
      const rows = await testDb.db.select({ at: schema.ticketEvents.at, seq: schema.ticketEvents.seq }).from(schema.ticketEvents).where(eq(schema.ticketEvents.ticketId, id));
      expect(new Set(rows.filter((row) => row.seq >= 3).map((row) => row.at.getTime()))).toEqual(new Set([ctx.clock.now().getTime()]));
      expect(res.json().events.map((event: { toState: string }) => event.toState)).toEqual(['remeasured', 'closed']);
    });

    it('is open to the millisecond: one before six weeks after the seen event is refused (409) and changes nothing, and the exact moment is accepted', async () => {
      const { id, seenAt } = await seen();
      const before = await eventStates(testDb.db, id);
      at(seenAt, SIX_WEEKS - 1);
      const early = await remeasure(id, { scores: [PHQ, GAD] });
      expect(early.statusCode).toBe(409);
      expect(early.json().error).toBe('too_early');
      expect(await eventStates(testDb.db, id)).toEqual(before);
      expect(await stateOf(id)).toBe('seen');
      expect((await storedContent(testDb.db, id))!.scores).toHaveLength(1); // the totals sent with a refused request went nowhere
      at(seenAt, SIX_WEEKS);
      expect((await remeasure(id)).statusCode).toBe(200);
    });

    it('counts the six weeks from the seen event, not from the issue date', async () => {
      const ticket = await issue(ctx, person, ticketRequest(gpA));
      ctx.clock.advance(30 * ONE_DAY);
      expect((await asClinic(ticket.id, { to: 'seen' })).statusCode).toBe(200);
      const seenAt = ctx.clock.now();
      at(seenAt, 20 * ONE_DAY); // 50 days after issue, 20 after seen
      expect((await remeasure(ticket.id)).statusCode).toBe(409);
      at(seenAt, SIX_WEEKS);
      expect((await remeasure(ticket.id)).statusCode).toBe(200);
    });

    it('counts from the late `seen` of a ticket that went overdue first', async () => {
      const ticket = await issue(ctx, person, ticketRequest(gpA, { windowDays: 7 }));
      ctx.clock.advance(10 * ONE_DAY);
      await sweep(testDb.db, ctx.clock);
      expect(await stateOf(ticket.id)).toBe('overdue');
      expect((await asClinic(ticket.id, { to: 'seen' })).statusCode).toBe(200);
      const seenAt = ctx.clock.now();
      at(seenAt, SIX_WEEKS - 1);
      expect((await remeasure(ticket.id)).statusCode).toBe(409);
      at(seenAt, SIX_WEEKS);
      expect((await remeasure(ticket.id)).statusCode).toBe(200);
    });

    it('refuses a second repeat check on a ticket that is already closed, and records nothing', async () => {
      const { id, seenAt } = await seen();
      at(seenAt, SIX_WEEKS);
      expect((await remeasure(id)).statusCode).toBe(200);
      const after = await eventStates(testDb.db, id);
      expect((await remeasure(id)).statusCode).toBe(409);
      expect(await eventStates(testDb.db, id)).toEqual(after);
    });

    it('lets exactly one of two simultaneous requests through', async () => {
      const { id, seenAt } = await seen();
      at(seenAt, SIX_WEEKS);
      const responses = await Promise.all([remeasure(id), remeasure(id)]);
      expect(responses.map((res) => res.statusCode).sort()).toEqual([200, 409]);
      expect((await eventStates(testDb.db, id)).map((event) => event.to)).toEqual(['issued', 'seen', 'remeasured', 'closed']);
    });

    it('rolls the whole move back, the first event and the shared totals with it, when a rival takes the second sequence number', async () => {
      const { id, seenAt } = await seen(['ticket', 'free_text']);
      at(seenAt, SIX_WEEKS);
      const [row] = await testDb.db.select({ personId: schema.tickets.personId }).from(schema.tickets).where(eq(schema.tickets.id, id));
      const bundleBefore = (await rawBundle(testDb.db, id)).contentCiphertext;
      const ledgerBefore = await ledger(id);
      const outcome = await remeasureTicket(
        { db: testDb.db, cipher, clock: ctx.clock },
        { id, personId: row!.personId },
        { scores: [PHQ, GAD] },
        {
          // Claims sequence number 4 after the request read the ticket, so its `closed` event loses.
          afterRead: async () => {
            await testDb.db.insert(schema.ticketEvents).values({ ticketId: id, seq: 4, fromState: 'seen', toState: 'seen', actor: 'clinic', channel: 'rival', reason: 'other', at: ctx.clock.now() });
          },
        },
      );
      expect(outcome.kind).toBe('lost_race');
      expect((await eventStates(testDb.db, id)).map((event) => event.seq)).toEqual([1, 2, 4]);
      expect(await stateOf(id)).toBe('seen');
      expect((await rawBundle(testDb.db, id)).contentCiphertext).toBe(bundleBefore);
      expect(await ledger(id)).toEqual(ledgerBefore);
    });
  });

  describe('is refused from every state but seen', () => {
    const clinicAt = async (id: string, to: string) => expect((await asClinic(id, { to })).statusCode).toBe(200);
    const setups: Record<string, () => Promise<string>> = {
      issued: async () => (await issue(ctx, person, ticketRequest(gpA))).id,
      acknowledged: async () => {
        const ticket = await issue(ctx, person, ticketRequest(gpA));
        await clinicAt(ticket.id, 'acknowledged');
        return ticket.id;
      },
      overdue: async () => {
        const ticket = await issue(ctx, person, ticketRequest(gpA, { windowDays: 7 }));
        ctx.clock.advance(10 * ONE_DAY);
        await sweep(testDb.db, ctx.clock);
        return ticket.id;
      },
      declined: async () => {
        const ticket = await issue(ctx, person, ticketRequest(gpA));
        expect((await asPerson(ticket.id, { to: 'declined' })).statusCode).toBe(200);
        return ticket.id;
      },
      withdrawn: async () => {
        const ticket = await issue(ctx, person, ticketRequest(gpA));
        await clinicAt(ticket.id, 'seen');
        expect((await asPerson(ticket.id, { to: 'withdrawn' })).statusCode).toBe(200);
        return ticket.id;
      },
      rerouted: async () => {
        const ticket = await issue(ctx, person, ticketRequest(gpA));
        const res = await ctx.app.inject({ method: 'POST', url: `/me/tickets/${ticket.id}/reroute`, headers: person.headers, payload: { ...ticketRequest(specialistB), reason: 'cost' } });
        expect(res.statusCode).toBe(201);
        return ticket.id;
      },
      closed: async () => {
        const ticket = await seen();
        expect((await asPerson(ticket.id, { to: 'closed' })).statusCode).toBe(200);
        return ticket.id;
      },
    };

    it.each(Object.keys(setups))('a ticket that is %s answers 409 to a repeat check, a year on, and records nothing', async (state) => {
      const id = await setups[state]!();
      ctx.clock.advance(400 * ONE_DAY);
      const before = await eventStates(testDb.db, id);
      const res = await remeasure(id, { scores: [PHQ] });
      expect(res.statusCode).toBe(409);
      expect(await eventStates(testDb.db, id)).toEqual(before);
    });

    it('answers 409 to a ticket stuck in remeasured too (state only the seed can make), since only seen allows it', async () => {
      const { id, seenAt } = await seen();
      await testDb.db.insert(schema.ticketEvents).values({ ticketId: id, seq: 3, fromState: 'seen', toState: 'remeasured', actor: 'person', channel: 'app', at: seenAt });
      await testDb.db.update(schema.tickets).set({ state: 'remeasured' }).where(eq(schema.tickets.id, id));
      at(seenAt, 2 * SIX_WEEKS);
      expect((await remeasure(id)).statusCode).toBe(409);
      expect((await eventStates(testDb.db, id)).map((event) => event.seq)).toEqual([1, 2, 3]);
    });
  });

  describe('nothing else can fire remeasured or closed', () => {
    it('refuses the person\'s plain remeasured event even after six weeks, so the wait and the closing step cannot be skipped', async () => {
      const { id, seenAt } = await seen();
      at(seenAt, 3 * SIX_WEEKS);
      const before = await eventStates(testDb.db, id);
      expect((await asPerson(id, { to: 'remeasured' })).statusCode).toBe(409);
      expect(await eventStates(testDb.db, id)).toEqual(before);
    });

    it('answers 403 to the clinic firing remeasured or closed on a seen ticket, and 409 from other states', async () => {
      const { id } = await seen();
      for (const to of ['remeasured', 'closed']) expect((await asClinic(id, { to })).statusCode, to).toBe(403);
      expect((await eventStates(testDb.db, id)).map((event) => event.to)).toEqual(['issued', 'seen']);
      const waiting = await issue(ctx, person, ticketRequest(gpA));
      for (const to of ['remeasured', 'closed']) expect((await asClinic(waiting.id, { to })).statusCode, to).toBe(409);
    });

    it('is the person\'s alone: another person gets 404 and a clinic or ops session cannot reach the route', async () => {
      const { id, seenAt } = await seen();
      at(seenAt, SIX_WEEKS);
      expect((await remeasure(id, {}, other)).statusCode).toBe(404);
      for (const headers of [{}, await clinicHeaders(), { authorization: `Bearer ${await signIn(ctx, 'ops@demo.mawsool.test')}` }]) {
        const res = await ctx.app.inject({ method: 'POST', url: `/me/tickets/${id}/remeasure`, headers, payload: {} });
        expect([401, 403], JSON.stringify(headers)).toContain(res.statusCode);
      }
      expect(await stateOf(id)).toBe('seen');
    });

    it('refuses a body with a third total, a repeated or other instrument, an item answer or an unknown field (400), and moves nothing', async () => {
      const { id, seenAt } = await seen();
      at(seenAt, SIX_WEEKS);
      const bodies = [
        { scores: [PHQ, GAD, PHQ] },
        { scores: [PHQ, { ...PHQ, total: 9 }] },
        { scores: [{ ...PHQ, instrument: 'who5' }] },
        { scores: [{ ...PHQ, answers: [1, 1, 1, 1, 1, 1, 1, 1, 1] }] },
        { scores: [{ ...PHQ, total: 101 }] },
        { scores: [PHQ], extra: true },
      ];
      for (const body of bodies) expect((await remeasure(id, body)).statusCode, JSON.stringify(body)).toBe(400);
      expect(await stateOf(id)).toBe('seen');
    });
  });

  describe('the person ending the ticket', () => {
    it('moves seen to closed with the person as actor, with no repeat check recorded', async () => {
      const { id } = await seen();
      const res = await asPerson(id, { to: 'closed' });
      expect(res.statusCode).toBe(200);
      expect(res.json().state).toBe('closed');
      expect((await eventStates(testDb.db, id)).map((event) => [event.from, event.to, event.actor])).toEqual([
        [null, 'issued', 'person'],
        ['issued', 'seen', 'clinic'],
        ['seen', 'closed', 'person'],
      ]);
    });

    it('is open at any time while the ticket is seen, before the six weeks as well', async () => {
      const { id } = await seen();
      expect(await stateOf(id)).toBe('seen');
      expect((await asPerson(id, { to: 'closed' })).statusCode).toBe(200);
    });

    it('is refused from every other state (409), and for another person\'s ticket (404)', async () => {
      const waiting = await issue(ctx, person, ticketRequest(gpA));
      expect((await asPerson(waiting.id, { to: 'closed' })).statusCode).toBe(409);
      const { id } = await seen();
      expect((await asPerson(id, { to: 'closed' }, other)).statusCode).toBe(404);
      expect((await asPerson(id, { to: 'closed' })).statusCode).toBe(200);
      expect((await asPerson(id, { to: 'closed' })).statusCode).toBe(409);
    });
  });

  describe('a sweep leaves a seen ticket unchanged', () => {
    it('before six weeks, at six weeks, and long after the clock has moved past them', async () => {
      const { id, seenAt } = await seen();
      const before = await eventStates(testDb.db, id);
      for (const offset of [ONE_DAY, SIX_WEEKS - 1, SIX_WEEKS, SIX_WEEKS + ONE_DAY, 5 * SIX_WEEKS]) {
        at(seenAt, offset);
        await sweep(testDb.db, ctx.clock);
        expect(await stateOf(id)).toBe('seen');
        expect(await eventStates(testDb.db, id)).toEqual(before);
      }
    });
  });

  describe('sending the new totals is the person\'s choice, recorded in the consent ledger', () => {
    it('sends nothing when the box is not ticked: the stored bundle is byte for byte what it was, the ledger is the same, and the state still moves', async () => {
      const { id, seenAt } = await seen();
      const bundleBefore = await rawBundle(testDb.db, id);
      const ledgerBefore = await ledger(id);
      at(seenAt, SIX_WEEKS);
      const res = await remeasure(id, { scores: [] });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ state: 'closed', scoresShared: false });
      expect(await rawBundle(testDb.db, id)).toEqual(bundleBefore);
      expect(await ledger(id)).toEqual(ledgerBefore);
    });

    it('adds the totals to the shared scores when scores are already shared, without a second ledger row, and the clinic reads them', async () => {
      const { id, seenAt } = await seen(['ticket', 'scores']);
      const ledgerBefore = await ledger(id);
      at(seenAt, SIX_WEEKS);
      const res = await remeasure(id, { scores: [PHQ, GAD] });
      expect(res.statusCode).toBe(200);
      expect(res.json().scoresShared).toBe(true);
      expect(await ledger(id)).toEqual(ledgerBefore);
      const stored = await storedContent(testDb.db, id);
      expect((stored!.scores as { instrument: string; total: number }[]).map((score) => [score.instrument, score.total])).toEqual([['phq9', 12], ['phq9', 7], ['gad7', 5]]);
      const read = await ctx.app.inject({ method: 'GET', url: `/tickets/${id}/bundle`, headers: await clinicHeaders() });
      expect(read.statusCode).toBe(200);
      expect(read.json().content.scores).toHaveLength(3);
    });

    it('records a new ledger row for scores when they were not shared, stores the totals encrypted, and the clinic reads only those', async () => {
      const { id, seenAt } = await seen(['ticket', 'free_text']);
      expect((await ledger(id)).map((row) => row.element).sort()).toEqual(['free_text', 'ticket']);
      at(seenAt, SIX_WEEKS);
      const res = await remeasure(id, { scores: [PHQ, GAD] });
      expect(res.statusCode).toBe(200);
      const rows = await ledger(id);
      expect(rows.map((row) => [row.element, row.revokedAt])).toEqual(expect.arrayContaining([['scores', null]]));
      const granted = rows.find((row) => row.element === 'scores')!;
      expect(granted.grantedAt.getTime()).toBe(ctx.clock.now().getTime());
      expect(granted.personId).toBe(person.id);
      const bundle = await rawBundle(testDb.db, id);
      expect(bundle.contentCiphertext).not.toContain('phq9');
      expect((await storedContent(testDb.db, id))!.scores).toEqual([PHQ, GAD]);
      const read = await ctx.app.inject({ method: 'GET', url: `/tickets/${id}/bundle`, headers: await clinicHeaders() });
      expect(read.json().content.scores).toEqual([PHQ, GAD]);
      expect(read.json().notShared).not.toContain('scores');
    });

    it('asks again by the tick after the person stopped sharing scores: a new ledger row, the old revoked one kept', async () => {
      const { id, seenAt } = await seen(['ticket', 'scores']);
      const ticketView = await ctx.app.inject({ method: 'GET', url: `/me/tickets/${id}`, headers: person.headers });
      const scoresConsent = ticketView.json().consents.find((consent: { element: string }) => consent.element === 'scores');
      expect((await ctx.app.inject({ method: 'DELETE', url: `/consents/${scoresConsent.id}`, headers: person.headers })).statusCode).toBe(200);
      at(seenAt, SIX_WEEKS);
      expect((await remeasure(id, { scores: [PHQ] })).statusCode).toBe(200);
      const rows = (await ledger(id)).filter((row) => row.element === 'scores');
      expect(rows.map((row) => row.revokedAt !== null)).toEqual([true, false]);
      expect((await storedContent(testDb.db, id))!.scores).toEqual([PHQ]);
    });

    it('stopping sharing scores afterwards takes the new totals out of the stored bundle and the clinic\'s read', async () => {
      const { id, seenAt } = await seen(['ticket', 'free_text']);
      at(seenAt, SIX_WEEKS);
      await remeasure(id, { scores: [PHQ, GAD] });
      const granted = (await ledger(id)).find((row) => row.element === 'scores')!;
      expect((await ctx.app.inject({ method: 'DELETE', url: `/consents/${granted.id}`, headers: person.headers })).statusCode).toBe(200);
      expect((await storedContent(testDb.db, id))!.scores).toBeUndefined();
      const read = await ctx.app.inject({ method: 'GET', url: `/tickets/${id}/bundle`, headers: await clinicHeaders() });
      expect(read.json().content.scores).toBeUndefined();
      expect(read.body).not.toContain('"total":7');
    });

    it('ending the share after the totals were sent (withdrawing) takes them out of the raw bundle, and the clinic reads 410', async () => {
      const { id, seenAt } = await seen(['ticket', 'scores']);
      at(seenAt, SIX_WEEKS);
      expect((await remeasure(id, { scores: [PHQ, GAD] })).statusCode).toBe(200);
      expect((await storedContent(testDb.db, id))!.scores).toHaveLength(3);
      const ticketConsent = (await ledger(id)).find((row) => row.element === 'ticket')!;
      expect((await ctx.app.inject({ method: 'DELETE', url: `/consents/${ticketConsent.id}`, headers: person.headers })).statusCode).toBe(200);
      const bundle = await rawBundle(testDb.db, id);
      expect(bundle).toMatchObject({ contentCiphertext: null, approvedSummaryCiphertext: null });
      expect(bundle.deletedAt).not.toBeNull();
      expect(await storedContent(testDb.db, id)).toBeNull();
      expect((await ctx.app.inject({ method: 'GET', url: `/tickets/${id}/bundle`, headers: await clinicHeaders() })).statusCode).toBe(410);
      expect(await stateOf(id)).toBe('closed'); // the data goes, a terminal state stays
    });

    it('Delete everything after the totals were sent empties both ciphertext columns, and the clinic reads 410', async () => {
      const { id, seenAt } = await seen(['ticket', 'scores']);
      at(seenAt, SIX_WEEKS);
      await remeasure(id, { scores: [PHQ, GAD] });
      expect((await ctx.app.inject({ method: 'DELETE', url: '/me/data', headers: person.headers })).statusCode).toBe(200);
      const bundle = await rawBundle(testDb.db, id);
      expect(bundle).toMatchObject({ contentCiphertext: null, approvedSummaryCiphertext: null });
      expect(bundle.deletedAt).not.toBeNull();
      expect((await ctx.app.inject({ method: 'GET', url: `/tickets/${id}/bundle`, headers: await clinicHeaders() })).statusCode).toBe(410);
      expect(await stateOf(id)).toBe('closed'); // the data goes, a terminal state stays
    });

    it('refuses a total taken before the repeat check opened, or dated after now (400), and writes no event, no ledger row and no bundle change', async () => {
      const { id, seenAt } = await seen(['ticket', 'free_text']);
      at(seenAt, SIX_WEEKS);
      const opens = ctx.clock.now().getTime();
      const bundleBefore = (await rawBundle(testDb.db, id)).contentCiphertext;
      const ledgerBefore = await ledger(id);
      const eventsBefore = await eventStates(testDb.db, id);
      const stamps = [new Date(opens - 1), new Date(seenAt.getTime()), new Date('2020-01-01T00:00:00Z'), new Date(opens + 1)];
      for (const takenAt of stamps) {
        const res = await remeasure(id, { scores: [{ ...PHQ, takenAt: takenAt.toISOString() }] });
        expect(res.statusCode, takenAt.toISOString()).toBe(400);
      }
      // One good total and one early one: the whole request is refused.
      expect((await remeasure(id, { scores: [PHQ, { ...GAD, takenAt: new Date(opens - 1).toISOString() }] })).statusCode).toBe(400);
      expect(await eventStates(testDb.db, id)).toEqual(eventsBefore);
      expect(await ledger(id)).toEqual(ledgerBefore);
      expect((await rawBundle(testDb.db, id)).contentCiphertext).toBe(bundleBefore);
      expect(await stateOf(id)).toBe('seen');
      // Exactly when the repeat check opened is the earliest accepted, and now the latest.
      expect((await remeasure(id, { scores: [{ ...PHQ, takenAt: new Date(opens).toISOString() }] })).statusCode).toBe(200);
    });

    it('answers 409 and moves nothing when the stored totals leave no room for the new ones; without totals the move still works', async () => {
      const { id, seenAt } = await seen(['ticket', 'scores']);
      const four = Array.from({ length: 4 }, (_, index) => ({ instrument: 'phq9' as const, total: index, band: 'minimal', takenAt: '2026-10-29T08:00:00+04:00' }));
      await testDb.db
        .update(schema.sharedBundles)
        .set({ contentCiphertext: cipher.encrypt(JSON.stringify({ scores: four }), `bundle:${id}`) })
        .where(eq(schema.sharedBundles.ticketId, id));
      at(seenAt, SIX_WEEKS);
      const bundleBefore = (await rawBundle(testDb.db, id)).contentCiphertext;
      const eventsBefore = await eventStates(testDb.db, id);
      const refused = await remeasure(id, { scores: [PHQ, GAD] });
      expect(refused.statusCode).toBe(409);
      expect(await eventStates(testDb.db, id)).toEqual(eventsBefore);
      expect((await rawBundle(testDb.db, id)).contentCiphertext).toBe(bundleBefore);
      expect((await remeasure(id, { scores: [] })).statusCode).toBe(200);
    });

    it('refuses a referral, a consent or a summary draft that carries more than three totals (400), though a stored bundle can hold five', async () => {
      const total = (instrument: 'who5' | 'phq9' | 'gad7', takenAt: string) => ({ instrument, total: 3, band: 'mild', takenAt });
      const four = [total('who5', '2026-10-01T08:00:00+04:00'), total('phq9', '2026-10-02T08:00:00+04:00'), total('gad7', '2026-10-03T08:00:00+04:00'), total('phq9', '2026-10-04T08:00:00+04:00')];
      const ticketsBefore = (await testDb.db.select({ id: schema.tickets.id }).from(schema.tickets)).length;
      const res = await ctx.app.inject({ method: 'POST', url: '/tickets', headers: person.headers, payload: ticketRequest(gpA, { content: { scores: four } }) });
      expect(res.statusCode).toBe(400);
      expect((await testDb.db.select({ id: schema.tickets.id }).from(schema.tickets)).length).toBe(ticketsBefore);
      expect((await ctx.app.inject({ method: 'POST', url: '/tickets', headers: person.headers, payload: ticketRequest(gpA, { content: { scores: four.slice(0, 3) } }) })).statusCode).toBe(201);

      const { id } = await seen(['ticket', 'free_text']);
      const grant = await ctx.app.inject({ method: 'POST', url: '/consents', headers: person.headers, payload: { ticketId: id, element: 'scores', content: { scores: four } } });
      expect(grant.statusCode).toBe(400);
      const draft = await ctx.app.inject({ method: 'POST', url: '/summary/draft', headers: person.headers, payload: { requestId: randomUUID(), locale: 'en', useAi: false, consented: ['scores'], content: { scores: four } } });
      expect(draft.statusCode).toBe(400);
    });

    it('answers 409 and moves nothing when totals are sent but nothing is shared for the ticket any more; without totals the move still works', async () => {
      const first = await seen();
      await testDb.db.delete(schema.sharedBundles).where(eq(schema.sharedBundles.ticketId, first.id));
      at(first.seenAt, SIX_WEEKS);
      const before = await eventStates(testDb.db, first.id);
      const refused = await remeasure(first.id, { scores: [PHQ] });
      expect(refused.statusCode).toBe(409);
      expect(await eventStates(testDb.db, first.id)).toEqual(before);
      expect(await ledger(first.id)).toHaveLength(3);
      expect((await remeasure(first.id, { scores: [] })).statusCode).toBe(200);
      expect(await stateOf(first.id)).toBe('closed');
    });
  });

  describe('the metrics', () => {
    it('count a repeat check as reaching remeasured and seen, and a ticket the person ended from seen as seen but not remeasured', async () => {
      const repeated = await seen();
      const ended = await seen();
      at(repeated.seenAt, SIX_WEEKS);
      expect((await remeasure(repeated.id)).statusCode).toBe(200);
      expect((await asPerson(ended.id, { to: 'closed' })).statusCode).toBe(200);
      const facts = new Map((await loadTicketFacts(testDb.db)).map((fact) => [fact.id, fact]));
      expect(facts.get(repeated.id)).toMatchObject({ seen: true, remeasured: true, state: 'closed' });
      expect(facts.get(ended.id)).toMatchObject({ seen: true, remeasured: false, state: 'closed' });
    });
  });

  it('uses an unknown ticket id as a 404', async () => {
    expect((await remeasure(randomUUID())).statusCode).toBe(404);
  });

  it('keeps the cached state of every ticket this suite touched equal to its last event\'s', async () => {
    const rows = await testDb.db.select({ id: schema.tickets.id, state: schema.tickets.state }).from(schema.tickets);
    for (const row of rows) {
      const events = await eventStates(testDb.db, row.id);
      if (events.length > 0) expect(events.at(-1)!.to as TicketState, row.id).toBe(row.state);
    }
  });
});
