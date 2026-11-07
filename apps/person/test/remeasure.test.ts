import type { PersonTicketView, Screening, TicketState } from '@mawsool/types';
import { createTabMark } from '@mawsool/ui';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCrisisStore, isCrisisMark, type CrisisMark } from '../lib/crisis';
import { recordAnswer, type RecordAnswerDeps } from '../lib/record-answer';
import { idFrom, remeasureDue, remeasureOpensAt, repeatCheck, seenAt, sendRemeasure, sinceFrom, totalsOf } from '../lib/remeasure';
import { GUARDED_ROUTES, isGuardedPath } from '../lib/routes';
import { findDraft, loadScreenings } from '../lib/screening-store';
import { forgetRegistration } from '../lib/server';
// @ts-expect-error plain .mjs script with JSDoc types
import { PRECACHE_ROUTES } from '../scripts/build-precache.mjs';
import ar from '../messages/ar.json';
import en from '../messages/en.json';
import { fixtureClock, memoryStorage } from './helpers/memory';

const DAY = 86_400_000;
const SEEN = '2026-11-09T10:00:00+04:00';
const AT = (days: number, from = SEEN) => new Date(Date.parse(from) + days * DAY);
const TICKET_ID = '11111111-1111-4111-8111-111111111111';

type EventLike = PersonTicketView['events'][number];
const event = (seq: number, fromState: TicketState | null, toState: TicketState, at: string, actor = 'clinic'): EventLike => ({ seq, fromState, toState, actor, reason: null, selfConfirmed: false, at: new Date(at).toISOString() }) as EventLike;
const ticket = (state: TicketState, events: EventLike[]) => ({ state, events });
const seenTicket = ticket('seen', [event(1, null, 'issued', '2026-11-01T08:00:00+04:00', 'person'), event(2, 'issued', 'seen', SEEN)]);

describe('when the repeat check opens', () => {
  it('is six weeks to the millisecond after the seen event, not the issue date', () => {
    expect(remeasureOpensAt(seenTicket)?.toISOString()).toBe(AT(42).toISOString());
    expect(remeasureDue(seenTicket, new Date(AT(42).getTime() - 1))).toBe(false);
    expect(remeasureDue(seenTicket, AT(42))).toBe(true);
    expect(remeasureDue(seenTicket, AT(400))).toBe(true);
  });

  it('counts from the late seen of a ticket that was overdue first, and ignores a same-state event', () => {
    const late = ticket('seen', [event(1, null, 'issued', '2026-11-01T08:00:00+04:00'), event(2, 'issued', 'overdue', '2026-11-08T08:00:00+04:00'), event(3, 'overdue', 'seen', SEEN), event(4, 'seen', 'seen', '2026-11-20T08:00:00+04:00')]);
    expect(seenAt(late)?.toISOString()).toBe(new Date(SEEN).toISOString());
    expect(remeasureOpensAt(late)?.toISOString()).toBe(AT(42).toISOString());
  });

  it.each(['issued', 'acknowledged', 'overdue', 'rerouted', 'remeasured', 'closed', 'declined', 'withdrawn'] as const)('never opens for a ticket that is %s', (state) => {
    const events = [event(1, null, 'issued', '2026-11-01T08:00:00+04:00'), event(2, 'issued', 'seen', SEEN)];
    expect(remeasureOpensAt(ticket(state, events))).toBeNull();
    expect(remeasureDue(ticket(state, events), AT(400))).toBe(false);
  });

  it('does not open for a seen ticket whose seen event is missing from the list', () => {
    expect(remeasureOpensAt(ticket('seen', []))).toBeNull();
  });
});

