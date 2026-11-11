import { RELIABLE_CHANGE, remeasureAvailableAt } from '@mawsool/rules';
import type { OutcomesResponse, ScoreEntry } from '@mawsool/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import { loadTicketFacts } from '../src/metrics/facts';
import { journeysOf, remeasuredHiddenInFunnel } from '../src/metrics/funnel';
import { buildOutcomes, countOutcomes, loadOutcomeFacts, totalsPair, type OutcomeFact, type TotalsPair } from '../src/metrics/outcomes';
import { bundleContext } from '../src/tickets/service';
import { createTestApp, TEST_START, type TestApp } from './helpers/app';
import { createTestDb, type TestDb } from './helpers/db';
import { cipher } from './helpers/flow';
import { DAY, HOUR, createWorld } from './helpers/world';

type World = Awaited<ReturnType<typeof createWorld>>;

let testDb: TestDb;
let ctx: TestApp;
let world: World;
let headers: { authorization: string };

beforeEach(async () => {
  testDb = await createTestDb();
  world = await createWorld(testDb.db);
  ctx = await createTestApp(testDb.db);
  headers = await world.opsHeaders();
});

afterEach(async () => {
  await ctx.app.close();
  await testDb.close();
});

const outcomes = async (period = 'all'): Promise<OutcomesResponse> => {
  const res = await ctx.app.inject({ method: 'GET', url: `/metrics/outcomes?period=${period}`, headers });
  if (res.statusCode !== 200) throw new Error(`${res.statusCode} ${res.body}`);
  return res.json() as OutcomesResponse;
};
const instrument = (response: OutcomesResponse, name: 'phq9' | 'gad7') => response.instruments.find((entry) => entry.instrument === name)!;
const SUPPRESSED = { suppressed: true };

/** Issued 100 days before the test clock; seen two days later; so the repeat check opened 44 days after that, well before now. */
const ISSUED = new Date(TEST_START.getTime() - 100 * DAY);
const SEEN_AT = new Date(ISSUED.getTime() + 2 * DAY);
const OPENS = remeasureAvailableAt(SEEN_AT);

const score = (instrumentName: 'phq9' | 'gad7', total: number, takenAt: Date): ScoreEntry => ({ instrument: instrumentName, total, band: null, takenAt: takenAt.toISOString() });
const referral = (instrumentName: 'phq9' | 'gad7', total: number) => score(instrumentName, total, new Date(ISSUED.getTime() - HOUR));
const repeat = (instrumentName: 'phq9' | 'gad7', total: number) => score(instrumentName, total, new Date(OPENS.getTime() + HOUR));

interface Shared {
  scores?: ScoreEntry[];
  /** Which consent rows exist: `ticket` and `scores` live by default. */
  consents?: { element: string; revoked?: boolean }[];
  /** `deleted` keeps the ciphertext and sets `deleted_at`, so the test proves the flag and not the emptied column. */
  bundle?: 'live' | 'deleted' | 'none' | 'damaged';
  /** The ticket this one is a reroute of. */
  parent?: string;
  issuedAt?: Date;
  person?: string;
  state?: ('acknowledged' | 'seen' | 'remeasured' | 'closed')[];
}

/** A ticket that went issued, acknowledged, seen, remeasured, closed, with what it shared (or not). */
async function addRemeasured(shared: Shared = {}): Promise<string> {
  const issuedAt = shared.issuedAt ?? ISSUED;
  const ticket = await world.addTicket({ issuedAt, path: shared.state ?? ['acknowledged', 'seen', 'remeasured', 'closed'], hours: [1, 48, 24 * 50, 24 * 50 + 1], person: shared.person, parent: shared.parent });
  const consents = shared.consents ?? [{ element: 'ticket' }, { element: 'scores' }];
  for (const consent of consents) {
    await testDb.db.insert(schema.consents).values({
      personId: ticket.personId,
      ticketId: ticket.id,
      recipient: 'facility',
      element: consent.element as 'ticket',
      grantedAt: issuedAt,
      revokedAt: consent.revoked ? new Date(issuedAt.getTime() + DAY) : null,
    });
  }
  const bundle = shared.bundle ?? 'live';
  if (bundle !== 'none') {
    const content = bundle === 'damaged' ? 'not encrypted at all' : cipher.encrypt(JSON.stringify({ scores: shared.scores ?? [] }), bundleContext(ticket.id));
    await testDb.db.insert(schema.sharedBundles).values({ ticketId: ticket.id, recipient: 'facility', contentCiphertext: content, createdAt: issuedAt, deletedAt: bundle === 'deleted' ? new Date(issuedAt.getTime() + DAY) : null });
  }
  return ticket.id;
}

