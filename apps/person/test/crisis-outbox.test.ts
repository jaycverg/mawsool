import { CrisisEventSubmissionSchema, type CrisisEventSubmission } from '@mawsool/types';
import { describe, expect, it, vi } from 'vitest';
import { enqueueEvent, flushOutbox, pendingEvents } from '../lib/crisis-outbox';
import { memoryStorage } from './helpers/memory';

const snapshot = (overrides: Partial<CrisisEventSubmission> = {}): CrisisEventSubmission => ({
  id: '00000000-0000-4000-8000-000000000001',
  trigger: 'phq9_item9',
  shownAt: '2026-11-01T08:00:00+04:00',
  callTapped: null,
  contextShared: false,
  humanContactConfirmed: false,
  contactSource: null,
  contactAt: null,
  resolvedAt: null,
  locale: 'en',
  ...overrides,
});

let random = 0;
const rng = { randomUUID: () => `10000000-0000-4000-8000-${String(++random).padStart(12, '0')}`, getRandomValues: <T extends ArrayBufferView>(array: T) => crypto.getRandomValues(array) };

/** A fake server: records every call and answers by route. */
function server(options: { register?: number | 'throw'; events?: number | 'throw' | (() => number) } = {}) {
  const calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = [];
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const text = String(url);
    const route = text.endsWith('/persons') ? options.register : options.events;
    calls.push({ url: text, method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : null });
    const result = typeof route === 'function' ? route() : (route ?? (text.endsWith('/persons') ? 201 : 201));
    if (result === 'throw') throw new TypeError('Failed to fetch');
    return new Response('{}', { status: result });
  });
  return { calls, fetch: fetchFn as unknown as typeof fetch };
}

const deps = (storage: ReturnType<typeof memoryStorage>['storage'], fetchFn: typeof fetch) => ({ storage, fetch: fetchFn, apiUrl: 'http://api.test', locale: 'ar' as const, random: rng });

describe('the crisis outbox', () => {
  it('holds the newest snapshot of each event', async () => {
    const { storage } = memoryStorage();
    await enqueueEvent(storage, snapshot());
    await enqueueEvent(storage, snapshot({ callTapped: '999' }));
    await enqueueEvent(storage, snapshot({ id: '00000000-0000-4000-8000-000000000002' }));
    expect((await pendingEvents(storage)).map((e) => [e.id.slice(-1), e.callTapped])).toEqual([['1', '999'], ['2', null]]);
  });

  it('ignores a queued entry that is not a valid snapshot', async () => {
    const { storage } = memoryStorage({ 'crisis:outbox': [{ answers: [1, 2, 3] }, snapshot()] });
    expect(await pendingEvents(storage)).toEqual([snapshot()]);
    expect(await pendingEvents(memoryStorage({ 'crisis:outbox': 'nope' }).storage)).toEqual([]);
  });
});

