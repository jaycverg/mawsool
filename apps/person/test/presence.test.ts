import { describe, expect, it, vi } from 'vitest';
import { KEYS } from '../lib/keys';
import { keepSeenToday, utcDay, type PresenceDeps } from '../lib/presence';
import { forgetRegistration } from '../lib/server';
import { memoryStorage } from './helpers/memory';

const DAY = 86_400_000;
const MORNING = new Date('2026-11-02T08:00:00Z');

/** A phone with the given choices on and a server that answers every call, recording the requests it saw. */
function phone(options: { equity?: boolean; statistics?: boolean; anonymous?: boolean; crisis?: boolean; online?: boolean; status?: number; throwing?: boolean } = {}) {
  const store = memoryStorage({
    ...(options.equity ? { [KEYS.equity]: { optIn: true, buckets: {} } } : {}),
    ...(options.statistics ? { [KEYS.outcomeStatistics]: { optIn: true } } : {}),
  });
  forgetRegistration(store.storage);
  const state = { now: MORNING, online: options.online ?? true, status: options.status ?? 200, throwing: options.throwing ?? false };
  const requests: string[] = [];
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (state.throwing) throw new TypeError('network down');
    if (path === '/persons') return new Response('{}', { status: 200 });
    requests.push(`${init?.method ?? 'GET'} ${path}`);
    return new Response(JSON.stringify([]), { status: state.status });
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
  ])('makes one authenticated read of the person’s own tickets when %s is on, and records the day', async (_name, options) => {
    const p = phone(options);
    expect(await keepSeenToday(p.deps)).toBe('sent');
    expect(p.requests).toEqual(['GET /me/tickets']);
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
    expect(unwritable.requests).toEqual(['GET /me/tickets']);
  });

  it('shares one request between two overlapping checks', async () => {
    const p = phone({ equity: true });
    const [first, second] = await Promise.all([keepSeenToday(p.deps), keepSeenToday(p.deps)]);
    expect([first, second]).toEqual(['sent', 'sent']);
    expect(p.requests).toEqual(['GET /me/tickets']);
  });
});