describe('addresses', () => {
  it('reads a ticket or screening id and nothing else', () => {
    expect(idFrom(TICKET_ID)).toBe(TICKET_ID);
    for (const bad of [null, '', 'abc', `${TICKET_ID}x`, '../ticket', "11111111-1111-4111-8111-11111111111'"]) expect(idFrom(bad), String(bad)).toBeNull();
  });

  it('puts the repeat check screen among the guarded routes and in the precache list of both languages', () => {
    expect(GUARDED_ROUTES).toContain('/remeasure');
    expect(PRECACHE_ROUTES).toContain('/en/remeasure/');
    expect(PRECACHE_ROUTES).toContain('/ar/remeasure/');
    expect(isGuardedPath('/en/remeasure/')).toBe(true);
    expect(isGuardedPath('/ar/remeasure/?id=x')).toBe(true);
  });
});

describe('the two finished questionnaires of a repeat check', () => {
  const done = (id: string, instrument: 'phq9' | 'gad7', total: number): Screening =>
    ({ id, instrument, answers: Array.from({ length: instrument === 'phq9' ? 9 : 7 }, () => 0), total, band: 'mild', item9Flag: false, takenAt: '2026-12-21T09:00:00+04:00' }) as Screening;
  const phq = done('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'phq9', 7);
  const gad = done('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'gad7', 5);

  it('are found by the ids in the address, only when both are finished and of the right kind', () => {
    const opens = new Date('2026-12-21T08:00:00+04:00');
    expect(repeatCheck([phq, gad], { phq9: phq.id, gad7: gad.id }, opens)).toEqual({ phq9: phq, gad7: gad });
    expect(repeatCheck([phq], { phq9: phq.id, gad7: gad.id }, opens)).toBeNull();
    expect(repeatCheck([phq, gad], { phq9: null, gad7: gad.id }, opens)).toBeNull();
    expect(repeatCheck([phq, gad], { phq9: gad.id, gad7: phq.id }, opens)).toBeNull();
    expect(repeatCheck([phq, { ...gad, answers: [1, 1] }], { phq9: phq.id, gad7: gad.id }, opens)).toBeNull();
    expect(repeatCheck([phq, gad], { phq9: phq.id, gad7: gad.id }, null)).toBeNull();
  });

  it('refuse a screening started before the repeat check opened, to the millisecond', () => {
    const ids = { phq9: phq.id, gad7: gad.id };
    const taken = Date.parse(phq.takenAt);
    expect(repeatCheck([phq, gad], ids, new Date(taken))).not.toBeNull();
    expect(repeatCheck([phq, gad], ids, new Date(taken + 1))).toBeNull();
    const old = { ...gad, takenAt: '2026-10-01T09:00:00+04:00' };
    expect(repeatCheck([phq, old], ids, new Date('2026-12-21T08:00:00+04:00'))).toBeNull();
  });

  it('give totals with a band and a date and no answers', () => {
    const totals = totalsOf({ phq9: phq, gad7: gad });
    expect(totals).toEqual([
      { instrument: 'phq9', total: 7, band: 'mild', takenAt: phq.takenAt },
      { instrument: 'gad7', total: 5, band: 'mild', takenAt: gad.takenAt },
    ]);
    expect(JSON.stringify(totals)).not.toContain('answers');
  });
});

describe('sending the repeat check', () => {
  function server(reply: { status: number; body?: unknown } | 'offline') {
    const store = memoryStorage();
    forgetRegistration(store.storage);
    const bodies: { path: string; body: unknown }[] = [];
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === '/persons') return new Response('{}', { status: 201 });
      bodies.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (reply === 'offline') throw new TypeError('network down');
      return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status });
    }) as unknown as typeof fetch;
    return { bodies, deps: { storage: store.storage, fetch: fetchFn, apiUrl: 'http://api.test', locale: 'en' as const, random: globalThis.crypto } };
  }
  const OK = { status: 200, body: { state: 'closed', scoresShared: false, events: [] } };
  const SCORES = [{ instrument: 'phq9' as const, total: 7, band: 'mild', takenAt: '2026-12-21T09:00:00+04:00' }];

  it('sends an empty list of totals when the box is not ticked, so nothing but the move leaves the phone', async () => {
    const { bodies, deps } = server(OK);
    expect(await sendRemeasure(deps, TICKET_ID, [])).toBe('done');
    expect(bodies).toEqual([{ path: `/me/tickets/${TICKET_ID}/remeasure`, body: { scores: [] } }]);
  });

  it('sends exactly the totals the person chose to send', async () => {
    const { bodies, deps } = server(OK);
    expect(await sendRemeasure(deps, TICKET_ID, SCORES)).toBe('done');
    expect(bodies[0]!.body).toEqual({ scores: SCORES });
  });

  it('says the server refused when it answers 409, so asking again is not offered as a fix', async () => {
    expect(await sendRemeasure(server({ status: 409 }).deps, TICKET_ID, [])).toBe('not_ready');
  });

  it.each([
    ['the server cannot be reached', 'offline' as const],
    ['the server fails', { status: 503 }],
    ['the ticket is unknown', { status: 404 }],
    ['the server answers with something that is not a result', { status: 200, body: { nope: true } }],
  ])('says it failed, to ask again, when %s', async (_name, reply) => {
    expect(await sendRemeasure(server(reply).deps, TICKET_ID, [])).toBe('failed');
  });
});

