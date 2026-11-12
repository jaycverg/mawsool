import type { Demographics } from '@mawsool/types';
import { createDeviceIdentity } from '@mawsool/ui';
import { describe, expect, it, vi } from 'vitest';
import { KEYS } from '../lib/keys';
import { loadOutcomeStatistics } from '../lib/outcome-statistics';
import { finishRepeatCheck } from '../lib/remeasure';
import { forgetRegistration } from '../lib/server';
import { learnServerChoices, readSendMarks, sendEquityChoice, takeClearedNote, withChoiceSend } from '../lib/server-choices';
import ar from '../messages/ar.json';
import en from '../messages/en.json';
import { loadEquity } from '../lib/share';
import { memoryStorage } from './helpers/memory';

const IDENTITY = createDeviceIdentity(globalThis.crypto);
const TICKET_ID = '11111111-1111-4111-8111-111111111111';
const SCORES = [{ instrument: 'phq9' as const, total: 7, band: 'mild', takenAt: '2026-12-21T09:00:00+04:00' }];
const BUCKETS: Demographics = { ageBand: '25_34', gender: null, language: null, region: null };
const NOW = new Date('2026-11-02T08:00:00Z');
const now = () => NOW;
const IDLE_DAY = '2026-05-06';

interface Deferred {
  promise: Promise<void>;
  release: () => void;
}
const deferred = (): Deferred => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
};

/**
 * A phone with the given notes and a fake API. The server holds `server`'s choices; each answer can be held back
 * (`hold`) so a read can be made to overlap a send, or be made to fail.
 */
