import { createTabMark } from '@mawsool/ui';
import type { Screening } from '@mawsool/types';
import { describe, expect, it, vi } from 'vitest';
import type { StorageAdapter } from '@mawsool/ui';
import { createCrisisStore, isCrisisMark, type CrisisMark } from '../lib/crisis';
import { buildHandoffPreview, handoffFor, handoffOffer, loadHandoffs, offerState, sendHandoff, stopHandoff, type HandoffRecord } from '../lib/crisis-handoff';
import type { FlushResult } from '../lib/crisis-outbox';
import { deleteDeviceData } from '../lib/device-data';
import { forgetRegistration, hasServerFootprint } from '../lib/server';
import ar from '../messages/ar.json';
import en from '../messages/en.json';
import { fixtureClock, memoryStorage } from './helpers/memory';

const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_EVENT_ID = '33333333-3333-4333-8333-333333333333';
/** The only record on the phone, or null: most cases involve one crisis. */
const loadHandoff = async (storage: StorageAdapter): Promise<HandoffRecord | null> => (await loadHandoffs(storage))[0] ?? null;
const NUMBER = '+971501234567';

function phq9(): Screening {
  return { id: 's1', instrument: 'phq9', answers: [3, 3, 3, 3, 3, 3, 3, 3, 1], total: 25, band: 'severe', item9Flag: true, takenAt: '2026-11-01T08:00:00+04:00' } as Screening;
}
function unfinishedPhq9(): Screening {
  return { id: 's2', instrument: 'phq9', answers: [3, 3, 3], total: 9, band: null, item9Flag: false, takenAt: '2026-11-01T08:05:00+04:00' } as Screening;
}

type PostReply = 'created' | 'offline' | 'lost-reply' | 'timeout' | 'unknown-event' | 'stopped' | 'rejected' | 'unavailable';

/** A fake API: registration works, the hand-off route answers as told, and a row is kept when the server "stored" it. */
function setup(post: PostReply = 'created', flush: FlushResult['outcome'] = 'sent') {
  const store = memoryStorage({ 'crisis:block': { blocked: true, trigger: 'phq9_item9' } });
  const clock = fixtureClock();
  const calls: { method: string; path: string; body: Record<string, unknown> | null }[] = [];
  const server = { stored: false, deleteAnswers: 'ok' as 'ok' | 'offline' | 'missing' | 'rejected' };
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const method = init?.method ?? 'GET';
    calls.push({ method, path, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null });
    if (path === '/persons') return new Response('{}', { status: 201 });
    if (method === 'POST') {
      if (post === 'offline') throw new TypeError('network down');
      if (post === 'unavailable') return new Response('{}', { status: 503 });
      if (post === 'unknown-event') return new Response(JSON.stringify({ error: 'crisis_event_unknown' }), { status: 409 });
      if (post === 'stopped') return new Response(JSON.stringify({ error: 'handoff_stopped' }), { status: 409 });
      if (post === 'rejected') return new Response('{}', { status: 400 });
      server.stored = true;
      if (post === 'lost-reply') throw new TypeError('the reply never came');
      // What `AbortSignal.timeout` makes fetch reject with when the call's own limit runs out after the request was sent.
      if (post === 'timeout') throw new DOMException('The operation timed out.', 'TimeoutError');
      return new Response(JSON.stringify({ handoffId: 'x', consentId: 'y', grantedAt: '2026-11-01T04:00:00.000Z', created: true }), { status: 201 });
    }
    if (server.deleteAnswers === 'offline') throw new TypeError('network down');
    if (server.deleteAnswers === 'rejected') return new Response('{}', { status: 400 });
    if (server.deleteAnswers === 'missing') return new Response('{}', { status: 404 });
    server.stored = false;
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  const flushFn = vi.fn(async () => ({ outcome: flush, sent: 0, rejected: 0 }));
  const serverDeps = { storage: store.storage, fetch: fetchFn, apiUrl: 'http://api.test', locale: 'en' as const, random: globalThis.crypto };
  forgetRegistration(store.storage);
  return { store, calls, server, flushFn, serverDeps, deps: { server: serverDeps, flush: flushFn, now: clock.now, newId: clock.newId } };
}

const input = (overrides: Record<string, unknown> = {}) => ({ crisisEventId: EVENT_ID, screenings: [phq9()], language: 'en' as const, trigger: 'phq9_item9' as const, callbackInput: '', ...overrides });
const posts = (calls: ReturnType<typeof setup>['calls']) => calls.filter((call) => call.method === 'POST' && call.path === '/me/crisis-handoffs');

