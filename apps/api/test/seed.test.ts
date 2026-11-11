import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { reliableChange, remeasureAvailableAt, SUPPRESSION_THRESHOLD } from '@mawsool/rules';
import { BundleContentSchema, REGIONS, TICKET_SOURCES } from '@mawsool/types';
import { generateSeed, LOOP_CLOSED_OTHER, LOOP_CLOSED_URDU, TICKET_COUNT, URDU_TICKET_COUNT } from '../src/seed/generate';
import { startOfDubaiDay } from '../src/metrics/facts';
import { LAST_DASHBOARD_POSITION_MS, SEED_OUTCOME_QUOTAS, SEED_OUTCOME_SHARES } from '../src/seed/outcome-shares';
import { bundleContext } from '../src/tickets/service';
import { FACILITY_A_ID, FACILITY_B_ID, SEED_ANCHOR } from '../src/seed/fixtures';
import { schema } from '../src/db/client';
import { ALL_TABLE_NAMES } from '../src/db/schema';
import { runSeed } from '../src/seed/run';
import { loopClosedByLanguage, urduGap } from '../src/seed/stats';
import { createTestDb, dumpDatabase, type TestDb } from './helpers/db';

const DAY = 86_400_000;

describe('seed content', () => {
  const data = generateSeed();

  it('has 24 sample services, 6 self-help without a facility and 18 tied to one of two facilities', () => {
    expect(data.services).toHaveLength(24);
    expect(data.services.every((s) => s.sample === true)).toBe(true);
    const selfHelp = data.services.filter((s) => s.tier === 'self_help');
    expect(selfHelp).toHaveLength(6);
    expect(selfHelp.every((s) => s.facilityId === null)).toBe(true);
    const others = data.services.filter((s) => s.tier !== 'self_help');
    expect(others).toHaveLength(18);
    expect(new Set(others.map((s) => s.facilityId))).toEqual(new Set([FACILITY_A_ID, FACILITY_B_ID]));
  });

  it('gives every service and facility an Arabic name, and every facility Arabic contact text, with no Latin letter in any of them', () => {
    for (const service of data.services) expect(service.nameAr, service.name).toMatch(/^[^A-Za-z]*[؀-ۿ][^A-Za-z]*$/);
    for (const facility of data.facilities) {
      expect(facility.nameAr, facility.name).toMatch(/^[^A-Za-z]*[؀-ۿ][^A-Za-z]*$/);
      expect(facility.contactTextAr, facility.name).toMatch(/^[^A-Za-z]*[؀-ۿ][^A-Za-z]*$/);
    }
    expect(new Set(data.services.map((service) => service.nameAr)).size).toBe(data.services.length);
  });

  it('covers tele, every region, and all five tiers', () => {
    expect(new Set(data.services.map((s) => s.tier))).toEqual(new Set(['self_help', 'community', 'tele', 'gp', 'specialist']));
    expect(new Set(data.services.map((s) => s.region))).toEqual(new Set(REGIONS));
    expect(data.services.filter((s) => s.tier === 'tele').every((s) => s.facilityId !== null)).toBe(true);
  });

  it('has 500 tickets over 90 days, all on seeded non-self-help services', () => {
    expect(data.tickets).toHaveLength(TICKET_COUNT);
    const serviceIds = new Set(data.services.filter((s) => s.tier !== 'self_help').map((s) => s.id));
    expect(data.tickets.every((t) => serviceIds.has(t.serviceId))).toBe(true);
    const created = data.tickets.map((t) => t.createdAt.getTime());
    expect(Math.min(...created)).toBeGreaterThanOrEqual(SEED_ANCHOR.getTime() - 90 * DAY);
    expect(Math.max(...created)).toBeLessThan(SEED_ANCHOR.getTime());
    // "Over 90 days": the tickets span most of the window, not one corner of it.
    expect(Math.max(...created) - Math.min(...created)).toBeGreaterThan(80 * DAY);
  });

  it('has tickets from every source, with unique short codes', () => {
    expect(new Set(data.tickets.map((t) => t.source))).toEqual(new Set(TICKET_SOURCES));
    expect(new Set(data.tickets.map((t) => t.shortCode)).size).toBe(TICKET_COUNT);
    expect(data.tickets.every((t) => /^MW[2-9A-HJKMNP-Z]{4}$/.test(t.shortCode))).toBe(true);
  });

  it('has reroute chains: a rerouted parent and a child that names it', () => {
    const byId = new Map(data.tickets.map((t) => [t.id, t]));
    const children = data.tickets.filter((t) => t.parentTicketId);
    expect(children).toHaveLength(30);
    for (const child of children) {
      const parent = byId.get(child.parentTicketId!)!;
      expect(parent.state).toBe('rerouted');
      expect(parent.personId).toBe(child.personId);
      expect(parent.serviceId).not.toBe(child.serviceId);
    }
  });

  it('has equity buckets only for persons who opted in, with all four buckets', () => {
    const optedIn = data.persons.filter((p) => p.equityOptIn);
    expect(optedIn.length).toBeGreaterThan(200);
    expect(optedIn.length).toBeLessThan(data.persons.length);
    for (const person of data.persons) {
      const buckets = [person.ageBand, person.gender, person.language, person.region];
      expect(buckets.every((b) => (person.equityOptIn ? b !== null : b === null))).toBe(true);
    }
  });

  it('has 40 crisis events carrying no person id', () => {
    expect(data.crisisEvents).toHaveLength(40);
    expect(data.crisisEvents.every((c) => !('personId' in c))).toBe(true);
    expect(data.crisisEvents.some((c) => c.humanContactConfirmed)).toBe(true);
    expect(data.crisisEvents.some((c) => c.callTapped === null)).toBe(true);
  });

  it('has demo staff: a clinician at each facility, ops, admin and the mock crisis-line operator', () => {
    expect(data.staffUsers.map((s) => s.role).sort()).toEqual(['admin', 'clinician', 'clinician', 'crisis_line', 'ops']);
    expect(new Set(data.staffUsers.filter((s) => s.role === 'clinician').map((s) => s.facilityId))).toEqual(
      new Set([FACILITY_A_ID, FACILITY_B_ID]),
    );
  });
});