/** Adds `count` re-measured tickets that each shared a PHQ-9 and a GAD-7 pair with these changes (repeat total minus referral total). */
async function addMany(count: number, change: { phq9: number | null; gad7: number | null }, base = { phq9: 14, gad7: 12 }) {
  for (let i = 0; i < count; i += 1) {
    const scores: ScoreEntry[] = [];
    if (change.phq9 !== null) scores.push(referral('phq9', base.phq9), repeat('phq9', base.phq9 + change.phq9));
    if (change.gad7 !== null) scores.push(referral('gad7', base.gad7), repeat('gad7', base.gad7 + change.gad7));
    await addRemeasured({ scores });
  }
}

const factsOf = async (): Promise<OutcomeFact[]> => loadOutcomeFacts(testDb.db, cipher, await loadTicketFacts(testDb.db));
const totalsOf = async (id: string): Promise<{ phq9: TotalsPair; gad7: TotalsPair }> => {
  const tickets = await loadTicketFacts(testDb.db);
  const facts = await loadOutcomeFacts(testDb.db, cipher, tickets.filter((ticket) => ticket.id === id));
  expect(facts).toHaveLength(1);
  return facts[0]!.totals;
};

describe('symptom change among re-measured tickets', () => {
  it('works out the mean change and the two shares on a fixture, with the thresholds from the rules config and exactly-the-threshold counted as reliable', async () => {
    expect(RELIABLE_CHANGE).toEqual({ phq9: 6, gad7: 4 });
    // PHQ-9: 6 at exactly -6 and 6 at -10 (reliable improvement), 10 at exactly +6 (reliable deterioration), 10 at +1 (none).
    // GAD-7: 6 at exactly -4 and 6 at -5 (improvement), 10 at exactly +4 (deterioration), 10 at -3 (none). 32 tickets each.
    await addMany(6, { phq9: -6, gad7: -4 });
    await addMany(6, { phq9: -10, gad7: -5 });
    await addMany(10, { phq9: 6, gad7: 4 });
    await addMany(10, { phq9: 1, gad7: -3 });
    const response = await outcomes();
    const phq9Sum = 6 * -6 + 6 * -10 + 10 * 6 + 10 * 1; // -26
    const gad7Sum = 6 * -4 + 6 * -5 + 10 * 4 + 10 * -3; // -20
    expect(response.reliableChangePoints).toEqual({ phq9: 6, gad7: 4 });
    expect(response.remeasured).toBe(32);
    expect(instrument(response, 'phq9')).toEqual({
      instrument: 'phq9',
      included: 32,
      excluded: SUPPRESSED, // none excluded: a count of zero is under ten like any other
      meanChange: Math.round((phq9Sum / 32) * 10) / 10,
      reliableImprovement: { count: 12, of: 32, percent: 37.5 },
      reliableDeterioration: { count: 10, of: 32, percent: 31.3 },
    });
    expect(instrument(response, 'gad7')).toEqual({
      instrument: 'gad7',
      included: 32,
      excluded: SUPPRESSED, // none excluded: a count of zero is under ten like any other
      meanChange: Math.round((gad7Sum / 32) * 10) / 10,
      reliableImprovement: { count: 12, of: 32, percent: 37.5 },
      reliableDeterioration: { count: 10, of: 32, percent: 31.3 },
    });
  });

  it('counts a change one point short of the threshold as no reliable change, and the threshold itself as reliable, in both directions', () => {
    const fact = (phq9: number, gad7: number): OutcomeFact => ({ rootCreatedAt: ISSUED, totals: { phq9: { referral: 10, remeasure: 10 + phq9 }, gad7: { referral: 10, remeasure: 10 + gad7 } } });
    const at = (change: { phq9: number; gad7: number }) => countOutcomes([fact(change.phq9, change.gad7)], null).perInstrument;
    expect(at({ phq9: -6, gad7: -4 })).toMatchObject({ phq9: { improved: 1, deteriorated: 0, unchanged: 0 }, gad7: { improved: 1, deteriorated: 0, unchanged: 0 } });
    expect(at({ phq9: -5, gad7: -3 })).toMatchObject({ phq9: { improved: 0, deteriorated: 0, unchanged: 1 }, gad7: { improved: 0, deteriorated: 0, unchanged: 1 } });
    expect(at({ phq9: 6, gad7: 4 })).toMatchObject({ phq9: { improved: 0, deteriorated: 1, unchanged: 0 }, gad7: { improved: 0, deteriorated: 1, unchanged: 0 } });
    expect(at({ phq9: 5, gad7: 3 })).toMatchObject({ phq9: { improved: 0, deteriorated: 0, unchanged: 1 }, gad7: { improved: 0, deteriorated: 0, unchanged: 1 } });
    // The change is the repeat total minus the referral total, so a fall is negative.
    expect(countOutcomes([fact(-8, -6)], null).perInstrument.phq9.sumChange).toBe(-8);
  });

  it('is served to the ops role on its own route and holds no per-ticket figure, id or person', async () => {
    await addMany(12, { phq9: -7, gad7: -5 });
    const res = await ctx.app.inject({ method: 'GET', url: '/metrics/outcomes', headers });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json()).sort()).toEqual(['instruments', 'period', 'reliableChangePoints', 'remeasured']);
    expect(res.body).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });
});

