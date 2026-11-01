import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { REGIONS, TICKET_SOURCES } from '@mawsool/types';
import { generateSeed, LOOP_CLOSED_OTHER, LOOP_CLOSED_URDU, TICKET_COUNT, URDU_TICKET_COUNT } from '../src/seed/generate';
import { FACILITY_A_ID, FACILITY_B_ID, SEED_ANCHOR } from '../src/seed/fixtures';
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

  it('has demo staff: a clinician at each facility, ops and admin', () => {
    expect(data.staffUsers.map((s) => s.role).sort()).toEqual(['admin', 'clinician', 'clinician', 'ops']);
    expect(new Set(data.staffUsers.filter((s) => s.role === 'clinician').map((s) => s.facilityId))).toEqual(
      new Set([FACILITY_A_ID, FACILITY_B_ID]),
    );
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
    await runSeed(first.db);
    vi.setSystemTime(new Date('2031-05-05T05:05:05Z'));
    try {
      await runSeed(second.db);
    } finally {
      vi.useRealTimers();
    }
  });

  afterAll(async () => {
    vi.useRealTimers();
    await Promise.all([first.close(), second.close()]);
  });

  it('holds the same data in two separate databases seeded at different times', async () => {
    const [a, b] = await Promise.all([dumpDatabase(first.db), dumpDatabase(second.db)]);
    expect(Object.keys(a)).toHaveLength(ALL_TABLE_NAMES.length);
    expect(ALL_TABLE_NAMES).toHaveLength(16);
    expect(a['tickets']).toHaveLength(TICKET_COUNT);
    expect(b).toEqual(a);
  });

  it('holds the same data after seeding the same database a second time', async () => {
    const before = await dumpDatabase(first.db);
    await runSeed(first.db);
    expect(await dumpDatabase(first.db)).toEqual(before);
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
