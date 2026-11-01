import { afterEach, describe, expect, it, vi } from 'vitest';
import { demoNow, demoOffsetMs, fetchDemoOffsetMs, setDemoOffsetMs, subscribeDemoOffset } from '../src';

const reply = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('the demo clock as an app sees it', () => {
  afterEach(() => setDemoOffsetMs(0));

  it('is the device clock until an offset is set, then runs ahead of it by exactly that much', () => {
    expect(demoOffsetMs()).toBe(0);
    const before = Date.now();
    setDemoOffsetMs(21 * 86_400_000);
    expect(demoNow().getTime() - before).toBeGreaterThanOrEqual(21 * 86_400_000);
    expect(demoNow().getTime() - Date.now()).toBeLessThanOrEqual(21 * 86_400_000);
  });

  it('tells a subscriber when the offset changes, and not when it does not', () => {
    const seen = vi.fn();
    const stop = subscribeDemoOffset(seen);
    setDemoOffsetMs(1000);
    setDemoOffsetMs(1000);
    setDemoOffsetMs(0);
    expect(seen).toHaveBeenCalledTimes(2);
    stop();
    setDemoOffsetMs(5);
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it('ignores an offset that is negative, fractional or not a number', () => {
    setDemoOffsetMs(1000);
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) setDemoOffsetMs(bad);
    expect(demoOffsetMs()).toBe(1000);
  });
});

describe('fetchDemoOffsetMs', () => {
  it('reads the offset from GET /clock', async () => {
    const fetcher = reply(200, { demoMode: true, offsetMs: 604_800_000 });
    expect(await fetchDemoOffsetMs({ fetch: fetcher, apiUrl: 'http://api.test' })).toBe(604_800_000);
    expect((fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe('http://api.test/clock');
  });

  it('reads 0 when no demo is running', async () => {
    expect(await fetchDemoOffsetMs({ fetch: reply(200, { demoMode: false, offsetMs: 0 }), apiUrl: '' })).toBe(0);
  });

  it('gives null, never a throw, for an error status, an unreadable body, a wrong shape and an unreachable server', async () => {
    expect(await fetchDemoOffsetMs({ fetch: reply(500, {}), apiUrl: '' })).toBeNull();
    expect(await fetchDemoOffsetMs({ fetch: vi.fn(async () => new Response('not json')) as unknown as typeof fetch, apiUrl: '' })).toBeNull();
    expect(await fetchDemoOffsetMs({ fetch: reply(200, { offsetMs: -5, demoMode: true }), apiUrl: '' })).toBeNull();
    expect(await fetchDemoOffsetMs({ fetch: reply(200, { offsetMs: 'soon' }), apiUrl: '' })).toBeNull();
    expect(await fetchDemoOffsetMs({ fetch: vi.fn(async () => { throw new TypeError('network'); }) as unknown as typeof fetch, apiUrl: '' })).toBeNull();
  });
});