describe('flushOutbox', () => {
  it('does nothing, and touches no network, when the queue is empty', async () => {
    const { storage } = memoryStorage();
    const { fetch: fetchFn, calls } = server();
    expect(await flushOutbox(deps(storage, fetchFn))).toEqual({ outcome: 'empty', sent: 0, rejected: 0 });
    expect(calls).toEqual([]);
  });

  it('registers the device first, then posts the event with its credential, and clears the queue', async () => {
    const { storage } = memoryStorage();
    await enqueueEvent(storage, snapshot());
    const { fetch: fetchFn, calls } = server();
    expect(await flushOutbox(deps(storage, fetchFn))).toEqual({ outcome: 'sent', sent: 1, rejected: 0 });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['POST http://api.test/persons', 'POST http://api.test/crisis-events']);
    expect(calls[0]!.body).toMatchObject({ locale: 'ar' });
    expect(calls[1]!.headers.authorization).toMatch(/^Bearer [0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
    expect(calls[1]!.body).toEqual(snapshot());
    expect(await pendingEvents(storage)).toEqual([]);
  });

  it('sends only what the schema allows: no item answers, no person id', async () => {
    const { storage } = memoryStorage();
    await enqueueEvent(storage, snapshot({ callTapped: '800725462', humanContactConfirmed: true, contactSource: 'self_report', contactAt: '2026-11-01T08:03:00+04:00' }));
    const { fetch: fetchFn, calls } = server();
    await flushOutbox(deps(storage, fetchFn));
    const body = calls.at(-1)!.body as Record<string, unknown>;
    expect(CrisisEventSubmissionSchema.safeParse(body).success).toBe(true);
    expect(Object.keys(body).filter((key) => /answer|person|item|note/i.test(key))).toEqual([]);
  });

  it('keeps the queue and reports offline when the network is down, then sends once it is back', async () => {
    const { storage } = memoryStorage();
    await enqueueEvent(storage, snapshot());
    const down = server({ register: 'throw' });
    expect(await flushOutbox(deps(storage, down.fetch))).toEqual({ outcome: 'offline', sent: 0, rejected: 0 });
    expect(await pendingEvents(storage)).toHaveLength(1);
    const up = server();
    expect(await flushOutbox(deps(storage, up.fetch))).toMatchObject({ outcome: 'sent', sent: 1 });
    expect(await pendingEvents(storage)).toEqual([]);
  });

  it('keeps the queue when the event post fails after registering', async () => {
    const { storage } = memoryStorage();
    await enqueueEvent(storage, snapshot());
    for (const events of ['throw', 500, 401] as const) {
      const { fetch: fetchFn } = server({ events });
      expect(await flushOutbox(deps(storage, fetchFn))).toEqual({ outcome: 'offline', sent: 0, rejected: 0 });
      expect(await pendingEvents(storage)).toHaveLength(1);
    }
  });

  it('keeps the queue and stops when the id is registered with a different secret', async () => {
    const { storage } = memoryStorage();
    await enqueueEvent(storage, snapshot());
    const { fetch: fetchFn, calls } = server({ register: 409 });
    expect(await flushOutbox(deps(storage, fetchFn))).toEqual({ outcome: 'conflict', sent: 0, rejected: 0 });
    expect(calls).toHaveLength(1);
    expect(await pendingEvents(storage)).toHaveLength(1);
  });

  it('accepts 200 for an event the server already had, and drops one it refuses as malformed', async () => {
    const { storage } = memoryStorage();
    await enqueueEvent(storage, snapshot());
    await enqueueEvent(storage, snapshot({ id: '00000000-0000-4000-8000-000000000002' }));
    const statuses = [200, 400];
    const { fetch: fetchFn } = server({ events: () => statuses.shift()! });
    expect(await flushOutbox(deps(storage, fetchFn))).toEqual({ outcome: 'sent', sent: 1, rejected: 1 });
    expect(await pendingEvents(storage)).toEqual([]);
  });

  it('sends the rest next time when the network drops part-way', async () => {
    const { storage } = memoryStorage();
    await enqueueEvent(storage, snapshot());
    await enqueueEvent(storage, snapshot({ id: '00000000-0000-4000-8000-000000000002' }));
    const replies: (number | 'throw')[] = [201, 'throw'];
    const { fetch: fetchFn } = server({ events: () => (replies.shift() === 201 ? 201 : (() => { throw new TypeError('offline'); })()) });
    expect(await flushOutbox(deps(storage, fetchFn))).toEqual({ outcome: 'offline', sent: 1, rejected: 0 });
    expect((await pendingEvents(storage)).map((e) => e.id.slice(-1))).toEqual(['2']);
  });

  it('sends a newer snapshot that was queued while the older one was in flight, instead of leaving it for the next page load', async () => {
    const { storage } = memoryStorage();
    await enqueueEvent(storage, snapshot());
    const newer = snapshot({ callTapped: '999' });
    let queuedOnce = false;
    const posted: unknown[] = [];
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/crisis-events')) {
        posted.push(JSON.parse(String(init?.body)));
        if (!queuedOnce) {
          queuedOnce = true;
          await enqueueEvent(storage, newer);
        }
      }
      return new Response('{}', { status: 201 });
    }) as unknown as typeof fetch;
    expect(await flushOutbox(deps(storage, fetchFn))).toEqual({ outcome: 'sent', sent: 2, rejected: 0 });
    expect(posted).toEqual([snapshot(), newer]);
    expect(await pendingEvents(storage)).toEqual([]);
  });

  it('stops after a bounded number of passes when snapshots keep arriving', async () => {
    const { storage } = memoryStorage();
    await enqueueEvent(storage, snapshot());
    let counter = 0;
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/crisis-events')) await enqueueEvent(storage, snapshot({ id: `00000000-0000-4000-8000-${String(100 + ++counter).padStart(12, '0')}` }));
      return new Response('{}', { status: 201 });
    }) as unknown as typeof fetch;
    const result = await flushOutbox(deps(storage, fetchFn));
    expect(result.outcome).toBe('sent');
    expect(counter).toBe(6);
    expect(await pendingEvents(storage)).toHaveLength(1);
  });

  it('keeps the older queued snapshot when the second pass fails', async () => {
    const { storage } = memoryStorage();
    await enqueueEvent(storage, snapshot());
    let calls = 0;
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/crisis-events')) {
        calls += 1;
        if (calls === 1) await enqueueEvent(storage, snapshot({ id: '00000000-0000-4000-8000-000000000002' }));
        else throw new TypeError('offline');
      }
      return new Response('{}', { status: 201 });
    }) as unknown as typeof fetch;
    expect(await flushOutbox(deps(storage, fetchFn))).toEqual({ outcome: 'offline', sent: 1, rejected: 0 });
    expect((await pendingEvents(storage)).map((e) => e.id.slice(-1))).toEqual(['2']);
  });

  it('runs one send at a time, so a second call shares the first', async () => {
    const { storage } = memoryStorage();
    await enqueueEvent(storage, snapshot());
    const { fetch: fetchFn, calls } = server();
    const [a, b] = await Promise.all([flushOutbox(deps(storage, fetchFn)), flushOutbox(deps(storage, fetchFn))]);
    expect(a).toBe(b);
    expect(calls.filter((c) => c.url.endsWith('/crisis-events'))).toHaveLength(1);
  });
});