describe('item 9 of the repeat PHQ-9 takes the crisis path exactly as in a check-in', () => {
  afterEach(() => vi.unstubAllGlobals());

  function setup() {
    const memory = memoryStorage();
    const clock = fixtureClock('2026-12-21T09:00:00+04:00');
    const deps = { now: clock.now, newId: clock.newId };
    const fallback = createTabMark<CrisisMark>(undefined, 'crisis', isCrisisMark);
    const crisis = createCrisisStore(memory.storage, { ...deps, fallback, readPatienceMs: 20 });
    const base: RecordAnswerDeps = { storage: memory.storage, crisis, ...deps, locale: 'en', patienceMs: 20 };
    return { ...memory, crisis, base, fallback };
  }

  it('on the first PHQ-9 being finished, a fresh one starts, and an item 9 answer above zero blocks, saves and opens an event with the network down', async () => {
    const offline = vi.fn(() => Promise.reject(new TypeError('network down')));
    vi.stubGlobal('fetch', offline);
    const { base, crisis, storage } = setup();
    // The baseline check-in: finished, item 9 at zero.
    for (let index = 0; index < 9; index += 1) await recordAnswer({ instrument: 'phq9', index, value: 0 }, base);
    const baseline = (await loadScreenings(storage)).find((screening) => screening.instrument === 'phq9')!;
    expect(baseline.answers).toHaveLength(9);
    expect((await crisis.read()).status).toBe('clear');

    // The repeat check at six weeks: a new PHQ-9, answered through the same function the check-in screen calls.
    for (let index = 0; index < 8; index += 1) expect(await recordAnswer({ instrument: 'phq9', index, value: 1 }, base)).toMatchObject({ kind: 'saved' });
    const outcome = await recordAnswer({ instrument: 'phq9', index: 8, value: 2 }, base);
    expect(outcome).toMatchObject({ kind: 'crisis', blockSaved: true });

    const state = await crisis.read();
    expect(state.status).toBe('blocked');
    const all = await loadScreenings(storage);
    expect(all).toHaveLength(2);
    expect(all.find((screening) => screening.id === baseline.id)).toEqual(baseline);
    const repeat = all.find((screening) => screening.id !== baseline.id)!;
    expect(repeat.answers[8]).toBe(2);
    expect(repeat.item9Flag).toBe(true);
    expect(offline).not.toHaveBeenCalled();
  });

  it('is not a crisis when item 9 is zero, so the guard is not simply always on', async () => {
    const { base, crisis } = setup();
    for (let index = 0; index < 9; index += 1) expect(await recordAnswer({ instrument: 'phq9', index, value: index === 8 ? 0 : 3 }, base)).toMatchObject({ kind: 'saved' });
    expect((await crisis.read()).status).toBe('clear');
  });
});