describe('which re-measured tickets count, and the one that do not are counted as excluded', () => {
  it('uses the newest referral total and the newest repeat total of the instrument, split at the moment the repeat check opened', () => {
    const scores = [
      score('phq9', 12, new Date(ISSUED.getTime() - 2 * HOUR)),
      score('phq9', 16, new Date(ISSUED.getTime() - HOUR)),
      score('phq9', 9, new Date(OPENS.getTime() + HOUR)),
      score('phq9', 7, new Date(OPENS.getTime() + 2 * HOUR)),
    ];
    expect(totalsPair(scores, 'phq9', SEEN_AT)).toEqual({ referral: 16, remeasure: 7 });
    // A total taken exactly when the check opened is the repeat's; one a millisecond before is the referral's.
    expect(totalsPair([score('phq9', 15, new Date(OPENS.getTime() - 1)), score('phq9', 8, OPENS)], 'phq9', SEEN_AT)).toEqual({ referral: 15, remeasure: 8 });
    expect(totalsPair([score('phq9', 15, new Date(OPENS.getTime() - 1))], 'phq9', SEEN_AT)).toBeNull();
    expect(totalsPair([score('phq9', 8, OPENS)], 'phq9', SEEN_AT)).toBeNull();
    expect(totalsPair([score('gad7', 8, OPENS), score('gad7', 11, new Date(OPENS.getTime() - 1))], 'phq9', SEEN_AT)).toBeNull();
  });

  it('includes a ticket that shared both totals of an instrument, and only that instrument when the other has one total or none', async () => {
    const both = await addRemeasured({ scores: [referral('phq9', 14), repeat('phq9', 7), referral('gad7', 12), repeat('gad7', 8)] });
    expect(await totalsOf(both)).toEqual({ phq9: { referral: 14, remeasure: 7 }, gad7: { referral: 12, remeasure: 8 } });
    const oneInstrument = await addRemeasured({ scores: [referral('phq9', 14), repeat('phq9', 9), referral('gad7', 12)] });
    expect(await totalsOf(oneInstrument)).toEqual({ phq9: { referral: 14, remeasure: 9 }, gad7: null });
    const noRepeat = await addRemeasured({ scores: [referral('phq9', 14), referral('gad7', 12)] });
    expect(await totalsOf(noRepeat)).toEqual({ phq9: null, gad7: null });
    const noReferral = await addRemeasured({ scores: [repeat('phq9', 9), repeat('gad7', 5)] });
    expect(await totalsOf(noReferral)).toEqual({ phq9: null, gad7: null });
  });

  it('leaves out a ticket whose scores consent was never given, was stopped, or whose share ended, and one whose bundle is gone', async () => {
    const scores = [referral('phq9', 14), repeat('phq9', 7), referral('gad7', 12), repeat('gad7', 8)];
    const none = { phq9: null, gad7: null };
    expect(await totalsOf(await addRemeasured({ scores, consents: [{ element: 'ticket' }] })), 'scores never consented').toEqual(none);
    expect(await totalsOf(await addRemeasured({ scores, consents: [{ element: 'ticket' }, { element: 'scores', revoked: true }] })), 'scores stopped').toEqual(none);
    expect(await totalsOf(await addRemeasured({ scores, consents: [{ element: 'ticket', revoked: true }, { element: 'scores' }] })), 'share ended').toEqual(none);
    expect(await totalsOf(await addRemeasured({ scores, consents: [] })), 'no consent at all (a seeded ticket)').toEqual(none);
    expect(await totalsOf(await addRemeasured({ scores, bundle: 'deleted' })), 'bundle emptied').toEqual(none);
    expect(await totalsOf(await addRemeasured({ scores, bundle: 'none' })), 'no bundle').toEqual(none);
  });

  it('leaves out a ticket whose stored bundle cannot be read, instead of failing the dashboard', async () => {
    const damaged = await addRemeasured({ scores: [referral('phq9', 14), repeat('phq9', 7)], bundle: 'damaged' });
    expect(await totalsOf(damaged)).toEqual({ phq9: null, gad7: null });
    await expect(outcomes()).resolves.toMatchObject({ remeasured: SUPPRESSED });
  });

  it('counts only tickets that reached re-measured, and puts a ticket in the period of its journey\'s root', async () => {
    await addRemeasured({ scores: [referral('phq9', 14), repeat('phq9', 7)], state: ['acknowledged', 'seen'] }); // seen, never re-measured
    await addRemeasured({ scores: [referral('phq9', 14), repeat('phq9', 7)], issuedAt: new Date(TEST_START.getTime() - 400 * DAY) });
    await addRemeasured({ scores: [referral('phq9', 14), repeat('phq9', 7)] });
    const facts = await factsOf();
    expect(facts).toHaveLength(2); // the seen-only ticket is not among them
    const since = new Date(TEST_START.getTime() - 200 * DAY);
    expect(countOutcomes(facts, null).remeasured).toBe(2);
    expect(countOutcomes(facts, since).remeasured).toBe(1);
  });

  it('puts a re-measured reroute in the period of the ticket it was rerouted from', async () => {
    const root = await world.addTicket({ issuedAt: new Date(TEST_START.getTime() - 400 * DAY), path: ['overdue', 'rerouted'] });
    await addRemeasured({ scores: [referral('phq9', 14), repeat('phq9', 7)], parent: root.id });
    const facts = await factsOf();
    expect(countOutcomes(facts, null).remeasured).toBe(1);
    expect(countOutcomes(facts, new Date(TEST_START.getTime() - 200 * DAY)).remeasured).toBe(0);
  });

  it('counts the excluded tickets among the re-measured ones, so included and excluded add up to the funnel\'s re-measured count', async () => {
    await addMany(14, { phq9: -7, gad7: -5 });
    for (let i = 0; i < 12; i += 1) await addRemeasured({ scores: [referral('phq9', 14), repeat('phq9', 9)], consents: [{ element: 'ticket' }] }); // no scores consent
    const response = await outcomes();
    expect(response.remeasured).toBe(26);
    expect(instrument(response, 'phq9')).toMatchObject({ included: 14, excluded: 12 });
    expect(instrument(response, 'gad7')).toMatchObject({ included: 14, excluded: 12 });
  });
});

