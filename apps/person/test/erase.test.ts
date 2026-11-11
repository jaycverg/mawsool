import type { CrisisEventSubmission } from '@mawsool/types';
import { createTabMark } from '@mawsool/ui';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnonymousStore } from '../lib/anonymous';
import { eraseEverything, type EraseDeps } from '../lib/erase';
import { claimInvite } from '../lib/invite';
import { saveReminderNumber } from '../lib/reminders';
import { forgetRegistration, markServerFootprint } from '../lib/server';
import en from '../messages/en.json';
import ar from '../messages/ar.json';
import { memoryStorage } from './helpers/memory';

const NOW = () => new Date('2026-11-02T08:00:00+04:00');
const EVENT: CrisisEventSubmission = {
  id: '11111111-1111-4111-8111-111111111111',
  trigger: 'phq9_item9',
  shownAt: '2026-11-02T08:00:00+04:00',
  callTapped: null,
  contextShared: false,
  humanContactConfirmed: false,
  contactSource: null,
  contactAt: null,
  resolvedAt: null,
  locale: 'en',
};

type Reply = { status: number } | 'offline';

/** A fake API: registration works, and "DELETE /me/data" answers as told. Records what it was asked. */
function setup(options: { footprint?: boolean; unsent?: boolean; erase?: Reply; flush?: 'sends' | 'fails' | 'hangs'; crisisOpen?: boolean; failClear?: boolean } = {}) {
  const store = memoryStorage({ screenings: [{ id: 's' }], 'crisis:outbox': options.unsent ? [EVENT] : [] });
  const calls: string[] = [];
  const eraseBodies: unknown[] = [];
  const wipedBefore: boolean[] = [];
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    if (path === '/persons') return new Response('{}', { status: 201 });
    if (path === '/me/invites/claim') return new Response(JSON.stringify({ inviteId: '66666666-6666-4666-8666-666666666666', source: 'tamm', screenedAt: '2026-11-01T04:00:00.000Z' }), { status: 200 });
    wipedBefore.push(store.data.size === 0);
    eraseBodies.push(init?.body ? JSON.parse(String(init.body)) : null);
    const reply = options.erase ?? { status: 200 };
    if (reply === 'offline') throw new TypeError('network down');
    return new Response('{}', { status: reply.status });
  }) as unknown as typeof fetch;
  const mark = createTabMark<{ id: string }>(undefined, 'k', (value): value is { id: string } => typeof value === 'object');
  mark.set({ id: 'open' });
  const clear = store.storage.clear.bind(store.storage);
  if (options.failClear) store.storage.clear = async () => Promise.reject(new Error('cannot clear'));
  else store.storage.clear = async () => (calls.push('CLEAR'), clear());
  const flushCrisis = vi.fn(async () => {
    calls.push('FLUSH');
    if (options.flush === 'hangs') return new Promise<never>(() => undefined);
    if (options.flush === 'sends') await store.storage.set('crisis:outbox', []);
    return { outcome: options.flush === 'sends' ? ('sent' as const) : ('offline' as const), sent: 0, rejected: 0 };
  });
  const deps: EraseDeps = {
    storage: store.storage,
    tabMark: mark,
    server: { storage: store.storage, fetch: fetchFn, apiUrl: 'http://api.test', locale: 'en', random: globalThis.crypto },
    flushCrisis,
    crisisIsOpen: async () => options.crisisOpen ?? false,
  };
  return { deps, store, calls, eraseBodies, mark, flushCrisis, wipedBefore, prepare: async () => { forgetRegistration(store.storage); if (options.footprint) await markServerFootprint(store.storage, NOW); } };
}

afterEach(() => vi.useRealTimers());

