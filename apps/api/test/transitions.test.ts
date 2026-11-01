import { ACTORS, TICKET_STATES, type Actor, type TicketState } from '@mawsool/types';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import { runSeed } from '../src/seed/run';
import { createRng } from '../src/seed/prng';
import { lastEvent, moveTicket } from '../src/tickets/events';
import { TERMINAL_STATES, deriveState, evaluate, evaluateUnable } from '../src/tickets/transitions';
import { createTestApp, type TestApp } from './helpers/app';
import { createTestDb, type TestDb } from './helpers/db';
import { eventStates, issue, registerPerson, serviceAt, ticketRequest } from './helpers/flow';

/**
 * The allowed moves, written out by hand from the plan's decisions and independently of the rule table in the source:
 * [from, to, actors]. Anything not listed must be refused.
 */
const ALLOWED: [TicketState, TicketState, Actor[]][] = [
  ['issued', 'acknowledged', ['clinic']],
  ['issued', 'overdue', ['system']],
  ['acknowledged', 'overdue', ['system']],
  ['issued', 'seen', ['clinic', 'person']],
  ['acknowledged', 'seen', ['clinic', 'person']],
  ['overdue', 'seen', ['clinic', 'person']],
  ['issued', 'rerouted', ['person']],
  ['acknowledged', 'rerouted', ['person']],
  ['overdue', 'rerouted', ['person']],
  ['issued', 'declined', ['person']],
  ['acknowledged', 'declined', ['person']],
  ['overdue', 'declined', ['person']],
  ['issued', 'withdrawn', ['person']],
  ['acknowledged', 'withdrawn', ['person']],
  ['overdue', 'withdrawn', ['person']],
  ['seen', 'withdrawn', ['person']],
  ['remeasured', 'withdrawn', ['person']],
  ['seen', 'remeasured', ['person']],
  ['seen', 'closed', ['person', 'system']],
  ['remeasured', 'closed', ['person', 'system']],
];

describe('the transition table', () => {
  it('allows exactly the listed moves for exactly the listed actors, and refuses every other combination', () => {
    for (const from of TICKET_STATES) {
      for (const to of TICKET_STATES) {
        const rule = ALLOWED.find(([f, t]) => f === from && t === to);
        for (const actor of ACTORS) {
          const expected = !rule ? 'illegal' : rule[2].includes(actor) ? 'ok' : 'forbidden';
          expect(evaluate(from, to, actor), `${from} -> ${to} by ${actor}`).toBe(expected);
        }
      }
    }
  });

  it('lets nothing leave a terminal state', () => {
    expect([...TERMINAL_STATES].sort()).toEqual(['closed', 'declined', 'rerouted', 'withdrawn']);
    for (const from of TERMINAL_STATES) for (const to of TICKET_STATES) for (const actor of ACTORS) expect(evaluate(from, to, actor)).toBe('illegal');
  });

  it('allows "unable to see" only for a clinic, and only where a reroute is possible', () => {
    for (const state of TICKET_STATES) {
      const reroutable = ['issued', 'acknowledged', 'overdue'].includes(state);
      expect(evaluateUnable(state, 'clinic')).toBe(reroutable ? 'ok' : 'illegal');
      expect(evaluateUnable(state, 'person')).toBe(reroutable ? 'forbidden' : 'illegal');
      expect(evaluateUnable(state, 'system')).toBe(reroutable ? 'forbidden' : 'illegal');
    }
  });

  it('derives the state from the highest sequence number whatever the order given', () => {
    expect(deriveState([])).toBeNull();
    expect(deriveState([{ seq: 2, toState: 'seen' }, { seq: 1, toState: 'issued' }, { seq: 3, toState: 'closed' }])).toBe('closed');
  });
});

describe('random walks over a real database', () => {
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

  it('keeps the cached state equal to the state derived from the events, the sequence gap-free and every event allowed', async () => {
    const random = createRng('transition-walk');
    const person = await registerPerson(ctx);
    const service = await serviceAt(testDb.db, 'A', 'gp');
    let attempts = 0;
    let moved = 0;
    for (let walk = 0; walk < 12; walk += 1) {
      const ticket = await issue(ctx, person, ticketRequest(service));
      for (let step = 0; step < 14; step += 1) {
        const to = random.pick(TICKET_STATES);
        const actor = random.pick(ACTORS);
        const before = await lastEvent(testDb.db, ticket.id);
        const outcome = await moveTicket(testDb.db, { ticketId: ticket.id, to, actor, channel: 'test', at: ctx.clock.now() });
        attempts += 1;
        const after = await lastEvent(testDb.db, ticket.id);
        if (outcome.result === 'moved') {
          moved += 1;
          expect(evaluate(before!.state, to, actor)).toBe('ok');
          expect(after).toEqual({ seq: before!.seq + 1, state: to });
        } else {
          expect(after).toEqual(before);
        }
      }
      const events = await eventStates(testDb.db, ticket.id);
      expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
      const [row] = await testDb.db.select({ state: schema.tickets.state }).from(schema.tickets).where(eq(schema.tickets.id, ticket.id));
      expect(row!.state).toBe(deriveState(events.map((event) => ({ seq: event.seq, toState: event.to }))));
      for (const event of events.slice(1)) expect(evaluate(event.from!, event.to, event.actor)).toBe('ok');
    }
    // The walk was not trivial in either direction.
    expect(moved).toBeGreaterThan(20);
    expect(attempts - moved).toBeGreaterThan(60);
  });

  it('refuses a second event with the same sequence number at the database', async () => {
    const person = await registerPerson(ctx);
    const ticket = await issue(ctx, person, ticketRequest(await serviceAt(testDb.db, 'A', 'gp')));
    await expect(
      testDb.db.insert(schema.ticketEvents).values({ ticketId: ticket.id, seq: 1, toState: 'issued', actor: 'person', channel: 'x', at: ctx.clock.now() }),
    ).rejects.toThrow();
  });
});