describe('seeded re-measured tickets that share their totals and opted in to the statistics', () => {
  const data = generateSeed();
  const eventsOf = Map.groupBy(data.ticketEvents, (event) => event.ticketId);
  const reachedRemeasured = data.tickets.filter((ticket) => eventsOf.get(ticket.id)!.some((event) => event.toState === 'remeasured'));
  const personOf = new Map(data.persons.map((person) => [person.id, person]));
  const sharedIds = new Set(data.sharedBundles.map((bundle) => bundle.ticketId));
  const scoresOf = (ticketId: string) => data.sharedBundles.find((bundle) => bundle.ticketId === ticketId)!.content.scores!;

  it('gives 35 re-measured tickets a ticket consent, a scores consent and a bundle, and no other ticket any, on top of the 47 older re-measured ones that share nothing', () => {
    expect(reachedRemeasured).toHaveLength(47 + SEED_OUTCOME_SHARES);
    expect(data.sharedBundles).toHaveLength(SEED_OUTCOME_SHARES);
    expect(sharedIds.size).toBe(SEED_OUTCOME_SHARES);
    for (const id of sharedIds) expect(reachedRemeasured.map((ticket) => ticket.id)).toContain(id);
    expect(data.consents).toHaveLength(2 * SEED_OUTCOME_SHARES);
    expect(new Set(data.consents.map((consent) => consent.ticketId))).toEqual(sharedIds);
    for (const id of sharedIds) expect(data.consents.filter((consent) => consent.ticketId === id).map((consent) => consent.element).sort()).toEqual(['scores', 'ticket']);
    for (const consent of data.consents) expect(consent.revokedAt ?? null).toBeNull();
  });

  it('places each repeat check after the six weeks, before the seed\'s reference time and inside the window the dashboard still shows 28 days and 23 hours into the demo, and leaves the ticket closed', () => {
    const windowStart = startOfDubaiDay(new Date(SEED_ANCHOR.getTime() + LAST_DASHBOARD_POSITION_MS - 90 * DAY)).getTime();
    const ticketOf = new Map(data.tickets.map((ticket) => [ticket.id, ticket]));
    for (const id of sharedIds) {
      const ticket = ticketOf.get(id)!;
      const events = eventsOf.get(id)!;
      expect(ticket.parentTicketId, 'a root ticket').toBeNull();
      expect(ticket.createdAt.getTime(), 'still in the last 90 days at +28 d 23 h').toBeGreaterThanOrEqual(windowStart);
      expect(ticket.state).toBe('closed');
      expect(events.map((event) => event.toState).slice(-3)).toEqual(['seen', 'remeasured', 'closed']);
      const [seen, remeasured, closed] = events.slice(-3);
      expect(remeasured!.at.getTime(), 'six weeks after seen').toBeGreaterThanOrEqual(remeasureAvailableAt(seen!.at).getTime());
      expect(closed!.at.getTime()).toBeGreaterThan(remeasured!.at.getTime());
      expect(closed!.at.getTime(), 'before the reference time').toBeLessThanOrEqual(SEED_ANCHOR.getTime());
      expect([remeasured!.actor, closed!.actor]).toEqual(['person', 'system']);
    }
  });

  it('opts in the people of those tickets and nobody else', () => {
    const owners = new Set(reachedRemeasured.filter((ticket) => sharedIds.has(ticket.id)).map((ticket) => ticket.personId));
    expect(owners.size).toBe(SEED_OUTCOME_SHARES);
    expect(new Set(data.persons.filter((person) => person.outcomeStatsOptIn).map((person) => person.id))).toEqual(owners);
    for (const ticket of reachedRemeasured.filter((candidate) => !sharedIds.has(candidate.id))) expect(personOf.get(ticket.personId)!.outcomeStatsOptIn).toBe(false);
  });

  it('holds a referral and a repeat total of each instrument, taken before and after the repeat check opened, that the bundle schema accepts', () => {
    for (const bundle of data.sharedBundles) {
      expect(BundleContentSchema.safeParse(bundle.content).success, bundle.ticketId).toBe(true);
      const events = eventsOf.get(bundle.ticketId)!;
      const opens = remeasureAvailableAt(events.find((event) => event.toState === 'seen')!.at).getTime();
      const remeasuredAt = events.find((event) => event.toState === 'remeasured')!.at.getTime();
      for (const instrument of ['phq9', 'gad7'] as const) {
        const own = scoresOf(bundle.ticketId).filter((score) => score.instrument === instrument);
        const taken = own.map((score) => Date.parse(score.takenAt));
        expect(own, `${bundle.ticketId} ${instrument}`).toHaveLength(2);
        expect(taken.filter((at) => at < opens), 'one referral total before the check opened').toHaveLength(1);
        const repeatAt = taken.filter((at) => at >= opens);
        expect(repeatAt, 'one repeat total from when it opened').toHaveLength(1);
        expect(repeatAt[0]!, 'and not after it was finished').toBeLessThanOrEqual(remeasuredAt);
      }
    }
  });

  it('splits the changes the way the quotas say, by the rule the dashboard uses, so the tile has ten or more on every side that needs it', () => {
    for (const instrument of ['phq9', 'gad7'] as const) {
      const tally = { improved: 0, deteriorated: 0, unchanged: 0 };
      for (const bundle of data.sharedBundles) {
        const own = scoresOf(bundle.ticketId).filter((score) => score.instrument === instrument).sort((a, b) => Date.parse(a.takenAt) - Date.parse(b.takenAt));
        const kind = reliableChange(instrument, own[0]!.total, own[1]!.total).kind;
        tally[kind === 'reliable_improvement' ? 'improved' : kind === 'reliable_deterioration' ? 'deteriorated' : 'unchanged'] += 1;
      }
      expect(tally, instrument).toEqual(SEED_OUTCOME_QUOTAS[instrument]);
    }
    expect(SEED_OUTCOME_SHARES).toBeGreaterThanOrEqual(2 * SUPPRESSION_THRESHOLD);
  });
});

