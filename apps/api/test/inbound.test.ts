import { createHmac, randomBytes } from 'node:crypto';
import { INBOUND_SOURCES, INBOUND_WINDOW_SECONDS, type InboundSource } from '@mawsool/types';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import { INBOUND_HEADERS, checkInbound, signInbound } from '../src/inbound/signing';
import { NONCE_RETENTION_MS, formatInviteCode, generateInviteCode, inviteCodeHash } from '../src/inbound/service';
import { runSeed } from '../src/seed/run';
import { sha256Hex } from '../src/security';
import { sweep } from '../src/sweep';
import { createTestApp, signIn, type TestApp } from './helpers/app';
import { TEST_INBOUND_KEYS } from './helpers/config';
import { createTestDb, type TestDb } from './helpers/db';
import { issue, registerPerson, serviceAt, ticketRequest } from './helpers/flow';

const BODY = { result: 'positive', screenedAt: '2026-11-01T08:00:00+04:00', locale: 'ar' };
const nonce = () => randomBytes(18).toString('base64url');

describe('signing', () => {
  const base = { key: TEST_INBOUND_KEYS.tamm, source: 'tamm' as const, timestamp: 1_800_000_000, nonce: 'n'.repeat(20), body: JSON.stringify(BODY) };
  const keys = TEST_INBOUND_KEYS;
  const check = (headers: Record<string, string | string[] | undefined>, body = base.body, nowSeconds = base.timestamp) => checkInbound({ headers, body, keys, nowSeconds });

  it('accepts what signInbound produced, and names the source and nonce', () => {
    expect(check(signInbound(base))).toEqual({ ok: true, source: 'tamm', nonce: base.nonce });
  });

  it('is HMAC-SHA256 over source, time, nonce and the exact body, one per line, in hex', () => {
    const expected = createHmac('sha256', base.key).update(['tamm', '1800000000', base.nonce, base.body].join('\n')).digest('hex');
    expect(signInbound(base)[INBOUND_HEADERS.signature]).toBe(expected);
  });

  it('refuses a body that changed by one byte, a different source, a different nonce and a different time', () => {
    const headers = signInbound(base);
    expect(check(headers, `${base.body} `).ok).toBe(false);
    expect(check({ ...headers, [INBOUND_HEADERS.source]: 'phc' }).ok).toBe(false);
    expect(check({ ...headers, [INBOUND_HEADERS.nonce]: 'm'.repeat(20) }).ok).toBe(false);
    expect(check({ ...headers, [INBOUND_HEADERS.timestamp]: String(base.timestamp + 1) }).ok).toBe(false);
  });

  it('refuses a signature made with another source’s key', () => {
    expect(check(signInbound({ ...base, key: TEST_INBOUND_KEYS.phc })).ok).toBe(false);
  });

  it('keeps the time window exactly: the edge passes, one second past it does not, in both directions', () => {
    expect(check(signInbound({ ...base, timestamp: base.timestamp - INBOUND_WINDOW_SECONDS })).ok).toBe(true);
    expect(check(signInbound({ ...base, timestamp: base.timestamp + INBOUND_WINDOW_SECONDS })).ok).toBe(true);
    expect(check(signInbound({ ...base, timestamp: base.timestamp - INBOUND_WINDOW_SECONDS - 1 })).ok).toBe(false);
    expect(check(signInbound({ ...base, timestamp: base.timestamp + INBOUND_WINDOW_SECONDS + 1 })).ok).toBe(false);
  });

  it('refuses a missing header, a repeated header, a malformed value and a source with no key or no meaning', () => {
    const headers = signInbound(base);
    for (const name of Object.values(INBOUND_HEADERS)) expect(check({ ...headers, [name]: undefined }).ok, `missing ${name}`).toBe(false);
    expect(check({ ...headers, [INBOUND_HEADERS.signature]: [headers[INBOUND_HEADERS.signature]!, 'x'] }).ok).toBe(false);
    expect(check({ ...headers, [INBOUND_HEADERS.signature]: 'zz' }).ok).toBe(false);
    expect(check({ ...headers, [INBOUND_HEADERS.signature]: headers[INBOUND_HEADERS.signature]!.toUpperCase() }).ok).toBe(false);
    expect(check({ ...headers, [INBOUND_HEADERS.nonce]: 'short' }).ok).toBe(false);
    expect(check({ ...headers, [INBOUND_HEADERS.timestamp]: '1.8e9' }).ok).toBe(false);
    expect(check({ ...headers, [INBOUND_HEADERS.source]: 'app' }).ok).toBe(false);
    expect(checkInbound({ headers, body: base.body, keys: {}, nowSeconds: base.timestamp }).ok).toBe(false);
  });
});

