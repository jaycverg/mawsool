import { randomUUID } from 'node:crypto';
import { CRISIS_HANDOFF_ELEMENT, CrisisHandoffViewSchema } from '@mawsool/types';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crisisHandoffContext } from '../src/crisis-handoffs/service';
import { schema } from '../src/db/client';
import { sweep } from '../src/sweep';
import { loadCrisisFacts } from '../src/metrics/facts';
import { buildCrisis } from '../src/metrics/crisis';
import { runSeed } from '../src/seed/run';
import { createTestApp, signIn, TEST_START, type TestApp } from './helpers/app';
import { createTestDb, type TestDb } from './helpers/db';
import { CALLBACK, cipher, handoffBody, registerPerson, sendCrisisEvent, type TestPerson } from './helpers/flow';

describe('the optional hand-off to the mock crisis line', () => {
  let testDb: TestDb;
  let ctx: TestApp;
  let line: { authorization: string };

  beforeAll(async () => {
    testDb = await createTestDb();
    await runSeed(testDb.db, testDb.cipher);
    ctx = await createTestApp(testDb.db);
    line = { authorization: `Bearer ${await signIn(ctx, 'crisisline@demo.mawsool.test')}` };
  });

  afterAll(async () => {
    await ctx.app.close();
    await testDb.close();
  });

  const post = (person: TestPerson, body: unknown) => ctx.app.inject({ method: 'POST', url: '/me/crisis-handoffs', headers: person.headers, payload: body as object });
  const consoleGet = (url: string) => ctx.app.inject({ method: 'GET', url, headers: line });
  const handoffRows = () => testDb.db.select().from(schema.crisisHandoffs);
  const handoffConsents = () => testDb.db.select().from(schema.consents).where(eq(schema.consents.element, CRISIS_HANDOFF_ELEMENT));
  const eventRow = async (id: string) => (await testDb.db.select().from(schema.crisisEvents).where(eq(schema.crisisEvents.id, id)))[0]!;

  /** A person with a crisis event on the server and a consented hand-off. */
  async function handedOff(overrides: Record<string, unknown> = {}) {
    const person = await registerPerson(ctx);
    const eventId = await sendCrisisEvent(ctx, person);
    const res = await post(person, handoffBody(eventId, overrides));
    expect(res.statusCode).toBe(201);
    return { person, eventId, receipt: res.json() as { handoffId: string; consentId: string; grantedAt: string; created: boolean } };
  }

  it('records the consent in the ledger for the crisis line, with no ticket, and stores the template as ciphertext bound to its row', async () => {
    const { person, eventId, receipt } = await handedOff();
    const [consent] = await testDb.db.select().from(schema.consents).where(eq(schema.consents.id, receipt.consentId));
    expect(consent).toMatchObject({ personId: person.id, ticketId: null, recipient: 'crisis_line', element: 'crisis_handoff', revokedAt: null });
    const [row] = await testDb.db.select().from(schema.crisisHandoffs).where(eq(schema.crisisHandoffs.id, receipt.handoffId));
    expect(row).toMatchObject({ personId: person.id, crisisEventId: eventId, consentId: receipt.consentId });
    expect(row!.contentCiphertext).toMatch(/^v1\./);
    expect(row!.contentCiphertext).not.toContain(CALLBACK);
    expect(JSON.stringify(row)).not.toContain(CALLBACK);
    expect(JSON.parse(cipher.decrypt(row!.contentCiphertext, crisisHandoffContext(row!.id))).callbackNumber).toBe(CALLBACK);
    expect(() => cipher.decrypt(row!.contentCiphertext, crisisHandoffContext(randomUUID()))).toThrow();
    expect((await eventRow(eventId)).contextShared).toBe(true);
  });

  it('keeps the person off the crisis event: the event table has no person column, and the console sees neither id', async () => {
    const { person, eventId, receipt } = await handedOff();
    const columns = Object.keys(schema.crisisEvents).filter((name) => /person/i.test(name));
    expect(columns).toEqual([]);
    const read = await consoleGet(`/crisis-handoffs/${receipt.handoffId}`);
    expect(read.statusCode).toBe(200);
    expect(read.body).not.toContain(person.id);
    expect(read.body).not.toContain(eventId);
  });

  it('refuses a hand-off posted without the consent, and writes no row at all', async () => {
    const person = await registerPerson(ctx);
    const eventId = await sendCrisisEvent(ctx, person);
    const before = { handoffs: (await handoffRows()).length, consents: (await handoffConsents()).length };
    const withoutField = { ...handoffBody(eventId) } as Record<string, unknown>;
    delete withoutField.consented;
    for (const body of [withoutField, handoffBody(eventId, { consented: false }), handoffBody(eventId, { consented: 'yes' })]) {
      expect((await post(person, body)).statusCode).toBe(400);
    }
    expect({ handoffs: (await handoffRows()).length, consents: (await handoffConsents()).length }).toEqual(before);
    expect((await eventRow(eventId)).contextShared).toBe(false);
  });

  it('refuses a body that carries anything beyond the template, or a number that is not one, with no row', async () => {
    const person = await registerPerson(ctx);
    const eventId = await sendCrisisEvent(ctx, person);
    const before = (await handoffRows()).length;
    for (const extra of [{ answers: [0, 1, 3] }, { callbackNumber: '0501234567' }, { scores: Array.from({ length: 4 }, () => handoffBody(eventId).scores[0]) }, { language: 'ur' }]) {
      expect((await post(person, handoffBody(eventId, extra))).statusCode, JSON.stringify(Object.keys(extra))).toBe(400);
    }
    expect((await handoffRows()).length).toBe(before);
  });

  it('takes a hand-off with no callback number and no scores, because both are optional', async () => {
    const { receipt } = await handedOff({ callbackNumber: null, scores: [] });
    const read = await consoleGet(`/crisis-handoffs/${receipt.handoffId}`);
    expect(CrisisHandoffViewSchema.parse(read.json())).toMatchObject({ callbackNumber: null, scores: [], trigger: 'phq9_item9', language: 'en' });
  });

  it('refuses a hand-off for a crisis event the server does not hold yet, and leaves no consent behind', async () => {
    const person = await registerPerson(ctx);
    const before = { handoffs: (await handoffRows()).length, consents: (await handoffConsents()).length };
    const res = await post(person, handoffBody(randomUUID()));
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('crisis_event_unknown');
    expect({ handoffs: (await handoffRows()).length, consents: (await handoffConsents()).length }).toEqual(before);
  });

  it('answers a repeated send of the same hand-off with the first one (a lost reply), leaving one row and one consent; any other claim on that event or id is a conflict', async () => {
    const person = await registerPerson(ctx);
    const eventId = await sendCrisisEvent(ctx, person);
    const body = handoffBody(eventId);
    const first = await post(person, body);
    const again = await post(person, body);
    expect([first.statusCode, again.statusCode]).toEqual([201, 200]);
    expect(first.json().handoffId).toBe(body.handoffId);
    expect(again.json()).toMatchObject({ handoffId: first.json().handoffId, consentId: first.json().consentId, created: false });
    expect((await handoffRows()).filter((row) => row.crisisEventId === eventId)).toHaveLength(1);
    expect((await handoffConsents()).filter((row) => row.personId === person.id)).toHaveLength(1);
    const stranger = await registerPerson(ctx);
    expect((await post(stranger, handoffBody(eventId))).statusCode).toBe(409);
    expect((await post(stranger, { ...body, handoffId: body.handoffId })).statusCode).toBe(409);
    expect((await post(person, handoffBody(eventId))).statusCode).toBe(409); // a different hand-off id for an event that already has one
    expect((await handoffConsents()).filter((row) => row.personId === stranger.id)).toHaveLength(0);
    expect((await handoffConsents()).filter((row) => row.personId === person.id)).toHaveLength(1);
  });

  it('lets the crisis-line role read a consented hand-off, in the list and singly', async () => {
    const { receipt } = await handedOff();
    const list = await consoleGet('/crisis-handoffs');
    expect(list.statusCode).toBe(200);
    const item = list.json().items.find((entry: { id: string }) => entry.id === receipt.handoffId);
    expect(item).toMatchObject({ language: 'en', trigger: 'phq9_item9', callbackNumber: CALLBACK, contactMadeAt: null });
    expect(item.scores).toEqual([{ instrument: 'phq9', total: 14 }]);
    expect(Object.keys(item).sort()).toEqual(['callbackNumber', 'contactMadeAt', 'id', 'language', 'receivedAt', 'scores', 'trigger']);
  });

  it('stores a total as an instrument and a total only: a band and a time sent by an older copy of the app are dropped, not stored and not shown', async () => {
    const OLD_SCORES = [{ instrument: 'phq9', total: 14, band: 'moderate', takenAt: '2026-11-01T08:00:00+04:00' }, { instrument: 'gad7', total: 9, band: 'mild', takenAt: '2026-11-01T08:05:00+04:00' }];
    const { receipt } = await handedOff({ scores: OLD_SCORES });
    const [row] = await testDb.db.select().from(schema.crisisHandoffs).where(eq(schema.crisisHandoffs.id, receipt.handoffId));
    const stored = JSON.parse(cipher.decrypt(row!.contentCiphertext, crisisHandoffContext(row!.id)));
    expect(stored.scores).toEqual([{ instrument: 'phq9', total: 14 }, { instrument: 'gad7', total: 9 }]);
    const read = await consoleGet(`/crisis-handoffs/${receipt.handoffId}`);
    expect(read.json().scores).toEqual([{ instrument: 'phq9', total: 14 }, { instrument: 'gad7', total: 9 }]);
    expect(read.body).not.toMatch(/moderate|mild|takenAt|2026-11-01T08/);
  });

  it('still reads a note stored before the band and the time were dropped, and shows it without them', async () => {
    const { receipt } = await handedOff();
    const [row] = await testDb.db.select().from(schema.crisisHandoffs).where(eq(schema.crisisHandoffs.id, receipt.handoffId));
    const old = { language: 'en', trigger: 'phq9_item9', scores: [{ instrument: 'phq9', total: 21, band: 'severe', takenAt: '2026-10-30T09:00:00+04:00' }], callbackNumber: CALLBACK };
    await testDb.db.update(schema.crisisHandoffs).set({ contentCiphertext: cipher.encrypt(JSON.stringify(old), crisisHandoffContext(row!.id)) }).where(eq(schema.crisisHandoffs.id, row!.id));
    for (const url of [`/crisis-handoffs/${receipt.handoffId}`, '/crisis-handoffs']) {
      const read = await consoleGet(url);
      expect(read.statusCode, url).toBe(200);
      const item = url.endsWith('s') ? read.json().items.find((entry: { id: string }) => entry.id === receipt.handoffId) : read.json();
      expect(item.scores, url).toEqual([{ instrument: 'phq9', total: 21 }]);
      expect(read.body, url).not.toMatch(/severe|takenAt|2026-10-30/);
    }
  });

  it('deletes the row on revoke: the raw row and its ledger row are gone, and the console read is 404', async () => {
    const { person, eventId, receipt } = await handedOff();
    const revoked = await ctx.app.inject({ method: 'DELETE', url: `/me/crisis-handoffs/${receipt.handoffId}`, headers: person.headers });
    expect(revoked.statusCode).toBe(200);
    expect(await testDb.db.select().from(schema.crisisHandoffs).where(eq(schema.crisisHandoffs.id, receipt.handoffId))).toEqual([]);
    // The ledger row goes with the hand-off: left behind it would keep the person against the time of the hand-off.
    expect(await testDb.db.select().from(schema.consents).where(eq(schema.consents.id, receipt.consentId))).toEqual([]);
    expect((await consoleGet(`/crisis-handoffs/${receipt.handoffId}`)).statusCode).toBe(404);
    expect((await consoleGet('/crisis-handoffs')).json().items.map((entry: { id: string }) => entry.id)).not.toContain(receipt.handoffId);
    const contact = await ctx.app.inject({ method: 'POST', url: `/crisis-handoffs/${receipt.handoffId}/contact`, headers: line });
    expect(contact.statusCode).toBe(404);
    expect((await eventRow(eventId)).humanContactConfirmed).toBe(false);
    expect((await ctx.app.inject({ method: 'DELETE', url: `/me/crisis-handoffs/${receipt.handoffId}`, headers: person.headers })).statusCode).toBe(404);
  });

  it('lets a person send again after stopping, as a new hand-off with a new consent', async () => {
    const { person, eventId, receipt } = await handedOff();
    await ctx.app.inject({ method: 'DELETE', url: `/me/crisis-handoffs/${receipt.handoffId}`, headers: person.headers });
    const again = await post(person, handoffBody(eventId));
    expect(again.statusCode).toBe(201);
    expect(again.json().handoffId).not.toBe(receipt.handoffId);
    expect(again.json().consentId).not.toBe(receipt.consentId);
  });

  it('reaches only the caller’s own hand-off to revoke: another person gets 404 and the row stays', async () => {
    const { receipt } = await handedOff();
    const stranger = await registerPerson(ctx);
    expect((await ctx.app.inject({ method: 'DELETE', url: `/me/crisis-handoffs/${receipt.handoffId}`, headers: stranger.headers })).statusCode).toBe(404);
    expect((await consoleGet(`/crisis-handoffs/${receipt.handoffId}`)).statusCode).toBe(200);
  });

  it('checks the ledger on every console read, not only the row: a revoked consent with a row left behind is not readable and cannot be marked', async () => {
    const { eventId, receipt } = await handedOff();
    await testDb.db.update(schema.consents).set({ revokedAt: new Date() }).where(eq(schema.consents.id, receipt.consentId));
    expect((await handoffRows()).some((row) => row.id === receipt.handoffId)).toBe(true);
    expect((await consoleGet(`/crisis-handoffs/${receipt.handoffId}`)).statusCode).toBe(404);
    expect((await consoleGet('/crisis-handoffs')).json().items.map((entry: { id: string }) => entry.id)).not.toContain(receipt.handoffId);
    expect((await ctx.app.inject({ method: 'POST', url: `/crisis-handoffs/${receipt.handoffId}/contact`, headers: line })).statusCode).toBe(404);
    expect((await eventRow(eventId)).humanContactConfirmed).toBe(false);
  });

  it('completes the event on "contact made": confirmed by the mock line, resolved, stamped on the care clock', async () => {
    const { eventId, receipt } = await handedOff();
    ctx.clock.set(new Date('2026-11-01T08:12:00+04:00'));
    const res = await ctx.app.inject({ method: 'POST', url: `/crisis-handoffs/${receipt.handoffId}/contact`, headers: line });
    expect(res.statusCode).toBe(200);
    expect(res.json().contactMadeAt).toBe('2026-11-01T04:12:00.000Z');
    expect(await eventRow(eventId)).toMatchObject({ humanContactConfirmed: true, contactSource: 'mock_line', contactAt: new Date('2026-11-01T04:12:00.000Z'), resolvedAt: new Date('2026-11-01T04:12:00.000Z') });
  });

  it('counts one contact once: a second press changes nothing, and a contact the person already confirmed keeps its source and time', async () => {
    const mine = await handedOff();
    ctx.clock.set(new Date('2026-11-01T09:00:00+04:00'));
    await ctx.app.inject({ method: 'POST', url: `/crisis-handoffs/${mine.receipt.handoffId}/contact`, headers: line });
    ctx.clock.set(new Date('2026-11-01T10:00:00+04:00'));
    const second = await ctx.app.inject({ method: 'POST', url: `/crisis-handoffs/${mine.receipt.handoffId}/contact`, headers: line });
    expect(second.json().contactMadeAt).toBe('2026-11-01T05:00:00.000Z');
    expect((await eventRow(mine.eventId)).contactAt).toEqual(new Date('2026-11-01T05:00:00.000Z'));

    const person = await registerPerson(ctx);
    const eventId = await sendCrisisEvent(ctx, person, { humanContactConfirmed: true, contactSource: 'self_report', contactAt: '2026-11-01T08:30:00+04:00' });
    const receipt = (await post(person, handoffBody(eventId))).json();
    ctx.clock.set(new Date('2026-11-01T11:00:00+04:00'));
    await ctx.app.inject({ method: 'POST', url: `/crisis-handoffs/${receipt.handoffId}/contact`, headers: line });
    expect(await eventRow(eventId)).toMatchObject({ contactSource: 'self_report', contactAt: new Date('2026-11-01T04:30:00.000Z'), resolvedAt: new Date('2026-11-01T07:00:00.000Z') });
  });

  it('shows up once in the dashboard’s crisis figures: confirmations from the console and from the phone are one row each', async () => {
    const before = (await loadCrisisFacts(testDb.db)).filter((fact) => fact.contactConfirmed).length;
    const { receipt } = await handedOff();
    await ctx.app.inject({ method: 'POST', url: `/crisis-handoffs/${receipt.handoffId}/contact`, headers: line });
    await ctx.app.inject({ method: 'POST', url: `/crisis-handoffs/${receipt.handoffId}/contact`, headers: line });
    const facts = await loadCrisisFacts(testDb.db);
    expect(facts.filter((fact) => fact.contactConfirmed)).toHaveLength(before + 1);
    // Through the same suppression as every figure: a count under ten is not published as a number.
    const figures = buildCrisis('all', facts.slice(0, 3), null);
    expect(figures.contactConfirmed).toEqual({ suppressed: true });
  });

  it('is reached by "Delete everything": the row and its ledger row are deleted and the console reads 404', async () => {
    const { person, receipt } = await handedOff();
    const erased = await ctx.app.inject({ method: 'DELETE', url: '/me/data', headers: person.headers });
    expect(erased.statusCode).toBe(200);
    expect(await testDb.db.select().from(schema.crisisHandoffs).where(eq(schema.crisisHandoffs.personId, person.id))).toEqual([]);
    expect(await testDb.db.select().from(schema.consents).where(and(eq(schema.consents.personId, person.id), eq(schema.consents.element, CRISIS_HANDOFF_ELEMENT)))).toEqual([]);
    expect((await consoleGet(`/crisis-handoffs/${receipt.handoffId}`)).statusCode).toBe(404);
  });

  it('leaves a ticket consent alone and the generic revoke route cannot reach a hand-off consent', async () => {
    const { person, receipt } = await handedOff();
    const res = await ctx.app.inject({ method: 'DELETE', url: `/consents/${receipt.consentId}`, headers: person.headers });
    expect(res.statusCode).toBe(404);
    expect((await consoleGet(`/crisis-handoffs/${receipt.handoffId}`)).statusCode).toBe(200);
  });

  describe('a send that was already on its way when the person stopped', () => {
    const rowsFor = (id: string) => testDb.db.select().from(schema.crisisHandoffs).where(eq(schema.crisisHandoffs.id, id));

    it('is refused when the stop arrived first: the id is unknown to the server, the stop is 404, and the late send is 409 with no row and no ledger entry', async () => {
      const person = await registerPerson(ctx);
      const eventId = await sendCrisisEvent(ctx, person);
      const body = handoffBody(eventId);
      const consentsBefore = (await handoffConsents()).length;
      expect((await ctx.app.inject({ method: 'DELETE', url: `/me/crisis-handoffs/${body.handoffId}`, headers: person.headers })).statusCode).toBe(404);
      expect(await testDb.db.select().from(schema.revokedHandoffs).where(eq(schema.revokedHandoffs.handoffId, body.handoffId))).toHaveLength(1);
      const late = await post(person, body);
      expect(late.statusCode).toBe(409);
      expect(late.json().error).toBe('handoff_stopped');
      expect(await rowsFor(body.handoffId)).toEqual([]);
      expect((await handoffConsents()).length).toBe(consentsBefore);
      expect((await eventRow(eventId)).contextShared).toBe(false);
      expect((await consoleGet(`/crisis-handoffs/${body.handoffId}`)).statusCode).toBe(404);
    });

    it('is refused when the hand-off had already been stopped once, so a repeated request cannot bring it back', async () => {
      const { person, eventId, receipt } = await handedOff();
      await ctx.app.inject({ method: 'DELETE', url: `/me/crisis-handoffs/${receipt.handoffId}`, headers: person.headers });
      const again = await post(person, { ...handoffBody(eventId), handoffId: receipt.handoffId });
      expect(again.statusCode).toBe(409);
      expect(await rowsFor(receipt.handoffId)).toEqual([]);
    });

    it('is refused after Delete everything too', async () => {
      const { person, eventId, receipt } = await handedOff();
      await ctx.app.inject({ method: 'DELETE', url: '/me/data', headers: person.headers });
      const again = await post(person, { ...handoffBody(eventId), handoffId: receipt.handoffId });
      expect(again.statusCode).toBe(409);
      expect(await rowsFor(receipt.handoffId)).toEqual([]);
    });

    it('is refused after Delete everything even when the server had never seen the id: the phone lists it with the erase', async () => {
      const person = await registerPerson(ctx);
      const eventId = await sendCrisisEvent(ctx, person);
      const body = handoffBody(eventId);
      const consentsBefore = (await handoffConsents()).length;
      const erased = await ctx.app.inject({ method: 'DELETE', url: '/me/data', headers: person.headers, payload: { handoffIds: [body.handoffId] } });
      expect(erased.statusCode).toBe(200);
      const late = await post(person, body);
      expect(late.statusCode).toBe(409);
      expect(late.json().error).toBe('handoff_stopped');
      expect(await rowsFor(body.handoffId)).toEqual([]);
      expect((await handoffConsents()).length).toBe(consentsBefore);
      expect((await consoleGet(`/crisis-handoffs/${body.handoffId}`)).statusCode).toBe(404);
    });

    it('still lets a person erase with no body at all, and refuses a body that is not a list of ids', async () => {
      const person = await registerPerson(ctx);
      expect((await ctx.app.inject({ method: 'DELETE', url: '/me/data', headers: person.headers })).statusCode).toBe(200);
      expect((await ctx.app.inject({ method: 'DELETE', url: '/me/data', headers: person.headers, payload: { handoffIds: ['nope'] } })).statusCode).toBe(400);
    });

    it('does not remember a stop for an id that another person holds: the answer is the unknown-id 404, nothing is written, and the owner can still replay and be read', async () => {
      const { person: owner, eventId, receipt } = await handedOff();
      const stranger = await registerPerson(ctx);
      const stop = await ctx.app.inject({ method: 'DELETE', url: `/me/crisis-handoffs/${receipt.handoffId}`, headers: stranger.headers });
      expect(stop.statusCode).toBe(404);
      expect(await testDb.db.select().from(schema.revokedHandoffs).where(eq(schema.revokedHandoffs.handoffId, receipt.handoffId))).toEqual([]);
      expect(await rowsFor(receipt.handoffId)).toHaveLength(1);
      const replay = await post(owner, { ...handoffBody(eventId), handoffId: receipt.handoffId });
      expect(replay.statusCode).toBe(200);
      expect(replay.json().created).toBe(false);
      expect((await consoleGet(`/crisis-handoffs/${receipt.handoffId}`)).statusCode).toBe(200);
    });

    it('does not remember an id that another person holds when it comes in a Delete everything list either, and still erases the sender’s own', async () => {
      const { person: owner, eventId, receipt } = await handedOff();
      const stranger = await registerPerson(ctx);
      const strangersOwn = randomUUID();
      const erased = await ctx.app.inject({ method: 'DELETE', url: '/me/data', headers: stranger.headers, payload: { handoffIds: [receipt.handoffId, strangersOwn] } });
      expect(erased.statusCode).toBe(200);
      const remembered = (await testDb.db.select().from(schema.revokedHandoffs)).map((row) => row.handoffId);
      expect(remembered).toContain(strangersOwn);
      expect(remembered).not.toContain(receipt.handoffId);
      expect((await post(owner, { ...handoffBody(eventId), handoffId: receipt.handoffId })).statusCode).toBe(200);
      expect((await consoleGet(`/crisis-handoffs/${receipt.handoffId}`)).statusCode).toBe(200);
    });

    it('still remembers a stop for an id nobody holds, so the late send of the real owner is refused', async () => {
      const person = await registerPerson(ctx);
      const eventId = await sendCrisisEvent(ctx, person);
      const body = handoffBody(eventId);
      const other = await registerPerson(ctx);
      expect((await ctx.app.inject({ method: 'DELETE', url: `/me/crisis-handoffs/${body.handoffId}`, headers: other.headers })).statusCode).toBe(404);
      expect(await testDb.db.select().from(schema.revokedHandoffs).where(eq(schema.revokedHandoffs.handoffId, body.handoffId))).toHaveLength(1);
      expect((await post(person, body)).statusCode).toBe(409);
    });

    it('remembers the id and the time of the stop and nothing else, then forgets it an hour later', async () => {
      expect(Object.keys(schema.revokedHandoffs).filter((name) => /person|event|consent|content/i.test(name))).toEqual([]);
      const old = randomUUID();
      const fresh = randomUUID();
      const now = ctx.clock.now();
      await testDb.db.insert(schema.revokedHandoffs).values([
        { handoffId: old, revokedAt: new Date(now.getTime() - 61 * 60_000) },
        { handoffId: fresh, revokedAt: new Date(now.getTime() - 59 * 60_000) },
      ]);
      const result = await sweep(testDb.db, ctx.clock);
      expect(result.stopsForgotten).toBeGreaterThanOrEqual(1);
      const left = (await testDb.db.select().from(schema.revokedHandoffs)).map((row) => row.handoffId);
      expect(left).toContain(fresh);
      expect(left).not.toContain(old);
    });
  });

  describe('after a stop or an erase nothing the server keeps ties the person to the crisis event', () => {
    /** Every row in any table that names the person and, by id or by time, could be set beside the crisis event. */
    async function tiesOf(personId: string, eventId: string, receipt: { handoffId: string }) {
      const ledger = await testDb.db.select().from(schema.consents).where(eq(schema.consents.personId, personId));
      const handoffs = await testDb.db.select().from(schema.crisisHandoffs).where(eq(schema.crisisHandoffs.personId, personId));
      const remembered = await testDb.db.select().from(schema.revokedHandoffs).where(eq(schema.revokedHandoffs.handoffId, receipt.handoffId));
      const [event] = await testDb.db.select().from(schema.crisisEvents).where(eq(schema.crisisEvents.id, eventId));
      return { ledger: ledger.length, handoffs: handoffs.length, rememberedWithPerson: remembered.filter((row) => JSON.stringify(row).includes(personId)).length, eventHasPerson: JSON.stringify(event).includes(personId) };
    }

    it('after Stop: no ledger row, no hand-off row, no person on the remembered stop or the event, and the event is still counted once', async () => {
      const { person, eventId, receipt } = await handedOff();
      const counted = (await loadCrisisFacts(testDb.db)).length;
      expect((await tiesOf(person.id, eventId, receipt)).ledger).toBe(1);
      await ctx.app.inject({ method: 'DELETE', url: `/me/crisis-handoffs/${receipt.handoffId}`, headers: person.headers });
      expect(await tiesOf(person.id, eventId, receipt)).toEqual({ ledger: 0, handoffs: 0, rememberedWithPerson: 0, eventHasPerson: false });
      expect((await loadCrisisFacts(testDb.db)).length).toBe(counted);
    });

    it('after Delete everything: the same', async () => {
      const { person, eventId, receipt } = await handedOff();
      await ctx.app.inject({ method: 'DELETE', url: '/me/data', headers: person.headers });
      expect(await tiesOf(person.id, eventId, receipt)).toEqual({ ledger: 0, handoffs: 0, rememberedWithPerson: 0, eventHasPerson: false });
    });
  });
});

