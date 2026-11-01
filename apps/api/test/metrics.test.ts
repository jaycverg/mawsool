import { randomUUID } from 'node:crypto';
import type { CrisisResponse, EquityResponse, FunnelResponse, TimelinessResponse } from '@mawsool/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadTicketFacts } from '../src/metrics/facts';
import { pseudonymOf } from '../src/metrics/timeliness';
import { runSeed } from '../src/seed/run';
import { SEED_ANCHOR } from '../src/seed/fixtures';
import { SEED_CLAIMED_INVITES, SEED_EXPIRED_INVITES, SEED_OPEN_INVITES, generateSeed } from '../src/seed/generate';
import { INVITE_TTL_MS } from '../src/inbound/service';
import { createTestApp, TEST_START, type TestApp } from './helpers/app';
import { TEST_ENCRYPTION_KEY } from './helpers/config';
import { createTestDb, type TestDb } from './helpers/db';
import { registerPerson } from './helpers/flow';
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

async function get<T>(path: string): Promise<T> {
  const res = await ctx.app.inject({ method: 'GET', url: path, headers });
  if (res.statusCode !== 200) throw new Error(`${path}: ${res.statusCode} ${res.body}`);
  return res.json() as T;
}

const issued = (hoursAgo: number) => new Date(TEST_START.getTime() - hoursAgo * HOUR);
const counts = (response: FunnelResponse) => Object.fromEntries(response.stages.map((stage) => [stage.stage, stage.count]));

/** Every number in a response, with the path it was found at, leaving out the values that are not aggregates. */
function numbersIn(value: unknown, path = '$'): string[] {
  if (typeof value === 'number') return [path];
  if (Array.isArray(value)) return value.flatMap((item, index) => numbersIn(item, `${path}[${index}]`));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, item]) => numbersIn(item, `${path}.${key}`));
  return [];
}

describe('the loop-closed query', () => {
  it('counts the tickets that reached seen, remeasured or closed, one withdrawn after seen included, and no others', async () => {
    const t = issued(24 * 40);
    const path = async (states: Parameters<typeof world.addTicket>[0]['path']) => (await world.addTicket({ issuedAt: t, path: states })).id;
    const counted = {
      seen: await path(['acknowledged', 'seen']),
      seenFromIssued: await path(['seen']),
      lateSeen: await path(['overdue', 'seen']),
      remeasured: await path(['seen', 'remeasured']),
      closed: await path(['seen', 'remeasured', 'closed']),
      closedFromSeen: await path(['seen', 'closed']),
      withdrawnAfterSeen: await path(['acknowledged', 'seen', 'withdrawn']),
    };
    const notCounted = {
      issuedOnly: await path([]),
      acknowledged: await path(['acknowledged']),
      overdue: await path(['overdue']),
      rerouted: await path(['overdue', 'rerouted']),
      declined: await path(['declined']),
      withdrawnBeforeSeen: await path(['acknowledged', 'withdrawn']),
    };
    const facts = new Map((await loadTicketFacts(testDb.db)).map((fact) => [fact.id, fact]));
    for (const [name, id] of Object.entries(counted)) expect(facts.get(id)!.seen, name).toBe(true);
    for (const [name, id] of Object.entries(notCounted)) expect(facts.get(id)!.seen, name).toBe(false);
    expect(facts.get(counted.withdrawnAfterSeen)!.state).toBe('withdrawn'); // the current state says withdrawn; the events say it was seen
  });

  it('reads the events, not the current state, and records the stages a ticket reached in order', async () => {
    const t = issued(24 * 40);
    const lateSeen = await world.addTicket({ issuedAt: t, path: ['overdue', 'seen'] });
    const facts = (await loadTicketFacts(testDb.db)).find((fact) => fact.id === lateSeen.id)!;
    expect(facts).toMatchObject({ acknowledged: true, seen: true, remeasured: false, overdue: true });
    expect(facts.firstSeenMs).toBe(t.getTime() + 2 * HOUR);
  });
});