describe('Delete everything when an anonymous session\'s check-ins cannot all be deleted', () => {
  /** An anonymous store that deletes nothing it is asked to and reports `left`; `keeps` says whether the ids can be written back. */
  const leftover = (left: string[], keeps = true): AnonymousStore => ({
    open: () => Promise.reject(new Error('not used')),
    reconcile: () => Promise.resolve(),
    wipe: () => Promise.resolve('deleted'),
    ids: () => Promise.resolve(left),
    wipeAll: () => Promise.resolve({ left }),
    keep: () => (keeps ? Promise.resolve() : Promise.reject(new Error('the list refused'))),
  });

  it('is still erased, with every ordinary key gone, and the result says some are left for the next start', async () => {
    const s = setup();
    await s.prepare();
    const outcome = await eraseEverything({ ...s.deps, anonymousStore: leftover(['22222222-2222-4222-8222-222222222222']) });
    expect(outcome).toEqual({ status: 'erased', crisisRecord: 'none', crisisWasOpen: false, anonymousLeft: 'next_start' });
    expect(s.store.data.has('screenings')).toBe(false);
  });

  it('says it is unknown when the ids of what is left could not be written back', async () => {
    const s = setup();
    await s.prepare();
    expect(await eraseEverything({ ...s.deps, anonymousStore: leftover(['22222222-2222-4222-8222-222222222222'], false) })).toMatchObject({ status: 'erased', anonymousLeft: 'unknown' });
  });

  it('says nothing is left when every database was deleted', async () => {
    const s = setup();
    await s.prepare();
    expect(await eraseEverything({ ...s.deps, anonymousStore: leftover([]) })).toMatchObject({ status: 'erased', anonymousLeft: 'none' });
  });
});

describe('Delete everything on a phone that only claimed a front-door invite', () => {
  it('asks the server to remove the claim before it wipes the phone, because the wipe destroys the only secret that can', async () => {
    const s = setup();
    forgetRegistration(s.store.storage);
    expect((await claimInvite(s.deps.server, 'ABCD-EFGH', NOW)).status).toBe('claimed');
    expect(s.store.data.has('invite')).toBe(true);
    s.calls.length = 0;
    expect((await eraseEverything(s.deps)).status).toBe('erased');
    expect(s.calls).toEqual(['DELETE /me/data', 'CLEAR']);
    expect(s.wipedBefore).toEqual([false]);
    expect(s.store.data.size).toBe(0);
  });

  it('offline, deletes nothing and stays blocked, so the claim can still be removed later', async () => {
    const s = setup({ erase: 'offline' });
    forgetRegistration(s.store.storage);
    expect((await claimInvite(s.deps.server, 'ABCD-EFGH', NOW)).status).toBe('claimed');
    s.calls.length = 0;
    expect(await eraseEverything(s.deps)).toEqual({ status: 'blocked' });
    expect(s.calls).toEqual(['DELETE /me/data']);
    expect(s.store.data.has('invite')).toBe(true);
    expect(s.store.data.has('screenings')).toBe(true);
  });

  it('is told the truth about why: the blocked message names what the server holds, not only what was shared', () => {
    for (const messages of [en, ar]) {
      expect(messages.settings.blocked).not.toMatch(/withdraw what you shared|لسحب ما شاركته/);
    }
    expect(en.settings.blocked).toMatch(/linked screen/);
    expect(ar.settings.blocked).toMatch(/نتيجة الفحص المرتبطة/);
  });
});

