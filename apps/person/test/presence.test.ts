import { createDeviceIdentity } from '@mawsool/ui';
import { describe, expect, it, vi } from 'vitest';
import { KEYS } from '../lib/keys';
import { keepSeenToday, learnChoicesOnOpen, utcDay, type PresenceDeps } from '../lib/presence';
import { loadEquity } from '../lib/share';
import { loadOutcomeStatistics } from '../lib/outcome-statistics';
import { callServer } from '../lib/server';
import { takeClearedNote } from '../lib/server-choices';
import { forgetRegistration } from '../lib/server';
import { memoryStorage } from './helpers/memory';

const DAY = 86_400_000;
const MORNING = new Date('2026-11-02T08:00:00Z');
/** The credential a phone that has used the server before holds: a background read uses it and never makes one. */
const IDENTITY = createDeviceIdentity(globalThis.crypto);

/** A phone with the given choices on and a server that answers every call, recording the requests it saw. */
function phone(options: { equity?: boolean; statistics?: boolean; anonymous?: boolean; crisis?: boolean; online?: boolean; status?: number; throwing?: boolean; serverEquity?: boolean; serverStatistics?: boolean; lastReached?: string; body?: unknown } = {}) {
  const store = memoryStorage({
    identity: IDENTITY,
    ...(options.equity ? { [KEYS.equity]: { optIn: true, buckets: { ageBand: '25_34' } } } : {}),
    ...(options.statistics ? { [KEYS.outcomeStatistics]: { optIn: true } } : {}),
    ...(options.lastReached ? { [KEYS.lastSeenSent]: { day: options.lastReached } } : {}),
  });
  forgetRegistration(store.storage);
  const state = { now: MORNING, online: options.online ?? true, status: options.status ?? 200, throwing: options.throwing ?? false };
  /** Every request the phone made, the registration included. */
  const requests: string[] = [];
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (state.throwing) throw new TypeError('network down');
    requests.push(`${init?.method ?? 'GET'} ${path}`);
    if (path === '/persons') return new Response('{}', { status: 200 });
    const choices = { equityOptIn: options.serverEquity ?? true, outcomeStatsOptIn: options.serverStatistics ?? true };
    return new Response(JSON.stringify(options.body ?? choices), { status: state.status });
  }) as unknown as typeof fetch;
  const deps: PresenceDeps = {
    server: { storage: store.storage, fetch: fetchFn, apiUrl: 'http://api.test', locale: 'en', random: globalThis.crypto },
    now: () => state.now,
    isAnonymous: () => options.anonymous ?? false,
    isOnline: () => state.online,
    crisisOpen: async () => options.crisis ?? false,
  };
  return { ...store, state, requests, fetchFn, deps };
}