describe('what the hand-off would send', () => {
  it('holds the language, the reason, the latest finished totals and the number typed, and no item answer', () => {
    const preview = buildHandoffPreview({ screenings: [phq9(), unfinishedPhq9()], language: 'ar', trigger: 'phq9_item9', callback: NUMBER });
    expect(preview).toEqual({ language: 'ar', trigger: 'phq9_item9', scores: [{ instrument: 'phq9', total: 25 }], callbackNumber: NUMBER });
    expect(JSON.stringify(preview)).not.toContain('answers');
    expect(JSON.stringify(preview), 'no band and no time of the check-in').not.toMatch(/band|severe|takenAt|2026-11-01/);
  });

  it('sends no scores when no check-in was finished', () => {
    expect(buildHandoffPreview({ screenings: [unfinishedPhq9()], language: 'en', trigger: 'cssrs', callback: null }).scores).toEqual([]);
  });
});

describe('a crisis that opened in an anonymous session', () => {
  async function anonymousCrisisOnPhone() {
    const s = setup();
    const clock = fixtureClock();
    const fallback = createTabMark<CrisisMark>(undefined, 'crisis', isCrisisMark);
    await createCrisisStore(s.store.storage, { now: clock.now, newId: clock.newId, fallback, anonymous: true }).raise({ trigger: 'phq9_item9', screeningId: null, locale: 'en' });
    // The phone is read afterwards by an ordinary session: a store that is not anonymous, over the same record.
    const ordinary = createCrisisStore(s.store.storage, { now: clock.now, newId: clock.newId, fallback, anonymous: false });
    return { s, ordinary };
  }

  it('is not offered a hand-off by an ordinary session that reads its record, and the server is never called', async () => {
    const { s, ordinary } = await anonymousCrisisOnPhone();
    const record = (await ordinary.read()).record;
    expect(record).toMatchObject({ blocked: true, anonymous: true });
    expect(handoffOffer(record)).toBeNull();
    expect(s.calls).toEqual([]);
  });

  it('is still refused by sendHandoff itself, before anything is read from the server or sent to it', async () => {
    const { s, ordinary } = await anonymousCrisisOnPhone();
    const eventId = (await ordinary.read()).record!.event!.id;
    expect(await sendHandoff(s.deps, input({ crisisEventId: eventId }))).toBe('failed');
    expect(s.calls).toEqual([]);
    expect(s.flushFn).not.toHaveBeenCalled();
    expect(await loadHandoffs(s.store.storage)).toEqual([]);
    expect(await hasServerFootprint(s.store.storage)).toBe(false);
  });

  it('is the only kind refused: an ordinary crisis is offered one for its own event', async () => {
    const s = setup();
    const clock = fixtureClock();
    const fallback = createTabMark<CrisisMark>(undefined, 'crisis', isCrisisMark);
    const crisis = createCrisisStore(s.store.storage, { now: clock.now, newId: clock.newId, fallback });
    await crisis.raise({ trigger: 'phq9_item9', screeningId: null, locale: 'en' });
    const record = (await crisis.read()).record;
    expect(handoffOffer(record)).toEqual({ eventId: record!.event!.id, trigger: 'phq9_item9' });
    expect(handoffOffer(null)).toBeNull();
    expect(await sendHandoff(s.deps, input({ crisisEventId: record!.event!.id }))).toBe('sent');
  });
});

