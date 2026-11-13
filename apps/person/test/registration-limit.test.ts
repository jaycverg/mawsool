import type { Demographics } from '@mawsool/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KEYS } from '../lib/keys';
import { loadOutcomeStatistics } from '../lib/outcome-statistics';
import { finishRepeatCheck } from '../lib/remeasure';
import { callServer, forgetRegistration, SERVER_CALL_PATIENCE_MS } from '../lib/server';
import { readSendMarks, sendEquityChoice } from '../lib/server-choices';
import { loadEquity } from '../lib/share';
import { memoryStorage } from './helpers/memory';
import { createDeviceIdentity } from '@mawsool/ui';

const IDENTITY = createDeviceIdentity(globalThis.crypto);
const TICKET_ID = '11111111-1111-4111-8111-111111111111';
const BUCKETS: Demographics = { ageBand: '25_34', gender: null, language: null, region: null };
const NOW = new Date('2026-11-02T08:00:00Z');

/** A phone whose server accepts the connection for the registration and never answers it; every other request is recorded and answered. */
function phoneWhoseRegistrationHangs(initial: Record<string, unknown> = {}) {
  const store = memoryStorage({ identity: IDENTITY, ...initial });
  forgetRegistration(store.storage);
  const requests: string[] = [];
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    requests.push(`${init?.method ?? 'GET'} ${path}`);
    if (path === '/persons') return new Promise<Response>(() => undefined);
    return new Response(JSON.stringify({ state: 'closed', scoresShared: true, events: [], optIn: true }), { status: 200 });
  }) as unknown as typeof fetch;
  return { ...store, requests, server: { storage: store.storage, fetch: fetchFn, apiUrl: 'http://api.test', locale: 'en' as const, random: globalThis.crypto } };
}

describe('a registration that never answers', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }));
  afterEach(() => vi.useRealTimers());

  it('ends the call as not registered once the call limit has passed, and makes no call after it', async () => {
    const p = phoneWhoseRegistrationHangs();
    const call = callServer(p.server, 'PUT', '/me/equity', { optIn: true });
    await vi.advanceTimersByTimeAsync(SERVER_CALL_PATIENCE_MS - 1);
    expect(p.requests, 'still waiting for the registration just before the limit').toEqual(['POST /persons']);
    let settled = false;
    void call.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await call).toEqual({ ok: false, reason: 'not_registered', status: null });
    expect(p.requests, 'the call itself was never made').toEqual(['POST /persons']);
  });

  it('ends the group-totals send as a refused send, sends nothing, leaves the note as it was and clears the send’s mark', async () => {
    vi.setSystemTime(NOW);
    const p = phoneWhoseRegistrationHangs({ [KEYS.equity]: { optIn: true, buckets: { ageBand: '25_34' } } });
    const sent = sendEquityChoice(p.server, { on: true, buckets: BUCKETS, storedOptIn: true, tickedHere: true, now: () => NOW });
    await vi.advanceTimersByTimeAsync(SERVER_CALL_PATIENCE_MS);
    expect(await sent).toBe('rejected');
    expect(p.requests.filter((request) => request.startsWith('PUT'))).toEqual([]);
    expect(await loadEquity(p.storage)).toEqual({ optIn: true, buckets: { ageBand: '25_34' } });
    const marks = await readSendMarks(p.storage);
    expect(marks.equity.pending, 'the mark that brackets the send is cleared').toEqual({});
    expect(marks.equity.tick).not.toBeNull();
  });

  it('ends the repeat check’s send as failed, sends no choice, and clears the send’s mark', async () => {
    vi.setSystemTime(NOW);
    const p = phoneWhoseRegistrationHangs();
    const sent = finishRepeatCheck(p.server, TICKET_ID, [], true, { statisticsSource: 'ticked', now: () => NOW });
    await vi.advanceTimersByTimeAsync(SERVER_CALL_PATIENCE_MS);
    expect(await sent).toBe('failed');
    expect(p.requests.filter((request) => request.endsWith('/remeasure'))).toEqual([]);
    expect((await readSendMarks(p.storage)).statistics.pending).toEqual({});
    // The note says the choice MAY be on, written before the send as always: Settings can still turn it off.
    expect(await loadOutcomeStatistics(p.storage)).toBe(true);
  });

  it('does not slow a registration that answers: the call goes on at once', async () => {
    const p = phoneWhoseRegistrationHangs();
    p.server.fetch = (async (url: string) => (new URL(url).pathname === '/persons' ? new Response('{}', { status: 201 }) : new Response('{}', { status: 200 }))) as unknown as typeof fetch;
    expect((await callServer(p.server, 'GET', '/me/tickets')).ok).toBe(true);
  });
});
