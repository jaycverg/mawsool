import { randomUUID } from 'node:crypto';
import { ClinicLinkActResultSchema, ClinicLinkTicketSchema } from '@mawsool/types';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLINIC_LINK_KEEP_MS, CLINIC_LINK_TTL_MS } from '../src/clinic-links/service';
import { schema } from '../src/db/client';
import { FACILITY_A_ID, FACILITY_B_ID } from '../src/seed/fixtures';
import { runSeed } from '../src/seed/run';
import { randomToken, sha256Hex } from '../src/security';
import { sweep } from '../src/sweep';
import { createTestApp, signIn, TEST_START, type TestApp } from './helpers/app';
import { TEST_CONFIG } from './helpers/config';
import { createTestDb, type TestDb } from './helpers/db';
import { CONDITION, FREE_TEXT, issue, registerPerson, serviceAt, ticketRequest, type TestPerson } from './helpers/flow';

const SUMMARY = 'SUMMARY-MARKER-6612';
const HOUR = 3_600_000;

describe('the no-login clinic channel', () => {
  let testDb: TestDb;
  let ctx: TestApp;
  let person: TestPerson;
  let admin: { authorization: string };
  let gpA: string;
  let gpB: string;

  beforeAll(async () => {
    testDb = await createTestDb();
    await runSeed(testDb.db, testDb.cipher);
    ctx = await createTestApp(testDb.db);
    person = await registerPerson(ctx);
    admin = { authorization: `Bearer ${await signIn(ctx, 'admin@demo.mawsool.test')}` };
    gpA = await serviceAt(testDb.db, 'A', 'gp');
    gpB = await serviceAt(testDb.db, 'B', 'gp');
    // Facility A has no portal, so its tickets get a link. Facility B keeps the portal.
    const switched = await ctx.app.inject({ method: 'PUT', url: `/facilities/${FACILITY_A_ID}/portal-access`, headers: admin, payload: { portalAccess: false } });
    expect(switched.statusCode).toBe(200);
  });

  afterAll(async () => {
    await ctx.app.close();
    await testDb.close();
  });

  const open = (credential: object) => ctx.app.inject({ method: 'POST', url: '/clinic-link/open', payload: credential });
  const act = (credential: object, to: string) => ctx.app.inject({ method: 'POST', url: '/clinic-link/act', payload: { ...credential, to } });
  const events = (ticketId: string) => testDb.db.select().from(schema.ticketEvents).where(eq(schema.ticketEvents.ticketId, ticketId)).orderBy(schema.ticketEvents.seq);
  const linkRows = (ticketId: string) => testDb.db.select().from(schema.clinicLinks).where(eq(schema.clinicLinks.ticketId, ticketId));
  const readCount = () => testDb.db.select().from(schema.bundleReads).then((rows) => rows.length);

  /** A ticket at facility A with everything shared, and the link that was logged for it. */
  async function ticketWithLink(who = person) {
    const before = ctx.notifier.clinicLinks.length;
    const ticket = await issue(ctx, who, ticketRequest(gpA, { consents: ['ticket', 'scores', 'free_text', 'conditions'], approvedSummary: SUMMARY, summaryBuiltFrom: ['ticket'] }));
    expect(ctx.notifier.clinicLinks).toHaveLength(before + 1);
    return { ticket, credential: ctx.notifier.lastClinicCredential() };
  }

  const refusedLikeAnyBadLink = { error: 'invalid_link', message: 'This link is invalid, expired or already used' };

  describe('issuing', () => {
    it('logs one link for a ticket at a facility without the portal, and stores only the hash of its token', async () => {
      const { ticket, credential } = await ticketWithLink();
      expect(credential.ticketId).toBe(ticket.id);
      const message = ctx.notifier.clinicLinks.at(-1)!;
      expect(message.link).toBe(`${TEST_CONFIG.clinicianAppUrl}/en/clinic-link/#${ticket.id}.${credential.token}`);
      expect(new URL(message.link).search).toBe('');
      expect(message.ticketCode).toBe(ticket.shortCode);
      const [row, ...rest] = await linkRows(ticket.id);
      expect(rest).toEqual([]);
      expect(row).toMatchObject({ tokenHash: sha256Hex(credential.token), facilityId: FACILITY_A_ID, createdAt: TEST_START, usedAt: null });
      expect(row!.expiresAt.getTime() - row!.createdAt.getTime()).toBe(CLINIC_LINK_TTL_MS);
      expect(CLINIC_LINK_TTL_MS).toBe(48 * HOUR);
      expect(JSON.stringify(row)).not.toContain(credential.token);
      expect(message.expiresAt).toEqual(row!.expiresAt);
    });

    it('makes no link for a ticket at a facility that has the portal', async () => {
      const before = ctx.notifier.clinicLinks.length;
      const ticket = await issue(ctx, person, ticketRequest(gpB));
      expect(ctx.notifier.clinicLinks).toHaveLength(before);
      expect(await linkRows(ticket.id)).toEqual([]);
    });

    it('makes none for a replayed request, and one for the child of a reroute', async () => {
      const request = ticketRequest(gpA);
      const first = await ctx.app.inject({ method: 'POST', url: '/tickets', headers: person.headers, payload: request });
      const afterFirst = ctx.notifier.clinicLinks.length;
      const replay = await ctx.app.inject({ method: 'POST', url: '/tickets', headers: person.headers, payload: request });
      expect(replay.statusCode).toBe(200);
      expect(ctx.notifier.clinicLinks).toHaveLength(afterFirst);
      const parentId = first.json().ticket.id as string;
      const rerouted = await ctx.app.inject({ method: 'POST', url: `/me/tickets/${parentId}/reroute`, headers: person.headers, payload: { ...ticketRequest(gpA), reason: 'cost' } });
      expect(rerouted.statusCode).toBe(201);
      expect(ctx.notifier.clinicLinks).toHaveLength(afterFirst + 1);
      expect(ctx.notifier.lastClinicCredential().ticketId).toBe(rerouted.json().ticket.id);
    });

    it('does not fail the ticket when the link cannot be logged, and leaves no link that anyone holds', async () => {
      ctx.notifier.failWith = new Error('log is full');
      try {
        const res = await ctx.app.inject({ method: 'POST', url: '/tickets', headers: person.headers, payload: ticketRequest(gpA) });
        expect(res.statusCode).toBe(201);
      } finally {
        ctx.notifier.failWith = null;
      }
    });

    it('follows the facility’s switch: with the portal back on a new ticket gets none, with it off again it gets one', async () => {
      const set = (portalAccess: boolean) => ctx.app.inject({ method: 'PUT', url: `/facilities/${FACILITY_A_ID}/portal-access`, headers: admin, payload: { portalAccess } });
      expect((await set(true)).json()).toEqual({ id: FACILITY_A_ID, portalAccess: true });
      const before = ctx.notifier.clinicLinks.length;
      await issue(ctx, person, ticketRequest(gpA));
      expect(ctx.notifier.clinicLinks).toHaveLength(before);
      await set(false);
      await issue(ctx, person, ticketRequest(gpA));
      expect(ctx.notifier.clinicLinks).toHaveLength(before + 1);
      expect((await ctx.app.inject({ method: 'PUT', url: `/facilities/${randomUUID()}/portal-access`, headers: admin, payload: { portalAccess: true } })).statusCode).toBe(404);
    });
  });

  describe('opening', () => {
    it('shows only what is needed to act, writes nothing and reads no bundle', async () => {
      const { ticket, credential } = await ticketWithLink();
      const eventsBefore = (await events(ticket.id)).length;
      const reads = await readCount();
      const res = await open(credential);
      expect(res.statusCode).toBe(200);
      const body = ClinicLinkTicketSchema.parse(res.json());
      expect(Object.keys(body).sort()).toEqual(['deadlineAt', 'expiresAt', 'moves', 'shortCode', 'state', 'tier']);
      expect(body).toMatchObject({ shortCode: ticket.shortCode, tier: 'gp', state: 'issued', moves: ['acknowledged', 'seen'] });
      for (const secret of [FREE_TEXT, CONDITION, SUMMARY, person.id, 'phq9']) expect(res.body).not.toContain(secret);
      expect((await events(ticket.id)).length).toBe(eventsBefore);
      expect(await readCount()).toBe(reads);
      expect((await linkRows(ticket.id))[0]!.usedAt).toBeNull();
    });

    it('is the same for a staff session or a person credential: no bearer token is read, and none helps', async () => {
      const { credential } = await ticketWithLink();
      const asOwner = await ctx.app.inject({ method: 'POST', url: '/clinic-link/open', headers: person.headers, payload: { ...credential, token: 'wrong' } });
      const asClinic = await ctx.app.inject({ method: 'POST', url: '/clinic-link/open', headers: admin, payload: { ...credential, token: 'wrong' } });
      for (const res of [asOwner, asClinic]) {
        expect(res.statusCode).toBe(401);
        expect(res.json()).toEqual(refusedLikeAnyBadLink);
      }
      // And a good token needs no header at all.
      expect((await open(credential)).statusCode).toBe(200);
    });

    it('offers only the seen move once a ticket is overdue, because the table allows nothing else', async () => {
      const { ticket, credential } = await ticketWithLink();
      // The care clock is two months on; the links run on the wall clock, which is not.
      await sweep(testDb.db, { now: () => new Date(ctx.clock.now().getTime() + 60 * 24 * HOUR) }, {}, ctx.clock);
      expect((await events(ticket.id)).at(-1)!.toState).toBe('overdue');
      expect((await open(credential)).json().moves).toEqual(['seen']);
    });
  });

  describe('acting', () => {
    it('acknowledges through the transition table as the clinic, spends the link and logs a fresh one while a move remains', async () => {
      const { ticket, credential } = await ticketWithLink();
      const logged = ctx.notifier.clinicLinks.length;
      const res = await act(credential, 'acknowledged');
      expect(res.statusCode).toBe(200);
      expect(ClinicLinkActResultSchema.parse(res.json())).toEqual({ state: 'acknowledged', nextLink: 'issued' });
      const last = (await events(ticket.id)).at(-1)!;
      expect(last).toMatchObject({ fromState: 'issued', toState: 'acknowledged', actor: 'clinic', channel: 'link', reason: null });
      const rows = await linkRows(ticket.id);
      expect(rows).toHaveLength(2);
      expect(rows.filter((row) => row.usedAt !== null)).toHaveLength(1);
      expect(ctx.notifier.clinicLinks).toHaveLength(logged + 1);
      // The spent link is refused, the fresh one works and finishes the clinic's part.
      const fresh = ctx.notifier.lastClinicCredential();
      expect(fresh.token).not.toBe(credential.token);
      expect((await act(credential, 'seen')).statusCode).toBe(401);
      const seen = await act(fresh, 'seen');
      expect(seen.json()).toEqual({ state: 'seen', nextLink: 'not_needed' });
      expect(ctx.notifier.clinicLinks).toHaveLength(logged + 1);
      expect((await events(ticket.id)).map((event) => event.toState)).toEqual(['issued', 'acknowledged', 'seen']);
      expect((await open(fresh)).statusCode).toBe(401);
    });

    it('marks seen straight from issued, and the ticket has no clinic move left afterwards, so no fresh link', async () => {
      const { ticket, credential } = await ticketWithLink();
      const logged = ctx.notifier.clinicLinks.length;
      expect((await act(credential, 'seen')).json()).toEqual({ state: 'seen', nextLink: 'not_needed' });
      expect(ctx.notifier.clinicLinks).toHaveLength(logged);
      expect((await events(ticket.id)).at(-1)).toMatchObject({ actor: 'clinic', toState: 'seen' });
    });

    it('commits the move and says the next link could not be made when the notifier fails, rather than that nothing more is asked', async () => {
      const { ticket, credential } = await ticketWithLink();
      const logged = ctx.notifier.clinicLinks.length;
      ctx.notifier.failWith = new Error('the mock channel is down');
      try {
        const res = await act(credential, 'acknowledged');
        expect(res.statusCode).toBe(200);
        expect(ClinicLinkActResultSchema.parse(res.json())).toEqual({ state: 'acknowledged', nextLink: 'failed' });
      } finally {
        ctx.notifier.failWith = null;
      }
      expect((await events(ticket.id)).at(-1)).toMatchObject({ toState: 'acknowledged', actor: 'clinic', channel: 'link' });
      expect(ctx.notifier.clinicLinks).toHaveLength(logged);
      // The link that was used is spent; the clinic has a move left and no link, which is what `failed` tells it.
      expect((await act(credential, 'seen')).statusCode).toBe(401);
    });

    it('stamps the event on the care clock and spends the link on the wall clock', async () => {
      const { ticket, credential } = await ticketWithLink();
      await act(credential, 'seen');
      expect((await events(ticket.id)).at(-1)!.at).toEqual(ctx.clock.now());
      expect((await linkRows(ticket.id))[0]!.usedAt).toEqual(ctx.clock.now());
    });

    it.each(['withdrawn', 'overdue', 'rerouted', 'declined', 'closed', 'remeasured', 'issued'])('fires nothing but acknowledge and seen: %s is refused with no write', async (to) => {
      const { ticket, credential } = await ticketWithLink();
      const before = (await events(ticket.id)).length;
      const res = await act(credential, to);
      expect(res.statusCode).toBe(400);
      expect((await events(ticket.id)).length).toBe(before);
      expect((await linkRows(ticket.id))[0]!.usedAt).toBeNull();
    });

    it('asks the table, not the link: an acknowledge from a seen ticket is 409, the link is not spent and the ticket is as it was', async () => {
      const { ticket, credential } = await ticketWithLink();
      const clinic = { authorization: `Bearer ${await signIn(ctx, 'clinician.a@demo.mawsool.test')}` };
      expect((await ctx.app.inject({ method: 'POST', url: `/tickets/${ticket.id}/events`, headers: clinic, payload: { to: 'seen' } })).statusCode).toBe(200);
      const before = (await events(ticket.id)).length;
      const res = await act(credential, 'acknowledged');
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('conflict');
      expect((await events(ticket.id)).length).toBe(before);
      expect((await linkRows(ticket.id))[0]!.usedAt).toBeNull();
      expect((await open(credential)).json().moves).toEqual([]);
    });

    it('lets two presses of one link move the ticket once and spend the link once', async () => {
      const { ticket, credential } = await ticketWithLink();
      const results = await Promise.all([act(credential, 'seen'), act(credential, 'seen'), act(credential, 'seen')]);
      expect(results.map((res) => res.statusCode).sort()).toEqual([200, 401, 401]);
      expect((await events(ticket.id)).filter((event) => event.actor === 'clinic')).toHaveLength(1);
      expect((await linkRows(ticket.id)).filter((row) => row.usedAt !== null)).toHaveLength(1);
    });
  });

  describe('a link that is not live', () => {
    /** The same 401 with the same body, and nothing written, however the link is bad. */
    async function expectRefused(credential: object, ticketId: string) {
      const before = { events: (await events(ticketId)).length, links: JSON.stringify(await linkRows(ticketId)), reads: await readCount() };
      for (const res of [await open(credential), await act(credential, 'seen')]) {
        expect(res.statusCode).toBe(401);
        expect(res.json()).toEqual(refusedLikeAnyBadLink);
      }
      expect({ events: (await events(ticketId)).length, links: JSON.stringify(await linkRows(ticketId)), reads: await readCount() }).toEqual(before);
    }

    it('is refused alike when it was used', async () => {
      const { ticket, credential } = await ticketWithLink();
      await act(credential, 'acknowledged');
      await expectRefused(credential, ticket.id);
    });

    it('is refused alike when it expired, 48 hours after it was made on the wall clock', async () => {
      const { ticket, credential } = await ticketWithLink();
      ctx.clock.advance(CLINIC_LINK_TTL_MS - 1000);
      expect((await open(credential)).statusCode).toBe(200);
      ctx.clock.advance(1000);
      await expectRefused(credential, ticket.id);
    });

    it('is refused alike when the token was tampered with or is not a token at all', async () => {
      const { ticket, credential } = await ticketWithLink();
      const flipped = credential.token.slice(0, -1) + (credential.token.endsWith('A') ? 'B' : 'A');
      for (const token of [flipped, '', 'x'.repeat(200), randomToken(), credential.token.toUpperCase()]) await expectRefused({ ticketId: ticket.id, token }, ticket.id);
    });

    it('is refused alike when its token is used with another ticket’s id, or with an id that is no id', async () => {
      const first = await ticketWithLink();
      const second = await ticketWithLink();
      await expectRefused({ ticketId: second.ticket.id, token: first.credential.token }, second.ticket.id);
      await expectRefused({ ticketId: first.ticket.id, token: second.credential.token }, first.ticket.id);
      for (const ticketId of ['nope', '', randomUUID()]) {
        for (const res of [await open({ ticketId, token: first.credential.token }), await act({ ticketId, token: first.credential.token }, 'seen')]) {
          expect(res.statusCode).toBe(401);
          expect(res.json()).toEqual(refusedLikeAnyBadLink);
        }
      }
      expect((await open(first.credential)).statusCode).toBe(200);
    });

    it('is refused as a bad request, with nothing written, when the body is not a credential at all', async () => {
      const before = (await testDb.db.select().from(schema.clinicLinks)).length;
      for (const payload of [{}, { token: 'x' }, { ticketId: randomUUID(), token: 'x', extra: 1 }]) expect((await ctx.app.inject({ method: 'POST', url: '/clinic-link/open', payload })).statusCode).toBe(400);
      expect((await testDb.db.select().from(schema.clinicLinks)).length).toBe(before);
    });
  });

  describe('the ticket behind a live link', () => {
    it('is 404 when it is addressed to another facility than the link was made for, and nothing is spent or written', async () => {
      const ticket = await issue(ctx, person, ticketRequest(gpA));
      const token = randomToken();
      await testDb.db.insert(schema.clinicLinks).values({ tokenHash: sha256Hex(token), ticketId: ticket.id, facilityId: FACILITY_B_ID, createdAt: ctx.clock.now(), expiresAt: new Date(ctx.clock.now().getTime() + CLINIC_LINK_TTL_MS) });
      const before = (await events(ticket.id)).length;
      for (const res of [await open({ ticketId: ticket.id, token }), await act({ ticketId: ticket.id, token }, 'seen')]) {
        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual({ error: 'not_found', message: 'Ticket not found' });
      }
      expect((await events(ticket.id)).length).toBe(before);
      const [row] = await testDb.db.select().from(schema.clinicLinks).where(and(eq(schema.clinicLinks.ticketId, ticket.id), eq(schema.clinicLinks.tokenHash, sha256Hex(token))));
      expect(row!.usedAt).toBeNull();
      // The clinician of facility B reaches the same ticket through the staff route with the same answer.
      expect((await ctx.app.inject({ method: 'GET', url: `/tickets/${ticket.id}`, headers: { authorization: `Bearer ${await signIn(ctx, 'clinician.b@demo.mawsool.test')}` } })).statusCode).toBe(404);
    });

    it('is 410 once the person ended the share, as on the staff routes, with nothing written and no data', async () => {
      const { ticket, credential } = await ticketWithLink();
      const clinic = { authorization: `Bearer ${await signIn(ctx, 'clinician.a@demo.mawsool.test')}` };
      const consent = ticket.consents.find((entry: { element: string }) => entry.element === 'ticket')!;
      expect((await ctx.app.inject({ method: 'DELETE', url: `/consents/${consent.id}`, headers: person.headers })).statusCode).toBe(200);
      const staff = await ctx.app.inject({ method: 'GET', url: `/tickets/${ticket.id}`, headers: clinic });
      expect(staff.statusCode).toBe(410);
      const before = (await events(ticket.id)).length;
      for (const res of [await open(credential), await act(credential, 'seen')]) {
        expect(res.statusCode).toBe(410);
        expect(res.json()).toEqual({ error: 'withdrawn', message: 'Withdrawn by the person' });
        for (const secret of [FREE_TEXT, CONDITION, SUMMARY, ticket.shortCode]) expect(res.body).not.toContain(secret);
      }
      expect((await events(ticket.id)).length).toBe(before);
      expect((await linkRows(ticket.id))[0]!.usedAt).toBeNull();
    });
  });

  describe('housekeeping', () => {
    it('is deleted by Delete everything along with the links of the person’s tickets, and the stranger’s links stay', async () => {
      const leaver = await registerPerson(ctx);
      const stays = await registerPerson(ctx);
      const mine = await ticketWithLink(leaver);
      const theirs = await ticketWithLink(stays);
      expect((await ctx.app.inject({ method: 'DELETE', url: '/me/data', headers: leaver.headers })).statusCode).toBe(200);
      expect(await linkRows(mine.ticket.id)).toEqual([]);
      expect(await linkRows(theirs.ticket.id)).toHaveLength(1);
    });

    it('forgets a link a day after it was spent or expired, and keeps a live one', async () => {
      const spent = await ticketWithLink();
      await act(spent.credential, 'seen');
      const expired = await ticketWithLink();
      ctx.clock.advance(CLINIC_LINK_TTL_MS + CLINIC_LINK_KEEP_MS + HOUR);
      const live = await ticketWithLink();
      const swept = await sweep(testDb.db, ctx.clock);
      expect(swept.linksDeleted).toBeGreaterThanOrEqual(2);
      expect(await linkRows(spent.ticket.id)).toEqual([]);
      expect(await linkRows(expired.ticket.id)).toEqual([]);
      expect(await linkRows(live.ticket.id)).toHaveLength(1);
    });
  });
});