describe('sending the hand-off', () => {
  it('sends the crisis record first, then the note with the consent flag, the totals and the normalised number, and keeps a record of it', async () => {
    const s = setup();
    expect(await sendHandoff(s.deps, input({ callbackInput: '+971 50 123 4567' }))).toBe('sent');
    expect(s.flushFn).toHaveBeenCalledTimes(1);
    const [post] = posts(s.calls);
    expect(post!.body).toMatchObject({ crisisEventId: EVENT_ID, consented: true, language: 'en', trigger: 'phq9_item9', callbackNumber: NUMBER, scores: [{ instrument: 'phq9', total: 25 }] });
    expect(post!.body!.scores, 'an instrument and a total, with no band and no time').toEqual([{ instrument: 'phq9', total: 25 }]);
    expect(JSON.stringify(post!.body)).not.toContain('answers');
    const record = (await loadHandoff(s.store.storage))!;
    expect(record).toMatchObject({ crisisEventId: EVENT_ID, state: 'sent', handoffId: post!.body!.handoffId });
    expect(s.store.data.get('crisis:handoff')).toHaveLength(1);
    expect(JSON.stringify(record)).not.toContain('971');
    expect(await hasServerFootprint(s.store.storage)).toBe(true);
  });

  it('sends no number when none was typed', async () => {
    const s = setup();
    await sendHandoff(s.deps, input());
    expect(posts(s.calls)[0]!.body!.callbackNumber).toBeNull();
  });

  it('refuses a number that is not international before anything leaves the phone', async () => {
    const s = setup();
    expect(await sendHandoff(s.deps, input({ callbackInput: '0501234567' }))).toBe('invalid_number');
    expect(s.calls).toEqual([]);
    expect(s.flushFn).not.toHaveBeenCalled();
    expect(await loadHandoff(s.store.storage)).toBeNull();
  });

  it('says offline, and sends and records nothing, when the crisis record cannot be flushed', async () => {
    for (const outcome of ['offline', 'conflict'] as const) {
      const s = setup('created', outcome);
      expect(await sendHandoff(s.deps, input())).toBe('offline');
      expect(posts(s.calls)).toEqual([]);
      expect(await loadHandoff(s.store.storage)).toBeNull();
    }
  });

  it('says offline when the flush itself throws', async () => {
    const s = setup();
    s.flushFn.mockRejectedValueOnce(new Error('boom'));
    expect(await sendHandoff(s.deps, input())).toBe('offline');
    expect(posts(s.calls)).toEqual([]);
  });

  it('never touches the crisis block or its queue, whatever the outcome', async () => {
    for (const reply of ['created', 'offline', 'lost-reply', 'unknown-event', 'rejected', 'unavailable'] as const) {
      const s = setup(reply);
      const before = structuredClone(s.store.data.get('crisis:block'));
      await sendHandoff(s.deps, input());
      expect(s.store.data.get('crisis:block'), reply).toEqual(before);
      expect(s.store.data.has('crisis:outbox'), reply).toBe(false);
    }
  });

  it('keeps a "sending" record when the network fails or the reply is lost, and a retry reuses its id so the server holds one', async () => {
    for (const reply of ['offline', 'lost-reply', 'unavailable'] as const) {
      const s = setup(reply);
      expect(await sendHandoff(s.deps, input()), reply).toBe('unconfirmed');
      const first = (await loadHandoff(s.store.storage))!;
      expect(first.state).toBe('sending');
      expect(await sendHandoff(s.deps, input()), reply).toBe('unconfirmed');
      const ids = posts(s.calls).map((call) => call.body!.handoffId);
      expect(new Set(ids), reply).toEqual(new Set([first.handoffId]));
    }
  });

  it('says unconfirmed, not offline, when the call’s own time limit runs out after the request was sent, keeps the record to stop from, and a retry reuses its id', async () => {
    const s = setup('timeout');
    expect(await sendHandoff(s.deps, input())).toBe('unconfirmed');
    expect(s.server.stored, 'the server did get the note').toBe(true);
    const first = (await loadHandoff(s.store.storage))!;
    expect(first.state).toBe('sending');
    expect(await sendHandoff(s.deps, input())).toBe('unconfirmed');
    expect(new Set(posts(s.calls).map((call) => call.body!.handoffId))).toEqual(new Set([first.handoffId]));
    expect(await stopHandoff({ server: s.serverDeps }, first)).toBe('stopped');
    expect(s.server.stored).toBe(false);
    expect(await loadHandoff(s.store.storage)).toBeNull();
  });

  it('says unconfirmed, never offline, for every failure after the request was issued: a dropped connection, a lost reply, a server error, a timeout', async () => {
    for (const reply of ['offline', 'lost-reply', 'unavailable', 'timeout'] as const) {
      const s = setup(reply);
      expect(await sendHandoff(s.deps, input()), reply).toBe('unconfirmed');
      expect(posts(s.calls), `${reply}: the request was issued`).toHaveLength(1);
      expect((await loadHandoff(s.store.storage))!.state, `${reply}: the record is kept to stop from`).toBe('sending');
    }
  });

  it('says offline, and keeps no record, only where nothing left the phone: no network reported, a queue that cannot be flushed, a phone that cannot register', async () => {
    const noNetwork = setup();
    expect(await sendHandoff({ ...noNetwork.deps, isOnline: () => false }, input())).toBe('offline');
    expect(noNetwork.calls).toEqual([]);
    expect(noNetwork.flushFn).not.toHaveBeenCalled();
    expect(await loadHandoff(noNetwork.store.storage)).toBeNull();

    const unregistered = setup();
    unregistered.serverDeps.fetch = (async () => new Response('{}', { status: 503 })) as unknown as typeof fetch;
    expect(await sendHandoff(unregistered.deps, input()), 'the phone could not register, so nothing left it').toBe('offline');
    expect(await loadHandoff(unregistered.store.storage), 'there is nothing to stop').toBeNull();

    const noCredential = setup();
    noCredential.store.storage.setIfAbsent = (async () => { throw new Error('storage write failed'); }) as typeof noCredential.store.storage.setIfAbsent;
    expect(await sendHandoff(noCredential.deps, input())).toBe('offline');
    expect(posts(noCredential.calls)).toEqual([]);
    expect(await loadHandoff(noCredential.store.storage)).toBeNull();

    const online = setup();
    expect(await sendHandoff({ ...online.deps, isOnline: () => true }, input())).toBe('sent');
  });

  it('keeps the outcomes where nothing was sent for certain: stopped, refused, not ready, could not prepare, invalid number', async () => {
    expect(await sendHandoff(setup('stopped').deps, input())).toBe('stopped');
    expect(await sendHandoff(setup('rejected').deps, input())).toBe('rejected');
    expect(await sendHandoff(setup('unknown-event').deps, input())).toBe('not_ready');
    const unprepared = setup();
    unprepared.store.failures.write = true;
    expect(await sendHandoff(unprepared.deps, input())).toBe('failed');
    expect(await sendHandoff(setup().deps, input({ callbackInput: '0501' }))).toBe('invalid_number');
  });

  it('drops its record when the server refuses for good, and says the crisis record is not there yet on a 409', async () => {
    const unknown = setup('unknown-event');
    expect(await sendHandoff(unknown.deps, input())).toBe('not_ready');
    expect(await loadHandoff(unknown.store.storage)).toBeNull();
    const rejected = setup('rejected');
    expect(await sendHandoff(rejected.deps, input())).toBe('rejected');
    expect(await loadHandoff(rejected.store.storage)).toBeNull();
  });

  it('sends nothing and says so when the phone cannot write its own record', async () => {
    const s = setup();
    s.store.failures.write = true;
    expect(await sendHandoff(s.deps, input())).toBe('failed');
    expect(posts(s.calls)).toEqual([]);
  });

  it('still reports sent when only the confirmation could not be written, leaving the "sending" record to stop from', async () => {
    const s = setup();
    const set = s.store.storage.set.bind(s.store.storage);
    s.store.storage.set = async (key, value) => {
      if (key === 'crisis:handoff' && (value as HandoffRecord[]).some((record) => record.state === 'sent')) throw new Error('storage write failed');
      return set(key, value);
    };
    expect(await sendHandoff(s.deps, input())).toBe('sent');
    expect((await loadHandoff(s.store.storage))!.state).toBe('sending');
  });
});