describe('GET /metrics/funnel', () => {
  async function bigWorld() {
    // Four sources, one tier, a dozen journeys each; eleven open invites for each front door; fifteen crisis events.
    for (const source of ['app', 'phc', 'tamm', 'school'] as const) await world.addMany(12, { source, tier: 'gp', issuedAt: issued(24 * 10), path: ['acknowledged', 'seen'] });
    for (const source of ['phc', 'tamm', 'school'] as const) {
      for (let i = 0; i < 11; i += 1) await world.addInvite({ source, createdAt: issued(24), expiresAt: new Date(TEST_START.getTime() + 5 * DAY) });
    }
    for (let i = 0; i < 15; i += 1) await world.addCrisis({ shownAt: issued(48) });
  }

  it('counts the positive-screen stage as unclaimed unexpired invites plus parentless tickets plus crisis events', async () => {
    await bigWorld();
    const funnel = await get<FunnelResponse>('/metrics/funnel');
    expect(counts(funnel).positive_screen).toBe(33 + 48 + 15);
    expect(counts(funnel).ticket_issued).toBe(48);
    expect(funnel.notCounted).toEqual({ appOnlyScreens: true, crisisEventsUnmatched: true });
  });

  it('counts a claimed invite and its ticket once, as the ticket', async () => {
    await bigWorld();
    const before = counts(await get<FunnelResponse>('/metrics/funnel')).positive_screen;
    const person = await world.addPerson();
    const ticket = await world.addTicket({ issuedAt: issued(10), source: 'tamm', tier: 'gp', person, path: [] });
    await world.addInvite({ source: 'tamm', createdAt: issued(30), expiresAt: new Date(TEST_START.getTime() + 5 * DAY), claimedBy: person, ticketId: ticket.id });
    // The new journey is one more screen; its claimed invite adds nothing.
    expect(counts(await get<FunnelResponse>('/metrics/funnel')).positive_screen).toBe((before as number) + 1);
  });

  it('does not count a reroute as another screen, and keeps the journey in its root source and tier', async () => {
    await bigWorld();
    const base = await get<FunnelResponse>('/metrics/funnel?source=tamm&tier=gp');
    // A rerouted tamm journey: the root went overdue and was rerouted; the child (source app, a new ticket) was seen.
    const person = await world.addPerson();
    const root = await world.addTicket({ issuedAt: issued(24 * 9), source: 'tamm', tier: 'gp', person, path: ['overdue', 'rerouted'] });
    await world.addTicket({ issuedAt: issued(24 * 8), source: 'app', tier: 'specialist', person, parent: root.id, path: ['acknowledged', 'seen'] });
    const after = await get<FunnelResponse>('/metrics/funnel?source=tamm&tier=gp');
    expect(counts(after).positive_screen).toBe((counts(base).positive_screen as number) + 1);
    expect(counts(after).ticket_issued).toBe((counts(base).ticket_issued as number) + 1);
    expect(counts(after).seen).toBe((counts(base).seen as number) + 1); // the child's progress counts for the root's journey
    // The child's own source and tier did not create a row of their own.
    expect(counts(await get<FunnelResponse>('/metrics/funnel?source=app&tier=specialist')).positive_screen).toEqual({ suppressed: true });
    expect(counts(await get<FunnelResponse>('/metrics/funnel?source=app&tier=gp')).positive_screen).toBe(12);
  });

  it('makes the stages cumulative: a ticket that went issued to seen still counts as acknowledged, and a share never passes 100%', async () => {
    await world.addMany(12, { issuedAt: issued(24 * 10), path: ['seen'] });
    await world.addMany(12, { issuedAt: issued(24 * 10), path: ['overdue', 'seen', 'remeasured'] });
    await world.addMany(12, { issuedAt: issued(24 * 10), path: ['acknowledged', 'seen', 'withdrawn'] });
    const funnel = await get<FunnelResponse>('/metrics/funnel');
    expect(counts(funnel)).toMatchObject({ ticket_issued: 36, acknowledged: 36, seen: 36, remeasured: 12 });
    for (const stage of funnel.stages) if (typeof stage.carriedOn === 'number') expect(stage.carriedOn).toBeLessThanOrEqual(100);
    expect(funnel.stages.map((stage) => stage.carriedOn)).toEqual([100, 100, 100, 33.3, null]);
  });

  it('applies a source or tier filter only to rows that carry that field: invites have a source and no tier, crisis events neither', async () => {
    await bigWorld();
    expect(counts(await get<FunnelResponse>('/metrics/funnel?source=tamm')).positive_screen).toBe(11 + 12);
    expect(counts(await get<FunnelResponse>('/metrics/funnel?tier=gp')).positive_screen).toBe(48);
    expect(counts(await get<FunnelResponse>('/metrics/funnel?source=tamm&tier=gp')).positive_screen).toBe(12);
    expect(counts(await get<FunnelResponse>('/metrics/funnel?source=app')).positive_screen).toBe(12);
  });

  it('counts an invite only while it is unclaimed and unexpired at the care clock: one second before expiry it counts, at expiry it does not', async () => {
    await bigWorld();
    const expiresAt = new Date(TEST_START.getTime() + 5 * DAY);
    const open = () => get<FunnelResponse>('/metrics/funnel?source=phc').then((funnel) => counts(funnel).positive_screen);
    expect(await open()).toBe(11 + 12);
    ctx.clock.set(new Date(expiresAt.getTime() - 1000));
    expect(await open()).toBe(11 + 12);
    ctx.clock.set(expiresAt); // expires_at > now is false at the instant of expiry
    expect(await open()).toBe(12);
    ctx.clock.set(new Date(expiresAt.getTime() + DAY));
    expect(await open()).toBe(12);
  });

  it('does not let an expired unclaimed invite stand in for a screen, and a re-signed orphan invite adds at most one, for its lifetime only', async () => {
    await bigWorld();
    const base = counts(await get<FunnelResponse>('/metrics/funnel?source=phc')).positive_screen as number;
    await world.addInvite({ source: 'phc', createdAt: issued(1), expiresAt: new Date(TEST_START.getTime() + INVITE_TTL_MS) });
    expect(counts(await get<FunnelResponse>('/metrics/funnel?source=phc')).positive_screen).toBe(base + 1);
    ctx.clock.set(new Date(TEST_START.getTime() + INVITE_TTL_MS + 1000));
    const later = counts(await get<FunnelResponse>('/metrics/funnel?source=phc')).positive_screen as number;
    expect(later).toBe(12); // the five-day invites and the thirty-day one have all expired
  });

  it('filters by period: a journey issued before the period is not in it', async () => {
    await world.addMany(12, { issuedAt: issued(24 * 100), tier: 'gp', path: ['seen'] });
    await world.addMany(11, { issuedAt: issued(24 * 10), tier: 'gp', path: ['seen'] });
    expect(counts(await get<FunnelResponse>('/metrics/funnel?period=all')).ticket_issued).toBe(23);
    expect(counts(await get<FunnelResponse>('/metrics/funnel?period=90d')).ticket_issued).toBe(11);
    expect(counts(await get<FunnelResponse>('/metrics/funnel?period=30d')).ticket_issued).toBe(11);
  });

  it('suppresses a filter value under ten, and the next smallest beside it, so no filter value can be taken out of the total', async () => {
    await world.addMany(30, { source: 'app', tier: 'gp', issuedAt: issued(100), path: ['seen'] });
    await world.addMany(25, { source: 'phc', tier: 'gp', issuedAt: issued(100), path: ['seen'] });
    await world.addMany(14, { source: 'tamm', tier: 'gp', issuedAt: issued(100), path: ['seen'] });
    await world.addMany(4, { source: 'school', tier: 'gp', issuedAt: issued(100), path: ['seen'] });
    const grand = counts(await get<FunnelResponse>('/metrics/funnel')).ticket_issued;
    const bySource = Object.fromEntries(await Promise.all((['app', 'phc', 'tamm', 'school'] as const).map(async (source) => [source, counts(await get<FunnelResponse>(`/metrics/funnel?source=${source}`)).ticket_issued])));
    expect(grand).toBe(73);
    expect(bySource['school']).toEqual({ suppressed: true });
    // school (4) is hidden, so the smallest visible source beside it, tamm (14), is hidden too: 73 - 30 - 25 would give school.
    expect(bySource['tamm']).toEqual({ suppressed: true });
    expect(bySource['app']).toBe(30);
    expect(bySource['phc']).toBe(25);
    const visible = Object.values(bySource).filter((value): value is number => typeof value === 'number');
    expect((grand as number) - visible.reduce((a, b) => a + b, 0)).toBe(18); // tamm and school together: no way to split them
  });

  it('leaves no filter value recoverable from the others: asked for every source and tier, the answers never leave exactly one hidden beside a total', async () => {
    const tiers = ['community', 'tele', 'gp', 'specialist'] as const;
    const sources = ['app', 'phc', 'tamm', 'school'] as const;
    const size = { app: [14, 22, 31, 16], phc: [12, 40, 11, 25], tamm: [10, 13, 12, 9], school: [3, 4, 18, 10] };
    for (const source of sources) for (const [t, tier] of tiers.entries()) await world.addMany(size[source][t]!, { source, tier, issuedAt: issued(100), path: ['acknowledged', 'seen'] });
    for (const source of ['phc', 'tamm', 'school'] as const) for (let i = 0; i < 4; i += 1) await world.addInvite({ source, createdAt: issued(24), expiresAt: new Date(TEST_START.getTime() + 5 * DAY) });

    const asked = async (stage: 'positive_screen' | 'ticket_issued', source: string | null, tier: string | null) => {
      const query = [source ? `source=${source}` : '', tier ? `tier=${tier}` : ''].filter(Boolean).join('&');
      return counts(await get<FunnelResponse>(`/metrics/funnel?${query}`))[stage];
    };
    for (const stage of ['ticket_issued', 'positive_screen'] as const) {
      const cell = new Map<string, number | { suppressed: true }>();
      for (const source of [null, ...sources]) for (const tier of [null, ...tiers]) cell.set(`${source}/${tier}`, (await asked(stage, source, tier))!);
      const hidden = (key: string) => typeof cell.get(key) !== 'number';
      const lines: string[][] = [
        ...sources.map((source) => tiers.map((tier) => `${source}/${tier}`)), // a source's tiers, which add up to its row (and, on the first stage, its open invites)
        ...tiers.map((tier) => sources.map((source) => `${source}/${tier}`)), // a tier's sources, which add up to its column
      ];
      const totals = [...sources.map((source) => `${source}/null`), ...tiers.map((tier) => `null/${tier}`)];
      lines.forEach((parts, index) => {
        const total = totals[index]!;
        const stillHidden = [total, ...parts].filter(hidden);
        // A first stage row also holds the source's open invites, which no filter value shows, so the row is not a pure sum of its tier cells and is skipped here; what its invites and the crisis events could give away is checked against the second stage in `metrics-leaks.test.ts`.
        if (stage === 'ticket_issued' || index >= sources.length) expect(stillHidden.length, `${stage} ${total}`).not.toBe(1);
      });
      if (stage === 'ticket_issued') {
        for (const parts of [sources.map((source) => `${source}/null`), tiers.map((tier) => `null/${tier}`)]) {
          expect(['null/null', ...parts].filter(hidden).length, `${stage} grand over ${parts.join(',')}`).not.toBe(1);
        }
        expect([...cell.values()].some((value) => typeof value !== 'number'), 'the table has small cells, so the test exercises hiding').toBe(true);
      }
      if (stage === 'positive_screen') {
        // A source's invites are its row minus its tier cells; with the tier cells all shown, a row would give them away.
        for (const source of ['phc', 'tamm', 'school'] as const) {
          const everyTierShown = tiers.every((tier) => !hidden(`${source}/${tier}`));
          expect(hidden(`${source}/null`) || !everyTierShown, `${source} invites`).toBe(true);
        }
      }
    }
  });
});

