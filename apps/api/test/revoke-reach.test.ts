import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import { runSeed } from '../src/seed/run';
import { DRAFT_RETENTION_MS, sweep } from '../src/sweep';
import { summaryLogContext } from '../src/tickets/service';
import { createTestApp, signIn, type TestApp } from './helpers/app';
import { createTestDb, type TestDb } from './helpers/db';
import { ONE_DAY, cipher, eventStates, issue, rawBundle, registerPerson, serviceAt, ticketRequest, type TestPerson } from './helpers/flow';

/** What a revoke reaches: terminal tickets, what the clinic's other routes say, drafts, and the ledger itself. */
describe('revoke reach and completeness', () => {
  let testDb: TestDb;
  let ctx: TestApp;
  let gpA: string;
  let specialistB: string;
  let person: TestPerson;
  let other: TestPerson;
  let tokenA: string;
  let tokenB: string;

  beforeAll(async () => {
    testDb = await createTestDb();
    await runSeed(testDb.db);
    ctx = await createTestApp(testDb.db);
    gpA = await serviceAt(testDb.db, 'A', 'gp');
    specialistB = await serviceAt(testDb.db, 'B', 'specialist');
    person = await registerPerson(ctx);
    other = await registerPerson(ctx);
    tokenA = await signIn(ctx, 'clinician.a@demo.mawsool.test');
    tokenB = await signIn(ctx, 'clinician.b@demo.mawsool.test');
    await testDb.db.update(schema.tickets).set({ state: 'closed' }).where(eq(schema.tickets.source, 'phc'));
  });

  afterAll(async () => {
    await ctx.app.close();
    await testDb.close();
  });

  const staff = (token: string) => ({ authorization: `Bearer ${token}` });
  const event = (headers: Record<string, string>, id: string, body: object) => ctx.app.inject({ method: 'POST', url: `/me/tickets/${id}/events`, headers, payload: body });
  const clinicReads = async (id: string) => ({
    bundle: (await ctx.app.inject({ method: 'GET', url: `/tickets/${id}/bundle`, headers: staff(tokenA) })).statusCode,
    ticket: (await ctx.app.inject({ method: 'GET', url: `/tickets/${id}`, headers: staff(tokenA) })).statusCode,
  });
  const draft = (headers: Record<string, string>, requestId: string) =>
    ctx.app.inject({ method: 'POST', url: '/summary/draft', headers, payload: { requestId, locale: 'en', useAi: false, consented: ['ticket'], content: {} } });
  const logs = (personId: string) => testDb.db.select().from(schema.summaryLogs).where(eq(schema.summaryLogs.personId, personId));

  describe('withdrawing from a terminal state', () => {
    const toTerminal: Record<string, (id: string) => Promise<void>> = {
      declined: async (id) => void (await event(person.headers, id, { to: 'declined' })),
      closed: async (id) => {
        await event(person.headers, id, { to: 'seen' });
        await event(person.headers, id, { to: 'closed' });
      },
      rerouted: async (id) => {
        const res = await ctx.app.inject({ method: 'POST', url: `/me/tickets/${id}/reroute`, headers: person.headers, payload: { ...ticketRequest(specialistB), reason: 'cost' } });
        expect(res.statusCode).toBe(201);
      },
    };

    it.each(['declined', 'closed', 'rerouted'])('on a %s ticket revokes the share, changes no state, and the old clinic reads 410', async (terminal) => {
      const ticket = await issue(ctx, person, ticketRequest(gpA, { approvedSummary: 'APPROVED-WORDS' }));
      await toTerminal[terminal]!(ticket.id);
      const before = await eventStates(testDb.db, ticket.id);
      expect((await clinicReads(ticket.id)).bundle).toBe(200);

      const res = await event(person.headers, ticket.id, { to: 'withdrawn' });
      expect(res.statusCode).toBe(200);
      expect(res.json().state).toBe(terminal);
      expect(await eventStates(testDb.db, ticket.id)).toEqual(before);
      const raw = await rawBundle(testDb.db, ticket.id);
      expect([raw.contentCiphertext, raw.approvedSummaryCiphertext]).toEqual([null, null]);
      const consents = await testDb.db.select().from(schema.consents).where(eq(schema.consents.ticketId, ticket.id));
      expect(consents.every((consent) => consent.revokedAt !== null)).toBe(true);
      expect(await clinicReads(ticket.id)).toEqual({ bundle: 410, ticket: 410 });
    });

    it('still answers 409 for a withdrawal when there is no live share left to revoke', async () => {
      const ticket = await issue(ctx, person, ticketRequest(gpA));
      await event(person.headers, ticket.id, { to: 'declined' });
      expect((await event(person.headers, ticket.id, { to: 'withdrawn' })).statusCode).toBe(200);
      expect((await event(person.headers, ticket.id, { to: 'withdrawn' })).statusCode).toBe(409);
    });
  });

  describe('the staff ticket read after the share ends', () => {
    it('answers 410 once the ticket consent is revoked, 404 at another facility either way, and 200 for a ticket that never had a share', async () => {
      const ticket = await issue(ctx, person, ticketRequest(gpA));
      const get = (token: string, id: string) => ctx.app.inject({ method: 'GET', url: `/tickets/${id}`, headers: staff(token) });
      expect((await get(tokenA, ticket.id)).statusCode).toBe(200);
      await ctx.app.inject({ method: 'DELETE', url: `/consents/${ticket.consents.find((c) => c.element === 'ticket')!.id}`, headers: person.headers });
      const gone = await get(tokenA, ticket.id);
      expect(gone.statusCode).toBe(410);
      expect(gone.body).not.toMatch(/MW[A-Z0-9]{4}|issued|withdrawn".*tier/);
      expect(gone.json()).toEqual({ error: 'withdrawn', message: 'Withdrawn by the person' });
      expect((await get(tokenB, ticket.id)).statusCode).toBe(404);

      const [seeded] = await testDb.db.select({ id: schema.tickets.id }).from(schema.tickets).innerJoin(schema.services, eq(schema.services.id, schema.tickets.serviceId)).where(eq(schema.services.facilityId, '00000000-0000-4000-8000-00000000fa01')).limit(1);
      expect((await get(tokenA, seeded!.id)).statusCode).toBe(200);
    });
  });

  describe('summaries that outlive what they were built from', () => {
    it('removes the approved summary and the logs when an element is stopped, and says so', async () => {
      const requestId = crypto.randomUUID();
      await draft(person.headers, requestId);
      const ticket = await issue(ctx, person, ticketRequest(gpA, { clientRequestId: requestId, approvedSummary: 'APPROVED-WORDS', summaryRequestId: requestId }));
      expect((await rawBundle(testDb.db, ticket.id)).approvedSummaryCiphertext).not.toBeNull();
      const res = await ctx.app.inject({ method: 'DELETE', url: `/consents/${ticket.consents.find((c) => c.element === 'scores')!.id}`, headers: person.headers });
      expect(res.json()).toMatchObject({ summaryRemoved: true, ticketState: 'issued' });
      expect((await rawBundle(testDb.db, ticket.id)).approvedSummaryCiphertext).toBeNull();
      expect(await testDb.db.select().from(schema.summaryLogs).where(eq(schema.summaryLogs.ticketId, ticket.id))).toHaveLength(0);
    });

    it('says nothing was removed when the ticket never had a summary', async () => {
      const ticket = await issue(ctx, person, ticketRequest(gpA));
      const res = await ctx.app.inject({ method: 'DELETE', url: `/consents/${ticket.consents.find((c) => c.element === 'scores')!.id}`, headers: person.headers });
      expect(res.json().summaryRemoved).toBe(false);
    });
  });

  describe('drafts that no ticket claimed', () => {
    it('are deleted when the person ends any share, along with the draft made under that ticket’s request id', async () => {
      const mine = await registerPerson(ctx);
      const abandoned = crypto.randomUUID();
      await draft(mine.headers, abandoned);
      await draft(other.headers, crypto.randomUUID());
      const ticket = await issue(ctx, mine, ticketRequest(gpA));
      expect(await logs(mine.id)).toHaveLength(1);
      await ctx.app.inject({ method: 'DELETE', url: `/consents/${ticket.consents.find((c) => c.element === 'ticket')!.id}`, headers: mine.headers });
      expect(await logs(mine.id)).toHaveLength(0);
      expect(await logs(other.id)).not.toHaveLength(0); // someone else's drafts are never touched
    });

    it('are deleted by the sweep after 24 hours, also when written after Delete everything, and never while linked to a ticket', async () => {
      const mine = await registerPerson(ctx);
      await ctx.app.inject({ method: 'DELETE', url: '/me/data', headers: mine.headers });
      await draft(mine.headers, crypto.randomUUID()); // finishes after the erase
      const requestId = crypto.randomUUID();
      await draft(mine.headers, requestId);
      const ticket = await issue(ctx, mine, ticketRequest(gpA, { summaryRequestId: requestId, approvedSummary: 'WORDS' }));
      const claimed = await testDb.db.select().from(schema.summaryLogs).where(eq(schema.summaryLogs.ticketId, ticket.id));
      expect(claimed).toHaveLength(2);

      ctx.clock.advance(DRAFT_RETENTION_MS - 1000);
      expect((await sweep(testDb.db, ctx.clock)).draftsDeleted).toBe(0);
      expect(await logs(mine.id)).toHaveLength(3);
      ctx.clock.advance(2000);
      const result = await sweep(testDb.db, ctx.clock);
      expect(result.draftsDeleted).toBeGreaterThanOrEqual(1);
      const left = await logs(mine.id);
      expect(left.every((row) => row.ticketId === ticket.id)).toBe(true);
      expect(left).toHaveLength(2);
    });

    it('are linked to a ticket only by the person who made them: a stranger’s request id leaves the row alone', async () => {
      const requestId = crypto.randomUUID();
      await draft(person.headers, requestId);
      await issue(ctx, other, ticketRequest(gpA, { summaryRequestId: requestId }));
      const [row] = await testDb.db.select().from(schema.summaryLogs).where(and(eq(schema.summaryLogs.requestId, requestId), eq(schema.summaryLogs.personId, person.id)));
      expect(row!.ticketId).toBeNull();
    });
  });

  it('binds a logged summary to its row: the same ciphertext does not decrypt under another row’s context', async () => {
    const requestId = crypto.randomUUID();
    await draft(person.headers, requestId);
    const [row] = await testDb.db.select().from(schema.summaryLogs).where(eq(schema.summaryLogs.requestId, requestId));
    expect(cipher.decrypt(row!.ciphertext, summaryLogContext(person.id, requestId, 'draft'))).toBeTruthy();
    for (const wrong of [summaryLogContext(other.id, requestId, 'draft'), summaryLogContext(person.id, crypto.randomUUID(), 'draft'), summaryLogContext(person.id, requestId, 'approved')]) {
      expect(() => cipher.decrypt(row!.ciphertext, wrong)).toThrow();
    }
  });

  describe('the ledger is append-only', () => {
    it('keeps the row on a revoke, sets revoked_at once, leaves granted_at alone, and a second revoke does not move it', async () => {
      const ticket = await issue(ctx, person, ticketRequest(gpA, { consents: ['ticket', 'free_text'] }));
      const id = ticket.consents.find((consent) => consent.element === 'free_text')!.id;
      const row = async () => (await testDb.db.select().from(schema.consents).where(eq(schema.consents.id, id)))[0]!;
      const granted = await row();
      expect(granted.revokedAt).toBeNull();

      ctx.clock.advance(ONE_DAY);
      await ctx.app.inject({ method: 'DELETE', url: `/consents/${id}`, headers: person.headers });
      const revoked = await row();
      expect(revoked.revokedAt!.getTime()).toBe(ctx.clock.now().getTime());
      expect(revoked.grantedAt.getTime()).toBe(granted.grantedAt.getTime());
      expect(revoked.id).toBe(id);

      ctx.clock.advance(ONE_DAY);
      await ctx.app.inject({ method: 'DELETE', url: `/consents/${id}`, headers: person.headers });
      expect((await row()).revokedAt!.getTime()).toBe(revoked.revokedAt!.getTime());
      expect(await testDb.db.select().from(schema.consents).where(eq(schema.consents.ticketId, ticket.id))).toHaveLength(2);
    });
  });
});