describe('seed event logs', () => {
  const data = generateSeed();
  const eventsByTicket = Map.groupBy(data.ticketEvents, (e) => e.ticketId);

  it('gives every ticket a gap-free sequence from issued, with strictly increasing times before the anchor', () => {
    expect(eventsByTicket.size).toBe(TICKET_COUNT);
    for (const ticket of data.tickets) {
      const events = eventsByTicket.get(ticket.id)!;
      expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
      expect(events[0]).toMatchObject({ fromState: null, toState: 'issued' });
      events.forEach((event, i) => {
        if (i > 0) {
          expect(event.fromState).toBe(events[i - 1]!.toState);
          expect(event.at.getTime()).toBeGreaterThan(events[i - 1]!.at.getTime());
        }
        expect(event.at.getTime()).toBeLessThanOrEqual(SEED_ANCHOR.getTime());
      });
      expect(ticket.state).toBe(events.at(-1)!.toState);
    }
  });

  it('only uses transitions the plan allows', () => {
    const allowed: Record<string, string[]> = {
      issued: ['acknowledged', 'overdue', 'declined', 'withdrawn', 'rerouted', 'seen'],
      acknowledged: ['seen', 'overdue', 'withdrawn', 'declined', 'rerouted'],
      overdue: ['rerouted', 'seen', 'declined'],
      seen: ['remeasured', 'closed', 'withdrawn'],
      remeasured: ['closed', 'withdrawn'],
    };
    for (const event of data.ticketEvents) {
      if (!event.fromState) continue;
      expect(allowed[event.fromState] ?? [], `${event.fromState} to ${event.toState}`).toContain(event.toState);
    }
  });

  it('sets a deadline at 23:59:59 Asia/Dubai', () => {
    for (const ticket of data.tickets) {
      const local = new Date(ticket.deadlineAt.getTime() + 4 * 3_600_000);
      expect([local.getUTCHours(), local.getUTCMinutes(), local.getUTCSeconds()]).toEqual([23, 59, 59]);
    }
  });

  it('puts an overdue event only after the deadline, and a seen-in-time event before it', () => {
    for (const ticket of data.tickets) {
      for (const event of eventsByTicket.get(ticket.id)!) {
        if (event.toState === 'overdue') expect(event.at.getTime()).toBeGreaterThan(ticket.deadlineAt.getTime());
      }
    }
    const overdueFirst = data.tickets.filter((t) => eventsByTicket.get(t.id)!.some((e) => e.toState === 'overdue'));
    expect(overdueFirst.length).toBeGreaterThan(50);
  });

  it('includes a ticket that was seen and later withdrawn, which still counts as loop closed', () => {
    const seenThenWithdrawn = data.tickets.filter((t) => {
      const states = eventsByTicket.get(t.id)!.map((e) => e.toState);
      return states.includes('seen') && t.state === 'withdrawn';
    });
    expect(seenThenWithdrawn.length).toBeGreaterThan(0);
  });
});