describe('every GET /metrics route under ten people', () => {
  /** The numbers left in responses once the fixed flag threshold and the directory's own listed waits (mock services, not people) are set aside. */
  const publishedNumbers = (...responses: unknown[]) => responses.flatMap((response) => numbersIn(response)).filter((path) => !/\.flagPoints$|\.indicativeWait\[\d+\]\.days$/.test(path));

  it('returns suppressed for the funnel, timeliness, overdue list and equity when nine tickets stand behind them, and publishes no number', async () => {
    // Nine journeys, four of them overdue and five seen: every count is under ten.
    await world.addMany(5, { issuedAt: issued(24 * 30), path: ['acknowledged', 'seen'], tier: 'gp', language: 'ur' }, { optIn: true, ageBand: '25_34', gender: 'female', region: 'al_ain', language: 'ur' });
    await world.addMany(4, { issuedAt: issued(24 * 30), path: ['overdue'], tier: 'tele', deadlineAt: issued(24 * 20), language: 'ur' });
    const funnel = await get<FunnelResponse>('/metrics/funnel');
    const timeliness = await get<TimelinessResponse>('/metrics/timeliness');
    const equity = await get<EquityResponse>('/metrics/equity');

    for (const stage of funnel.stages) expect(stage.count, stage.stage).toEqual({ suppressed: true });
    for (const stage of funnel.stages.slice(0, -1)) expect(stage.carriedOn, stage.stage).toEqual({ suppressed: true });
    expect(timeliness.overall).toEqual({ suppressed: true });
    for (const tier of timeliness.tiers) expect(tier.cell, tier.tier).toEqual({ suppressed: true });
    expect(timeliness.overdue).toEqual({ suppressed: true });
    expect(equity.overall).toEqual({ suppressed: true });
    for (const dimension of equity.dimensions) for (const row of dimension.rows) expect(row.cell, `${dimension.dimension} ${row.value}`).toEqual({ suppressed: true });
    expect(publishedNumbers(funnel, timeliness, equity)).toEqual([]);
  });

  it('returns suppressed for the crisis figures when nine crisis screens stand behind them, and publishes no number', async () => {
    for (let i = 0; i < 9; i += 1) await world.addCrisis({ shownAt: issued(48), called: true, contactMinutes: 5 });
    const crisis = await get<CrisisResponse>('/metrics/crisis');
    expect(crisis).toEqual({ period: 'all', shown: { suppressed: true }, calledALine: { suppressed: true }, contactConfirmed: { suppressed: true }, medianMinutesToContact: { suppressed: true } });
    expect(publishedNumbers(crisis)).toEqual([]);
    // The same nine are one short of ten on the funnel's first stage too: crisis events count there.
    expect(counts(await get<FunnelResponse>('/metrics/funnel')).positive_screen).toEqual({ suppressed: true });
  });

  it('suppresses zero as well: an empty database publishes no zero', async () => {
    const funnel = await get<FunnelResponse>('/metrics/funnel');
    for (const stage of funnel.stages) expect(stage.count).toEqual({ suppressed: true });
    expect((await get<CrisisResponse>('/metrics/crisis')).shown).toEqual({ suppressed: true });
  });

  it('shows a count of ten and suppresses a count of nine', async () => {
    for (let i = 0; i < 9; i += 1) await world.addCrisis({ shownAt: issued(48) });
    expect((await get<CrisisResponse>('/metrics/crisis')).shown).toEqual({ suppressed: true });
    await world.addCrisis({ shownAt: issued(48) });
    expect((await get<CrisisResponse>('/metrics/crisis')).shown).toBe(10);
  });
});