describe('invite codes', () => {
  it('are eight characters from the ticket alphabet, shown as two groups of four, stored only as a hash', () => {
    const code = generateInviteCode();
    expect(code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/);
    expect(formatInviteCode('ABCDEFGH')).toBe('ABCD-EFGH');
    expect(inviteCodeHash(code)).toBe(sha256Hex(code));
    expect(new Set(Array.from({ length: 50 }, generateInviteCode)).size).toBe(50);
  });
});

describe('POST /inbound/screens', () => {
  let testDb: TestDb;
  let ctx: TestApp;

  beforeAll(async () => {
    testDb = await createTestDb();
    await runSeed(testDb.db);
    ctx = await createTestApp(testDb.db);
  });

  afterAll(async () => {
    await ctx.app.close();
    await testDb.close();
  });

  const counts = async () => ({
    invites: (await testDb.db.select({ id: schema.inboundInvites.id }).from(schema.inboundInvites)).length,
    nonces: (await testDb.db.select({ nonce: schema.inboundNonces.nonce }).from(schema.inboundNonces)).length,
    tickets: (await testDb.db.select({ id: schema.tickets.id }).from(schema.tickets)).length,
  });

  /** Posts a body signed by a front door. `overrides` change the headers after signing, to build a bad request. */
  async function post(options: { source?: InboundSource; key?: string; body?: unknown; raw?: string; timestamp?: number; nonce?: string; overrides?: Record<string, string>; extra?: Record<string, string> } = {}) {
    const source = options.source ?? 'tamm';
    const raw = options.raw ?? JSON.stringify(options.body ?? BODY);
    const timestamp = options.timestamp ?? Math.floor(ctx.clock.now().getTime() / 1000);
    const headers = signInbound({ key: options.key ?? TEST_INBOUND_KEYS[source], source, timestamp, nonce: options.nonce ?? nonce(), body: raw });
    return ctx.app.inject({ method: 'POST', url: '/inbound/screens', headers: { 'content-type': 'application/json', ...headers, ...options.overrides, ...options.extra }, payload: raw });
  }

  it('creates an invite and never a ticket, and answers with the claim code and link', async () => {
    const before = await counts();
    const res = await post();
    expect(res.statusCode).toBe(201);
    const receipt = res.json() as { inviteId: string; code: string; claimUrl: string; expiresAt: string };
    expect(receipt.code).toMatch(/^[23456789A-HJKMNP-Z]{4}-[23456789A-HJKMNP-Z]{4}$/);
    expect(receipt.claimUrl).toBe(`http://localhost:3000/ar/claim/?code=${receipt.code}`);
    expect(new Date(receipt.expiresAt).getTime()).toBe(ctx.clock.now().getTime() + 30 * 24 * 3600 * 1000);
    expect(await counts()).toEqual({ ...before, invites: before.invites + 1, nonces: before.nonces + 1 });
  });

  it('keeps only the hash of the code, the source and the screen time: no name, no scores, no plain code', async () => {
    const res = await post({ source: 'phc', body: { ...BODY, locale: 'en' } });
    const receipt = res.json() as { inviteId: string; code: string };
    const [row] = await testDb.db.select().from(schema.inboundInvites).where(eq(schema.inboundInvites.id, receipt.inviteId));
    expect(row).toMatchObject({ source: 'phc', locale: 'en', claimedBy: null, claimedAt: null, ticketId: null });
    expect(row!.codeHash).toBe(sha256Hex(receipt.code.replace('-', '')));
    expect(row!.screenedAt.toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(JSON.stringify(row)).not.toContain(receipt.code);
    expect(JSON.stringify(row)).not.toContain(receipt.code.replace('-', ''));
    expect(Object.keys(row!).sort()).toEqual(['claimedAt', 'claimedBy', 'codeHash', 'createdAt', 'expiresAt', 'id', 'locale', 'screenedAt', 'source', 'ticketId']);
  });

  it('accepts each of the three front doors with its own key', async () => {
    for (const source of INBOUND_SOURCES) expect((await post({ source })).statusCode, source).toBe(201);
  });

  describe('refuses with no invite row and no nonce stored', () => {
    const refused = async (label: string, send: () => Promise<{ statusCode: number }>, status = 401) => {
      const before = await counts();
      const res = await send();
      expect(res.statusCode, label).toBe(status);
      expect(await counts(), label).toEqual(before);
      return res;
    };

    it('a bad signature: wrong key, tampered body, another source’s key, a mangled signature', async () => {
      await refused('wrong key', () => post({ key: 'not-the-key-not-the-key-not-the-key-0' }));
      await refused('tampered body', async () => {
        const signed = signInbound({ key: TEST_INBOUND_KEYS.tamm, source: 'tamm', timestamp: Math.floor(ctx.clock.now().getTime() / 1000), nonce: nonce(), body: JSON.stringify(BODY) });
        return ctx.app.inject({ method: 'POST', url: '/inbound/screens', headers: { 'content-type': 'application/json', ...signed }, payload: JSON.stringify({ ...BODY, locale: 'en' }) });
      });
      await refused('another source key', () => post({ source: 'tamm', key: TEST_INBOUND_KEYS.phc }));
      await refused('mangled', () => post({ overrides: { [INBOUND_HEADERS.signature]: 'ab'.repeat(32) } }));
    });

    it('no signature headers at all, with and without a bearer token of any kind', async () => {
      await refused('bare', () => ctx.app.inject({ method: 'POST', url: '/inbound/screens', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(BODY) }));
      const person = await registerPerson(ctx);
      await refused('person token', () => ctx.app.inject({ method: 'POST', url: '/inbound/screens', headers: { 'content-type': 'application/json', ...person.headers }, payload: JSON.stringify(BODY) }));
      const staff = await signIn(ctx, 'ops@demo.mawsool.test');
      await refused('staff token', () => ctx.app.inject({ method: 'POST', url: '/inbound/screens', headers: { 'content-type': 'application/json', authorization: `Bearer ${staff}` }, payload: JSON.stringify(BODY) }));
    });

    it('a source that is unknown or has no key on this server', async () => {
      await refused('unknown source', () => post({ overrides: { [INBOUND_HEADERS.source]: 'app' } }));
      const noPhc = await (await import('../src/app')).buildApp({
        db: testDb.db,
        clock: ctx.clock,
        config: { corsOrigins: [], clinicianAppUrl: 'http://x.test', opsAppUrl: 'http://y.test', encryptionKey: Buffer.alloc(32, 7).toString('base64'), summaryLlmEnabled: false, inboundKeys: { tamm: TEST_INBOUND_KEYS.tamm } },
      });
      try {
        const before = await counts();
        const raw = JSON.stringify(BODY);
        const headers = signInbound({ key: TEST_INBOUND_KEYS.phc, source: 'phc', timestamp: Math.floor(ctx.clock.now().getTime() / 1000), nonce: nonce(), body: raw });
        const res = await noPhc.inject({ method: 'POST', url: '/inbound/screens', headers: { 'content-type': 'application/json', ...headers }, payload: raw });
        expect(res.statusCode).toBe(401);
        expect(await counts()).toEqual(before);
      } finally {
        await noPhc.close();
      }
    });

    it('a request outside the time window, either way, signed correctly', async () => {
      const now = Math.floor(ctx.clock.now().getTime() / 1000);
      await refused('old', () => post({ timestamp: now - INBOUND_WINDOW_SECONDS - 1 }));
      await refused('future', () => post({ timestamp: now + INBOUND_WINDOW_SECONDS + 1 }));
      expect((await post({ timestamp: now - INBOUND_WINDOW_SECONDS })).statusCode).toBe(201);
    });

    it('a replay: the same signed request sent again, however soon', async () => {
      const raw = JSON.stringify(BODY);
      const stamp = Math.floor(ctx.clock.now().getTime() / 1000);
      const sameNonce = nonce();
      const first = await post({ raw, timestamp: stamp, nonce: sameNonce });
      expect(first.statusCode).toBe(201);
      const before = await counts();
      const second = await post({ raw, timestamp: stamp, nonce: sameNonce });
      expect(second.statusCode).toBe(401);
      expect(second.json()).toMatchObject({ error: 'replayed' });
      expect(await counts()).toEqual(before);
      // A different body signed with a used nonce is a replay too: the nonce is what is spent.
      const other = await post({ body: { ...BODY, locale: 'en' }, timestamp: stamp, nonce: sameNonce });
      expect(other.statusCode).toBe(401);
      expect(await counts()).toEqual(before);
    });

    it('while the nonce of one front door is free for another, because each is its own key', async () => {
      const shared = nonce();
      expect((await post({ source: 'tamm', nonce: shared })).statusCode).toBe(201);
      expect((await post({ source: 'phc', nonce: shared })).statusCode).toBe(201);
    });
  });

  it('refuses a correctly signed body that is not a positive screen, naming nothing it should not, with no invite', async () => {
    const before = await counts();
    for (const body of [{ ...BODY, result: 'negative' }, { ...BODY, name: 'Someone' }, { ...BODY, score: 14 }, { result: 'positive' }, { ...BODY, screenedAt: 'yesterday' }, { ...BODY, locale: 'ur' }]) {
      const res = await post({ body });
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
    const unparsable = await post({ raw: '{not json' });
    expect(unparsable.statusCode).toBe(400);
    expect((await counts()).invites).toBe(before.invites);
  });

  it('does not spend the nonce of a request whose body is refused: nothing was stored, so the corrected request is not a replay', async () => {
    const free = nonce();
    const before = await counts();
    expect((await post({ body: { ...BODY, result: 'negative' }, nonce: free })).statusCode).toBe(400);
    expect(await counts()).toEqual(before);
    expect((await post({ nonce: free })).statusCode).toBe(201);
    expect((await post({ nonce: free })).statusCode).toBe(401);
  });

  it('leaves the request retriable when the invite cannot be written: the nonce is not spent, and the same request then succeeds once', async () => {
    const request = nonce();
    const before = await counts();
    // The invite insert fails after the nonce was taken (a constraint that refuses every row stands in for a database fault).
    await testDb.db.execute(sql`ALTER TABLE inbound_invites ADD CONSTRAINT refuse_every_invite CHECK (false) NOT VALID`);
    const failed = await post({ nonce: request, timestamp: Math.floor(ctx.clock.now().getTime() / 1000) });
    await testDb.db.execute(sql`ALTER TABLE inbound_invites DROP CONSTRAINT refuse_every_invite`);
    expect(failed.statusCode).toBe(500);
    expect(await counts()).toEqual(before); // no invite, and no nonce spent
    const again = await post({ nonce: request });
    expect(again.statusCode).toBe(201);
    expect(await counts()).toEqual({ ...before, invites: before.invites + 1, nonces: before.nonces + 1 });
    expect((await post({ nonce: request })).json()).toMatchObject({ error: 'replayed' });
  });

  it('is not used by other routes: the raw-body parser lives in its own scope', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/auth/magic-link', headers: { 'content-type': 'application/json' }, payload: '{"email":"nobody@example.test"}' });
    expect(res.statusCode).toBe(202);
    const bad = await ctx.app.inject({ method: 'POST', url: '/auth/magic-link', headers: { 'content-type': 'application/json' }, payload: '{bad' });
    expect(bad.statusCode).toBe(400);
  });

  it('has nonces deleted by the sweep once they are older than the window needs', async () => {
    const used = nonce();
    await post({ nonce: used });
    const [stored] = await testDb.db.select().from(schema.inboundNonces).where(eq(schema.inboundNonces.nonce, used));
    expect(stored).toBeDefined();
    expect((await sweep(testDb.db, ctx.clock)).noncesDeleted).toBe(0);
    ctx.clock.advance(NONCE_RETENTION_MS + 1000);
    const result = await sweep(testDb.db, ctx.clock);
    expect(result.noncesDeleted).toBeGreaterThan(0);
    expect(await testDb.db.select().from(schema.inboundNonces).where(eq(schema.inboundNonces.nonce, used))).toEqual([]);
    ctx.clock.advance(-(NONCE_RETENTION_MS + 1000));
  });
});

describe('claiming an invite and its source reaching the ticket', () => {
  let testDb: TestDb;
  let ctx: TestApp;
  let gp: string;

  beforeAll(async () => {
    testDb = await createTestDb();
    await runSeed(testDb.db);
    ctx = await createTestApp(testDb.db);
    gp = await serviceAt(testDb.db, 'A', 'gp');
  });

  afterAll(async () => {
    await ctx.app.close();
    await testDb.close();
  });

  async function newInvite(source: InboundSource = 'tamm'): Promise<{ inviteId: string; code: string }> {
    const raw = JSON.stringify(BODY);
    const headers = signInbound({ key: TEST_INBOUND_KEYS[source], source, timestamp: Math.floor(ctx.clock.now().getTime() / 1000), nonce: nonce(), body: raw });
    const res = await ctx.app.inject({ method: 'POST', url: '/inbound/screens', headers: { 'content-type': 'application/json', ...headers }, payload: raw });
    return res.json() as { inviteId: string; code: string };
  }
  const claim = (person: { headers: { authorization: string } }, code: string) => ctx.app.inject({ method: 'POST', url: '/me/invites/claim', headers: person.headers, payload: { code } });
  const inviteRow = async (id: string) => (await testDb.db.select().from(schema.inboundInvites).where(eq(schema.inboundInvites.id, id)))[0]!;

  it('binds the invite to the person who sends the code, in any case and with or without the dash', async () => {
    for (const write of [(code: string) => code, (code: string) => code.toLowerCase(), (code: string) => code.replace('-', ''), (code: string) => ` ${code.replace('-', ' ')} `]) {
      const invite = await newInvite();
      const person = await registerPerson(ctx);
      const res = await claim(person, write(invite.code));
      expect(res.statusCode, write(invite.code)).toBe(200);
      expect(res.json()).toEqual({ inviteId: invite.inviteId, source: 'tamm', screenedAt: '2026-11-01T04:00:00.000Z' });
      expect(await inviteRow(invite.inviteId)).toMatchObject({ claimedBy: person.id, claimedAt: ctx.clock.now() });
    }
  });

  it('answers the holder again with the same invite, and everyone else with the same 404 as for a code that does not exist', async () => {
    const invite = await newInvite();
    const holder = await registerPerson(ctx);
    const other = await registerPerson(ctx);
    expect((await claim(holder, invite.code)).statusCode).toBe(200);
    const again = await claim(holder, invite.code);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ inviteId: invite.inviteId });
    const taken = await claim(other, invite.code);
    const missing = await claim(other, 'ZZZZ-ZZZZ');
    expect(taken.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(taken.body).toBe(missing.body);
    expect((await inviteRow(invite.inviteId)).claimedBy).toBe(holder.id);
  });

  it('lets only one of two people who send the same code at once have it', async () => {
    const invite = await newInvite();
    const people = await Promise.all([registerPerson(ctx), registerPerson(ctx)]);
    const results = await Promise.all(people.map((person) => claim(person, invite.code)));
    expect(results.map((res) => res.statusCode).sort()).toEqual([200, 404]);
    const winner = people[results.findIndex((res) => res.statusCode === 200)]!;
    expect((await inviteRow(invite.inviteId)).claimedBy).toBe(winner.id);
  });

  it('refuses a code after 30 days unless it was already claimed, and a code that is not a code', async () => {
    const stale = await newInvite();
    const claimed = await newInvite();
    const holder = await registerPerson(ctx);
    await claim(holder, claimed.code);
    ctx.clock.advance(30 * 24 * 3600 * 1000 + 1000);
    try {
      expect((await claim(await registerPerson(ctx), stale.code)).statusCode).toBe(404);
      expect((await claim(holder, claimed.code)).statusCode).toBe(200);
    } finally {
      ctx.clock.advance(-(30 * 24 * 3600 * 1000 + 1000));
    }
    for (const bad of ['', 'ABC', 'ABCD-EFGH-JKMN', 'ABCD-EFG0', 'ABCD-EFGI']) expect((await claim(holder, bad)).statusCode, bad).toBe(400);
  });

  it('gives a ticket the invite’s source, once, and records which ticket used the invite', async () => {
    const invite = await newInvite('tamm');
    const person = await registerPerson(ctx);
    await claim(person, invite.code);
    const first = await issue(ctx, person, ticketRequest(gp, { inviteId: invite.inviteId }));
    expect(first.source).toBe('tamm');
    expect((await inviteRow(invite.inviteId)).ticketId).toBe(first.id);
    const [stored] = await testDb.db.select({ source: schema.tickets.source }).from(schema.tickets).where(eq(schema.tickets.id, first.id));
    expect(stored!.source).toBe('tamm');
    // The clinic sees the same.
    const clinic = await signIn(ctx, 'clinician.a@demo.mawsool.test');
    const staffView = await ctx.app.inject({ method: 'GET', url: `/tickets/${first.id}`, headers: { authorization: `Bearer ${clinic}` } });
    expect(staffView.json()).toMatchObject({ source: 'tamm' });
    // A second ticket cannot use it again.
    const second = await issue(ctx, person, ticketRequest(gp, { inviteId: invite.inviteId }));
    expect(second.source).toBe('app');
    expect((await inviteRow(invite.inviteId)).ticketId).toBe(first.id);
  });

  it('takes each front door’s name through to the ticket', async () => {
    for (const source of INBOUND_SOURCES) {
      const invite = await newInvite(source);
      const person = await registerPerson(ctx);
      await claim(person, invite.code);
      expect((await issue(ctx, person, ticketRequest(gp, { inviteId: invite.inviteId }))).source).toBe(source);
    }
  });

  it('leaves the source as the app for an invite that is unclaimed, someone else’s, or not there', async () => {
    const invite = await newInvite('school');
    const owner = await registerPerson(ctx);
    const stranger = await registerPerson(ctx);
    expect((await issue(ctx, stranger, ticketRequest(gp, { inviteId: invite.inviteId }))).source).toBe('app');
    await claim(owner, invite.code);
    expect((await issue(ctx, stranger, ticketRequest(gp, { inviteId: invite.inviteId }))).source).toBe('app');
    expect((await issue(ctx, stranger, ticketRequest(gp, { inviteId: '00000000-0000-4000-8000-000000000999' }))).source).toBe('app');
    expect((await inviteRow(invite.inviteId)).ticketId).toBeNull();
    expect((await issue(ctx, owner, ticketRequest(gp, { inviteId: invite.inviteId }))).source).toBe('school');
  });

  it('keeps the first ticket’s source when the same request is sent again, and uses the invite once for two sent at once', async () => {
    const invite = await newInvite();
    const person = await registerPerson(ctx);
    await claim(person, invite.code);
    const request = ticketRequest(gp, { inviteId: invite.inviteId });
    const first = await issue(ctx, person, request);
    const again = await ctx.app.inject({ method: 'POST', url: '/tickets', headers: person.headers, payload: request });
    expect(again.statusCode).toBe(200);
    expect(again.json().ticket).toMatchObject({ id: first.id, source: 'tamm' });

    const racing = await newInvite('phc');
    await claim(person, racing.code);
    const sent = await Promise.all([ticketRequest(gp, { inviteId: racing.inviteId }), ticketRequest(gp, { inviteId: racing.inviteId })].map((body) => ctx.app.inject({ method: 'POST', url: '/tickets', headers: person.headers, payload: body })));
    expect(sent.map((res) => res.statusCode)).toEqual([201, 201]);
    expect(sent.map((res) => res.json().ticket.source).sort()).toEqual(['app', 'phc']);
  });

  it('is deleted by Delete everything: the invites the person claimed, used or not, leave no row tying their id to a screen, and the ticket keeps its source', async () => {
    const person = await registerPerson(ctx);
    const bystander = await registerPerson(ctx);
    const unused = await newInvite('phc');
    const used = await newInvite('tamm');
    const theirs = await newInvite('school');
    const unclaimed = await newInvite('tamm');
    await claim(person, unused.code);
    await claim(person, used.code);
    await claim(bystander, theirs.code);
    const ticket = await issue(ctx, person, ticketRequest(gp, { inviteId: used.inviteId }));
    expect((await inviteRow(used.inviteId)).ticketId).toBe(ticket.id);

    const erased = await ctx.app.inject({ method: 'DELETE', url: '/me/data', headers: person.headers });
    expect(erased.statusCode).toBe(200);

    // Raw rows: nothing is left that names this person.
    expect(await testDb.db.select().from(schema.inboundInvites).where(eq(schema.inboundInvites.claimedBy, person.id))).toEqual([]);
    for (const gone of [unused, used]) expect(await testDb.db.select().from(schema.inboundInvites).where(eq(schema.inboundInvites.id, gone.inviteId))).toEqual([]);
    // Someone else's claim and an unclaimed invite are untouched.
    expect((await inviteRow(theirs.inviteId)).claimedBy).toBe(bystander.id);
    expect((await inviteRow(unclaimed.inviteId)).claimedBy).toBeNull();
    // The ticket keeps its own source, and the deleted codes cannot be claimed again.
    const [stored] = await testDb.db.select({ source: schema.tickets.source }).from(schema.tickets).where(eq(schema.tickets.id, ticket.id));
    expect(stored!.source).toBe('tamm');
    expect((await claim(await registerPerson(ctx), unused.code)).statusCode).toBe(404);
  });

  it('does not apply an invite to a reroute, and the child ticket is an app ticket', async () => {
    const person = await registerPerson(ctx);
    const parent = await issue(ctx, person, ticketRequest(gp));
    const invite = await newInvite('tamm');
    await claim(person, invite.code);
    const res = await ctx.app.inject({ method: 'POST', url: `/me/tickets/${parent.id}/reroute`, headers: person.headers, payload: { ...ticketRequest(gp, { inviteId: invite.inviteId }), reason: 'cost' } });
    expect(res.statusCode).toBe(201);
    expect(res.json().ticket.source).toBe('app');
    expect((await inviteRow(invite.inviteId)).ticketId).toBeNull();
  });
});