describe('keeping the server told the person still uses the phone', () => {
  it.each([
    ['the equity choice', { equity: true }],
    ['the statistics choice', { statistics: true }],
    ['both', { equity: true, statistics: true }],
  ])('makes one authenticated read of the person’s own two choices when %s is on, and records the day', async (_name, options) => {
    const p = phone(options);
    expect(await keepSeenToday(p.deps)).toBe('sent');
    expect(p.requests).toEqual(['GET /me/opt-ins']);
    expect(p.data.get(KEYS.lastSeenSent)).toEqual({ day: '2026-11-02' });
  });

  it('makes no second call on the same day however often the app starts, and one more on the next day', async () => {
    const p = phone({ equity: true });
    expect(await keepSeenToday(p.deps)).toBe('sent');
    p.state.now = new Date(MORNING.getTime() + 10 * 3_600_000);
    expect(await keepSeenToday(p.deps)).toBe('not_due');
    expect(await keepSeenToday(p.deps)).toBe('not_due');
    expect(p.requests).toHaveLength(1);
    p.state.now = new Date(MORNING.getTime() + DAY);
    expect(await keepSeenToday(p.deps)).toBe('sent');
    expect(p.requests).toHaveLength(2);
    expect(p.data.get(KEYS.lastSeenSent)).toEqual({ day: '2026-11-03' });
  });

  it('counts the day in UTC on the clock it is given, so a care-clock jump cannot move it', () => {
    expect(utcDay(new Date('2026-11-02T23:59:59Z'))).toBe('2026-11-02');
    expect(utcDay(new Date('2026-11-03T00:00:00Z'))).toBe('2026-11-03');
  });

  it('makes no call and records nothing when neither choice is on', async () => {
    const p = phone();
    expect(await keepSeenToday(p.deps)).toBe('no_opt_in');
    expect(p.fetchFn).not.toHaveBeenCalled();
    expect(p.data.has(KEYS.lastSeenSent)).toBe(false);
  });

  it('makes no call and does not open the store in an anonymous session, whatever the store holds', async () => {
    const p = phone({ equity: true, statistics: true, anonymous: true });
    const read = vi.spyOn(p.storage, 'get');
    expect(await keepSeenToday(p.deps)).toBe('anonymous');
    expect(p.fetchFn).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it('makes no call while a crisis is open, and does so on the next start once it is not', async () => {
    const p = phone({ equity: true, crisis: true });
    expect(await keepSeenToday(p.deps)).toBe('crisis_open');
    expect(p.fetchFn).not.toHaveBeenCalled();
    p.deps.crisisOpen = async () => false;
    expect(await keepSeenToday(p.deps)).toBe('sent');
  });

  it('makes no request while the browser says it is offline, records nothing, and calls once it is back', async () => {
    const p = phone({ equity: true, online: false });
    expect(await keepSeenToday(p.deps)).toBe('offline');
    expect(p.fetchFn).not.toHaveBeenCalled();
    expect(p.data.has(KEYS.lastSeenSent)).toBe(false);
    p.state.online = true;
    expect(await keepSeenToday(p.deps)).toBe('sent');
  });

  it.each([
    ['a network failure', { throwing: true }],
    ['a server error', { status: 503 }],
    ['a refusal', { status: 403 }],
  ])('does not throw on %s, records nothing, and tries again at the next start', async (_name, failure) => {
    const p = phone({ equity: true, ...failure });
    await expect(keepSeenToday(p.deps)).resolves.toBe('failed');
    expect(p.data.has(KEYS.lastSeenSent)).toBe(false);
    p.state.throwing = false;
    p.state.status = 200;
    expect(await keepSeenToday(p.deps)).toBe('sent');
    expect(p.data.get(KEYS.lastSeenSent)).toEqual({ day: '2026-11-02' });
  });

  it('does not throw when the phone’s store will not answer, and still sends when it will not keep the day', async () => {
    const unreadable = phone({ equity: true });
    unreadable.failures.read = true;
    await expect(keepSeenToday(unreadable.deps)).resolves.toBe('failed');
    expect(unreadable.fetchFn).not.toHaveBeenCalled();

    const unwritable = phone({ equity: true });
    const set = unwritable.storage.set.bind(unwritable.storage);
    unwritable.storage.set = async (key, value) => {
      if (key === KEYS.lastSeenSent) throw new Error('storage write failed');
      return set(key, value);
    };
    await expect(keepSeenToday(unwritable.deps)).resolves.toBe('sent');
    expect(unwritable.requests).toEqual(['GET /me/opt-ins']);
  });

  it('shares one request between two overlapping checks', async () => {
    const p = phone({ equity: true });
    const [first, second] = await Promise.all([keepSeenToday(p.deps), keepSeenToday(p.deps)]);
    expect([first, second]).toEqual(['sent', 'sent']);
    expect(p.requests).toEqual(['GET /me/opt-ins']);
  });
});

describe('a background read never registers or re-registers the phone', () => {
  it('makes no registration, and no second try, when the server answers 401, changes nothing on the phone and records no day', async () => {
    const p = phone({ equity: true, statistics: true, status: 401 });
    expect(await keepSeenToday(p.deps)).toBe('not_recognised');
    expect(p.requests).toEqual(['GET /me/opt-ins']);
    expect(p.data.has(KEYS.lastSeenSent)).toBe(false);
    expect(p.data.has(KEYS.optInsCleared)).toBe(false);
    expect(p.data.get('identity')).toEqual(IDENTITY);
    expect(await loadEquity(p.storage)).toEqual({ optIn: true, buckets: { ageBand: '25_34' } });
    expect(await loadOutcomeStatistics(p.storage)).toBe(true);
  });

  it('makes no registration on a fresh page load either, so a phone the server forgot is never made a new person by a call nobody asked for', async () => {
    const p = phone({ equity: true });
    forgetRegistration(p.storage);
    expect(await keepSeenToday(p.deps)).toBe('sent');
    expect(p.requests.filter((request) => request.endsWith('/persons'))).toEqual([]);
  });

  it('makes no request and makes no identity when the phone holds none', async () => {
    const p = phone({ equity: true });
    p.data.delete('identity');
    expect(await keepSeenToday(p.deps)).toBe('failed');
    expect(p.fetchFn).not.toHaveBeenCalled();
    expect(p.data.has('identity')).toBe(false);
    expect(p.data.has(KEYS.lastSeenSent)).toBe(false);
  });

  it('is the same on opening Settings: a 401 registers nothing and changes nothing', async () => {
    const p = phone({ equity: true, status: 401 });
    expect(await learnChoicesOnOpen(p.deps)).toBe('not_recognised');
    expect(p.requests).toEqual(['GET /me/opt-ins']);
    expect(p.data.has(KEYS.lastSeenSent)).toBe(false);
  });

  it('is what a person’s own action does not do: a foreground call that gets 401 registers the phone again, once, and asks again once', async () => {
    const store = memoryStorage({ identity: IDENTITY });
    forgetRegistration(store.storage);
    const requests: string[] = [];
    let gets = 0;
    const fetchFn = (async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      requests.push(`${init?.method ?? 'GET'} ${path}`);
      if (path === '/persons') return new Response('{}', { status: 201 });
      gets += 1;
      return gets === 1 ? new Response('{}', { status: 401 }) : new Response(JSON.stringify({ equityOptIn: true, outcomeStatsOptIn: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await callServer({ storage: store.storage, fetch: fetchFn, apiUrl: 'http://api.test', locale: 'en', random: globalThis.crypto }, 'GET', '/me/opt-ins');
    expect(result.ok).toBe(true);
    expect(requests).toEqual(['POST /persons', 'GET /me/opt-ins', 'POST /persons', 'GET /me/opt-ins']);
  });

  it('leaves a second 401 of a foreground call as it is, so a real refusal cannot loop', async () => {
    const store = memoryStorage({ identity: IDENTITY });
    forgetRegistration(store.storage);
    const requests: string[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      requests.push(`${init?.method ?? 'GET'} ${path}`);
      return new Response('{}', { status: path === '/persons' ? 201 : 401 });
    }) as unknown as typeof fetch;
    const result = await callServer({ storage: store.storage, fetch: fetchFn, apiUrl: 'http://api.test', locale: 'en', random: globalThis.crypto }, 'GET', '/me/opt-ins');
    expect(result).toMatchObject({ ok: false, reason: 'rejected', status: 401 });
    expect(requests).toEqual(['POST /persons', 'GET /me/opt-ins', 'POST /persons', 'GET /me/opt-ins']);
  });
});

describe('a phone the server has forgotten is not asked again until the person’s own action registers it', () => {
  it('records the 401, and then makes no read on any later start, on the same day or a later one, nor when Settings opens', async () => {
    const p = phone({ equity: true, status: 401 });
    expect(await keepSeenToday(p.deps)).toBe('not_recognised');
    expect(p.data.get(KEYS.serverForgotPhone)).toEqual({ since: '2026-11-02' });
    expect(p.requests).toEqual(['GET /me/opt-ins']);

    p.state.now = new Date(MORNING.getTime() + 3 * DAY);
    expect(await keepSeenToday(p.deps)).toBe('still_not_recognised');
    expect(await keepSeenToday(p.deps)).toBe('still_not_recognised');
    expect(await learnChoicesOnOpen(p.deps)).toBe('still_not_recognised');
    expect(p.requests, 'not one more request, registration included').toEqual(['GET /me/opt-ins']);
    expect(p.data.has(KEYS.lastSeenSent)).toBe(false);
  });

  it('reads again once a call the person makes has registered the phone, by its 401 retry or on a fresh page load, and not before', async () => {
    const p = phone({ equity: true, status: 401 });
    expect(await keepSeenToday(p.deps)).toBe('not_recognised');
    expect(await keepSeenToday(p.deps)).toBe('still_not_recognised');

    // The person sends something: the server answers 401 to the first call, the phone registers again and asks again, and the note goes.
    let answers = 0;
    const foreground = { ...p.deps.server, fetch: (async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      p.requests.push(`${init?.method ?? 'GET'} ${path}`);
      if (path === '/persons') return new Response('{}', { status: 201 });
      answers += 1;
      return new Response('{}', { status: answers === 1 ? 401 : 200 });
    }) as unknown as typeof fetch };
    forgetRegistration(p.storage);
    expect((await callServer(foreground, 'POST', '/tickets', {})).ok).toBe(true);
    expect(p.data.has(KEYS.serverForgotPhone), 'registered again, so the note is gone').toBe(false);

    p.state.status = 200;
    expect(await keepSeenToday(p.deps)).toBe('sent');
    expect(p.requests.at(-1)).toBe('GET /me/opt-ins');

    // A phone that is forgotten again is recorded again, and a fresh page load whose first call registers it clears the note too.
    p.state.status = 401;
    p.state.now = new Date(MORNING.getTime() + DAY);
    expect(await keepSeenToday(p.deps)).toBe('not_recognised');
    forgetRegistration(p.storage);
    const fresh = { ...p.deps.server, fetch: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch };
    expect((await callServer(fresh, 'GET', '/me/tickets')).ok).toBe(true);
    expect(p.data.has(KEYS.serverForgotPhone)).toBe(false);
  });

  it('keeps the note when the registration the person’s call tried failed, so nothing is read for a phone the server still does not know', async () => {
    const p = phone({ equity: true, status: 401 });
    await keepSeenToday(p.deps);
    forgetRegistration(p.storage);
    const refused = { ...p.deps.server, fetch: (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch };
    expect((await callServer(refused, 'GET', '/me/tickets')).ok).toBe(false);
    expect(p.data.has(KEYS.serverForgotPhone)).toBe(true);
  });

  it('still answers not_recognised when the phone cannot keep the note, and makes no request when it cannot read it', async () => {
    const unwritable = phone({ equity: true, status: 401 });
    const set = unwritable.storage.set.bind(unwritable.storage);
    unwritable.storage.set = async (key, value) => {
      if (key === KEYS.serverForgotPhone) throw new Error('storage write failed');
      return set(key, value);
    };
    expect(await keepSeenToday(unwritable.deps)).toBe('not_recognised');
    expect(unwritable.data.has(KEYS.serverForgotPhone)).toBe(false);

    const unreadable = phone({ equity: true });
    const get = unreadable.storage.get.bind(unreadable.storage);
    unreadable.storage.get = (async (key: string) => {
      if (key === KEYS.serverForgotPhone) throw new Error('storage read failed');
      return get(key);
    }) as typeof unreadable.storage.get;
    expect(await keepSeenToday(unreadable.deps)).toBe('failed');
    expect(unreadable.requests).toEqual([]);
  });

  it('checks the note after whether any choice is on, so a phone with none reads nothing either way', async () => {
    const p = phone({ equity: false, statistics: false });
    p.data.set(KEYS.serverForgotPhone, { since: '2026-11-01' });
    expect(await keepSeenToday(p.deps)).toBe('no_opt_in');
  });
});

describe('learning that the server switched a choice off', () => {
  /** 2026-11-02 is 180 days after this day: the day the server's idle rule falls on. */
  const IDLE_DAY = '2026-05-06';
  const NOT_QUITE_IDLE_DAY = '2026-05-07';

  it('turns off on the phone a choice the server has off, drops the equity buckets, and leaves a note for Settings that is given out once', async () => {
    const p = phone({ equity: true, statistics: true, serverEquity: false, serverStatistics: false, lastReached: IDLE_DAY });
    expect(await keepSeenToday(p.deps)).toBe('turned_off');
    expect(await loadEquity(p.storage)).toEqual({ optIn: false, buckets: {} });
    expect(await loadOutcomeStatistics(p.storage)).toBe(false);
    expect(p.data.get(KEYS.lastSeenSent)).toEqual({ day: '2026-11-02' });
    expect(await takeClearedNote(p.storage)).toEqual({ equity: true, statistics: true });
    expect(await takeClearedNote(p.storage)).toBeNull();
    expect(p.data.has(KEYS.optInsCleared)).toBe(false);
  });

  it.each([
    ['the equity choice', { serverEquity: false, serverStatistics: true }, { equity: true, statistics: false }],
    ['the statistics choice', { serverEquity: true, serverStatistics: false }, { equity: false, statistics: true }],
  ])('turns off only %s when the server has only that one off', async (_name, server, note) => {
    const p = phone({ equity: true, statistics: true, lastReached: IDLE_DAY, ...server });
    expect(await keepSeenToday(p.deps)).toBe('turned_off');
    // The choice the server still has on stays on, on the phone; the other is off.
    expect({ equity: (await loadEquity(p.storage)).optIn, statistics: await loadOutcomeStatistics(p.storage) }).toEqual({ equity: server.serverEquity, statistics: server.serverStatistics });
    expect(await takeClearedNote(p.storage)).toEqual(note);
  });

  it('never turns a choice on from the server’s answer: the server on and the phone off changes nothing', async () => {
    const p = phone({ statistics: true, serverEquity: true, serverStatistics: true });
    expect(await keepSeenToday(p.deps)).toBe('sent');
    expect(await loadEquity(p.storage)).toEqual({ optIn: false, buckets: {} });
    expect(await loadOutcomeStatistics(p.storage)).toBe(true);
    expect(p.data.has(KEYS.optInsCleared)).toBe(false);
    const wrote = phone({ equity: true, serverEquity: true, serverStatistics: true });
    const set = vi.spyOn(wrote.storage, 'set');
    await keepSeenToday(wrote.deps);
    expect(set.mock.calls.map(([key]) => key)).toEqual([KEYS.lastSeenSent]);
  });

  it.each([
    ['a network failure', { throwing: true }],
    ['a server error', { status: 503 }],
    ['a refusal', { status: 403 }],
    ['an answer that is not the two choices', { body: { equityOptIn: 'yes' } }],
  ])('changes nothing on the phone and records no day when the read ends in %s', async (_name, failure) => {
    const p = phone({ equity: true, statistics: true, serverEquity: false, serverStatistics: false, lastReached: IDLE_DAY, ...failure });
    await expect(keepSeenToday(p.deps)).resolves.toBe('failed');
    expect(await loadEquity(p.storage)).toEqual({ optIn: true, buckets: { ageBand: '25_34' } });
    expect(await loadOutcomeStatistics(p.storage)).toBe(true);
    expect(p.data.get(KEYS.lastSeenSent)).toEqual({ day: IDLE_DAY });
    expect(p.data.has(KEYS.optInsCleared)).toBe(false);
  });

  it('is retried at the next start, not marked done, when the phone’s store refuses to turn the choice off', async () => {
    const p = phone({ equity: true, serverEquity: false, lastReached: IDLE_DAY });
    const set = p.storage.set.bind(p.storage);
    p.storage.set = async (key, value) => {
      if (key === KEYS.equity) throw new Error('storage write failed');
      return set(key, value);
    };
    await expect(keepSeenToday(p.deps)).resolves.toBe('failed');
    expect(p.data.get(KEYS.lastSeenSent)).toEqual({ day: IDLE_DAY });
    expect(p.data.has(KEYS.optInsCleared)).toBe(false);
    p.storage.set = set;
    await expect(keepSeenToday(p.deps)).resolves.toBe('turned_off');
    expect((await loadEquity(p.storage)).optIn).toBe(false);
  });

  it('still turns the choice off when only the note for Settings cannot be kept', async () => {
    const p = phone({ equity: true, serverEquity: false, lastReached: IDLE_DAY });
    const set = p.storage.set.bind(p.storage);
    p.storage.set = async (key, value) => {
      if (key === KEYS.optInsCleared) throw new Error('storage write failed');
      return set(key, value);
    };
    await expect(keepSeenToday(p.deps)).resolves.toBe('turned_off');
    expect((await loadEquity(p.storage)).optIn).toBe(false);
    expect(await takeClearedNote(p.storage)).toBeNull();
  });

  it('gives no note when the phone reached the server recently and still disagrees with it, or has never recorded a reach, since six months of idleness is then not the reason', async () => {
    const recent = phone({ statistics: true, serverStatistics: false, lastReached: NOT_QUITE_IDLE_DAY });
    expect(await keepSeenToday(recent.deps)).toBe('turned_off');
    expect(await loadOutcomeStatistics(recent.storage)).toBe(false);
    expect(await takeClearedNote(recent.storage)).toBeNull();
    // A phone that never reached the server (a statistics send that failed before it got there) has no evidence of idleness either.
    const never = phone({ statistics: true, serverStatistics: false });
    expect(await keepSeenToday(never.deps)).toBe('turned_off');
    expect(await loadOutcomeStatistics(never.storage)).toBe(false);
    expect(await takeClearedNote(never.storage)).toBeNull();
    // At the limit the note is given.
    const idle = phone({ statistics: true, serverStatistics: false, lastReached: IDLE_DAY });
    expect(await keepSeenToday(idle.deps)).toBe('turned_off');
    expect(await takeClearedNote(idle.storage)).toEqual({ equity: false, statistics: true });
  });

  it('keeps the note of an earlier turn-off that Settings has not shown yet when a later read turns off the other choice', async () => {
    const p = phone({ equity: true, statistics: true, serverEquity: false, serverStatistics: true, lastReached: IDLE_DAY });
    await keepSeenToday(p.deps);
    const later = phone({ statistics: true, serverStatistics: false, lastReached: IDLE_DAY });
    later.data.set(KEYS.optInsCleared, { equity: true, statistics: false });
    await keepSeenToday(later.deps);
    expect(await takeClearedNote(later.storage)).toEqual({ equity: true, statistics: true });
  });

  it('gives Settings nothing from a note that is not one', async () => {
    const p = phone();
    p.data.set(KEYS.optInsCleared, { equity: 'maybe' });
    expect(await takeClearedNote(p.storage)).toBeNull();
    expect(p.data.has(KEYS.optInsCleared)).toBe(false);
  });

  it('on opening Settings, reads even though today’s call was made, records no day, and turns off what the server has off', async () => {
    const p = phone({ equity: true, serverEquity: false, lastReached: '2026-11-02' });
    expect(await keepSeenToday(p.deps)).toBe('not_due');
    expect(p.fetchFn).not.toHaveBeenCalled();
    expect(await learnChoicesOnOpen(p.deps)).toBe('turned_off');
    expect(p.requests).toEqual(['GET /me/opt-ins']);
    expect(p.data.get(KEYS.lastSeenSent)).toEqual({ day: '2026-11-02' });
    expect((await loadEquity(p.storage)).optIn).toBe(false);
  });

  it.each([
    ['an anonymous session', { anonymous: true }, 'anonymous'],
    ['an open crisis', { crisis: true }, 'crisis_open'],
    ['no choice on', { equity: false }, 'no_opt_in'],
    ['no network', { online: false }, 'offline'],
  ])('on opening Settings makes no request in %s', async (_name, options, expected) => {
    const p = phone({ equity: true, ...options });
    expect(await learnChoicesOnOpen(p.deps)).toBe(expected);
    expect(p.fetchFn).not.toHaveBeenCalled();
  });
});