function world(options: { equity?: boolean; statistics?: boolean; server?: { equityOptIn: boolean; outcomeStatsOptIn: boolean }; optIns?: 'ok' | 'down' | 'unusable'; lastReached?: string } = {}) {
  const store = memoryStorage({
    identity: IDENTITY,
    ...(options.equity ? { [KEYS.equity]: { optIn: true, buckets: { ageBand: '25_34' } } } : {}),
    ...(options.statistics ? { [KEYS.outcomeStatistics]: { optIn: true } } : {}),
    ...(options.lastReached ? { [KEYS.lastSeenSent]: { day: options.lastReached } } : {}),
  });
  forgetRegistration(store.storage);
  const state = { server: options.server ?? { equityOptIn: false, outcomeStatsOptIn: false }, optIns: options.optIns ?? 'ok' };
  const hold: { optIns?: Deferred; put?: Deferred; post?: Deferred } = {};
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const method = init?.method ?? 'GET';
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (path === '/persons') return new Response('{}', { status: 201 });
    if (path === '/me/opt-ins') {
      const asked = hold.optIns;
      const answer = { ...state.server };
      if (asked) await asked.promise;
      if (state.optIns === 'down') throw new TypeError('network down');
      return new Response(JSON.stringify(state.optIns === 'unusable' ? { equityOptIn: 'yes' } : answer), { status: 200 });
    }
    if (path === '/me/equity') {
      if (hold.put) await hold.put.promise;
      const body = JSON.parse(String(init?.body)) as { optIn: boolean };
      state.server.equityOptIn = body.optIn;
      return new Response(JSON.stringify({ optIn: body.optIn }), { status: 200 });
    }
    if (path.endsWith('/remeasure')) {
      if (hold.post) await hold.post.promise;
      const body = JSON.parse(String(init?.body)) as { statisticsOptIn?: boolean };
      if (body.statisticsOptIn !== undefined) state.server.outcomeStatsOptIn = body.statisticsOptIn;
      return new Response(JSON.stringify({ state: 'closed', scoresShared: true, events: [] }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  const server = { storage: store.storage, fetch: fetchFn, apiUrl: 'http://api.test', locale: 'en' as const, random: globalThis.crypto };
  const sentTrue = () => calls.filter((call) => (call.path === '/me/equity' && (call.body as { optIn?: boolean }).optIn === true) || (call.path.endsWith('/remeasure') && (call.body as { statisticsOptIn?: boolean }).statisticsOptIn === true));
  return { ...store, state, hold, calls, server, sentTrue };
}

const equityInput = (tickedHere: boolean, extra: Partial<Parameters<typeof sendEquityChoice>[1]> = {}) => ({ on: true, buckets: BUCKETS, storedOptIn: true, tickedHere, now, ...extra });

describe('the group-totals choice the phone only remembers is checked with the server before it is sent', () => {
  it('sends no true, tells the screen, and turns the note off when the server has the choice off and the daily read has not run', async () => {
    const w = world({ equity: true });
    expect(await sendEquityChoice(w.server, equityInput(false))).toBe('cleared');
    expect(w.sentTrue()).toEqual([]);
    expect(w.calls.filter((call) => call.path === '/me/equity')).toEqual([]);
    expect(await loadEquity(w.storage)).toEqual({ optIn: false, buckets: {} });
    expect(await takeClearedNote(w.storage), 'the screen tells the person, Settings does not repeat it').toBeNull();
  });

  it.each([
    ['cannot be reached', { optIns: 'down' as const }],
    ['answers something that is not the two choices', { optIns: 'unusable' as const }],
  ])('sends no true when the server %s, and leaves the note as it was', async (_name, options) => {
    const w = world({ equity: true, ...options });
    expect(await sendEquityChoice(w.server, equityInput(false))).toBe('unread');
    expect(w.calls.filter((call) => call.path === '/me/equity')).toEqual([]);
    expect((await loadEquity(w.storage)).optIn).toBe(true);
  });

  it('sends the true, with the buckets, when the server confirms it holds the choice', async () => {
    const w = world({ equity: true, server: { equityOptIn: true, outcomeStatsOptIn: false } });
    expect(await sendEquityChoice(w.server, equityInput(false))).toBe('saved');
    expect(w.sentTrue()).toEqual([{ method: 'PUT', path: '/me/equity', body: { optIn: true, buckets: BUCKETS } }]);
  });

  it('sends the true as it always did, without asking, when the person ticked the group-totals box on this screen', async () => {
    const w = world({ equity: true });
    expect(await sendEquityChoice(w.server, equityInput(true))).toBe('saved');
    expect(w.calls.map((call) => `${call.method} ${call.path}`).filter((call) => call.includes('opt-ins'))).toEqual([]);
    expect(w.sentTrue()).toHaveLength(1);
    expect(w.state.server.equityOptIn, 'ticking it again is turning it on').toBe(true);
  });

  it('sends the off, without asking, when the box was unticked and the phone held a note, and nothing when there is no note', async () => {
    const off = world({ equity: true });
    expect(await sendEquityChoice(off.server, equityInput(false, { on: false }))).toBe('saved');
    expect(off.calls.find((call) => call.path === '/me/equity')!.body).toEqual({ optIn: false });
    expect(await loadEquity(off.storage)).toEqual({ optIn: false, buckets: {} });
    const none = world();
    expect(await sendEquityChoice(none.server, equityInput(false, { on: false, storedOptIn: false }))).toBe('skipped');
    expect(none.calls).toEqual([]);
  });

  it('reports a server that cannot be reached or refuses, and does not send when it cannot mark the send', async () => {
    const down = world({ server: { equityOptIn: true, outcomeStatsOptIn: false } });
    down.state.optIns = 'ok';
    const failing = { ...down.server, fetch: (async (url: string) => (new URL(url).pathname === '/persons' ? new Response('{}', { status: 201 }) : Promise.reject(new TypeError('network down')))) as unknown as typeof fetch };
    expect(await sendEquityChoice(failing, equityInput(true))).toBe('offline');
    const unmarkable = world();
    const set = unmarkable.storage.set.bind(unmarkable.storage);
    unmarkable.storage.set = async (key, value) => {
      if (key === KEYS.choiceSends) throw new Error('storage write failed');
      return set(key, value);
    };
    await expect(sendEquityChoice(unmarkable.server, equityInput(true))).rejects.toThrow();
    expect(unmarkable.calls.filter((call) => call.path === '/me/equity')).toEqual([]);
  });
});

describe('the statistics choice the phone only remembers is checked with the server before it is sent', () => {
  const NOTED = { statisticsSource: 'noted' as const, now };
  const TICKED = { statisticsSource: 'ticked' as const, now };

  it('sends nothing, and turns the note off, when the server has the choice off and the daily read has not run', async () => {
    const w = world({ statistics: true });
    expect(await finishRepeatCheck(w.server, TICKET_ID, SCORES, true, NOTED)).toBe('choice_cleared');
    expect(w.calls.filter((call) => call.path.endsWith('/remeasure'))).toEqual([]);
    expect(await loadOutcomeStatistics(w.storage)).toBe(false);
    expect(await takeClearedNote(w.storage)).toBeNull();
  });

  it.each([
    ['cannot be reached', { optIns: 'down' as const }],
    ['answers something that is not the two choices', { optIns: 'unusable' as const }],
  ])('sends nothing when the server %s, and leaves the note as it was', async (_name, options) => {
    const w = world({ statistics: true, ...options });
    expect(await finishRepeatCheck(w.server, TICKET_ID, SCORES, true, NOTED)).toBe('choice_unread');
    expect(w.calls.filter((call) => call.path.endsWith('/remeasure'))).toEqual([]);
    expect(await loadOutcomeStatistics(w.storage)).toBe(true);
  });

  it('sends the true when the server confirms it holds the choice', async () => {
    const w = world({ statistics: true, server: { equityOptIn: false, outcomeStatsOptIn: true } });
    expect(await finishRepeatCheck(w.server, TICKET_ID, SCORES, true, NOTED)).toBe('done');
    expect(w.sentTrue()).toHaveLength(1);
  });

  it('sends the true as it always did, without asking, when the person ticked the statistics box on this screen', async () => {
    const w = world({ statistics: true });
    expect(await finishRepeatCheck(w.server, TICKET_ID, SCORES, true, TICKED)).toBe('done');
    expect(w.calls.filter((call) => call.path === '/me/opt-ins')).toEqual([]);
    expect(w.state.server.outcomeStatsOptIn).toBe(true);
  });

  it('asks about nothing when the choice sent is off or left out, whatever its source', async () => {
    const w = world({ statistics: true });
    expect(await finishRepeatCheck(w.server, TICKET_ID, SCORES, false, NOTED)).toBe('done');
    expect(await finishRepeatCheck(w.server, TICKET_ID, [], undefined, NOTED)).toBe('done');
    expect(w.calls.filter((call) => call.path === '/me/opt-ins')).toEqual([]);
  });

  it('does not make the send when it cannot mark it', async () => {
    const w = world({ statistics: true });
    const set = w.storage.set.bind(w.storage);
    w.storage.set = async (key, value) => {
      if (key === KEYS.choiceSends) throw new Error('storage write failed');
      return set(key, value);
    };
    expect(await finishRepeatCheck(w.server, TICKET_ID, SCORES, true, TICKED)).toBe('note_failed');
    expect(w.calls.filter((call) => call.path.endsWith('/remeasure'))).toEqual([]);
  });
});

describe('a read of the server’s choices that overlaps a send cannot turn the note off from an answer given before the server took the choice', () => {
  /** The context a daily read gives: it knows the phone reached the server long ago, which is what lets the note be written. */
  const READ = { lastReached: IDLE_DAY, now: NOW };

  it('keeps the statistics note when the read is answered off while the send that turns it on is still on its way, and after it ends', async () => {
    const w = world({ statistics: true });
    w.hold.optIns = deferred();
    w.hold.post = deferred();
    const read = learnServerChoices(w.server, READ);
    await vi.waitFor(() => expect(w.calls.some((call) => call.path === '/me/opt-ins')).toBe(true));
    const send = finishRepeatCheck(w.server, TICKET_ID, SCORES, true, { statisticsSource: 'ticked', now });
    await vi.waitFor(() => expect(w.calls.some((call) => call.path.endsWith('/remeasure'))).toBe(true));
    w.hold.optIns.release(); // the read is answered "off", a moment before the server takes the choice
    expect(await read).toBe('unchanged');
    expect(await loadOutcomeStatistics(w.storage), 'the send is pending').toBe(true);
    w.hold.post.release();
    expect(await send).toBe('done');
    expect(w.state.server.outcomeStatsOptIn).toBe(true);
    expect(await loadOutcomeStatistics(w.storage), 'the server holds the choice and so does the phone: Settings can turn it off').toBe(true);
  });

  it('keeps the equity note when the read began before a send that has already finished by the time the read is answered', async () => {
    const w = world({ equity: true, server: { equityOptIn: true, outcomeStatsOptIn: false } });
    w.state.server.equityOptIn = false; // the read will be answered off
    w.hold.optIns = deferred();
    const read = learnServerChoices(w.server, READ);
    await vi.waitFor(() => expect(w.calls.some((call) => call.path === '/me/opt-ins')).toBe(true));
    expect(await sendEquityChoice(w.server, equityInput(true))).toBe('saved'); // starts and ends while the read is out
    w.hold.optIns.release();
    expect(await read).toBe('unchanged');
    expect(w.state.server.equityOptIn).toBe(true);
    expect((await loadEquity(w.storage)).optIn, 'the note matches the server').toBe(true);
  });

  it('turns the note off for a choice cleared at the server after the send that set it has ended (no overlap, nothing to protect)', async () => {
    const w = world({ statistics: true });
    expect(await finishRepeatCheck(w.server, TICKET_ID, SCORES, true, { statisticsSource: 'ticked', now })).toBe('done');
    w.state.server.outcomeStatsOptIn = false; // later cleared at the server, long after the send ended
    expect(await learnServerChoices(w.server, READ)).toBe('turned_off');
    expect(await loadOutcomeStatistics(w.storage)).toBe(false);
  });

  it('does not let a mark left behind by a tab that closed mid-send block the idle limit for ever', async () => {
    const w = world({ statistics: true });
    const marks = await readSendMarks(w.storage);
    w.data.set(KEYS.choiceSends, { ...marks, statistics: { gen: marks.statistics.gen, pendingSince: NOW.getTime() - 3 * 60_000 } });
    expect(await learnServerChoices(w.server, READ)).toBe('turned_off');
    expect(await loadOutcomeStatistics(w.storage)).toBe(false);
  });

  it('brackets a send with a start and an end mark whatever way it ends, and marks only the choice it can turn on', async () => {
    const w = world();
    await expect(withChoiceSend(w.storage, 'equity', now, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await readSendMarks(w.storage)).toEqual({ equity: { gen: 2, pendingSince: null }, statistics: { gen: 0, pendingSince: null } });
    const during = await withChoiceSend(w.storage, 'statistics', now, async () => (await readSendMarks(w.storage)).statistics);
    expect(during).toEqual({ started: true, value: { gen: 1, pendingSince: NOW.getTime() } });
  });
});

describe('the words for a choice that was unticked and not sent', () => {
  it.each(['en', 'ar'] as const)('says, in %s, why the choice was unticked and not sent, in the words of the other notes on the screen', (locale) => {
    const messages = locale === 'en' ? en : ar;
    const notes = [messages.consent.equityCleared, messages.consent.equityUnread, messages.remeasure.choiceCleared, messages.remeasure.choiceUnread];
    for (const note of notes) {
      expect(note, 'says nothing was sent and the box is unticked').toContain(locale === 'en' ? 'nothing' : 'لم يُرسل');
      expect(note, 'says the person can tick it again').toMatch(locale === 'en' ? /Tick it again/ : /حدّده من جديد/);
      expect(note, 'no clinical words').not.toMatch(locale === 'en' ? /\b(score|band|depress|anxi|PHQ|GAD|crisis|diagnos)/i : /(درجة|اكتئاب|قلق|أزمة|تشخيص)/);
    }
    expect(messages.consent.equityCleared).not.toBe(messages.consent.equityUnread);
    expect(messages.remeasure.choiceCleared).not.toBe(messages.remeasure.choiceUnread);
    if (locale === 'ar') for (const note of notes) expect(note).toMatch(/[؀-ۿ]/);
  });
});