describe('a remembered stop on the demo clock', () => {
  let testDb: TestDb;
  let ctx: TestApp;
  let admin: { authorization: string };

  beforeAll(async () => {
    testDb = await createTestDb();
    await runSeed(testDb.db, testDb.cipher);
    ctx = await createTestApp(testDb.db, { demoMode: true });
    admin = { authorization: `Bearer ${await signIn(ctx, 'admin@demo.mawsool.test')}` };
  });

  afterAll(async () => {
    await ctx.app.close();
    await testDb.close();
  });

  const stoppedAt = async (id: string) => (await testDb.db.select().from(schema.revokedHandoffs).where(eq(schema.revokedHandoffs.handoffId, id)))[0]?.revokedAt;

  it('is written and kept on the wall clock: a care clock step of seven days and its sweep do not forget a fresh stop, and a late send is still refused', async () => {
    const person = await registerPerson(ctx);
    const eventId = await sendCrisisEvent(ctx, person);
    const before = handoffBody(eventId);
    const after = handoffBody(eventId);
    expect((await ctx.app.inject({ method: 'DELETE', url: `/me/crisis-handoffs/${before.handoffId}`, headers: person.headers })).statusCode).toBe(404);
    const advanced = await ctx.app.inject({ method: 'POST', url: '/demo/clock/advance', headers: admin, payload: { by: '7d' } });
    expect(advanced.statusCode).toBe(200);
    expect(await stoppedAt(before.handoffId)).toEqual(TEST_START);
    // A stop made after the step is stamped with the wall clock too, not with the care clock a week ahead of it.
    expect((await ctx.app.inject({ method: 'DELETE', url: `/me/crisis-handoffs/${after.handoffId}`, headers: person.headers })).statusCode).toBe(404);
    expect(await stoppedAt(after.handoffId)).toEqual(TEST_START);
    const sweptAgain = await sweep(testDb.db, ctx.app.careClock, {}, ctx.clock);
    expect(sweptAgain.stopsForgotten).toBe(0);
    for (const body of [before, after]) {
      const late = await ctx.app.inject({ method: 'POST', url: '/me/crisis-handoffs', headers: person.headers, payload: body });
      expect(late.statusCode).toBe(409);
      expect(late.json().error).toBe('handoff_stopped');
    }
  });

  it('is still forgotten an hour of wall time later', async () => {
    const person = await registerPerson(ctx);
    const body = handoffBody(await sendCrisisEvent(ctx, person));
    await ctx.app.inject({ method: 'DELETE', url: `/me/crisis-handoffs/${body.handoffId}`, headers: person.headers });
    ctx.clock.advance(61 * 60_000);
    const swept = await sweep(testDb.db, ctx.app.careClock, {}, ctx.clock);
    expect(swept.stopsForgotten).toBeGreaterThanOrEqual(1);
    expect(await stoppedAt(body.handoffId)).toBeUndefined();
  });
});
