import { demoOffsetMs, setDemoOffsetMs } from '@mawsool/ui';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deviceNow } from '../lib/clock';
import { refreshDemoOffset, restoreDemoOffset } from '../lib/demo-offset';
import { KEYS } from '../lib/keys';
import { memoryStorage } from './helpers/memory';

const WEEK = 7 * 86_400_000;
const answer = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('the person app on the demo clock', () => {
  afterEach(() => setDemoOffsetMs(0));

  it('reads deviceNow as the device clock plus the offset the API reported', async () => {
    const { storage } = memoryStorage();
    await refreshDemoOffset(storage, answer({ demoMode: true, offsetMs: 3 * WEEK }));
    expect(demoOffsetMs()).toBe(3 * WEEK);
    expect(deviceNow().getTime() - Date.now()).toBeGreaterThanOrEqual(3 * WEEK);
    expect(deviceNow().getTime() - Date.now()).toBeLessThan(3 * WEEK + 5000);
  });

  it('keeps the last offset in the phone’s store, and restores it with no network at all', async () => {
    const { storage, data } = memoryStorage();
    await refreshDemoOffset(storage, answer({ demoMode: true, offsetMs: WEEK }));
    expect(data.get(KEYS.demoOffset)).toBe(WEEK);
    setDemoOffsetMs(0);
    await restoreDemoOffset(storage);
    expect(demoOffsetMs()).toBe(WEEK);
    const offline = vi.fn(async () => { throw new TypeError('offline'); }) as unknown as typeof fetch;
    await refreshDemoOffset(storage, offline); // a failed read changes nothing
    expect(demoOffsetMs()).toBe(WEEK);
    expect(data.get(KEYS.demoOffset)).toBe(WEEK);
  });

  it('goes back to zero when the API says no demo is running, and keeps that', async () => {
    const { storage, data } = memoryStorage();
    await refreshDemoOffset(storage, answer({ demoMode: true, offsetMs: 6 * WEEK }));
    await refreshDemoOffset(storage, answer({ demoMode: false, offsetMs: 0 }));
    expect(demoOffsetMs()).toBe(0);
    expect(data.get(KEYS.demoOffset)).toBe(0);
  });

  it('survives a store that refuses to answer or to write: the offset still applies for the session', async () => {
    const { storage, failures } = memoryStorage();
    failures.read = true;
    await expect(restoreDemoOffset(storage)).resolves.toBeUndefined();
    failures.write = true;
    await expect(refreshDemoOffset(storage, answer({ demoMode: true, offsetMs: WEEK }))).resolves.toBeUndefined();
    expect(demoOffsetMs()).toBe(WEEK);
  });

  it('ignores a stored value that is not an offset', async () => {
    const { storage } = memoryStorage({ [KEYS.demoOffset]: 'a while' });
    await restoreDemoOffset(storage);
    expect(demoOffsetMs()).toBe(0);
  });

  it('asks the API for nothing but the clock: a GET with no body and no credential', async () => {
    const { storage } = memoryStorage();
    const fetcher = answer({ demoMode: false, offsetMs: 0 });
    await refreshDemoOffset(storage, fetcher);
    const [url, init] = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0]! as [string, RequestInit];
    expect(new URL(url).pathname).toBe('/clock');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.headers).toBeUndefined();
  });
});