/** A promise that never settles: a store or a network that has stopped answering. */
const never = <T,>(): Promise<T> => new Promise<T>(() => undefined);
const QUICK = { storeMs: 25, networkMs: 40 };

describe('a hand-off that waits on a store or a network that does not answer', () => {
  /** Makes the store never answer a read, or a write, of one key. */
  function hang(s: ReturnType<typeof setup>, key: string, kind: 'get' | 'set', when: (value: unknown) => boolean = () => true) {
    const real = s.store.storage[kind].bind(s.store.storage) as (key: string, value?: unknown) => Promise<unknown>;
    (s.store.storage as unknown as Record<string, unknown>)[kind] = (k: string, value?: unknown) => (k === key && when(value) ? never() : real(k, value));
  }
  /** Makes the hand-off POST (and only it) never answer. */
  function hangPost(s: ReturnType<typeof setup>) {
    const inner = s.serverDeps.fetch;
    s.serverDeps.fetch = (async (url: string, init?: RequestInit) => (init?.method === 'POST' && new URL(url).pathname === '/me/crisis-handoffs' ? never() : inner(url, init))) as typeof fetch;
    return inner;
  }
  const quick = (s: ReturnType<typeof setup>) => ({ ...s.deps, patience: QUICK });

  it('says failed, and sends nothing, when the store does not answer the read of the crisis record', async () => {
    const s = setup();
    hang(s, 'crisis:block', 'get');
    expect(await sendHandoff(quick(s), input())).toBe('failed');
    expect(s.calls).toEqual([]);
    expect(s.flushFn).not.toHaveBeenCalled();
  });

  it('says offline, and sends nothing, when the crisis queue does not flush in time', async () => {
    const s = setup();
    s.flushFn.mockImplementationOnce(() => never());
    expect(await sendHandoff(quick(s), input())).toBe('offline');
    expect(posts(s.calls)).toEqual([]);
    expect(await loadHandoff(s.store.storage)).toBeNull();
  });

  it('says failed, and sends nothing, when the store does not take the record the send needs first', async () => {
    const s = setup();
    hang(s, 'crisis:handoff', 'set');
    expect(await sendHandoff(quick(s), input())).toBe('failed');
    expect(posts(s.calls)).toEqual([]);
  });

  it('says failed when the store does not answer the read of the earlier records, and a later send with a store that answers still works', async () => {
    const s = setup();
    const real = s.store.storage.get.bind(s.store.storage);
    let stuck = true;
    s.store.storage.get = ((key: string) => (key === 'crisis:handoff' && stuck ? never() : real(key))) as typeof s.store.storage.get;
    expect(await sendHandoff(quick(s), input())).toBe('failed');
    stuck = false;
    expect(await sendHandoff(quick(s), input())).toBe('sent');
    expect(posts(s.calls)).toHaveLength(1);
  });

  it('says unconfirmed, not offline, when the call does not answer, keeps the "sending" record to stop from, and a retry reuses its id and is not marked sent by the abandoned call', async () => {
    const s = setup();
    const inner = hangPost(s);
    expect(await sendHandoff(quick(s), input())).toBe('unconfirmed');
    const waiting = (await loadHandoff(s.store.storage))!;
    expect(waiting.state).toBe('sending');
    s.serverDeps.fetch = inner;
    expect(await sendHandoff(quick(s), input())).toBe('sent');
    expect(new Set(posts(s.calls).map((call) => call.body!.handoffId))).toEqual(new Set([waiting.handoffId]));
    expect((await loadHandoffs(s.store.storage)).map((record) => record.state)).toEqual(['sent']);
  });

  it('can stop the note whose send did not answer, because its record was written before the send', async () => {
    const s = setup();
    hangPost(s);
    expect(await sendHandoff(quick(s), input())).toBe('unconfirmed');
    const waiting = (await loadHandoff(s.store.storage))!;
    expect(await stopHandoff({ server: s.serverDeps, patience: QUICK }, waiting)).toBe('stopped');
    expect(await loadHandoff(s.store.storage)).toBeNull();
  });

  it('still says sent when the store does not answer the confirmation, leaving the "sending" record to stop from', async () => {
    const s = setup();
    hang(s, 'crisis:handoff', 'set', (value) => (value as HandoffRecord[]).some((record) => record.state === 'sent'));
    expect(await sendHandoff(quick(s), input())).toBe('sent');
    expect((await loadHandoff(s.store.storage))!.state).toBe('sending');
  });

  it('still answers rejected when the store does not take the removal of the refused record', async () => {
    const s = setup('rejected');
    hang(s, 'crisis:handoff', 'set', (value) => (value as HandoffRecord[]).length === 0);
    expect(await sendHandoff(quick(s), input())).toBe('rejected');
  });

  it('says offline and keeps the record when the stop does not get an answer from the server', async () => {
    const s = setup();
    await sendHandoff(s.deps, input());
    const record = (await loadHandoff(s.store.storage))!;
    s.serverDeps.fetch = (() => never()) as unknown as typeof fetch;
    expect(await stopHandoff({ server: s.serverDeps, patience: QUICK }, record)).toBe('offline');
    expect(await loadHandoff(s.store.storage)).toEqual(record);
  });

  it('says failed and keeps the record when the server stopped it but the store does not take the removal, so the person can stop again', async () => {
    const s = setup();
    await sendHandoff(s.deps, input());
    const record = (await loadHandoff(s.store.storage))!;
    hang(s, 'crisis:handoff', 'set', (value) => (value as HandoffRecord[]).length === 0);
    expect(await stopHandoff({ server: s.serverDeps, patience: QUICK }, record)).toBe('failed');
    expect(s.server.stored).toBe(false);
    expect(await loadHandoff(s.store.storage)).toEqual(record);
  });
});