describe('the repeat check starts a fresh check-in rather than finishing an old one', () => {
  const OPENED = Date.parse('2026-12-21T08:00:00+04:00');
  const oldDraft = { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', instrument: 'phq9', answers: [3, 3, 3], total: 9, band: null, item9Flag: false, takenAt: '2026-10-01T09:00:00+04:00' } as Screening;
  const newDraft = { ...oldDraft, id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', answers: [0, 0], total: 0, takenAt: '2026-12-21T09:00:00+04:00' } as Screening;

  it('does not resume an unfinished PHQ-9 from before the repeat check opened, and resumes one started after', () => {
    expect(findDraft([oldDraft], 'phq9')).toBe(oldDraft); // an ordinary check-in still resumes it
    expect(findDraft([oldDraft], 'phq9', OPENED)).toBeUndefined();
    expect(findDraft([oldDraft, newDraft], 'phq9', OPENED)).toBe(newDraft);
    expect(findDraft([oldDraft], 'phq9', sinceFrom(null))).toBeUndefined();
    expect(findDraft([newDraft], 'phq9', Date.parse(newDraft.takenAt))).toBe(newDraft);
  });

  it('starts at question 1 with a new id, and leaves the old unfinished check-in as it was', async () => {
    const memory = memoryStorage({ screenings: [oldDraft] });
    const clock = fixtureClock('2026-12-21T10:00:00+04:00');
    const fallback = createTabMark<CrisisMark>(undefined, 'crisis', isCrisisMark);
    const crisis = createCrisisStore(memory.storage, { now: clock.now, newId: clock.newId, fallback, readPatienceMs: 20 });
    const base: RecordAnswerDeps = { storage: memory.storage, crisis, now: clock.now, newId: clock.newId, locale: 'en', patienceMs: 20 };
    const outcome = await recordAnswer({ instrument: 'phq9', index: 0, value: 1, notBefore: OPENED }, base);
    expect(outcome).toMatchObject({ kind: 'saved' });
    const all = await loadScreenings(memory.storage);
    expect(all).toHaveLength(2);
    expect(all.find((screening) => screening.id === oldDraft.id)).toEqual(oldDraft);
    const fresh = all.find((screening) => screening.id !== oldDraft.id)!;
    expect(fresh.answers).toEqual([1]);
    expect(Date.parse(fresh.takenAt)).toBeGreaterThanOrEqual(OPENED);
    // The same answer without the bound is the ordinary check-in, which does finish the old draft.
    const ordinary = memoryStorage({ screenings: [oldDraft] });
    const outcome2 = await recordAnswer({ instrument: 'phq9', index: 3, value: 1 }, { ...base, storage: ordinary.storage, crisis: createCrisisStore(ordinary.storage, { now: clock.now, newId: clock.newId, fallback, readPatienceMs: 20 }) });
    expect(outcome2).toMatchObject({ kind: 'saved', screening: { id: oldDraft.id } });
  });

  it('reads the opening from the address, and treats a missing, empty or unreadable one as "resume nothing"', () => {
    expect(sinceFrom(String(OPENED))).toBe(OPENED);
    for (const bad of [null, '', ' ', 'abc']) expect(sinceFrom(bad), String(bad)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('every repeat-check string exists in both languages', () => {
  it('has the same keys under remeasure, and the new ticket and check-in keys, in English and Arabic', () => {
    expect(Object.keys(ar.remeasure).sort()).toEqual(Object.keys(en.remeasure).sort());
    for (const key of ['remeasureTitle', 'remeasureBody', 'remeasureStart', 'remeasureWait', 'endTicket', 'endConfirm', 'endYes', 'closedNote'] as const) {
      expect(en.ticket[key], key).toBeTruthy();
      expect(ar.ticket[key], key).toBeTruthy();
    }
    for (const key of ['repeatStep', 'finishRepeat'] as const) {
      expect(en.checkIn[key], key).toBeTruthy();
      expect(ar.checkIn[key], key).toBeTruthy();
    }
  });
});