describe('Delete everything', () => {
  it('wipes at once, without any network call, when this phone never gave the server anything', async () => {
    const s = setup();
    await s.prepare();
    expect(await eraseEverything(s.deps)).toEqual({ status: 'erased', crisisRecord: 'none', crisisWasOpen: false, anonymousLeft: 'none' });
    expect(s.calls).toEqual(['CLEAR']);
    expect(s.store.data.size).toBe(0);
    expect(s.mark.get()).toBeNull();
  });

  it('asks the server to remove what it holds before it wipes the phone', async () => {
    const s = setup({ footprint: true });
    await s.prepare();
    expect((await eraseEverything(s.deps)).status).toBe('erased');
    expect(s.calls).toEqual(['POST /persons', 'DELETE /me/data', 'CLEAR']);
    expect(s.wipedBefore).toEqual([false]); // the secret still existed when the server was asked
    expect(s.store.data.size).toBe(0);
  });

  it.each([
    ['the server cannot be reached', 'offline' as const],
    ['the server fails', { status: 503 }],
    ['the server refuses', { status: 401 }],
  ])('stops with nothing deleted when %s and the phone has data on the server', async (_name, erase) => {
    const s = setup({ footprint: true, erase });
    await s.prepare();
    expect(await eraseEverything(s.deps)).toEqual({ status: 'blocked' });
    expect(s.calls).not.toContain('CLEAR');
    expect(s.store.data.has('screenings')).toBe(true);
    expect(s.mark.get()).toEqual({ id: 'open' });
  });

  it('sends a crisis record that was never sent before it wipes, and says so', async () => {
    const s = setup({ unsent: true, flush: 'sends', crisisOpen: true });
    await s.prepare();
    expect(await eraseEverything(s.deps)).toEqual({ status: 'erased', crisisRecord: 'sent', crisisWasOpen: true, anonymousLeft: 'none' });
    expect(s.calls).toEqual(['FLUSH', 'CLEAR']);
  });

  it('lets erasure win when the crisis record cannot be sent: it is deleted with the rest, and the outcome says so', async () => {
    const s = setup({ unsent: true, flush: 'fails', crisisOpen: true });
    await s.prepare();
    expect(await eraseEverything(s.deps)).toEqual({ status: 'erased', crisisRecord: 'deleted', crisisWasOpen: true, anonymousLeft: 'none' });
    expect(s.store.data.size).toBe(0);
    expect(s.mark.get()).toBeNull();
  });

  it('does not wait for ever on a send that hangs', async () => {
    vi.useFakeTimers();
    const s = setup({ unsent: true, flush: 'hangs' });
    await s.prepare();
    const done = eraseEverything(s.deps);
    await vi.advanceTimersByTimeAsync(8000);
    expect(await done).toMatchObject({ status: 'erased', crisisRecord: 'deleted' });
  });

  it('keeps the unsent crisis record when the run is blocked, so a later try can still send it', async () => {
    const s = setup({ footprint: true, unsent: true, flush: 'fails', erase: 'offline' });
    await s.prepare();
    expect((await eraseEverything(s.deps)).status).toBe('blocked');
    expect(s.store.data.get('crisis:outbox')).toEqual([EVENT]);
  });

  it('reports a failure, deleting nothing, when the phone’s own storage cannot be read or cleared', async () => {
    const unreadable = setup();
    await unreadable.prepare();
    unreadable.store.failures.read = true;
    expect(await eraseEverything(unreadable.deps)).toEqual({ status: 'failed' });

    const stuck = setup({ failClear: true });
    await stuck.prepare();
    expect(await eraseEverything(stuck.deps)).toEqual({ status: 'failed' });
    expect(stuck.store.data.has('screenings')).toBe(true);
  });

  it('stops with nothing deleted when the phone cannot read its own device secret to ask the server', async () => {
    const s = setup({ footprint: true });
    await s.prepare();
    const ifAbsent = s.store.storage.setIfAbsent.bind(s.store.storage);
    s.store.storage.setIfAbsent = (async (key: string, value: unknown) => (key === 'identity' ? Promise.reject(new Error('unreadable')) : ifAbsent(key, value))) as typeof ifAbsent;
    expect(await eraseEverything(s.deps)).toEqual({ status: 'blocked' });
    expect(s.calls).not.toContain('CLEAR');
    expect(s.store.data.has('screenings')).toBe(true);
  });

  it('carries on when it cannot tell whether a crisis screen is open', async () => {
    const s = setup();
    await s.prepare();
    s.deps.crisisIsOpen = async () => Promise.reject(new Error('unreadable'));
    expect(await eraseEverything(s.deps)).toMatchObject({ status: 'erased', crisisWasOpen: false });
  });
});