describe('stopping the hand-off', () => {
  async function sent() {
    const s = setup();
    await sendHandoff(s.deps, input());
    return { s, record: (await loadHandoff(s.store.storage))! };
  }

  it('deletes it on the server first, and only then drops the record', async () => {
    const { s, record } = await sent();
    expect(await stopHandoff({ server: s.serverDeps }, record)).toBe('stopped');
    expect(s.calls.at(-1)).toMatchObject({ method: 'DELETE', path: `/me/crisis-handoffs/${record.handoffId}` });
    expect(s.server.stored).toBe(false);
    expect(await loadHandoff(s.store.storage)).toBeNull();
  });

  it('treats a hand-off the server no longer has as stopped', async () => {
    const { s, record } = await sent();
    s.server.deleteAnswers = 'missing';
    expect(await stopHandoff({ server: s.serverDeps }, record)).toBe('stopped');
    expect(await loadHandoff(s.store.storage)).toBeNull();
  });

  it('keeps the record when the server cannot be reached or refuses, so the person can try again', async () => {
    const { s, record } = await sent();
    s.server.deleteAnswers = 'offline';
    expect(await stopHandoff({ server: s.serverDeps }, record)).toBe('offline');
    s.server.deleteAnswers = 'rejected';
    expect(await stopHandoff({ server: s.serverDeps }, record)).toBe('failed');
    expect(await loadHandoff(s.store.storage)).not.toBeNull();
    expect(s.server.stored).toBe(true);
  });

  it('can stop a hand-off whose reply was lost, because the record was written before the send', async () => {
    const s = setup('lost-reply');
    await sendHandoff(s.deps, input());
    const record = (await loadHandoff(s.store.storage))!;
    expect(s.server.stored).toBe(true);
    expect(await stopHandoff({ server: s.serverDeps }, record)).toBe('stopped');
    expect(s.server.stored).toBe(false);
  });

  it('is wiped with the rest by Delete everything on the phone', async () => {
    const { s } = await sent();
    await deleteDeviceData(s.store.storage);
    expect(await loadHandoff(s.store.storage)).toBeNull();
    expect(s.store.data.size).toBe(0);
  });
});