describe('what is suppressed', () => {
  it('shows nothing when fewer than ten tickets were re-measured, the count included', async () => {
    await addMany(9, { phq9: -7, gad7: -5 });
    const response = await outcomes();
    expect(response.remeasured).toEqual(SUPPRESSED);
    for (const name of ['phq9', 'gad7'] as const) expect(instrument(response, name)).toEqual({ instrument: name, included: SUPPRESSED, excluded: SUPPRESSED, meanChange: SUPPRESSED, reliableImprovement: SUPPRESSED, reliableDeterioration: SUPPRESSED });
  });

  it('hides the included count, the mean and both shares when fewer than ten tickets have both totals, and the excluded count with them, but not the re-measured count', async () => {
    await addMany(5, { phq9: -7, gad7: -5 });
    for (let i = 0; i < 20; i += 1) await addRemeasured({ scores: [], consents: [{ element: 'ticket' }] });
    const response = await outcomes();
    expect(response.remeasured).toBe(25);
    expect(instrument(response, 'phq9')).toEqual({ instrument: 'phq9', included: SUPPRESSED, excluded: SUPPRESSED, meanChange: SUPPRESSED, reliableImprovement: SUPPRESSED, reliableDeterioration: SUPPRESSED });
  });

  it('hides the included count and what depends on it when fewer than ten were excluded, so the excluded handful cannot be worked out from the re-measured count', async () => {
    await addMany(25, { phq9: -7, gad7: -7 });
    for (let i = 0; i < 5; i += 1) await addRemeasured({ scores: [], consents: [{ element: 'ticket' }] });
    const response = await outcomes();
    expect(response.remeasured).toBe(30);
    expect(instrument(response, 'phq9')).toEqual({ instrument: 'phq9', included: SUPPRESSED, excluded: SUPPRESSED, meanChange: SUPPRESSED, reliableImprovement: SUPPRESSED, reliableDeterioration: SUPPRESSED });
  });

  it('hides a share whose remainder is under ten, and shows the mean while the included count is shown', async () => {
    // 25 included, all reliably improved: the remainder (nobody) would be given away by a share of 100%.
    await addMany(25, { phq9: -8, gad7: -8 });
    const phq9 = instrument(await outcomes(), 'phq9');
    expect(phq9).toMatchObject({ included: 25, excluded: SUPPRESSED, meanChange: -8 });
    expect(phq9.reliableImprovement).toEqual(SUPPRESSED);
    expect(phq9.reliableDeterioration).toEqual(SUPPRESSED);
  });

  it('hides a share whose own count is under ten, and the unchanged remainder that would reveal it', async () => {
    // 25 included: 12 improved, 9 deteriorated, 4 unchanged. The 9 and the 4 are small and together make 13, but the three
    // parts add up to the included count, so one of the shown parts goes with them.
    await addMany(12, { phq9: -8, gad7: 0 });
    await addMany(9, { phq9: 8, gad7: 0 });
    await addMany(4, { phq9: 0, gad7: 0 });
    const phq9 = instrument(await outcomes(), 'phq9');
    expect(phq9.reliableDeterioration).toEqual(SUPPRESSED);
    expect(typeof phq9.included === 'number' ? phq9.included : null).toBe(25);
  });

  it('never lets the three parts of the included tickets be told apart when two of them are small', async () => {
    // 30 included: 20 improved, 6 deteriorated, 4 unchanged. Both small parts are hidden and together reach ten: the improved share is
    // shown only if what is left (10) reaches ten; the deteriorated share is not shown.
    await addMany(20, { phq9: -8, gad7: 0 });
    await addMany(6, { phq9: 8, gad7: 0 });
    await addMany(4, { phq9: 0, gad7: 0 });
    const phq9 = instrument(await outcomes(), 'phq9');
    expect(phq9.reliableDeterioration).toEqual(SUPPRESSED);
    expect(phq9.reliableImprovement).toEqual({ count: 20, of: 30, percent: 66.7 });
  });

  it('hides every figure whenever the funnel hides its re-measured stage for the period, even when the counts here would be shown', () => {
    const fact = (change: number): OutcomeFact => ({ rootCreatedAt: ISSUED, totals: { phq9: { referral: 14, remeasure: 14 + change }, gad7: { referral: 14, remeasure: 14 + change } } });
    const facts = [...Array(12).fill(-8), ...Array(10).fill(6), ...Array(10).fill(1)].map(fact);
    const shown = buildOutcomes('all', facts, null, false);
    expect(shown.remeasured).toBe(32);
    const hidden = buildOutcomes('all', facts, null, true);
    expect(hidden.remeasured).toEqual(SUPPRESSED);
    for (const entry of hidden.instruments) expect(entry).toEqual({ instrument: entry.instrument, included: SUPPRESSED, excluded: SUPPRESSED, meanChange: SUPPRESSED, reliableImprovement: SUPPRESSED, reliableDeterioration: SUPPRESSED });
  });

  it('follows the funnel: the funnel hides its re-measured stage under ten journeys and shows it from ten, and the outcome figures with it', async () => {
    await addMany(9, { phq9: -8, gad7: -8 });
    const inputs = async () => ({ journeys: journeysOf(await loadTicketFacts(testDb.db)), openInvites: [], crisis: [], since: null });
    expect(remeasuredHiddenInFunnel(await inputs())).toBe(true);
    expect((await outcomes()).remeasured).toEqual(SUPPRESSED);
    await addMany(1, { phq9: -8, gad7: -8 });
    expect(remeasuredHiddenInFunnel(await inputs())).toBe(false);
    expect((await outcomes()).remeasured).toBe(10);
  });

  it('answers for each period of the funnel: the last 30 days leave out a journey rooted earlier', async () => {
    await addMany(12, { phq9: -8, gad7: -8 });
    expect((await outcomes('all')).remeasured).toBe(12);
    expect((await outcomes('90d')).remeasured).toEqual(SUPPRESSED); // all twelve were issued 100 days ago
    expect((await outcomes('30d')).remeasured).toEqual(SUPPRESSED);
  });
});

describe('reading the totals is not a clinician\'s read of the bundle', () => {
  it('writes no bundle read and leaves every stored bundle as it was', async () => {
    await addMany(12, { phq9: -8, gad7: -8 });
    const before = await testDb.db.select().from(schema.sharedBundles);
    await outcomes();
    expect(await testDb.db.select().from(schema.bundleReads)).toEqual([]);
    expect(await testDb.db.select().from(schema.sharedBundles)).toEqual(before);
  });
});