describe('Delete everything on a phone that gave a number for text reminders', () => {
  const settings = { intervalWeeks: 4 as const, since: '2026-11-01T08:00:00+04:00', notifiedFor: null, phone: null, serverMayHoldPhone: false };

  it('asks the server to delete the number before the wipe, then leaves no reminder record on the phone', async () => {
    const s = setup();
    s.store.data.set('reminders', settings);
    forgetRegistration(s.store.storage);
    expect(await saveReminderNumber({ server: s.deps.server, now: NOW }, settings, '+971501234567')).toBe('saved');
    expect(s.store.data.get('reminders')).toMatchObject({ phone: '+971501234567' });
    s.calls.length = 0;
    s.wipedBefore.length = 0;
    expect((await eraseEverything(s.deps)).status).toBe('erased');
    expect(s.calls).toEqual(['DELETE /me/data', 'CLEAR']);
    expect(s.wipedBefore).toEqual([false]);
    expect(s.store.data.has('reminders')).toBe(false);
    expect(s.store.data.size).toBe(0);
  });

  it('offline, deletes nothing, so the number can still be removed from the server later', async () => {
    const s = setup();
    s.store.data.set('reminders', settings);
    forgetRegistration(s.store.storage);
    expect(await saveReminderNumber({ server: s.deps.server, now: NOW }, settings, '+971501234567')).toBe('saved');
    s.deps.server.fetch = (async () => {
      throw new TypeError('network down');
    }) as unknown as typeof fetch;
    expect(await eraseEverything(s.deps)).toEqual({ status: 'blocked' });
    expect(s.store.data.get('reminders')).toMatchObject({ phone: '+971501234567' });
  });

  it('wipes reminders that never had a number without any network call', async () => {
    const s = setup();
    s.store.data.set('reminders', settings);
    await s.prepare();
    expect((await eraseEverything(s.deps)).status).toBe('erased');
    expect(s.calls).toEqual(['CLEAR']);
    expect(s.store.data.has('reminders')).toBe(false);
  });
});

describe('Delete everything on a phone that handed a note to the crisis line', () => {
  const FIRST = '55555555-5555-4555-8555-555555555555';
  const SECOND = '66666666-6666-4666-8666-666666666666';
  const record = (handoffId: string, state: 'sending' | 'sent') => ({ handoffId, crisisEventId: '11111111-1111-4111-8111-111111111111', state, startedAt: '2026-11-02T08:00:00+04:00' });

  it('sends the ids of every note it made, the one whose reply never came included, so the server can refuse a send still on its way', async () => {
    const s = setup({ footprint: true });
    s.store.data.set('crisis:handoff', [record(FIRST, 'sent'), record(SECOND, 'sending')]);
    await s.prepare();
    expect((await eraseEverything(s.deps)).status).toBe('erased');
    expect(s.calls.filter((call) => call !== 'POST /persons')).toEqual(['DELETE /me/data', 'CLEAR']);
    expect(s.eraseBodies).toEqual([{ handoffIds: [FIRST, SECOND] }]);
    expect(s.store.data.size).toBe(0);
  });

  it('sends no body when no note was ever made, and still wipes', async () => {
    const s = setup({ footprint: true });
    await s.prepare();
    expect((await eraseEverything(s.deps)).status).toBe('erased');
    expect(s.eraseBodies).toEqual([null]);
  });

  it('wipes without any network call when nothing was ever shared, even with a record that never reached the server', async () => {
    const s = setup();
    s.store.data.set('crisis:handoff', [record(FIRST, 'sending')]);
    await s.prepare();
    expect((await eraseEverything(s.deps)).status).toBe('erased');
    expect(s.calls).toEqual(['CLEAR']);
  });

  it('keeps the hand-off ids to send again later when the server cannot be reached, deleting nothing', async () => {
    const s = setup({ footprint: true, erase: 'offline' });
    s.store.data.set('crisis:handoff', [record(FIRST, 'sending')]);
    await s.prepare();
    expect((await eraseEverything(s.deps)).status).toBe('blocked');
    expect(s.store.data.get('crisis:handoff')).toEqual([record(FIRST, 'sending')]);
  });
});
