import { TICKET_SOURCES, TICKET_TIERS, type CrisisResponse, type EquityResponse, type FunnelResponse } from '@mawsool/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadCrisisFacts, loadTicketFacts, periodStart, type TicketFact } from '../src/metrics/facts';
import { journeysOf } from '../src/metrics/funnel';
import { runSeed } from '../src/seed/run';
import { SEED_ANCHOR } from '../src/seed/fixtures';
import { createTestApp, signIn, TEST_START, type TestApp } from './helpers/app';
import { createTestDb, type TestDb } from './helpers/db';
import { createWorld, DAY, HOUR } from './helpers/world';

/**
 * Subtractions a reader can try on the published figures, run on real route responses and compared with the truth read
 * from the tables. Each one fails the test if it comes out exact. They are the ones a reviewer found by hand: the first
 * stage minus the second, a hidden cell recovered from a row total shown at one stage and hidden at the other, the crisis
 * count from the funnel, and the same tickets counted as "no bucket given" in several dimensions.
 */
type Stage = 'positive_screen' | 'ticket_issued';
const num = (value: unknown): number | null => (typeof value === 'number' ? value : null);

describe('what cannot be worked out from the funnel, the crisis figures and the equity view', () => {
  let testDb: TestDb;
  let ctx: TestApp;
  let headers: { authorization: string };
  let facts: TicketFact[];

  beforeAll(async () => {
    testDb = await createTestDb();
    await runSeed(testDb.db, testDb.cipher, SEED_ANCHOR);
    ctx = await createTestApp(testDb.db);
    ctx.clock.set(SEED_ANCHOR);
    headers = { authorization: `Bearer ${await signIn(ctx, 'ops@demo.mawsool.test')}` };
    facts = await loadTicketFacts(testDb.db);
  });

  afterAll(async () => {
    await ctx.app.close();
    await testDb.close();
  });

  const get = async <T>(path: string): Promise<T> => {
    const res = await ctx.app.inject({ method: 'GET', url: path, headers });
    if (res.statusCode !== 200) throw new Error(`${path}: ${res.statusCode} ${res.body}`);
    return res.json() as T;
  };
  const stageCount = (funnel: FunnelResponse, stage: Stage) => num(funnel.stages.find((entry) => entry.stage === stage)!.count);

  for (const period of ['90d', '30d', 'all'] as const) {
    describe(`over ${period}`, () => {
      const since = () => periodStart(period, SEED_ANCHOR);
      const journeys = () => journeysOf(facts).filter((journey) => since() === null || journey.createdAt >= since()!);

      it('does not give a hidden source-and-tier cell from a row or column total at either stage, and shows it at both stages or neither', async () => {
        const truth = (source: string, tier: string) => journeys().filter((journey) => journey.source === source && journey.tier === tier).length;
        const cell = async (stage: Stage, source: string | null, tier: string | null) =>
          stageCount(await get<FunnelResponse>(`/metrics/funnel?period=${period}${source ? `&source=${source}` : ''}${tier ? `&tier=${tier}` : ''}`), stage);
        for (const source of TICKET_SOURCES) {
          for (const tier of TICKET_TIERS) {
            const seen = { positive_screen: await cell('positive_screen', source, tier), ticket_issued: await cell('ticket_issued', source, tier) };
            expect(seen.positive_screen === null, `${source}/${tier} is hidden at both stages or neither`).toBe(seen.ticket_issued === null);
            for (const stage of ['positive_screen', 'ticket_issued'] as const) {
              if (seen[stage] !== null) continue;
              const row = await cell(stage, source, null);
              const others = await Promise.all(TICKET_TIERS.filter((other) => other !== tier).map((other) => cell(stage, source, other)));
              // A stage 1 row also holds the source's open invites, which are not tickets, so only the ticket stage's row is a pure sum.
              if (stage === 'ticket_issued' && row !== null && others.every((value) => value !== null)) {
                expect(row - others.reduce((sum, value) => sum + (value ?? 0), 0), `${source}/${tier} from its row at ${stage}`).not.toBe(truth(source, tier));
              }
              const column = await cell(stage, null, tier);
              const peers = await Promise.all(TICKET_SOURCES.filter((other) => other !== source).map((other) => cell(stage, other, tier)));
              if (column !== null && peers.every((value) => value !== null)) {
                expect(column - peers.reduce((sum, value) => sum + (value ?? 0), 0), `${source}/${tier} from its column at ${stage}`).not.toBe(truth(source, tier));
              }
            }
          }
        }
      });

      it('does not give the crisis count as the difference of the funnel’s totals less the sources’ differences, and the crisis figures follow the funnel', async () => {
        const trueCrisis = (await loadCrisisFacts(testDb.db)).filter((event) => since() === null || event.shownAt >= since()!).length;
        const grand = await get<FunnelResponse>(`/metrics/funnel?period=${period}`);
        const perSource = await Promise.all(TICKET_SOURCES.map((source) => get<FunnelResponse>(`/metrics/funnel?period=${period}&source=${source}`)));
        const diffs = perSource.map((funnel) => [stageCount(funnel, 'positive_screen'), stageCount(funnel, 'ticket_issued')] as const);
        const [grandFirst, grandSecond] = [stageCount(grand, 'positive_screen'), stageCount(grand, 'ticket_issued')];
        if (grandFirst !== null && grandSecond !== null && diffs.every(([a, b]) => a !== null && b !== null)) {
          const rest = diffs.reduce((sum, [a, b]) => sum + (a! - b!), 0);
          expect(grandFirst - grandSecond - rest, 'the crisis count from the funnel').not.toBe(trueCrisis);
        }
        const crisis = await get<CrisisResponse>(`/metrics/crisis?period=${period}`);
        // On this seed the funnel does not hide the crisis events in any of the three periods: it holds 40 crisis screens (18 in
        // the last 30 days), so the crisis route publishes the true count. (When the funnel does hide them, the route hides
        // the figures with it: `metrics-crisis.test.ts` and the six-screen case below.)
        expect(crisis.shown, `the crisis count over ${period}`).toBe(trueCrisis);
      });
    });
  }

  it('does not give the equity group "another" back through the groups every dimension shares', async () => {
    const equity = await get<EquityResponse>('/metrics/equity');
    const inPeriod = facts;
    const valueOf: Record<string, (ticket: TicketFact) => string | null> = {
      age_band: (ticket) => ticket.ageBand,
      gender: (ticket) => ticket.gender,
      language: (ticket) => ticket.bucketLanguage,
      region: (ticket) => ticket.region,
    };
    const notGiven = equity.dimensions.map((dimension) => ({ dimension: dimension.dimension, hidden: 'suppressed' in dimension.rows.find((row) => row.value === 'not_given')!.cell }));
    // The same tickets are "no bucket given" in every dimension in the seed (a person opts in to all four or none), so it is shown in all or in none.
    expect(new Set(notGiven.map((entry) => entry.hidden)).size, JSON.stringify(notGiven)).toBe(1);
    const shownSomewhere = notGiven.some((entry) => !entry.hidden);
    for (const dimension of equity.dimensions) {
      const hiddenValues = dimension.rows.filter((row) => 'suppressed' in row.cell && !(shownSomewhere && row.value === 'not_given')).map((row) => row.value);
      const present = hiddenValues.filter((value) => inPeriod.some((ticket) => (valueOf[dimension.dimension]!(ticket) ?? 'not_given') === value));
      // What the overall figure minus the shown groups leaves is more than one non-empty group, so no one group is that number.
      expect(present.length, `${dimension.dimension}: hidden non-empty groups ${present.join(', ')}`).not.toBe(1);
    }
    // The reader's try at "another": the total, less the gender groups that are shown, less "no bucket given" taken from the
    // age dimension when gender hides its own copy.
    const gender = equity.dimensions.find((dimension) => dimension.dimension === 'gender')!;
    const total = (equity.overall as { tickets: number }).tickets;
    const ageNotGiven = equity.dimensions.find((dimension) => dimension.dimension === 'age_band')!.rows.find((row) => row.value === 'not_given')!.cell;
    const genderNotGivenHidden = 'suppressed' in gender.rows.find((row) => row.value === 'not_given')!.cell;
    const shown = gender.rows.reduce((sum, row) => sum + ('suppressed' in row.cell ? 0 : row.cell.tickets), 0);
    const borrowed = genderNotGivenHidden && !('suppressed' in ageNotGiven) ? ageNotGiven.tickets : 0;
    const attempt = total - shown - borrowed;
    expect(attempt, 'gender "another" from the total').not.toBe(inPeriod.filter((ticket) => ticket.gender === 'another').length);
  });

  it('does not give a front door’s open invites as its first stage minus its second when each door holds only a few', async () => {
    // The seed holds twelve open invites per door, which are publishable. Here each door holds a few (3, 5 and 4), so each
    // count is a small number that stage 1 less stage 2 would otherwise give back.
    const db = await createTestDb();
    try {
      const world = await createWorld(db.db);
      const app = await createTestApp(db.db);
      const opsHeaders = await world.opsHeaders();
      const issued = (hoursAgo: number) => new Date(TEST_START.getTime() - hoursAgo * HOUR);
      for (const source of TICKET_SOURCES) for (const tier of TICKET_TIERS) await world.addMany(12, { source, tier, issuedAt: issued(100), path: ['seen'] });
      const few = { phc: 3, tamm: 5, school: 4 } as const;
      for (const [source, count] of Object.entries(few) as [keyof typeof few, number][]) {
        for (let i = 0; i < count; i += 1) await world.addInvite({ source, createdAt: issued(24), expiresAt: new Date(TEST_START.getTime() + 5 * DAY) });
      }
      const read = async (source: string) => (await app.app.inject({ method: 'GET', url: `/metrics/funnel?source=${source}`, headers: opsHeaders })).json() as FunnelResponse;
      for (const [source, truth] of Object.entries(few)) {
        const funnel = await read(source);
        // On this fixture the door's first stage is hidden outright (its invites are a small number the table protects), while
        // the ticket stage stays readable; so stage 1 minus stage 2 has nothing to subtract, whatever the invite count is.
        expect(funnel.stages.find((entry) => entry.stage === 'positive_screen')!.count, `${source} (${truth} open invites): the first stage`).toEqual({ suppressed: true });
        expect(stageCount(funnel, 'ticket_issued'), `${source}: the ticket stage stays readable`).toBe(48);
      }
      await app.app.close();
    } finally {
      await db.close();
    }
  });

  it('hides the crisis count along with the funnel when six crisis screens are all there is', async () => {
    const db = await createTestDb();
    try {
      const world = await createWorld(db.db);
      const app = await createTestApp(db.db);
      const opsHeaders = await world.opsHeaders();
      const issued = (hoursAgo: number) => new Date(TEST_START.getTime() - hoursAgo * HOUR);
      for (const source of TICKET_SOURCES) for (const tier of TICKET_TIERS) await world.addMany(12, { source, tier, issuedAt: issued(100), path: ['seen'] });
      for (let i = 0; i < 6; i += 1) await world.addCrisis({ shownAt: issued(DAY / HOUR + i), called: true });
      const read = async <T>(path: string) => (await app.app.inject({ method: 'GET', url: path, headers: opsHeaders })).json() as T;
      const funnel = await read<FunnelResponse>('/metrics/funnel');
      const crisis = await read<CrisisResponse>('/metrics/crisis');
      expect(crisis.shown).toEqual({ suppressed: true });
      expect(crisis.calledALine).toEqual({ suppressed: true });
      const [first, second] = [stageCount(funnel, 'positive_screen'), stageCount(funnel, 'ticket_issued')];
      if (first !== null && second !== null) expect(first - second, 'the six crisis screens from the funnel').not.toBe(6);
      // And the ticket stages stay readable: the one that goes is the first stage's total.
      expect(second).toBe(192);
      await app.app.close();
    } finally {
      await db.close();
    }
  });
});