describe('one record per crisis', () => {
  it('shows the offer for a new crisis even though an earlier crisis’s note was sent', async () => {
    const s = setup();
    await sendHandoff(s.deps, input());
    const records = await loadHandoffs(s.store.storage);
    expect(offerState(records, EVENT_ID)).toBe('sent');
    expect(offerState(records, OTHER_EVENT_ID)).toBe('offer');
    expect(handoffFor(records, OTHER_EVENT_ID)).toBeNull();
  });

  it('shows the form, not the offer or the sent line, for the crisis whose send is unconfirmed', async () => {
    const s = setup('lost-reply');
    await sendHandoff(s.deps, input());
    const records = await loadHandoffs(s.store.storage);
    expect(offerState(records, EVENT_ID)).toBe('sending');
    expect(offerState(records, OTHER_EVENT_ID)).toBe('offer');
  });

  it('keeps an earlier crisis’s unconfirmed record through a new crisis’s send, and can still stop it', async () => {
    const s = setup('lost-reply');
    await sendHandoff(s.deps, input());
    const earlier = (await loadHandoff(s.store.storage))!;
    expect(earlier.state).toBe('sending');
    await sendHandoff(s.deps, input({ crisisEventId: OTHER_EVENT_ID }));
    const records = await loadHandoffs(s.store.storage);
    expect(records.map((record) => [record.crisisEventId, record.state])).toEqual([[EVENT_ID, 'sending'], [OTHER_EVENT_ID, 'sending']]);
    expect(records[0]!.handoffId).toBe(earlier.handoffId);
    expect(records[1]!.handoffId).not.toBe(earlier.handoffId);
    // The earlier note is on the server (its reply was lost) and the phone can still stop exactly that one.
    expect(await stopHandoff({ server: s.serverDeps }, earlier)).toBe('stopped');
    expect(s.calls.at(-1)).toMatchObject({ method: 'DELETE', path: `/me/crisis-handoffs/${earlier.handoffId}` });
    expect((await loadHandoffs(s.store.storage)).map((record) => record.crisisEventId)).toEqual([OTHER_EVENT_ID]);
  });

  it('stops only its own record and leaves a sent note of another crisis alone', async () => {
    const s = setup();
    await sendHandoff(s.deps, input());
    await sendHandoff(s.deps, input({ crisisEventId: OTHER_EVENT_ID }));
    const [first, second] = await loadHandoffs(s.store.storage);
    expect(await stopHandoff({ server: s.serverDeps }, second!)).toBe('stopped');
    expect(await loadHandoffs(s.store.storage)).toEqual([first]);
  });

  it('drops only the refused crisis’s record when the server refuses it', async () => {
    const s = setup();
    await sendHandoff(s.deps, input());
    const refused = setup('rejected');
    refused.store.data.set('crisis:handoff', (await loadHandoffs(s.store.storage)).map((record) => ({ ...record, handoffId: '44444444-4444-4444-8444-444444444444' })));
    expect(await sendHandoff(refused.deps, input({ crisisEventId: OTHER_EVENT_ID }))).toBe('rejected');
    expect((await loadHandoffs(refused.store.storage)).map((record) => record.crisisEventId)).toEqual([EVENT_ID]);
  });

  it('is reached by Delete everything on the phone, every record at once', async () => {
    const s = setup();
    await sendHandoff(s.deps, input());
    await sendHandoff(s.deps, input({ crisisEventId: OTHER_EVENT_ID }));
    expect(await loadHandoffs(s.store.storage)).toHaveLength(2);
    await deleteDeviceData(s.store.storage);
    expect(await loadHandoffs(s.store.storage)).toEqual([]);
  });
});

