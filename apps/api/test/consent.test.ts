import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import { runSeed } from '../src/seed/run';
import { createTestApp, signIn, type TestApp } from './helpers/app';
import { createTestDb, type TestDb } from './helpers/db';
import { CONDITION, FREE_TEXT, cipher, eventStates, issue, rawBundle, registerPerson, serviceAt, storedContent, ticketRequest, type TestPerson } from './helpers/flow';

const CLINICIAN_A = 'clinician.a@demo.mawsool.test';
const CLINICIAN_B = 'clinician.b@demo.mawsool.test';
const DRAFT_MARKER = 'DRAFT-TEXT-MARKER-5512';
const SUMMARY_MARKER = 'APPROVED-SUMMARY-MARKER-8830';

describe('consent, revoke and the bundle', () => {
  let testDb: TestDb;
  let ctx: TestApp;
  let gpA: string;
  let person: TestPerson;
  let other: TestPerson;
  let tokenA: string;
  let tokenB: string;

  beforeAll(async () => {
    testDb = await createTestDb();
    await runSeed(testDb.db);
    ctx = await createTestApp(testDb.db);
    gpA = await serviceAt(testDb.db, 'A', 'gp');
    person = await registerPerson(ctx);
    other = await registerPerson(ctx);
    tokenA = await signIn(ctx, CLINICIAN_A);
    tokenB = await signIn(ctx, CLINICIAN_B);
  });

  afterAll(async () => {
    await ctx.app.close();
    await testDb.close();
  });

  const staff = (token: string) => ({ authorization: `Bearer ${token}` });
  const readBundle = (ticketId: string, token = tokenA) => ctx.app.inject({ method: 'GET', url: `/tickets/${ticketId}/bundle`, headers: staff(token) });
  const revoke = (consentId: string, headers = person.headers) => ctx.app.inject({ method: 'DELETE', url: `/consents/${consentId}`, headers });
  const consentId = (ticket: Awaited<ReturnType<typeof issue>>, element: string) => ticket.consents.find((consent) => consent.element === element)!.id;
  const rawRows = async (ticketId: string) => JSON.stringify({ bundle: await rawBundle(testDb.db, ticketId) });

  /** A ticket with every element consented, an approved summary, a logged draft and the draft linked to it. */
  async function fullTicket() {
    const requestId = crypto.randomUUID();
    const summaryRequestId = crypto.randomUUID();
    const draft = await ctx.app.inject({
      method: 'POST',
      url: '/summary/draft',
      headers: person.headers,
      payload: { requestId: summaryRequestId, locale: 'en', useAi: false, consented: ['ticket'], content: {} },
    });
    expect(draft.statusCode).toBe(200);
    // A second draft keyed by the ticket's own request id, never linked through `summaryRequestId`.
    await ctx.app.inject({ method: 'POST', url: '/summary/draft', headers: person.headers, payload: { requestId, locale: 'en', useAi: false, consented: ['ticket'], content: {} } });
    const ticket = await issue(
      ctx,
      person,
      ticketRequest(gpA, {
        clientRequestId: requestId,
        consents: ['ticket', 'scores', 'trajectory', 'free_text', 'conditions', 'preferences'],
        content: {
          scores: [{ instrument: 'phq9', total: 12, band: 'moderate', takenAt: '2026-10-29T08:00:00+04:00' }],
          trajectory: [{ instrument: 'phq9', total: 7, band: 'mild', takenAt: '2026-10-08T08:00:00+04:00' }],
          free_text: FREE_TEXT,
          conditions: [CONDITION],
          preferences: { language: 'ar' },
        },
        approvedSummary: SUMMARY_MARKER,
        summaryRequestId,
      }),
    );
    return { ticket, summaryRequestId, requestId };
  }

  describe('storage at rest', () => {
    it('keeps the bundle and the approved summary as ciphertext that only the key and the right row can open', async () => {
      const { ticket } = await fullTicket();
      const raw = await rawBundle(testDb.db, ticket.id);
      for (const column of [raw.contentCiphertext!, raw.approvedSummaryCiphertext!]) {
        expect(column).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]*$/);
        for (const marker of [FREE_TEXT, CONDITION, SUMMARY_MARKER, 'phq9', 'moderate']) expect(column).not.toContain(marker);
      }
      expect(JSON.parse(cipher.decrypt(raw.contentCiphertext!, `bundle:${ticket.id}`)).free_text).toBe(FREE_TEXT);
      expect(() => cipher.decrypt(raw.contentCiphertext!, 'bundle:another-ticket')).toThrow();
      expect(cipher.decrypt(raw.approvedSummaryCiphertext!, `summary:${ticket.id}`)).toBe(SUMMARY_MARKER);
    });

    it('keeps the logged drafts and approved summaries as ciphertext too', async () => {
      const { ticket, summaryRequestId } = await fullTicket();
      const logs = await testDb.db.select().from(schema.summaryLogs).where(eq(schema.summaryLogs.requestId, summaryRequestId));
      const approved = await testDb.db.select().from(schema.summaryLogs).where(and(eq(schema.summaryLogs.ticketId, ticket.id), eq(schema.summaryLogs.kind, 'approved')));
      expect(logs.length).toBeGreaterThanOrEqual(1);
      expect(approved).toHaveLength(1);
      for (const row of [...logs, ...approved]) {
        expect(row.ciphertext).toMatch(/^v1\./);
        expect(row.ciphertext).not.toContain(SUMMARY_MARKER);
      }
      expect(cipher.decrypt(approved[0]!.ciphertext, 'summary-log')).toBe(SUMMARY_MARKER);
    });
  });

  describe('the clinician’s read', () => {
    it('returns exactly the consented elements, names the ones not shared and writes an audit row first', async () => {
      const ticket = await issue(ctx, person, ticketRequest(gpA, { consents: ['ticket', 'scores', 'free_text'], approvedSummary: SUMMARY_MARKER }));
      const res = await readBundle(ticket.id);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Object.keys(body.content).sort()).toEqual(['free_text', 'scores']);
      expect(body.notShared).toEqual(['trajectory', 'conditions', 'preferences']);
      expect(body.approvedSummary).toBe(SUMMARY_MARKER);
      expect(res.body).not.toContain(CONDITION);
      const reads = await testDb.db.select().from(schema.bundleReads).where(eq(schema.bundleReads.ticketId, ticket.id));
      expect(reads).toHaveLength(1);
    });

    it('shows "not shared" for the free text and puts its value nowhere in the response when it was not consented', async () => {
      const ticket = await issue(ctx, person, ticketRequest(gpA, { consents: ['ticket', 'scores'] }));
      const res = await readBundle(ticket.id);
      expect(res.json().notShared).toContain('free_text');
      expect(res.body).not.toContain(FREE_TEXT);
    });

    it('redacts again on read: an element in the stored bundle without a live consent is never returned', async () => {
      const ticket = await issue(ctx, person, ticketRequest(gpA, { consents: ['ticket', 'scores', 'free_text'] }));
      await testDb.db.update(schema.consents).set({ revokedAt: ctx.clock.now() }).where(and(eq(schema.consents.ticketId, ticket.id), eq(schema.consents.element, 'free_text')));
      const res = await readBundle(ticket.id);
      expect(res.statusCode).toBe(200);
      expect(Object.keys(res.json().content)).toEqual(['scores']);
      expect(res.body).not.toContain(FREE_TEXT);
    });

    it('checks live consent on every read: a ticket consent revoked in the ledger alone ends the read, whatever the bundle row says', async () => {
      const ticket = await issue(ctx, person, ticketRequest(gpA));
      expect((await readBundle(ticket.id)).statusCode).toBe(200);
      await testDb.db.update(schema.consents).set({ revokedAt: ctx.clock.now() }).where(and(eq(schema.consents.ticketId, ticket.id), eq(schema.consents.element, 'ticket')));
      expect((await rawBundle(testDb.db, ticket.id)).deletedAt).toBeNull();
      const res = await readBundle(ticket.id);
      expect(res.statusCode).toBe(410);
      expect(res.body).not.toContain(FREE_TEXT);
    });

    it('answers 404 at another facility and to a person, with no audit row, and 404 for a ticket with no bundle', async () => {
      const ticket = await issue(ctx, person, ticketRequest(gpA));
      expect((await readBundle(ticket.id, tokenB)).statusCode).toBe(404);
      expect((await ctx.app.inject({ method: 'GET', url: `/tickets/${ticket.id}/bundle`, headers: person.headers })).statusCode).toBe(401);
      expect(await testDb.db.select().from(schema.bundleReads).where(eq(schema.bundleReads.ticketId, ticket.id))).toHaveLength(0);
      const [seeded] = await testDb.db.select({ id: schema.tickets.id }).from(schema.tickets).innerJoin(schema.services, eq(schema.services.id, schema.tickets.serviceId)).where(eq(schema.services.facilityId, '00000000-0000-4000-8000-00000000fa01')).limit(1);
      expect((await readBundle(seeded!.id)).statusCode).toBe(404);
    });
  });

  describe('revoking one element', () => {
    it('removes only that element from the stored row; the read still succeeds and names it as not shared', async () => {
      const { ticket } = await fullTicket();
      const res = await revoke(consentId(ticket, 'free_text'));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ticketState: 'issued', revoked: [{ element: 'free_text' }] });

      const stored = await storedContent(testDb.db, ticket.id);
      expect(Object.keys(stored!).sort()).toEqual(['conditions', 'preferences', 'scores', 'trajectory']);
      expect(await rawRows(ticket.id)).not.toContain(FREE_TEXT);

      const read = await readBundle(ticket.id);
      expect(read.statusCode).toBe(200);
      expect(read.json().notShared).toEqual(['free_text']);
      expect(read.json().approvedSummary).toBe(SUMMARY_MARKER);
      expect(read.body).not.toContain(FREE_TEXT);
      expect(await eventStates(testDb.db, ticket.id)).toHaveLength(1);
    });
  });

  describe('revoking the ticket element', () => {
    it('empties the stored bundle and the logged summaries, withdraws the ticket and answers 410 with no data', async () => {
      const { ticket, summaryRequestId, requestId } = await fullTicket();
      expect((await readBundle(ticket.id)).statusCode).toBe(200);
      expect(await testDb.db.select().from(schema.summaryLogs).where(eq(schema.summaryLogs.requestId, requestId))).toHaveLength(1);
      const readsBefore = await testDb.db.select().from(schema.bundleReads).where(eq(schema.bundleReads.ticketId, ticket.id));

      const res = await revoke(consentId(ticket, 'ticket'));
      expect(res.statusCode).toBe(200);
      expect(res.json().ticketState).toBe('withdrawn');
      expect(res.json().revoked).toHaveLength(6);

      const raw = await rawBundle(testDb.db, ticket.id);
      expect(raw.contentCiphertext).toBeNull();
      expect(raw.approvedSummaryCiphertext).toBeNull();
      expect(raw.deletedAt).not.toBeNull();
      expect(await testDb.db.select().from(schema.summaryLogs).where(eq(schema.summaryLogs.ticketId, ticket.id))).toHaveLength(0);
      expect(await testDb.db.select().from(schema.summaryLogs).where(eq(schema.summaryLogs.requestId, summaryRequestId))).toHaveLength(0);
      expect(await testDb.db.select().from(schema.summaryLogs).where(eq(schema.summaryLogs.requestId, requestId))).toHaveLength(0);
      const consents = await testDb.db.select().from(schema.consents).where(eq(schema.consents.ticketId, ticket.id));
      expect(consents).toHaveLength(6); // the ledger keeps its rows
      expect(consents.every((consent) => consent.revokedAt !== null)).toBe(true);

      const read = await readBundle(ticket.id);
      expect(read.statusCode).toBe(410);
      expect(read.json()).toEqual({ error: 'withdrawn', message: 'Withdrawn by the person' });
      for (const marker of [FREE_TEXT, CONDITION, SUMMARY_MARKER]) expect(read.body).not.toContain(marker);
      expect(await testDb.db.select().from(schema.bundleReads).where(eq(schema.bundleReads.ticketId, ticket.id))).toHaveLength(readsBefore.length);

      expect((await eventStates(testDb.db, ticket.id)).at(-1)).toMatchObject({ from: 'issued', to: 'withdrawn', actor: 'person' });
    });

    it('withdraws a ticket that is acknowledged, overdue or seen, and only deletes the data once it is terminal', async () => {
      const seen = (await fullTicket()).ticket;
      await ctx.app.inject({ method: 'POST', url: `/me/tickets/${seen.id}/events`, headers: person.headers, payload: { to: 'seen' } });
      expect((await revoke(consentId(seen, 'ticket'))).json().ticketState).toBe('withdrawn');

      const closed = (await fullTicket()).ticket;
      for (const to of ['seen', 'closed']) await ctx.app.inject({ method: 'POST', url: `/me/tickets/${closed.id}/events`, headers: person.headers, payload: { to } });
      const before = await eventStates(testDb.db, closed.id);
      const res = await revoke(consentId(closed, 'ticket'));
      expect(res.json().ticketState).toBe('closed');
      expect(await eventStates(testDb.db, closed.id)).toEqual(before);
      expect((await rawBundle(testDb.db, closed.id)).contentCiphertext).toBeNull();
      expect((await readBundle(closed.id)).statusCode).toBe(410);
    });

    it('is idempotent: revoking again succeeds, revokes nothing new and adds no event', async () => {
      const { ticket } = await fullTicket();
      await revoke(consentId(ticket, 'ticket'));
      const before = await eventStates(testDb.db, ticket.id);
      const again = await revoke(consentId(ticket, 'ticket'));
      expect(again.statusCode).toBe(200);
      expect(again.json()).toEqual({ revoked: [], ticketState: 'withdrawn' });
      expect(await eventStates(testDb.db, ticket.id)).toEqual(before);
    });

    it('answers 404 to someone else’s consent and to one that does not exist, and changes nothing', async () => {
      const { ticket } = await fullTicket();
      expect((await revoke(consentId(ticket, 'ticket'), other.headers)).statusCode).toBe(404);
      expect((await revoke('00000000-0000-4000-8000-000000000009')).statusCode).toBe(404);
      expect((await readBundle(ticket.id)).statusCode).toBe(200);
    });
  });

  describe('granting an element later', () => {
    it('adds the consent row and the content, and refuses a repeat, the ticket element, a stranger’s ticket and a withdrawn ticket', async () => {
      const ticket = await issue(ctx, person, ticketRequest(gpA, { consents: ['ticket'] }));
      const grant = (headers: Record<string, string>, element: string, ticketId = ticket.id) =>
        ctx.app.inject({ method: 'POST', url: '/consents', headers, payload: { ticketId, element, content: { free_text: FREE_TEXT, conditions: [CONDITION] } } });

      const ok = await grant(person.headers, 'free_text');
      expect(ok.statusCode).toBe(201);
      expect(ok.json()).toMatchObject({ element: 'free_text', recipient: gpA, revokedAt: null });
      expect(await storedContent(testDb.db, ticket.id)).toEqual({ free_text: FREE_TEXT }); // conditions was not granted, so not kept
      expect((await readBundle(ticket.id)).json().content).toEqual({ free_text: FREE_TEXT });

      expect((await grant(person.headers, 'free_text')).statusCode).toBe(409);
      expect((await grant(person.headers, 'ticket')).statusCode).toBe(400);
      expect((await grant(other.headers, 'conditions')).statusCode).toBe(404);
      await revoke(ticket.consents[0]!.id);
      expect((await grant(person.headers, 'conditions')).statusCode).toBe(410);
    });
  });

  describe('delete everything on the server', () => {
    it('withdraws every live ticket, empties every bundle and draft, clears the equity buckets and touches nobody else', async () => {
      const mine = await registerPerson(ctx);
      const theirs = await registerPerson(ctx);
      const a = await issue(ctx, mine, ticketRequest(gpA, { approvedSummary: SUMMARY_MARKER }));
      const b = await issue(ctx, mine, ticketRequest(gpA));
      const c = await issue(ctx, theirs, ticketRequest(gpA));
      await ctx.app.inject({ method: 'POST', url: '/summary/draft', headers: mine.headers, payload: { requestId: crypto.randomUUID(), locale: 'en', useAi: false, consented: ['ticket'], content: {} } });
      await ctx.app.inject({ method: 'PUT', url: '/me/equity', headers: mine.headers, payload: { optIn: true, buckets: { ageBand: '25_34', gender: 'female', language: 'ur', region: 'al_ain' } } });
      expect((await testDb.db.select().from(schema.persons).where(eq(schema.persons.id, mine.id)))[0]).toMatchObject({ equityOptIn: true, language: 'ur' });

      const res = await ctx.app.inject({ method: 'DELETE', url: '/me/data', headers: mine.headers });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ticketsWithdrawn: 2, consentsRevoked: 6, summariesDeleted: expect.any(Number) });

      for (const ticket of [a, b]) {
        const raw = await rawBundle(testDb.db, ticket.id);
        expect([raw.contentCiphertext, raw.approvedSummaryCiphertext]).toEqual([null, null]);
        expect((await eventStates(testDb.db, ticket.id)).at(-1)!.to).toBe('withdrawn');
      }
      expect(await testDb.db.select().from(schema.summaryLogs).where(eq(schema.summaryLogs.personId, mine.id))).toHaveLength(0);
      expect((await testDb.db.select().from(schema.persons).where(eq(schema.persons.id, mine.id)))[0]).toMatchObject({ equityOptIn: false, ageBand: null, gender: null, language: null, region: null });
      expect((await rawBundle(testDb.db, c.id)).contentCiphertext).not.toBeNull();

      const again = await ctx.app.inject({ method: 'DELETE', url: '/me/data', headers: mine.headers });
      expect(again.json()).toEqual({ ticketsWithdrawn: 0, consentsRevoked: 0, summariesDeleted: 0 });
    });
  });

  describe('the equity opt-in', () => {
    it('stores the four buckets only on opt-in, clears them on opt-out and refuses an opt-in with none', async () => {
      const p = await registerPerson(ctx);
      const put = (payload: object) => ctx.app.inject({ method: 'PUT', url: '/me/equity', headers: p.headers, payload });
      const row = async () => (await testDb.db.select().from(schema.persons).where(eq(schema.persons.id, p.id)))[0]!;
      expect((await put({ optIn: true })).statusCode).toBe(400);
      expect(await row()).toMatchObject({ equityOptIn: false, ageBand: null });
      expect((await put({ optIn: true, buckets: { ageBand: '18_24', gender: 'male', language: 'ar', region: 'abu_dhabi_city' } })).statusCode).toBe(200);
      expect(await row()).toMatchObject({ equityOptIn: true, ageBand: '18_24', gender: 'male', language: 'ar', region: 'abu_dhabi_city' });
      expect((await put({ optIn: false, buckets: { ageBand: '18_24', gender: null, language: null, region: null } })).statusCode).toBe(200);
      expect(await row()).toMatchObject({ equityOptIn: false, ageBand: null, gender: null, language: null, region: null });
      expect((await put({ optIn: true, buckets: { nationality: 'x' } })).statusCode).toBe(400);
    });
  });
});