describe('seed determinism', () => {
  it('produces identical rows from two generator runs, whatever the wall clock says', () => {
    const first = generateSeed();
    // With fake timers off, setSystemTime moves only Date, so nothing else is disturbed.
    vi.setSystemTime(new Date('2031-05-05T05:05:05Z'));
    try {
      expect(generateSeed()).toEqual(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shifts every time when the anchor moves, so the anchor is the only time input', () => {
    const base = generateSeed();
    const shifted = generateSeed(new Date(SEED_ANCHOR.getTime() + 10 * DAY));
    expect(shifted.tickets.map((t) => t.id)).toEqual(base.tickets.map((t) => t.id));
    expect(shifted.tickets[0]!.createdAt.getTime()).not.toBe(base.tickets[0]!.createdAt.getTime());
  });
});

describe('seeded database', () => {
  let first: TestDb;
  let second: TestDb;

  beforeAll(async () => {
    [first, second] = await Promise.all([createTestDb(), createTestDb()]);
    await runSeed(first.db, first.cipher);
    vi.setSystemTime(new Date('2031-05-05T05:05:05Z'));
    try {
      await runSeed(second.db, second.cipher);
    } finally {
      vi.useRealTimers();
    }
  });

  afterAll(async () => {
    vi.useRealTimers();
    await Promise.all([first.close(), second.close()]);
  });

  it('holds the same data in two separate databases seeded at different times', async () => {
    const [a, b] = await Promise.all([dumpDatabase(first.db, first.cipher), dumpDatabase(second.db, second.cipher)]);
    expect(Object.keys(a)).toHaveLength(ALL_TABLE_NAMES.length);
    expect(ALL_TABLE_NAMES).toHaveLength(22);
    expect(a['tickets']).toHaveLength(TICKET_COUNT);
    expect(b).toEqual(a);
  });

  it('holds the same data after seeding the same database a second time', async () => {
    const before = await dumpDatabase(first.db, first.cipher);
    await runSeed(first.db, first.cipher);
    expect(await dumpDatabase(first.db, first.cipher)).toEqual(before);
  });

  it('stores each seeded bundle as ciphertext that opens for its own ticket only, with the content the generator made', async () => {
    const stored = await first.db.select().from(schema.sharedBundles);
    const made = generateSeed();
    expect(stored).toHaveLength(SEED_OUTCOME_SHARES);
    for (const row of stored) {
      expect(row.contentCiphertext).toMatch(/^v1\./);
      expect(row.contentCiphertext).not.toContain('phq9');
      expect(JSON.parse(first.cipher.decrypt(row.contentCiphertext!, bundleContext(row.ticketId)))).toEqual(JSON.parse(JSON.stringify(made.sharedBundles.find((bundle) => bundle.ticketId === row.ticketId)!.content)));
      expect(() => first.cipher.decrypt(row.contentCiphertext!, bundleContext(randomUUID()))).toThrow();
    }
  });

  it('would notice a changed total when two databases are compared, because the comparison opens the bundles', async () => {
    const third = await createTestDb();
    try {
      await runSeed(third.db, third.cipher);
      const [row] = await third.db.select().from(schema.sharedBundles).limit(1);
      const content = JSON.parse(third.cipher.decrypt(row!.contentCiphertext!, bundleContext(row!.ticketId))) as { scores: { total: number }[] };
      content.scores[0]!.total += 1;
      await third.db.update(schema.sharedBundles).set({ contentCiphertext: third.cipher.encrypt(JSON.stringify(content), bundleContext(row!.ticketId)) }).where(eq(schema.sharedBundles.id, row!.id));
      expect((await dumpDatabase(third.db, third.cipher))['shared_bundles']).not.toEqual((await dumpDatabase(first.db, first.cipher))['shared_bundles']);
      expect((await dumpDatabase(first.db))['shared_bundles']).not.toEqual((await dumpDatabase(second.db))['shared_bundles']);
    } finally {
      await third.close();
    }
  });

  it('counts rows through the database, not only in memory', async () => {
    const counts = await first.db.execute<{ t: number; s: number; e: number; c: number }>(sql`
      SELECT (SELECT count(*) FROM tickets)::int AS t, (SELECT count(*) FROM services)::int AS s,
             (SELECT count(*) FROM ticket_events)::int AS e, (SELECT count(*) FROM crisis_events)::int AS c`);
    expect(counts.rows[0]).toMatchObject({ t: 500, s: 24, c: 40 });
    expect(counts.rows[0]!.e).toBeGreaterThan(900);
  });

  it('plants the Urdu loop-closed gap: 18 to 22 points below the overall rate, where closed means seen or later', async () => {
    const gap = await urduGap(first.db);
    expect(gap.gapPoints).toBeGreaterThanOrEqual(18);
    expect(gap.gapPoints).toBeLessThanOrEqual(22);
    const rows = await loopClosedByLanguage(first.db);
    const urdu = rows.find((r) => r.language === 'ur')!;
    expect(urdu).toMatchObject({ tickets: URDU_TICKET_COUNT, loopClosed: LOOP_CLOSED_URDU });
    expect(rows.reduce((n, r) => n + r.loopClosed, 0)).toBe(LOOP_CLOSED_URDU + LOOP_CLOSED_OTHER);
  });

  it('measures loop closed from events, not from the current state', async () => {
    // A ticket seen and later withdrawn has state withdrawn but is still loop closed.
    const result = await first.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM tickets t
      WHERE t.state = 'withdrawn' AND EXISTS (SELECT 1 FROM ticket_events e WHERE e.ticket_id = t.id AND e.to_state = 'seen')`);
    expect(result.rows[0]!.n).toBeGreaterThan(0);
    const byState = await first.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM tickets WHERE state IN ('seen', 'remeasured', 'closed')`);
    const total = LOOP_CLOSED_URDU + LOOP_CLOSED_OTHER;
    expect(byState.rows[0]!.n).toBeLessThan(total);
  });
});
