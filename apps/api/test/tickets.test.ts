import { computeDeadline } from '@mawsool/rules';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import { runSeed } from '../src/seed/run';
import { sweep } from '../src/sweep';
import { issueTicket } from '../src/tickets/service';
import { createTestApp, signIn, type TestApp } from './helpers/app';
import { createTestDb, type TestDb } from './helpers/db';
import { CONDITION, FREE_TEXT, cipher, ONE_DAY, eventStates, issue, rawBundle, registerPerson, serviceAt, storedContent, ticketRequest, type TestPerson } from './helpers/flow';

const CLINICIAN_A = 'clinician.a@demo.mawsool.test';
const CLINICIAN_B = 'clinician.b@demo.mawsool.test';

describe('tickets', () => {
  let testDb: TestDb;
  let ctx: TestApp;
  let gpA: string;
  let specialistB: string;
  let tokenA: string;
  let tokenB: string;
  let person: TestPerson;
  let other: TestPerson;

  beforeAll(async () => {
    testDb = await createTestDb();
    await runSeed(testDb.db, testDb.cipher);
    ctx = await createTestApp(testDb.db);
    gpA = await serviceAt(testDb.db, 'A', 'gp');
    specialistB = await serviceAt(testDb.db, 'B', 'specialist');
    tokenA = await signIn(ctx, CLINICIAN_A);
    tokenB = await signIn(ctx, CLINICIAN_B);
    person = await registerPerson(ctx);
    other = await registerPerson(ctx);
  });

  afterAll(async () => {
    await ctx.app.close();
    await testDb.close();
  });

  const post = (url: string, headers: Record<string, string>, payload: unknown) => ctx.app.inject({ method: 'POST', url, headers, payload: payload as object });
  const staff = (token: string) => ({ authorization: `Bearer ${token}` });
  const count = async (table: typeof schema.tickets | typeof schema.consents | typeof schema.sharedBundles | typeof schema.ticketEvents) => (await testDb.db.select().from(table)).length;

  describe('issuing', () => {
    it('writes the ticket, its first event, one consent per element and an encrypted bundle, and returns the code, QR and deadline', async () => {
      const request = ticketRequest(gpA);
      const res = await post('/tickets', person.headers, request);
      expect(res.statusCode).toBe(201);
      const { created, ticket } = res.json();
      expect(created).toBe(true);
      expect(ticket).toMatchObject({ state: 'issued', tier: 'gp', source: 'app', parentTicketId: null, qrPayload: `MAWSOOL:TICKET:${ticket.shortCode}` });
      expect(ticket.shortCode).toMatch(/^MW[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/);
      expect(ticket.deadlineAt).toBe(computeDeadline(ctx.clock.now(), 14).toISOString());
      expect(ticket.events).toEqual([expect.objectContaining({ seq: 1, fromState: null, toState: 'issued', actor: 'person' })]);
      expect(ticket.consents.map((consent: { element: string }) => consent.element).sort()).toEqual(['free_text', 'scores', 'ticket']);
      expect(ticket.clinicName).toBeTruthy();
      expect(ticket.clinicContact).toBeTruthy();
      const stored = await rawBundle(testDb.db, ticket.id);
      expect(stored.recipient).toBe(gpA);
      expect(await storedContent(testDb.db, ticket.id)).toEqual({ scores: request.content.scores, free_text: FREE_TEXT });
    });

    it('keeps out of the stored bundle every element that was not consented to, even when the request carries it', async () => {
      const ticket = await issue(ctx, person, ticketRequest(gpA, { consents: ['ticket'] }));
      expect(await storedContent(testDb.db, ticket.id)).toEqual({});
      const raw = JSON.stringify(await rawBundle(testDb.db, ticket.id));
      expect(raw).not.toContain(FREE_TEXT);
      expect(raw).not.toContain(CONDITION);
    });

    it('returns the same ticket for a replayed request id and writes nothing more', async () => {
      const request = ticketRequest(gpA);
      const first = await post('/tickets', person.headers, request);
      const before = [await count(schema.tickets), await count(schema.consents), await count(schema.sharedBundles), await count(schema.ticketEvents)];
      const again = await post('/tickets', person.headers, request);
      expect(again.statusCode).toBe(200);
      expect(again.json().created).toBe(false);
      expect(again.json().ticket.id).toBe(first.json().ticket.id);
      expect([await count(schema.tickets), await count(schema.consents), await count(schema.sharedBundles), await count(schema.ticketEvents)]).toEqual(before);
      const rows = await testDb.db.select().from(schema.tickets).where(eq(schema.tickets.clientRequestId, request.clientRequestId));
      expect(rows).toHaveLength(1);
    });

    it('makes one ticket from two requests with the same id that arrive together', async () => {
      const request = ticketRequest(gpA);
      const [a, b] = await Promise.all([post('/tickets', person.headers, request), post('/tickets', person.headers, request)]);
      expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201]);
      expect(a.json().ticket.id).toBe(b.json().ticket.id);
      expect(await testDb.db.select().from(schema.tickets).where(eq(schema.tickets.clientRequestId, request.clientRequestId))).toHaveLength(1);
    });

    it('refuses a request id that another person already used, and leaks nothing about that ticket', async () => {
      const request = ticketRequest(gpA);
      await issue(ctx, person, request);
      const res = await post('/tickets', other.headers, request);
      expect(res.statusCode).toBe(409);
      expect(res.body).not.toMatch(/MW[A-Z0-9]{4}/);
    });

    it.each([
      ['no ticket element', { consents: ['scores'] }],
      ['a window the rules do not offer', { windowDays: 9 }],
      ['a summary over 120 words', { approvedSummary: Array(121).fill('word').join(' ') }],
      ['an unknown content key', { content: { diagnosis: 'x' } }],
    ])('refuses (400) a request with %s and stores nothing', async (_name, overrides) => {
      const before = await count(schema.tickets);
      const res = await post('/tickets', person.headers, ticketRequest(gpA, overrides as never));
      expect(res.statusCode).toBe(400);
      expect(await count(schema.tickets)).toBe(before);
    });

    it('refuses a self-help service and a service that does not exist', async () => {
      const [selfHelp] = await testDb.db.select().from(schema.services).where(eq(schema.services.tier, 'self_help')).limit(1);
      expect((await post('/tickets', person.headers, ticketRequest(selfHelp!.id))).statusCode).toBe(400);
      expect((await post('/tickets', person.headers, ticketRequest('00000000-0000-4000-8000-000000000001'))).statusCode).toBe(400);
    });

    it('needs a device credential: no credential and a staff session are both 401', async () => {
      expect((await post('/tickets', {}, ticketRequest(gpA))).statusCode).toBe(401);
      expect((await post('/tickets', staff(tokenA), ticketRequest(gpA))).statusCode).toBe(401);
    });
  });

  describe('who can see or move a ticket', () => {
    it('answers 404 to another person for a ticket, its events, its reads and a reroute, and changes nothing', async () => {
      const ticket = await issue(ctx, person, ticketRequest(gpA));
      const before = await eventStates(testDb.db, ticket.id);
      expect((await ctx.app.inject({ method: 'GET', url: `/me/tickets/${ticket.id}`, headers: other.headers })).statusCode).toBe(404);
      expect((await ctx.app.inject({ method: 'GET', url: `/me/tickets/${ticket.id}/reads`, headers: other.headers })).statusCode).toBe(404);
      expect((await post(`/me/tickets/${ticket.id}/events`, other.headers, { to: 'declined' })).statusCode).toBe(404);
      expect((await post(`/me/tickets/${ticket.id}/reroute`, other.headers, { ...ticketRequest(specialistB), reason: 'cost' })).statusCode).toBe(404);
      expect(await eventStates(testDb.db, ticket.id)).toEqual(before);
      const mine = await ctx.app.inject({ method: 'GET', url: '/me/tickets', headers: other.headers });
      expect(mine.json()).toEqual([]);
    });

    it('lists only the caller’s tickets, oldest first', async () => {
      const fresh = await registerPerson(ctx);
      const first = await issue(ctx, fresh, ticketRequest(gpA));
      ctx.clock.advance(1000);
      const second = await issue(ctx, fresh, ticketRequest(gpA));
      const res = await ctx.app.inject({ method: 'GET', url: '/me/tickets', headers: fresh.headers });
      expect(res.json().map((ticket: { id: string }) => ticket.id)).toEqual([first.id, second.id]);
    });

    it('answers 403 to a person who sends a clinic-only event, and leaves the ticket as it was', async () => {
      const ticket = await issue(ctx, person, ticketRequest(gpA));
      const res = await post(`/me/tickets/${ticket.id}/events`, person.headers, { to: 'acknowledged' });
      expect(res.statusCode).toBe(403);
      expect(await eventStates(testDb.db, ticket.id)).toHaveLength(1);
    });

    it('answers 409 to a forged transition that the table does not have, for every route that moves state', async () => {
      const ticket = await issue(ctx, person, ticketRequest(gpA));
      const before = await count(schema.tickets);
      for (const to of ['closed', 'remeasured']) expect((await post(`/me/tickets/${ticket.id}/events`, person.headers, { to })).statusCode, to).toBe(409);
      expect((await post(`/tickets/${ticket.id}/events`, staff(tokenA), { to: 'closed' })).statusCode).toBe(409);
      expect(await eventStates(testDb.db, ticket.id)).toHaveLength(1);
      expect(await count(schema.tickets)).toBe(before);
    });

    it('refuses a person’s own `rerouted` event, so only the reroute route fires it: no state change, no child, no consent', async () => {
      const ticket = await issue(ctx, person, ticketRequest(gpA));
      const before = [await count(schema.tickets), await count(schema.consents)];
      const res = await post(`/me/tickets/${ticket.id}/events`, person.headers, { to: 'rerouted' });
      expect(res.statusCode).toBe(409);
      expect(await eventStates(testDb.db, ticket.id)).toHaveLength(1);
      expect([await count(schema.tickets), await count(schema.consents)]).toEqual(before);
    });

    it('answers 409, and records nothing, to a move to the state the ticket is already in, so a repeated acknowledge is refused', async () => {
      const ticket = await issue(ctx, person, ticketRequest(gpA));
      expect((await post(`/tickets/${ticket.id}/events`, staff(tokenA), { to: 'acknowledged' })).statusCode).toBe(200);
      expect((await post(`/tickets/${ticket.id}/events`, staff(tokenA), { to: 'acknowledged' })).statusCode).toBe(409);
      expect(await eventStates(testDb.db, ticket.id)).toHaveLength(2);
    });

    it('lets a clinician at the right facility acknowledge and mark seen, and never at another facility', async () => {
      const ticket = await issue(ctx, person, ticketRequest(gpA));
      expect((await post(`/tickets/${ticket.id}/events`, staff(tokenB), { to: 'acknowledged' })).statusCode).toBe(404);
      const ack = await post(`/tickets/${ticket.id}/events`, staff(tokenA), { to: 'acknowledged' });
      expect(ack.statusCode).toBe(200);
      expect(ack.json()).toMatchObject({ state: 'acknowledged', event: { actor: 'clinic', selfConfirmed: false } });
      expect((await post(`/tickets/${ticket.id}/events`, staff(tokenA), { to: 'declined' })).statusCode).toBe(403);
      const seen = await post(`/tickets/${ticket.id}/events`, staff(tokenA), { to: 'seen' });
      expect(seen.json()).toMatchObject({ state: 'seen', event: { actor: 'clinic', selfConfirmed: false } });
    });

    it('moves an issued ticket to seen on the person’s day-7 yes, as a self-confirmation', async () => {
      const ticket = await issue(ctx, person, ticketRequest(gpA));
      const res = await post(`/me/tickets/${ticket.id}/events`, person.headers, { to: 'seen', selfConfirmed: false });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ state: 'seen', event: { fromState: 'issued', toState: 'seen', actor: 'person', selfConfirmed: true } });
      const [row] = await testDb.db.select({ state: schema.tickets.state }).from(schema.tickets).where(eq(schema.tickets.id, ticket.id));
      expect(row!.state).toBe('seen');
    });

    it('accepts "unable to see" from a clinic with a reason from the fixed list and leaves the state alone', async () => {
      const ticket = await issue(ctx, person, ticketRequest(gpA));
      const res = await post(`/tickets/${ticket.id}/events`, staff(tokenA), { unable: true, reason: 'could_not_reach' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ state: 'issued', event: { seq: 2, fromState: 'issued', toState: 'issued', actor: 'clinic', reason: 'could_not_reach' } });
    });

    it('refuses "unable to see" without a reason, with free text, from a person, or where a reroute is not possible', async () => {
      const ticket = await issue(ctx, person, ticketRequest(gpA));
      expect((await post(`/tickets/${ticket.id}/events`, staff(tokenA), { unable: true })).statusCode).toBe(400);
      expect((await post(`/tickets/${ticket.id}/events`, staff(tokenA), { unable: true, reason: 'The person could not be reached' })).statusCode).toBe(400);
      expect((await post(`/me/tickets/${ticket.id}/events`, person.headers, { unable: true, reason: 'other' })).statusCode).toBe(403);
      expect(await eventStates(testDb.db, ticket.id)).toHaveLength(1);
      await post(`/me/tickets/${ticket.id}/events`, person.headers, { to: 'seen' });
      expect((await post(`/tickets/${ticket.id}/events`, staff(tokenA), { unable: true, reason: 'other' })).statusCode).toBe(409);
    });

    it('accepts no reason on an ordinary move, so no free text reaches the event log', async () => {
      const ticket = await issue(ctx, person, ticketRequest(gpA));
      expect((await post(`/tickets/${ticket.id}/events`, staff(tokenA), { to: 'acknowledged', reason: 'a note about the person' })).statusCode).toBe(400);
      expect((await post(`/me/tickets/${ticket.id}/events`, person.headers, { to: 'seen', reason: 'a note' })).statusCode).toBe(400);
      expect(await eventStates(testDb.db, ticket.id)).toHaveLength(1);
    });

    it('turns a withdrawal sent as an event into a revoke: the data goes with the state', async () => {
      const ticket = await issue(ctx, person, ticketRequest(gpA));
      const res = await post(`/me/tickets/${ticket.id}/events`, person.headers, { to: 'withdrawn' });
      expect(res.json()).toMatchObject({ state: 'withdrawn', event: { actor: 'person', reason: 'consent_revoked' } });
      expect((await rawBundle(testDb.db, ticket.id)).contentCiphertext).toBeNull();
      expect((await post(`/me/tickets/${ticket.id}/events`, person.headers, { to: 'withdrawn' })).statusCode).toBe(409);
    });

    it('answers 409 to a withdrawal of a ticket that a revoke already withdrew', async () => {
      const ticket = await issue(ctx, person, ticketRequest(gpA));
      await ctx.app.inject({ method: 'DELETE', url: `/consents/${ticket.consents.find((c) => c.element === 'ticket')!.id}`, headers: person.headers });
      const res = await post(`/me/tickets/${ticket.id}/events`, person.headers, { to: 'withdrawn' });
      expect(res.statusCode).toBe(409); // the revoke already withdrew it; there is nothing left to move
    });
  });

  describe('rerouting', () => {
    it('moves the parent to rerouted and builds the child’s bundle from the new consent alone', async () => {
      const parent = await issue(ctx, person, ticketRequest(gpA, { consents: ['ticket', 'scores', 'free_text', 'conditions'] }));
      ctx.clock.advance(15 * ONE_DAY);
      await sweep(testDb.db, ctx.clock);
      expect((await eventStates(testDb.db, parent.id)).at(-1)).toMatchObject({ to: 'overdue', actor: 'system' });

      const request = ticketRequest(specialistB, { consents: ['ticket', 'scores'], content: { scores: [{ instrument: 'gad7', total: 9, band: 'mild', takenAt: '2026-10-30T08:00:00+04:00' }] } });
      const res = await post(`/me/tickets/${parent.id}/reroute`, person.headers, { ...request, reason: 'wait_too_long' });
      expect(res.statusCode).toBe(201);
      const child = res.json().ticket;
      expect(child).toMatchObject({ parentTicketId: parent.id, state: 'issued', tier: 'specialist' });

      expect(await storedContent(testDb.db, child.id)).toEqual({ scores: request.content.scores });
      expect(JSON.stringify(await rawBundle(testDb.db, child.id))).not.toContain('ciphertext":"v1.' + FREE_TEXT);
      const parentContent = await storedContent(testDb.db, parent.id);
      expect(Object.keys(parentContent!).sort()).toEqual(['conditions', 'free_text', 'scores']);
      expect(child.consents.map((consent: { element: string; recipient: string }) => [consent.element, consent.recipient]).sort()).toEqual([
        ['scores', specialistB],
        ['ticket', specialistB],
      ]);

      const events = await eventStates(testDb.db, parent.id);
      expect(events.at(-1)).toMatchObject({ from: 'overdue', to: 'rerouted', actor: 'person' });
      const [reason] = await testDb.db.select({ reason: schema.ticketEvents.reason }).from(schema.ticketEvents).where(eq(schema.ticketEvents.ticketId, parent.id)).orderBy(schema.ticketEvents.seq).then((rows) => rows.slice(-1));
      expect(reason!.reason).toBe('wait_too_long');
    });

    it('returns the same child for a replayed reroute and does not reroute the parent twice', async () => {
      const parent = await issue(ctx, person, ticketRequest(gpA));
      const request = { ...ticketRequest(specialistB), reason: 'cost' };
      const first = await post(`/me/tickets/${parent.id}/reroute`, person.headers, request);
      const again = await post(`/me/tickets/${parent.id}/reroute`, person.headers, request);
      expect(again.statusCode).toBe(200);
      expect(again.json().ticket.id).toBe(first.json().ticket.id);
      expect((await eventStates(testDb.db, parent.id)).filter((event) => event.to === 'rerouted')).toHaveLength(1);
    });

    it('refuses (409) a reroute of a ticket that is no longer open to one, and creates no child', async () => {
      const parent = await issue(ctx, person, ticketRequest(gpA));
      await post(`/me/tickets/${parent.id}/events`, person.headers, { to: 'seen' });
      const before = await count(schema.tickets);
      const res = await post(`/me/tickets/${parent.id}/reroute`, person.headers, { ...ticketRequest(specialistB), reason: 'cost' });
      expect(res.statusCode).toBe(409);
      expect(await count(schema.tickets)).toBe(before);
      expect((await eventStates(testDb.db, parent.id)).at(-1)!.to).toBe('seen');
    });

    it('leaves the parent alone when the new ticket is refused', async () => {
      const parent = await issue(ctx, person, ticketRequest(gpA));
      const res = await post(`/me/tickets/${parent.id}/reroute`, person.headers, { ...ticketRequest(specialistB, { consents: ['scores'] }), reason: 'cost' });
      expect(res.statusCode).toBe(400);
      expect((await eventStates(testDb.db, parent.id))).toHaveLength(1);
    });
  });

  it('creates one child and answers 409 to the loser when two reroutes of the same ticket race', async () => {
    const parent = await issue(ctx, person, ticketRequest(gpA));
    const winner = { ...ticketRequest(specialistB), reason: 'cost' };
    const loser = ticketRequest(specialistB);
    const before = await count(schema.tickets);
    const result = await issueTicket({ db: testDb.db, cipher, clock: ctx.clock }, person.id, loser, {
      parent: { ticketId: parent.id, reason: 'cost' },
      afterParentRead: async () => {
        expect((await post(`/me/tickets/${parent.id}/reroute`, person.headers, winner)).statusCode).toBe(201);
      },
    });
    expect(result.kind).toBe('conflict');
    expect(await count(schema.tickets)).toBe(before + 1);
    expect((await eventStates(testDb.db, parent.id)).filter((event) => event.to === 'rerouted')).toHaveLength(1);
    expect(await testDb.db.select().from(schema.tickets).where(eq(schema.tickets.clientRequestId, loser.clientRequestId))).toHaveLength(0);
  });

  it('shows the person their own audit trail of reads without any staff name', async () => {
    const ticket = await issue(ctx, person, ticketRequest(gpA));
    const fresh = await signIn(ctx, CLINICIAN_A); // the clock moved on in earlier tests, so the first session has expired
    const read = () => ctx.app.inject({ method: 'GET', url: `/tickets/${ticket.id}/bundle`, headers: staff(fresh) });
    expect((await read()).statusCode).toBe(200);
    ctx.clock.advance(60_000);
    expect((await read()).statusCode).toBe(200);
    const res = await ctx.app.inject({ method: 'GET', url: `/me/tickets/${ticket.id}/reads`, headers: person.headers });
    expect(res.json()).toEqual([
      { at: expect.any(String), role: 'clinician', facilityName: expect.any(String) },
      { at: expect.any(String), role: 'clinician', facilityName: expect.any(String) },
    ]);
    expect(res.body).not.toMatch(/demo\.mawsool|Demo clinician/);
  });
});