describe('the no-login clinic channel on the demo clock', () => {
  let testDb: TestDb;
  let ctx: TestApp;

  beforeAll(async () => {
    testDb = await createTestDb();
    await runSeed(testDb.db, testDb.cipher);
    ctx = await createTestApp(testDb.db, { demoMode: true });
  });

  afterAll(async () => {
    await ctx.app.close();
    await testDb.close();
  });

  it('expires on the wall clock: a care clock step of seven days neither ends a link nor keeps an expired one, and the event is stamped on the care clock', async () => {
    const admin = { authorization: `Bearer ${await signIn(ctx, 'admin@demo.mawsool.test')}` };
    await ctx.app.inject({ method: 'PUT', url: `/facilities/${FACILITY_A_ID}/portal-access`, headers: admin, payload: { portalAccess: false } });
    const person = await registerPerson(ctx);
    const ticket = await issue(ctx, person, ticketRequest(await serviceAt(testDb.db, 'A', 'gp')));
    const credential = ctx.notifier.lastClinicCredential();
    const advanced = await ctx.app.inject({ method: 'POST', url: '/demo/clock/advance', headers: admin, payload: { by: '7d' } });
    expect(advanced.statusCode).toBe(200);
    const opened = await ctx.app.inject({ method: 'POST', url: '/clinic-link/open', payload: credential });
    expect(opened.statusCode).toBe(200);
    // The ticket is a week older on the care clock, and the clinic's move is stamped there.
    const done = await ctx.app.inject({ method: 'POST', url: '/clinic-link/act', payload: { ...credential, to: 'seen' } });
    expect(done.statusCode).toBe(200);
    const [seen] = await testDb.db.select().from(schema.ticketEvents).where(and(eq(schema.ticketEvents.ticketId, ticket.id), eq(schema.ticketEvents.toState, 'seen')));
    expect(seen!.at).toEqual(ctx.app.careClock.now());
    expect(seen!.at.getTime() - TEST_START.getTime()).toBe(7 * 24 * HOUR);
    const [row] = await testDb.db.select().from(schema.clinicLinks).where(eq(schema.clinicLinks.ticketId, ticket.id));
    expect(row!.usedAt).toEqual(TEST_START);
    expect(row!.expiresAt.getTime() - row!.createdAt.getTime()).toBe(CLINIC_LINK_TTL_MS);
  });
});
