import { validateFhir } from '@mawsool/fhir/validate';
import { EXPORT_LABEL } from '@mawsool/fhir';
import { QUEUE_MAX_PAGE, TIERS, type TicketState } from '@mawsool/types';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import { API_SECURITY_HEADERS } from '../src/plugins/security-headers';
import { FACILITY_A_ID, FACILITY_B_ID } from '../src/seed/fixtures';
import { runSeed } from '../src/seed/run';
import { createTestApp, signIn, type TestApp } from './helpers/app';
import { createTestDb, type TestDb } from './helpers/db';
import { CONDITION, FREE_TEXT, issue, registerPerson, serviceAt, ticketRequest, type TestPerson } from './helpers/flow';

const SUMMARY = 'APPROVED-SUMMARY-MARKER-5512';

describe('the clinic’s queue, detail and export', () => {
  let testDb: TestDb;
  let ctx: TestApp;
  let person: TestPerson;
  let gpA: string;
  let tokenA: string;
  let tokenB: string;

  beforeAll(async () => {
    testDb = await createTestDb();
    await runSeed(testDb.db);
    ctx = await createTestApp(testDb.db);
    person = await registerPerson(ctx);
    gpA = await serviceAt(testDb.db, 'A', 'gp');
    tokenA = await signIn(ctx, 'clinician.a@demo.mawsool.test');
    tokenB = await signIn(ctx, 'clinician.b@demo.mawsool.test');
  });

  afterAll(async () => {
    await ctx.app.close();
    await testDb.close();
  });

  const as = (token: string) => ({ authorization: `Bearer ${token}` });
  const queue = (query = '', token = tokenA) => ctx.app.inject({ method: 'GET', url: `/tickets${query}`, headers: as(token) });
  const detail = (id: string, token = tokenA) => ctx.app.inject({ method: 'GET', url: `/tickets/${id}`, headers: as(token) });
  const bundle = (id: string, token = tokenA) => ctx.app.inject({ method: 'GET', url: `/tickets/${id}/bundle`, headers: as(token) });
  const fhir = (id: string, token = tokenA) => ctx.app.inject({ method: 'GET', url: `/tickets/${id}/fhir`, headers: as(token) });
  const revoke = (consentId: string) => ctx.app.inject({ method: 'DELETE', url: `/consents/${consentId}`, headers: person.headers });
  const consentOf = (ticket: Awaited<ReturnType<typeof issue>>, element: string) => ticket.consents.find((consent) => consent.element === element)!.id;
  const ids = (res: { json(): { items: { id: string }[] } }) => res.json().items.map((item) => item.id);
  const readsOf = async (id: string) => (await testDb.db.select().from(schema.bundleReads).where(eq(schema.bundleReads.ticketId, id))).length;
  const events = (id: string, token: string, payload: object) => ctx.app.inject({ method: 'POST', url: `/tickets/${id}/events`, headers: as(token), payload });

  describe('GET /tickets', () => {
    it('lists the clinic’s own tickets, earliest deadline first, with ticket fields only and no person', async () => {
      const res = await queue('?limit=200');
      expect(res.statusCode).toBe(200);
      const body = res.json() as { facility: { id: string; name: string }; total: number; items: { id: string; deadlineAt: string; state: string }[] };
      expect(body.facility).toEqual({ id: FACILITY_A_ID, name: 'Sample PHC · Khalifa City' });
      expect(body.items.length).toBeGreaterThan(5);
      const deadlines = body.items.map((item) => Date.parse(item.deadlineAt));
      expect(deadlines).toEqual([...deadlines].sort((a, b) => a - b));
      for (const item of body.items) {
        expect(Object.keys(item).sort()).toEqual(['createdAt', 'deadlineAt', 'id', 'language', 'serviceId', 'shortCode', 'source', 'state', 'tier']);
        expect(['issued', 'acknowledged', 'overdue']).toContain(item.state);
      }
      // Every row belongs to this facility, and none to the other.
      const rows = await testDb.db.select({ id: schema.tickets.id, facilityId: schema.services.facilityId }).from(schema.tickets).innerJoin(schema.services, eq(schema.services.id, schema.tickets.serviceId)).where(inArray(schema.tickets.id, body.items.map((item) => item.id)));
      expect(new Set(rows.map((row) => row.facilityId))).toEqual(new Set([FACILITY_A_ID]));
    });

    it('shows a clinician at the other facility only that facility’s tickets', async () => {
      const a = await queue('?limit=200');
      const b = await queue('?limit=200', tokenB);
      expect(b.json().facility.id).toBe(FACILITY_B_ID);
      const overlap = ids(a).filter((id) => ids(b).includes(id));
      expect(overlap).toEqual([]);
      const mine = await issue(ctx, person, ticketRequest(gpA));
      expect(ids(await queue('?limit=200'))).toContain(mine.id);
      expect(ids(await queue('?limit=200', tokenB))).not.toContain(mine.id);
      expect((await detail(mine.id, tokenB)).statusCode).toBe(404);
    });

    it('refuses an ops or admin session, a person and no session', async () => {
      const ops = await signIn(ctx, 'ops@demo.mawsool.test');
      expect((await queue('', ops)).statusCode).toBe(403);
      expect((await ctx.app.inject({ method: 'GET', url: '/tickets' })).statusCode).toBe(401);
      expect((await ctx.app.inject({ method: 'GET', url: '/tickets', headers: person.headers })).statusCode).toBe(401);
    });

    it('filters by state and tier, pages with a limit, and says how many match whatever the page holds', async () => {
      const all = (await queue('?state=open&limit=200')).json() as { total: number; items: { tier: string; state: string }[]; counts: Record<string, number> };
      expect(all.total).toBe(all.items.length);
      const overdue = (await queue('?state=overdue&limit=200')).json() as { total: number; items: { state: string }[] };
      expect(overdue.total).toBeGreaterThan(0);
      expect(new Set(overdue.items.map((item) => item.state))).toEqual(new Set(['overdue']));
      expect(overdue.total).toBe(all.counts['overdue']);
      const seen = (await queue('?state=seen&limit=200')).json() as { items: { state: string }[] };
      expect(new Set(seen.items.map((item) => item.state))).toEqual(new Set(['seen']));
      for (const tier of TIERS.filter((tier) => tier !== 'self_help')) {
        const res = (await queue(`?tier=${tier}&state=open&limit=200`)).json() as { items: { tier: string }[] };
        expect(new Set(res.items.map((item) => item.tier)).size).toBeLessThanOrEqual(1);
        for (const item of res.items) expect(item.tier).toBe(tier);
      }
      const page = (await queue('?state=open&limit=3')).json() as { total: number; items: unknown[] };
      expect(page.items).toHaveLength(3);
      expect(page.total).toBe(all.total);
    });

    it('counts every state of the clinic, whatever the filter', async () => {
      const filtered = (await queue('?state=seen&limit=1')).json() as { counts: Record<string, number> };
      const open = (await queue('?limit=1')).json() as { counts: Record<string, number> };
      expect(filtered.counts).toEqual(open.counts);
      const stored = await testDb.db
        .select({ state: schema.tickets.state })
        .from(schema.tickets)
        .innerJoin(schema.services, eq(schema.services.id, schema.tickets.serviceId))
        .where(eq(schema.services.facilityId, FACILITY_A_ID));
      const byState: Record<string, number> = {};
      for (const row of stored) byState[row.state] = (byState[row.state] ?? 0) + 1;
      expect(open.counts).toEqual(byState);
    });

    it('rejects an unknown state, a limit of zero and one over the largest page', async () => {
      expect((await queue('?state=sort-of-open')).statusCode).toBe(400);
      expect((await queue('?limit=0')).statusCode).toBe(400);
      expect((await queue(`?limit=${QUEUE_MAX_PAGE + 1}`)).statusCode).toBe(400);
      expect((await queue('?tier=gold')).statusCode).toBe(400);
    });

    it('lists a seeded ticket that never had a bundle, and the detail and the export say there is nothing shared rather than that it was withdrawn', async () => {
      const [seeded] = await testDb.db
        .select({ id: schema.tickets.id })
        .from(schema.tickets)
        .innerJoin(schema.services, eq(schema.services.id, schema.tickets.serviceId))
        .where(and(eq(schema.services.facilityId, FACILITY_A_ID), eq(schema.tickets.state, 'withdrawn')))
        .limit(1);
      expect(seeded).toBeDefined();
      expect(await testDb.db.select().from(schema.consents).where(eq(schema.consents.ticketId, seeded!.id))).toHaveLength(0);
      expect(ids(await queue('?state=withdrawn&limit=200'))).toContain(seeded!.id);
      const view = await detail(seeded!.id);
      expect(view.statusCode).toBe(200);
      expect(view.json()).toMatchObject({ state: 'withdrawn', unable: null });
      expect((await bundle(seeded!.id)).statusCode).toBe(404);
      expect((await fhir(seeded!.id)).statusCode).toBe(404);
      expect(await readsOf(seeded!.id)).toBe(0);
    });
  });

  describe('a share the person has ended', () => {
    it('is not in the queue and answers 410 on the detail, the bundle and the export, with no data, for every way a share can end', async () => {
      const live = await issue(ctx, person, ticketRequest(gpA));
      const withdrawn = await issue(ctx, person, ticketRequest(gpA));
      const closed = await issue(ctx, person, ticketRequest(gpA));
      const seen = await issue(ctx, person, ticketRequest(gpA));
      await ctx.app.inject({ method: 'POST', url: `/me/tickets/${seen.id}/events`, headers: person.headers, payload: { to: 'seen', selfConfirmed: true } });
      // A terminal state: revoking changes no state but the share still ends.
      await testDb.db.update(schema.tickets).set({ state: 'closed' }).where(eq(schema.tickets.id, closed.id));
      await testDb.db.insert(schema.ticketEvents).values({ ticketId: closed.id, seq: 2, fromState: 'issued', toState: 'closed', actor: 'person', channel: 'app', at: ctx.clock.now() });

      for (const ticket of [withdrawn, closed, seen]) expect((await revoke(consentOf(ticket, 'ticket'))).statusCode).toBe(200);

      for (const state of ['open', 'closed', 'seen', 'withdrawn'] as const) {
        const listed = ids(await queue(`?state=${state}&limit=200`));
        expect(listed, state).not.toContain(withdrawn.id);
        expect(listed, state).not.toContain(closed.id);
        expect(listed, state).not.toContain(seen.id);
      }
      expect(ids(await queue('?limit=200'))).toContain(live.id);

      for (const ticket of [withdrawn, closed, seen]) {
        for (const read of [detail, bundle, fhir]) {
          const res = await read(ticket.id);
          expect(res.statusCode, ticket.shortCode).toBe(410);
          expect(res.json()).toEqual({ error: 'withdrawn', message: 'Withdrawn by the person' });
          expect(res.body).not.toContain(ticket.shortCode);
        }
        expect((await detail(ticket.id, tokenB)).statusCode).toBe(404);
      }
      expect((await detail(live.id)).statusCode).toBe(200);
    });

    it('agrees with the detail for every ticket the clinic has: it is listed exactly when the detail is not 410', async () => {
      const ended = await issue(ctx, person, ticketRequest(gpA));
      const kept = await issue(ctx, person, ticketRequest(gpA));
      await revoke(consentOf(ended, 'ticket'));
      // A share that has ended always leaves the ticket withdrawn (or in a terminal state), never in a waiting state, so every state is walked.
      let ended410 = 0;
      let live200 = 0;
      for (const state of ['issued', 'acknowledged', 'overdue', 'seen', 'remeasured', 'closed', 'declined', 'rerouted', 'withdrawn'] satisfies TicketState[]) {
        const page = await queue(`?state=${state}&limit=200`);
        // The whole state fits one page, so "not listed" cannot be a page boundary.
        expect(page.json().total, state).toBeLessThanOrEqual(200);
        const listed = new Set(ids(page));
        const inState = await testDb.db
          .select({ id: schema.tickets.id })
          .from(schema.tickets)
          .innerJoin(schema.services, eq(schema.services.id, schema.tickets.serviceId))
          .where(and(eq(schema.services.facilityId, FACILITY_A_ID), eq(schema.tickets.state, state)));
        for (const { id } of inState) {
          const status = (await detail(id)).statusCode;
          if (status === 410) ended410 += 1;
          else live200 += 1;
          expect(listed.has(id), `${state} ${id} (detail ${status})`).toBe(status !== 410);
        }
      }
      expect(ended410).toBeGreaterThanOrEqual(1);
      expect(live200).toBeGreaterThan(100);
      expect((await detail(kept.id)).statusCode).toBe(200);
      expect((await detail(ended.id)).statusCode).toBe(410);
    });

    it('leaves the ticket in the queue when only an optional element was stopped', async () => {
      const ticket = await issue(ctx, person, ticketRequest(gpA));
      await revoke(consentOf(ticket, 'free_text'));
      expect(ids(await queue('?limit=200'))).toContain(ticket.id);
      expect((await detail(ticket.id)).statusCode).toBe(200);
    });
  });

  describe('GET /tickets/:id', () => {
    it('shows the clinic’s own standing "unable to see" report, and drops it once the ticket moves on', async () => {
      const ticket = await issue(ctx, person, ticketRequest(gpA));
      expect((await detail(ticket.id)).json().unable).toBeNull();
      expect((await events(ticket.id, tokenA, { unable: true, reason: 'no_capacity' })).statusCode).toBe(200);
      expect((await detail(ticket.id)).json().unable).toEqual({ reason: 'no_capacity', at: ctx.clock.now().toISOString() });
      expect((await detail(ticket.id)).json().state).toBe('issued');
      // The clinic reports again: still one standing report, the latest.
      ctx.clock.advance(60_000);
      await events(ticket.id, tokenA, { unable: true, reason: 'could_not_reach' });
      expect((await detail(ticket.id)).json().unable).toEqual({ reason: 'could_not_reach', at: ctx.clock.now().toISOString() });
      // The clinic acknowledges after all: the report no longer stands.
      expect((await events(ticket.id, tokenA, { to: 'acknowledged' })).statusCode).toBe(200);
      expect((await detail(ticket.id)).json().unable).toBeNull();
    });

    it('drops the report when the person has rerouted', async () => {
      const ticket = await issue(ctx, person, ticketRequest(gpA));
      await events(ticket.id, tokenA, { unable: true, reason: 'wrong_service' });
      const res = await ctx.app.inject({ method: 'POST', url: `/me/tickets/${ticket.id}/reroute`, headers: person.headers, payload: { ...ticketRequest(gpA), reason: 'unable_to_see' } });
      expect(res.statusCode).toBe(201);
      const after = await detail(ticket.id);
      expect(after.json()).toMatchObject({ state: 'rerouted', unable: null });
    });
  });

  describe('GET /tickets/:id/fhir', () => {
    const issueFull = (overrides: Parameters<typeof ticketRequest>[1] = {}) =>
      issue(ctx, person, ticketRequest(gpA, { consents: ['ticket', 'scores', 'conditions'], approvedSummary: SUMMARY, summaryBuiltFrom: ['ticket', 'scores'], ...overrides }));

    it('is a Bundle that validates against the R4 schema, labelled as not sent, and holds only what is consented to', async () => {
      const ticket = await issueFull();
      const res = await fhir(ticket.id);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('application/fhir+json');
      const body = res.json();
      expect(validateFhir(body)).toEqual({ valid: true });
      expect(body.meta.tag).toEqual([{ system: 'urn:mawsool:export', code: 'not-sent', display: EXPORT_LABEL }]);
      const types = body.entry.map((entry: { resource: { resourceType: string } }) => entry.resource.resourceType);
      expect(types).toEqual(['ServiceRequest', 'QuestionnaireResponse', 'Condition']);
      expect(res.body).toContain(CONDITION);
      expect(res.body).toContain(SUMMARY);
      // Free text was not consented to: it is nowhere in the response, and neither is the preferences value.
      expect(res.body).not.toContain(FREE_TEXT);
      expect(res.body).not.toContain('"ar"}'); // preferences
    });

    it('contains no unconsented element, for each element left out on its own', async () => {
      const markers = { free_text: FREE_TEXT, conditions: CONDITION, scores: '"valueInteger":12', trajectory: '"valueInteger":9', preferences: 'preference' } as const;
      const content = {
        scores: [{ instrument: 'phq9' as const, total: 12, band: 'moderate', takenAt: '2026-10-29T08:00:00+04:00' }],
        trajectory: [{ instrument: 'gad7' as const, total: 9, band: 'mild', takenAt: '2026-10-08T08:00:00+04:00' }],
        free_text: FREE_TEXT,
        conditions: [CONDITION],
        preferences: { language: 'ar' as const },
      };
      for (const element of ['free_text', 'conditions', 'scores', 'trajectory'] as const) {
        const ticket = await issue(ctx, person, ticketRequest(gpA, { consents: ['ticket', element], content }));
        const res = await fhir(ticket.id);
        expect(validateFhir(res.json()), element).toEqual({ valid: true });
        for (const [other, marker] of Object.entries(markers)) {
          if (other === element) expect(res.body, `${element} shared`).toContain(marker);
          else expect(res.body, `${other} while only ${element} is shared`).not.toContain(marker);
        }
      }
    });

    it('is a bundle read like any other: audited for the person, and 404 at the other facility with no row', async () => {
      const ticket = await issueFull();
      expect(await readsOf(ticket.id)).toBe(0);
      expect((await fhir(ticket.id)).statusCode).toBe(200);
      expect(await readsOf(ticket.id)).toBe(1);
      expect((await fhir(ticket.id, tokenB)).statusCode).toBe(404);
      expect(await readsOf(ticket.id)).toBe(1);
      const reads = await ctx.app.inject({ method: 'GET', url: `/me/tickets/${ticket.id}/reads`, headers: person.headers });
      expect(reads.json()).toHaveLength(1);
    });

    it('drops an element as soon as the person stops it, and is 410 with no data once the ticket is revoked', async () => {
      const ticket = await issueFull();
      expect((await fhir(ticket.id)).body).toContain(CONDITION);
      await revoke(consentOf(ticket, 'conditions'));
      const after = await fhir(ticket.id);
      expect(after.statusCode).toBe(200);
      expect(after.body).not.toContain(CONDITION);
      expect(validateFhir(after.json())).toEqual({ valid: true });
      await revoke(consentOf(ticket, 'ticket'));
      const gone = await fhir(ticket.id);
      expect(gone.statusCode).toBe(410);
      expect(gone.body).not.toContain(SUMMARY);
    });

    it('leaves the summary out when a stop removed it while the ticket stays live, and the bundle read shows no summary then', async () => {
      const ticket = await issueFull({ summaryBuiltFrom: ['ticket', 'conditions'] });
      expect((await bundle(ticket.id)).json().approvedSummary).toBe(SUMMARY);
      const stopped = await revoke(consentOf(ticket, 'conditions'));
      expect(stopped.json()).toMatchObject({ summaryRemoved: true });
      const read = await bundle(ticket.id);
      expect(read.statusCode).toBe(200);
      expect(read.json().approvedSummary).toBeNull();
      expect(read.json().notShared).toContain('conditions');
      expect((await detail(ticket.id)).statusCode).toBe(200);
      const exported = await fhir(ticket.id);
      expect(exported.statusCode).toBe(200);
      expect(exported.body).not.toContain(SUMMARY);
      expect(exported.body).not.toContain('"note"');
      expect(validateFhir(exported.json())).toEqual({ valid: true });
    });

    it('exports a ticket with no summary at all without a note', async () => {
      const ticket = await issueFull({ approvedSummary: null, summaryBuiltFrom: [] });
      const res = await fhir(ticket.id);
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain('"note"');
    });
  });

  describe('the bundle read for a free-text note the person did not share', () => {
    it('names it as not shared and carries the value nowhere in the response', async () => {
      const ticket = await issue(ctx, person, ticketRequest(gpA, { consents: ['ticket', 'scores'], content: { scores: [{ instrument: 'phq9', total: 12, band: 'moderate', takenAt: '2026-10-29T08:00:00+04:00' }], free_text: FREE_TEXT } }));
      const res = await bundle(ticket.id);
      expect(res.statusCode).toBe(200);
      expect(res.json().notShared).toContain('free_text');
      expect(res.json().content).not.toHaveProperty('free_text');
      expect(res.body).not.toContain(FREE_TEXT);
      // The raw row never held it either: the device and the server both cut it.
      const [row] = await testDb.db.select().from(schema.sharedBundles).where(eq(schema.sharedBundles.ticketId, ticket.id));
      expect(row!.contentCiphertext).not.toContain(FREE_TEXT);
    });
  });

  describe('what the API says to the browser', () => {
    it('never lets staff or error responses be stored, framed or sniffed', async () => {
      const ticket = await issue(ctx, person, ticketRequest(gpA));
      for (const res of [await queue(), await detail(ticket.id), await bundle(ticket.id), await detail(ticket.id, tokenB), await ctx.app.inject({ method: 'GET', url: '/tickets' }), await ctx.app.inject({ method: 'GET', url: '/health' })]) {
        for (const [name, value] of Object.entries(API_SECURITY_HEADERS)) expect(res.headers[name], `${res.statusCode} ${name}`).toBe(value);
      }
      expect(API_SECURITY_HEADERS['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'");
    });

    it('says the same on a CORS preflight', async () => {
      const res = await ctx.app.inject({ method: 'OPTIONS', url: '/tickets', headers: { origin: 'http://localhost:3001', 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' } });
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3001');
    });
  });
});