describe('GET /metrics/crisis', () => {
  it('reports screens shown, the share that tapped a number, the share with contact confirmed and the median minutes to contact', async () => {
    for (let i = 0; i < 40; i += 1) await world.addCrisis({ shownAt: issued(24 + i), called: i < 30, contactMinutes: i < 20 ? (i % 2 === 0 ? 4 : 8) : undefined });
    const crisis = await get<CrisisResponse>('/metrics/crisis');
    expect(crisis.shown).toBe(40);
    expect(crisis.calledALine).toEqual({ count: 30, of: 40, percent: 75 });
    expect(crisis.contactConfirmed).toEqual({ count: 20, of: 40, percent: 50 });
    expect(crisis.medianMinutesToContact).toBe(4);
  });

  it('suppresses the median when fewer than ten contacts stand behind it, even though the screens are plentiful', async () => {
    for (let i = 0; i < 40; i += 1) await world.addCrisis({ shownAt: issued(24 + i), called: true, contactMinutes: i < 9 ? 6 : undefined });
    const crisis = await get<CrisisResponse>('/metrics/crisis');
    expect(crisis.shown).toBe(40);
    expect(crisis.medianMinutesToContact).toEqual({ suppressed: true });
    expect(crisis.contactConfirmed).toEqual({ suppressed: true });
  });

  it('counts a contact-confirmed event the app logs through the real route', async () => {
    for (let i = 0; i < 24; i += 1) await world.addCrisis({ shownAt: issued(24 + i), called: i < 12, contactMinutes: i < 12 ? 3 : undefined });
    const person = await registerPerson(ctx);
    const event = {
      id: randomUUID(),
      trigger: 'phq9_item9',
      shownAt: issued(1).toISOString(),
      callTapped: '800725462',
      contextShared: false,
      humanContactConfirmed: true,
      contactSource: 'self_report',
      contactAt: new Date(issued(1).getTime() + 2 * 60_000).toISOString(),
      resolvedAt: null,
      locale: 'en',
    };
    expect((await ctx.app.inject({ method: 'POST', url: '/crisis-events', headers: person.headers, payload: event })).statusCode).toBeLessThan(300);
    const crisis = await get<CrisisResponse>('/metrics/crisis');
    expect(crisis.shown).toBe(25);
    expect(crisis.contactConfirmed).toEqual({ count: 13, of: 25, percent: 52 });
    expect(crisis.calledALine).toEqual({ count: 13, of: 25, percent: 52 });
  });
});