describe('a send the server says was stopped', () => {
  it('says it was stopped, drops the record, and offers nothing again: the next send, if the person makes one, is a different hand-off id', async () => {
    const s = setup('stopped');
    expect(await sendHandoff(s.deps, input())).toBe('stopped');
    expect(await loadHandoffs(s.store.storage)).toEqual([]);
    const idsSent = posts(s.calls).map((call) => call.body!.handoffId);
    await sendHandoff(s.deps, input());
    const all = posts(s.calls).map((call) => call.body!.handoffId);
    expect(all).toHaveLength(2);
    expect(all[1]).not.toBe(idsSent[0]);
  });

  it('keeps "try again in a moment" for a crisis record the server does not hold yet, and never for a stopped hand-off', async () => {
    const notReady = setup('unknown-event');
    expect(await sendHandoff(notReady.deps, input())).toBe('not_ready');
    const stopped = setup('stopped');
    expect(await sendHandoff(stopped.deps, input())).not.toBe('not_ready');
  });
});

describe('the words for a send that could not be confirmed', () => {
  it.each([
    ['en', en.crisis, ['could not confirm', 'may have been sent', 'numbers above still work', 'stop the note']],
    ['ar', ar.crisis, ['تعذّر التأكد من وصول الملاحظة', 'قد تكون أُرسلت', 'الأرقام أعلاه تعمل كالمعتاد', 'إيقاف الملاحظة']],
  ])('say, in %s, that the arrival could not be confirmed, that the numbers still work and that the note can be stopped', (_locale, crisis, parts) => {
    for (const part of parts) expect(crisis.handoffNotConfirmed).toContain(part);
  });

  it('never claim, in either language, that nothing was sent, which a slow send may have disproved', () => {
    expect(en.crisis.handoffNotConfirmed).not.toMatch(/nothing was sent/i);
    expect(ar.crisis.handoffNotConfirmed).not.toContain('فلم يُرسَل');
    expect(ar.crisis.handoffNotConfirmed).toMatch(/[؀-ۿ]/);
  });

  it('leave the words for the outcomes where nothing was sent for certain exactly as they were', () => {
    expect(en.crisis.handoffOffline).toBe('We could not reach the server, so nothing was sent. The numbers above still work.');
    expect(en.crisis.handoffFailed).toBe('This phone could not prepare the note, so nothing was sent.');
    expect(en.crisis.handoffStoppedNote).toBe('You stopped this note before it was stored, so it was not sent.');
    expect(ar.crisis.handoffOffline).toBe('تعذّر الوصول إلى الخادم، فلم يُرسَل شيء. الأرقام أعلاه تعمل كالمعتاد.');
    expect(ar.crisis.handoffFailed).toBe('تعذّر على هذا الهاتف تجهيز الملاحظة، فلم يُرسَل شيء.');
  });
});
