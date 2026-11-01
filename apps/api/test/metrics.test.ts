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
        // On the first stage a source's row also holds invites no filter value shows, so a single hidden tier cell is lost among them; the invites themselves are checked below.
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
    // tele: 12 settled, 11 in time and 1 late, so its rate has fewer than ten on the late side and is hidden.
    for (let i = 0; i < 18; i += 1) await world.addTicket({ tier: 'gp', issuedAt: issued(24 * 30), path: ['seen'], hours: [24 * (1 + (i % 4))] });
    for (let i = 0; i < 12; i += 1) await world.addTicket({ tier: 'gp', issuedAt: issued(24 * 30), path: ['overdue', 'seen'], hours: [24 * 8, 24 * 9] });
    for (let i = 0; i < 11; i += 1) await world.addTicket({ tier: 'tele', issuedAt: issued(24 * 30), path: ['acknowledged', 'seen'], hours: [10, 24 * 2] });
    await world.addTicket({ tier: 'tele', issuedAt: issued(24 * 30), path: ['overdue', 'seen'], hours: [24 * 8, 24 * 20] });
    const timeliness = await get<TimelinessResponse>('/metrics/timeliness');
    const gp = timeliness.tiers.find((entry) => entry.tier === 'gp')!.cell;
    expect(gp).toMatchObject({ tickets: 30, withinTarget: { count: 18, of: 30, percent: 60 } });
    // Days to seen: five 1s, five 2s, four 3s, four 4s and twelve 9s; the median is the 15th of 30, the 90th percentile the 27th.
    expect((gp as { medianDaysToSeen: number }).medianDaysToSeen).toBe(4);
    expect((gp as { p90DaysToSeen: number }).p90DaysToSeen).toBe(9);
    expect(timeliness.overall).toMatchObject({ tickets: 42, withinTarget: { count: 29, of: 42, percent: 69 } });
    expect(timeliness.tiers.find((entry) => entry.tier === 'tele')!.cell).toEqual({ suppressed: true });
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
    await settle('community', 3, 0);
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

  it('counts the people who gave no bucket as a group of every dimension that can be empty, and language as the ticket language', async () => {
    await world.addMany(14, { issuedAt: issued(100), path: ['seen'], language: 'ar' }, { optIn: true, ageBand: '25_34', gender: 'female', region: 'al_ain' });
    await world.addMany(30, { issuedAt: issued(100), path: [], language: 'en' });
    const equity = await get<EquityResponse>('/metrics/equity');
    const rows = (dimension: string) => Object.fromEntries(equity.dimensions.find((entry) => entry.dimension === dimension)!.rows.map((row) => [row.value, row.cell]));
    // 0 closed of 30 and 14 closed of 14 each leave one side of the rate under ten, so neither group shows a number.
    expect(rows('age_band')['not_given']).toEqual({ suppressed: true });
    expect(rows('age_band')['25_34']).toEqual({ suppressed: true });
    expect(Object.keys(rows('language')).sort()).toEqual(['ar', 'en', 'hi', 'other', 'tl', 'ur']);
    expect(Object.keys(rows('gender'))).toContain('not_given');
    expect(Object.keys(rows('language'))).not.toContain('not_given');
  });

  it('flags a group 10 points or more from the overall rate, and carries no flag or gap on a suppressed one', async () => {
    // English: 30 of 40 closed (75%); Urdu: 12 of 30 (40%); Hindi: 4 tickets (hidden). Overall 46 of 74 = 62.2%.
    for (let i = 0; i < 40; i += 1) await world.addTicket({ language: 'en', issuedAt: issued(24 * 20), path: i < 30 ? ['seen'] : [] });
    for (let i = 0; i < 30; i += 1) await world.addTicket({ language: 'ur', issuedAt: issued(24 * 20), path: i < 12 ? ['seen'] : [] });
    for (let i = 0; i < 4; i += 1) await world.addTicket({ language: 'hi', issuedAt: issued(24 * 20), path: ['seen'] });
    const equity = await get<EquityResponse>('/metrics/equity');
    expect(equity.overall).toEqual({ tickets: 74, loopClosed: 46, ratePercent: 62.2 });
    const language = Object.fromEntries(equity.dimensions.find((entry) => entry.dimension === 'language')!.rows.map((row) => [row.value, row.cell]));
    expect(language['ur']).toMatchObject({ ratePercent: 40, gapPoints: -22.2, flagged: true });
    expect(language['en']).toMatchObject({ ratePercent: 75, gapPoints: 12.8, flagged: true });
    // hi (4) is hidden, so the smallest visible group is hidden with it: nothing is left to subtract.
    expect(language['hi']).toEqual({ suppressed: true });
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
    expect(cell.tickets).toBe(60);
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
    const expected = 14 + 470 + 40; // open invites + parentless tickets + crisis events
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
    expect(counts(await get<FunnelResponse>('/metrics/funnel')).positive_screen).toBe(14 + 470 + 40);
    ctx.clock.set(new Date(SEED_ANCHOR.getTime() + 40 * DAY));
    // The invites have lapsed (they expire between 5 and 29 days after the anchor); tickets and crisis events stay.
    expect(counts(await get<FunnelResponse>('/metrics/funnel')).positive_screen).toBe(470 + 40);
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