describe('GET /metrics/timeliness', () => {
  it('reports, by tier, the share seen within the promised window and the median and 90th percentile days to seen', async () => {
    // gp: 30 settled tickets, 18 seen in time (1 to 4 days after issue; the promise is 7), 12 seen late (9 days).
    // tele: 22 settled, 12 in time and 10 late, which is shown in full.
    for (let i = 0; i < 18; i += 1) await world.addTicket({ tier: 'gp', issuedAt: issued(24 * 30), path: ['seen'], hours: [24 * (1 + (i % 4))] });
    for (let i = 0; i < 12; i += 1) await world.addTicket({ tier: 'gp', issuedAt: issued(24 * 30), path: ['overdue', 'seen'], hours: [24 * 8, 24 * 9] });
    for (let i = 0; i < 12; i += 1) await world.addTicket({ tier: 'tele', issuedAt: issued(24 * 30), path: ['acknowledged', 'seen'], hours: [10, 24 * 2] });
    for (let i = 0; i < 10; i += 1) await world.addTicket({ tier: 'tele', issuedAt: issued(24 * 30), path: ['overdue', 'seen'], hours: [24 * 8, 24 * 20] });
    const timeliness = await get<TimelinessResponse>('/metrics/timeliness');
    const gp = timeliness.tiers.find((entry) => entry.tier === 'gp')!.cell;
    expect(gp).toMatchObject({ tickets: 30, withinTarget: { count: 18, of: 30, percent: 60 } });
    // Days to seen: five 1s, five 2s, four 3s, four 4s and twelve 9s; the median is the 15th of 30, the 90th percentile the 27th.
    expect((gp as { medianDaysToSeen: number }).medianDaysToSeen).toBe(4);
    expect((gp as { p90DaysToSeen: number }).p90DaysToSeen).toBe(9);
    expect(timeliness.overall).toMatchObject({ tickets: 52, withinTarget: { count: 30, of: 52, percent: 57.7 } });
    expect(timeliness.tiers.find((entry) => entry.tier === 'tele')!.cell).toMatchObject({ tickets: 22, withinTarget: { count: 12, of: 22 } });
  });

  it('counts only tickets whose promise is settled: waiting, declined and withdrawn tickets are not a miss', async () => {
    await world.addMany(12, { tier: 'gp', issuedAt: issued(24 * 30), path: ['seen'] });
    await world.addMany(12, { tier: 'gp', issuedAt: issued(24 * 30), path: ['overdue'] });
    await world.addMany(30, { tier: 'gp', issuedAt: issued(24), path: [] });
    await world.addMany(30, { tier: 'gp', issuedAt: issued(24 * 30), path: ['declined'] });
    await world.addMany(30, { tier: 'gp', issuedAt: issued(24 * 30), path: ['withdrawn'] });
    const gp = (await get<TimelinessResponse>('/metrics/timeliness')).tiers.find((entry) => entry.tier === 'gp')!.cell;
    expect(gp).toMatchObject({ tickets: 24, withinTarget: { count: 12, of: 24, percent: 50 } });
  });

  it('lists overdue tickets by a pseudonymous id that is not the ticket id, the short code or the person id, only when ten or more are overdue', async () => {
    const made = [];
    for (let i = 0; i < 12; i += 1) made.push(await world.addTicket({ tier: 'gp', issuedAt: issued(24 * 30), path: ['overdue'], deadlineAt: new Date(TEST_START.getTime() - (i + 1) * DAY) }));
    const overdue = (await get<TimelinessResponse>('/metrics/timeliness')).overdue;
    expect(overdue).toMatchObject({ count: 12, shown: 12 });
    const list = (overdue as { tickets: { id: string; daysOverdue: number }[] }).tickets;
    expect(list.map((entry) => entry.daysOverdue)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    const text = JSON.stringify(list);
    for (const ticket of made) for (const secret of [ticket.id, ticket.shortCode, ticket.personId]) expect(text).not.toContain(secret);
    expect(list.every((entry) => /^od_[0-9a-f]{12}$/.test(entry.id))).toBe(true);
    expect(new Set(list.map((entry) => entry.id)).size).toBe(12);
    // Stable from one call to the next, and keyed: the same ticket under another key has another id.
    expect(list[0]!.id).toBe(pseudonymOf(made[11]!.id, TEST_ENCRYPTION_KEY));
    expect(pseudonymOf(made[11]!.id, Buffer.alloc(32, 1).toString('base64'))).not.toBe(list[0]!.id);
    expect(JSON.stringify(list)).not.toMatch(/tier|facility/);
  });

  it('shows no overdue list and no count for nine overdue tickets, and caps a long list while saying how long it is', async () => {
    await world.addMany(9, { tier: 'gp', issuedAt: issued(24 * 30), path: ['overdue'] });
    expect((await get<TimelinessResponse>('/metrics/timeliness')).overdue).toEqual({ suppressed: true });
    await world.addMany(31, { tier: 'gp', issuedAt: issued(24 * 30), path: ['overdue'] });
    const overdue = (await get<TimelinessResponse>('/metrics/timeliness')).overdue as { count: number; shown: number; tickets: unknown[] };
    expect(overdue).toMatchObject({ count: 40, shown: 25 });
    expect(overdue.tickets).toHaveLength(25);
  });

  it('hides a small tier and the next smallest, so the overall cannot give the small one away', async () => {
    // Each tier but community has ten or more in time and ten or more late, so only community (3 settled) is small.
    const settle = async (tier: 'gp' | 'tele' | 'specialist' | 'community', inTime: number, late: number) => {
      await world.addMany(inTime, { tier, issuedAt: issued(24 * 30), path: ['seen'] });
      await world.addMany(late, { tier, issuedAt: issued(24 * 30), path: ['overdue', 'seen'], hours: [24 * 8, 24 * 9] });
    };
    await settle('gp', 25, 15);
    await settle('tele', 12, 12);
    await settle('specialist', 15, 15);
    await settle('community', 2, 1);
    const timeliness = await get<TimelinessResponse>('/metrics/timeliness');
    const byTier = Object.fromEntries(timeliness.tiers.map((entry) => [entry.tier, entry.cell]));
    expect(byTier['community']).toEqual({ suppressed: true });
    expect(byTier['tele']).toEqual({ suppressed: true }); // 24 settled, the next smallest after community
    expect(byTier['gp']).toMatchObject({ tickets: 40 });
    expect(byTier['specialist']).toMatchObject({ tickets: 30 });
    expect(timeliness.overall).toMatchObject({ tickets: 97 });
  });
});

describe('GET /metrics/equity', () => {
  it('offers age band, gender, language and region, and no nationality', async () => {
    await world.addMany(12, { issuedAt: issued(100), path: ['seen'] }, { optIn: true, ageBand: '25_34', gender: 'female', region: 'al_ain' });
    const equity = await get<EquityResponse>('/metrics/equity');
    expect(equity.dimensions.map((dimension) => dimension.dimension)).toEqual(['age_band', 'gender', 'language', 'region']);
    expect(JSON.stringify(equity)).not.toMatch(/nationality/i);
    expect(equity.flagPoints).toBe(10);
  });

  it('serves one period only: any other is refused with no figures, so a group cannot be worked out by comparing two periods', async () => {
    // A group with forty tickets inside the last 90 days (20 closed, 20 open, so every figure of it clears the rules) and five
    // older ones, all closed: all time less 90 days would be those five, and 25 closed less 20 would be five closed.
    const shared = { optIn: true as const, ageBand: '25_34' as const, gender: 'female' as const, region: 'al_ain' as const, language: 'ur' as const };
    for (let i = 0; i < 40; i += 1) await world.addTicket({ person: await world.addPerson(shared), issuedAt: issued(24 * 20), path: i < 20 ? ['seen'] : [] });
    await world.addMany(5, { issuedAt: issued(24 * 120), path: ['seen'] }, shared);
    const allTime = await loadTicketFacts(testDb.db);
    expect(allTime).toHaveLength(45);
    expect(allTime.filter((ticket) => ticket.seen)).toHaveLength(25);
    const asked = (query: string) => ctx.app.inject({ method: 'GET', url: `/metrics/equity${query}`, headers });
    for (const period of ['all', '30d', '7d', '365d', '']) {
      const res = await asked(`?period=${period}`);
      expect(res.statusCode, `period=${period}`).toBe(400);
      expect(Object.keys(res.json()).sort(), `period=${period} carries no figures`).toEqual(['error', 'message']);
    }
    const defaulted = await asked('');
    const named = await asked('?period=90d');
    expect(defaulted.statusCode).toBe(200);
    expect(named.json()).toEqual(defaulted.json());
    expect(defaulted.json().period).toBe('90d');
    // The answer holds real figures (not two empty answers that agree), and they are the window's: 40 tickets, 20 closed.
    const published = defaulted.json() as EquityResponse;
    expect(published.overall).toEqual({ tickets: 40, loopClosed: 20, ratePercent: 50 });
    const urdu = published.dimensions.find((entry) => entry.dimension === 'language')!.rows.find((row) => row.value === 'ur')!.cell;
    expect(urdu).toMatchObject({ tickets: 40, loopClosed: 20 });
    // Subtracting the published figures from the true all-time counts gives the older five (and their five closed)... which
    // appear in no response: the published count is 40 and never 45, and no published number is an all-time figure.
    expect(allTime.length - (published.overall as { tickets: number }).tickets).toBe(5);
    expect(allTime.filter((ticket) => ticket.seen).length - (published.overall as { loopClosed: number }).loopClosed).toBe(5);
    const numbers = (value: unknown): number[] => (typeof value === 'number' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(numbers) : []);
    const everyNumber = numbers(published);
    expect(everyNumber, 'no all-time count in the equity answer').not.toContain(45);
    expect(everyNumber, 'no all-time closed count in the equity answer').not.toContain(25);
    // Nothing else in the response set gives a second window of an equity group.
    for (const path of ['funnel', 'timeliness', 'crisis']) {
      for (const period of ['all', '90d', '30d']) {
        const body = JSON.stringify((await ctx.app.inject({ method: 'GET', url: `/metrics/${path}?period=${period}`, headers })).json());
        expect(body, `${path} ${period}`).not.toMatch(/age_band|"gender"|"language"|not_given|"region"/);
      }
    }
  });

  it('counts the people who gave no bucket as a group of every dimension, language included: a ticket in Urdu from a person who did not opt in is in no language row', async () => {
    // 24 people opted in with Arabic (12 closed). 40 did not opt in; their tickets were made in Urdu (20 closed).
    await world.addMany(12, { issuedAt: issued(100), path: ['seen'], language: 'ar' }, { optIn: true, ageBand: '25_34', gender: 'female', region: 'al_ain', language: 'ar' });
    await world.addMany(12, { issuedAt: issued(100), path: [], language: 'ar' }, { optIn: true, ageBand: '25_34', gender: 'female', region: 'al_ain', language: 'ar' });
    await world.addMany(20, { issuedAt: issued(100), path: ['seen'], language: 'ur' });
    await world.addMany(20, { issuedAt: issued(100), path: [], language: 'ur' });
    const equity = await get<EquityResponse>('/metrics/equity');
    const rows = (dimension: string) => Object.fromEntries(equity.dimensions.find((entry) => entry.dimension === dimension)!.rows.map((row) => [row.value, row.cell]));
    expect(Object.keys(rows('language')).sort()).toEqual(['ar', 'en', 'hi', 'not_given', 'other', 'tl', 'ur']);
    expect(rows('language')['not_given']).toMatchObject({ tickets: 40, loopClosed: 20 });
    expect(rows('language')['ar']).toMatchObject({ tickets: 24, loopClosed: 12 });
    // The 40 Urdu-language tickets are in no language row of their own: the Urdu row is empty, so it is hidden, not 40.
    expect(rows('language')['ur']).toEqual({ suppressed: true });
    for (const dimension of ['age_band', 'gender', 'region']) expect(rows(dimension)['not_given'], dimension).toMatchObject({ tickets: 40, loopClosed: 20 });
  });

  it('flags a group 10 points or more from the overall rate, and carries no flag or gap on a suppressed one', async () => {
    // Each person opted in with a language. English: 30 of 40 closed (75%); Urdu: 12 of 30 (40%); Hindi 9 (5 closed), Tagalog
    // 9 (5) and other 5 (3) are small. Overall 55 of 93 = 59.1%.
    const add = async (language: 'en' | 'ur' | 'hi' | 'tl' | 'other', total: number, closed: number) => {
      for (let i = 0; i < total; i += 1) await world.addTicket({ person: await world.addPerson({ optIn: true, language }), issuedAt: issued(24 * 20), path: i < closed ? ['seen'] : [] });
    };
    await add('en', 40, 30);
    await add('ur', 30, 12);
    await add('hi', 9, 5);
    await add('tl', 9, 5);
    await add('other', 5, 3);
    const equity = await get<EquityResponse>('/metrics/equity');
    expect(equity.overall).toEqual({ tickets: 93, loopClosed: 55, ratePercent: 59.1 });
    const language = Object.fromEntries(equity.dimensions.find((entry) => entry.dimension === 'language')!.rows.map((row) => [row.value, row.cell]));
    expect(language['ur']).toMatchObject({ ratePercent: 40, gapPoints: -19.1, flagged: true });
    expect(language['en']).toMatchObject({ ratePercent: 75, gapPoints: 15.9, flagged: true });
    // hi, tl and other are each under ten and together hold 23 tickets, 13 closed and 10 open: nothing is left to subtract.
    for (const small of ['hi', 'tl', 'other']) expect(language[small]).toEqual({ suppressed: true });
    expect(Object.keys(language['hi'] as object)).toEqual(['suppressed']);
    for (const row of equity.dimensions.flatMap((dimension) => dimension.rows)) {
      if ('suppressed' in row.cell) expect(Object.keys(row.cell)).toEqual(['suppressed']);
    }
  });

  it('cannot give a suppressed group up through the overall rate: with one group hidden for being small, another is hidden with it', async () => {
    // Region has three buckets and "no bucket given". Only al_dhafra is small (5 tickets); the others are all above ten on every count.
    const closedOf = (total: number, closed: number) => (i: number) => (i < closed ? (['seen'] as const) : ([] as const));
    const add = async (region: 'abu_dhabi_city' | 'al_ain' | 'al_dhafra' | null, total: number, closed: number) => {
      for (let i = 0; i < total; i += 1) {
        const person = await world.addPerson(region ? { optIn: true, region } : {});
        await world.addTicket({ person, issuedAt: issued(24 * 20), path: [...closedOf(total, closed)(i)] });
      }
    };
    await add('abu_dhabi_city', 40, 20);
    await add('al_ain', 24, 12);
    await add('al_dhafra', 5, 3);
    await add(null, 30, 15);
    const equity = await get<EquityResponse>('/metrics/equity');
    expect(equity.overall).toEqual({ tickets: 99, loopClosed: 50, ratePercent: 50.5 });
    const rows = Object.fromEntries(equity.dimensions.find((entry) => entry.dimension === 'region')!.rows.map((row) => [row.value, row.cell]));
    expect(rows['al_dhafra']).toEqual({ suppressed: true });
    // al_ain (24) is the next smallest after al_dhafra, so it goes too: 99 - 40 - 30 would otherwise leave al_dhafra's 5 on its own.
    expect(rows['al_ain']).toEqual({ suppressed: true });
    expect(rows['abu_dhabi_city']).toMatchObject({ tickets: 40, loopClosed: 20 });
    expect(rows['not_given']).toMatchObject({ tickets: 30, loopClosed: 15 });
    const visible = Object.values(rows).flatMap((cell) => ('suppressed' in cell ? [] : [cell.tickets]));
    expect(99 - visible.reduce((a, b) => a + b, 0)).toBe(29); // two groups' worth: it cannot be split
  });

  describe('when only some people who opted in gave every bucket', () => {
    // 60 people did not opt in (30 closed). 80 opted in with every bucket (female 40, male 40, 20 closed each); 4 are "another"
    // (1 closed). `blanks` opted in with age band, region and language but no gender, none closed. Their gender "no bucket
    // given" then holds 60 + blanks tickets while the other dimensions' holds 60: the two differ by `blanks` people.
    const build = async (blanks: number) => {
      const shared = { optIn: true as const, ageBand: '25_34' as const, region: 'al_ain' as const, language: 'ar' as const };
      for (let i = 0; i < 60; i += 1) await world.addTicket({ person: await world.addPerson(), issuedAt: issued(100), path: i < 30 ? ['seen'] : [] });
      for (const [gender, total, closed] of [['female', 40, 20], ['male', 40, 20], ['another', 4, 1]] as const) {
        for (let i = 0; i < total; i += 1) await world.addTicket({ person: await world.addPerson({ ...shared, gender }), issuedAt: issued(100), path: i < closed ? ['seen'] : [] });
      }
      for (let i = 0; i < blanks; i += 1) await world.addTicket({ person: await world.addPerson(shared), issuedAt: issued(100), path: [] });
      return get<EquityResponse>('/metrics/equity');
    };
    const notGiven = (equity: EquityResponse) => Object.fromEntries(equity.dimensions.map((dimension) => [dimension.dimension, dimension.rows.find((row) => row.value === 'not_given')!.cell]));
    const hiddenIn = (equity: EquityResponse, dimension: string) => equity.dimensions.find((entry) => entry.dimension === dimension)!.rows.filter((row) => 'suppressed' in row.cell).map((row) => row.value);

    for (const blanks of [1, 9]) {
      it(`hides "no bucket given" in every dimension when ${blanks} blank${blanks > 1 ? 's' : ''} make the dimensions' copies differ, so the difference is not published`, async () => {
        const equity = await build(blanks);
        for (const [dimension, cell] of Object.entries(notGiven(equity))) expect(cell, dimension).toEqual({ suppressed: true });
        // The reader's tries: "another" from the total less the shown gender groups less a "no bucket given" taken from elsewhere.
        const gender = equity.dimensions.find((entry) => entry.dimension === 'gender')!;
        const shown = gender.rows.reduce((sum, row) => sum + ('suppressed' in row.cell ? 0 : row.cell.tickets), 0);
        const total = (equity.overall as { tickets: number }).tickets;
        expect(total - shown, 'what the gender rows leave is more than "another" alone').not.toBe(4);
        expect(hiddenIn(equity, 'gender').sort()).toEqual(['another', 'not_given']);
      });
    }

    it('lets the dimensions publish their own "no bucket given" once they differ by ten people, and still hides "another"', async () => {
      const equity = await build(10);
      const given = notGiven(equity) as Record<string, { tickets: number } | { suppressed: true }>;
      expect(given['gender']).toMatchObject({ tickets: 70 });
      expect(given['age_band']).toMatchObject({ tickets: 60 });
      expect(hiddenIn(equity, 'gender')).toContain('another');
      expect(hiddenIn(equity, 'gender').length).toBeGreaterThanOrEqual(2);
    });
  });

  it('measures the Urdu gap on the real query: 18 to 22 points below the overall rate, the way the seed measures it', async () => {
    await runSeed(testDb.db, SEED_ANCHOR);
    headers = await world.opsHeaders();
    ctx.clock.set(SEED_ANCHOR);
    const equity = await get<EquityResponse>('/metrics/equity');
    const language = equity.dimensions.find((entry) => entry.dimension === 'language')!.rows;
    const urdu = language.find((row) => row.value === 'ur')!.cell;
    expect(urdu).not.toHaveProperty('suppressed');
    const cell = urdu as { gapPoints: number; flagged: boolean; ratePercent: number; tickets: number };
    expect(cell.gapPoints).toBeLessThanOrEqual(-18);
    expect(cell.gapPoints).toBeGreaterThanOrEqual(-22);
    expect(cell.flagged).toBe(true);
    // The opt-in language bucket: 48 of the 60 Urdu-language tickets belong to people who shared it (22 closed, 45.8%); the
    // other 12 are in "no bucket given". `gate:seed` still measures the ticket language (60 tickets, 20.5 points).
    expect(cell).toMatchObject({ tickets: 48, loopClosed: 22, ratePercent: 45.8, gapPoints: -21.4 });
    expect(equity.overall).toMatchObject({ tickets: 500, loopClosed: 336, ratePercent: 67.2 });
  });
});

describe('the seeded data against the metric definitions', () => {
  it('gives every seeded unclaimed invite a life that spans the seed’s own reference time, and every expired one a life that ended before it', () => {
    const data = generateSeed(SEED_ANCHOR);
    const unclaimed = data.inboundInvites.filter((invite) => invite.claimedBy === null);
    const open = unclaimed.filter((invite) => invite.expiresAt.getTime() > SEED_ANCHOR.getTime());
    expect(open).toHaveLength(Object.values(SEED_OPEN_INVITES).reduce((a, b) => a + b, 0));
    expect(unclaimed.length - open.length).toBe(SEED_EXPIRED_INVITES);
    expect(data.inboundInvites.filter((invite) => invite.claimedBy !== null)).toHaveLength(SEED_CLAIMED_INVITES);
    for (const invite of open) {
      expect(invite.createdAt.getTime()).toBeLessThan(SEED_ANCHOR.getTime());
      expect(invite.expiresAt.getTime() - invite.createdAt.getTime()).toBe(INVITE_TTL_MS);
    }
    for (const invite of data.inboundInvites) expect(invite.createdAt.getTime()).toBeLessThanOrEqual(SEED_ANCHOR.getTime());
  });

  it('counts the same positive screens whatever day the seed is anchored on, as long as the clock reads that day', async () => {
    const expected = 36 + 470 + 40; // open invites + parentless tickets + crisis events
    for (const anchor of [SEED_ANCHOR, new Date('2027-03-15T00:00:00+04:00'), new Date('2031-08-02T00:00:00+04:00')]) {
      await runSeed(testDb.db, anchor);
    headers = await world.opsHeaders();
      ctx.clock.set(anchor);
      const funnel = await get<FunnelResponse>('/metrics/funnel');
      expect(counts(funnel).positive_screen, anchor.toISOString()).toBe(expected);
      expect(counts(funnel).ticket_issued).toBe(470);
    }
  });

  it('stops counting the seeded open invites once the clock passes their expiry, and counts none of the expired ones before it', async () => {
    await runSeed(testDb.db, SEED_ANCHOR);
    headers = await world.opsHeaders();
    ctx.clock.set(SEED_ANCHOR);
    expect(counts(await get<FunnelResponse>('/metrics/funnel')).positive_screen).toBe(36 + 470 + 40);
    ctx.clock.set(new Date(SEED_ANCHOR.getTime() + 40 * DAY));
    // The invites have lapsed (they were handed over in the 12 hours before the anchor and last 30 days); tickets and crisis events stay.
    expect(counts(await get<FunnelResponse>('/metrics/funnel')).positive_screen).toBe(470 + 40);
  });

  it('keeps the demo’s dashboard readable in the default view, straight after a reset and 28 days into the demo, and in all time at 28 days', async () => {
    await runSeed(testDb.db, SEED_ANCHOR);
    const moments = [0, 28 * DAY, 28 * DAY + 23 * HOUR];
    for (const [period, offsets] of [['90d', moments], ['all', [28 * DAY]]] as const) {
      for (const offset of offsets) {
        ctx.clock.set(new Date(SEED_ANCHOR.getTime() + offset));
        headers = await world.opsHeaders();
        const label = `${period} at +${offset / HOUR}h`;
        const funnel = await get<FunnelResponse>(`/metrics/funnel?period=${period}`);
        for (const stage of ['positive_screen', 'ticket_issued', 'acknowledged', 'seen']) expect(typeof funnel.stages.find((entry) => entry.stage === stage)!.count, `${stage} ${label}`).toBe('number');
        const timeliness = await get<TimelinessResponse>(`/metrics/timeliness?period=${period}`);
        for (const tier of timeliness.tiers) expect(tier.cell, `${tier.tier} ${label}`).not.toHaveProperty('suppressed');
        const crisis = await get<CrisisResponse>(`/metrics/crisis?period=${period}`);
        for (const figure of ['shown', 'calledALine', 'contactConfirmed', 'medianMinutesToContact'] as const) expect(crisis[figure], `${figure} ${label}`).not.toHaveProperty('suppressed');
        // Equity stays on its one period (the last 90 days) whatever period the rest of the dashboard is asked for.
        const equity = await get<EquityResponse>('/metrics/equity');
        expect(equity.period).toBe('90d');
        const urdu = equity.dimensions.find((entry) => entry.dimension === 'language')!.rows.find((row) => row.value === 'ur')!.cell;
        expect(urdu, `Urdu ${label}`).not.toHaveProperty('suppressed');
        const cell = urdu as { gapPoints: number; flagged: boolean };
        expect(cell.flagged).toBe(true);
        expect(cell.gapPoints, `Urdu gap ${label}`).toBeLessThanOrEqual(-18);
        expect(cell.gapPoints, `Urdu gap ${label}`).toBeGreaterThanOrEqual(-22);
      }
    }
  });

  it('shows a funnel and a timeliness table from the seed with the equity opt-in buckets and the crisis events', async () => {
    await runSeed(testDb.db, SEED_ANCHOR);
    headers = await world.opsHeaders();
    ctx.clock.set(SEED_ANCHOR);
    const funnel = await get<FunnelResponse>('/metrics/funnel');
    for (const stage of funnel.stages) expect(typeof stage.count, stage.stage).toBe('number');
    const crisis = await get<CrisisResponse>('/metrics/crisis');
    expect(crisis.shown).toBe(40);
    const timeliness = await get<TimelinessResponse>('/metrics/timeliness');
    expect(timeliness.overall).not.toHaveProperty('suppressed');
    expect(timeliness.overdue).not.toHaveProperty('suppressed');
  });
});
