import type { NotificationAdapter, NotificationPermissionState } from '@mawsool/ui';
import { setDemoOffsetMs } from '@mawsool/ui';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deviceNow } from '../lib/clock';
import { FOLLOW_UP_DELAY_MS, FOLLOW_UP_TAG, answerFollowUp, followUpDue, loadFollowUp, runDueFollowUp, scheduleFollowUp, type FollowUp } from '../lib/follow-up';
import { GUARDED_ROUTES, isGuardedPath } from '../lib/routes';
import ar from '../messages/ar.json';
import en from '../messages/en.json';
import { memoryStorage } from './helpers/memory';
// @ts-expect-error plain .mjs script with JSDoc types
import { OFFLINE_SCREENS } from '../scripts/build-precache.mjs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const RESOLVED = new Date('2026-11-01T08:00:00+04:00');
const DUE = new Date(RESOLVED.getTime() + FOLLOW_UP_DELAY_MS);
const text = { title: en.nextDay.notifyTitle, body: en.nextDay.notifyBody };

function adapter(permission: NotificationPermissionState) {
  const shown: { title: string; body?: string; tag?: string }[] = [];
  const requestPermission = vi.fn(async () => 'granted' as const);
  const notifications: NotificationAdapter = { permission: () => permission, requestPermission, show: async (n) => void shown.push(n) };
  return { notifications, shown, requestPermission };
}

afterEach(() => setDemoOffsetMs(0));

describe('scheduling the next-day check', () => {
  it('is due a day after the crisis was resolved, with nothing answered or shown yet', async () => {
    const { storage } = memoryStorage();
    expect(await scheduleFollowUp(storage, { eventId: 'e1', resolvedAt: RESOLVED })).toBe('scheduled');
    expect(await loadFollowUp(storage)).toEqual({ eventId: 'e1', dueAt: DUE.toISOString(), notified: false, answer: null, answeredAt: null });
  });

  it('keeps the schedule and the answer of a crisis it already knows, so resolving twice changes nothing', async () => {
    const { storage } = memoryStorage();
    await scheduleFollowUp(storage, { eventId: 'e1', resolvedAt: RESOLVED });
    await answerFollowUp(storage, 'same', () => DUE);
    expect(await scheduleFollowUp(storage, { eventId: 'e1', resolvedAt: new Date(RESOLVED.getTime() + 3 * FOLLOW_UP_DELAY_MS) })).toBe('kept');
    expect(await loadFollowUp(storage)).toMatchObject({ dueAt: DUE.toISOString(), answer: 'same' });
  });

  it('replaces the check of an older crisis with a newer crisis’s', async () => {
    const { storage } = memoryStorage();
    await scheduleFollowUp(storage, { eventId: 'e1', resolvedAt: RESOLVED });
    const later = new Date(RESOLVED.getTime() + 5 * FOLLOW_UP_DELAY_MS);
    expect(await scheduleFollowUp(storage, { eventId: 'e2', resolvedAt: later })).toBe('scheduled');
    expect(await loadFollowUp(storage)).toMatchObject({ eventId: 'e2', answer: null, dueAt: new Date(later.getTime() + FOLLOW_UP_DELAY_MS).toISOString() });
  });

  it('reports a failed store instead of throwing, because the crisis screen must never fail on it', async () => {
    const s = memoryStorage();
    s.failures.write = true;
    expect(await scheduleFollowUp(s.storage, { eventId: 'e1', resolvedAt: RESOLVED })).toBe('failed');
    s.failures.write = false;
    s.failures.read = true;
    expect(await scheduleFollowUp(s.storage, { eventId: 'e1', resolvedAt: RESOLVED })).toBe('failed');
  });
});

describe('when the check is due', () => {
  const followUp: FollowUp = { eventId: 'e1', dueAt: DUE.toISOString(), notified: false, answer: null, answeredAt: null };

  it('is not due a millisecond early, is due on the dot, and stops being due once answered', () => {
    expect(followUpDue(followUp, new Date(DUE.getTime() - 1))).toBe(false);
    expect(followUpDue(followUp, DUE)).toBe(true);
    expect(followUpDue({ ...followUp, answer: 'better', answeredAt: DUE.toISOString() }, DUE)).toBe(false);
    expect(followUpDue(null, DUE)).toBe(false);
  });

  it('follows the demo clock: a week-long jump makes a check that was a day away due', async () => {
    const { storage } = memoryStorage();
    await scheduleFollowUp(storage, { eventId: 'e1', resolvedAt: deviceNow() });
    expect(followUpDue(await loadFollowUp(storage), deviceNow())).toBe(false);
    setDemoOffsetMs(7 * 86_400_000);
    expect(followUpDue(await loadFollowUp(storage), deviceNow())).toBe(true);
  });
});

describe('the next-day notification', () => {
  async function stored(overrides: Partial<FollowUp> = {}) {
    const s = memoryStorage({ 'crisis:follow-up': { eventId: 'e1', dueAt: DUE.toISOString(), notified: false, answer: null, answeredAt: null, ...overrides } });
    return s;
  }

  it('does nothing when nothing is scheduled or it was already answered', async () => {
    const a = adapter('granted');
    expect(await runDueFollowUp({ storage: memoryStorage().storage, notifications: a.notifications, now: () => DUE, text })).toBe('none');
    const answered = await stored({ answer: 'better', answeredAt: DUE.toISOString() });
    expect(await runDueFollowUp({ storage: answered.storage, notifications: a.notifications, now: () => DUE, text })).toBe('none');
    expect(a.shown).toEqual([]);
  });

  it('waits until the day has passed', async () => {
    const a = adapter('granted');
    const s = await stored();
    expect(await runDueFollowUp({ storage: s.storage, notifications: a.notifications, now: () => new Date(DUE.getTime() - 1), text })).toBe('not_due');
    expect(a.shown).toEqual([]);
  });

  it('shows once, with its tag, and never asks for permission', async () => {
    const a = adapter('granted');
    const s = await stored();
    expect(await runDueFollowUp({ storage: s.storage, notifications: a.notifications, now: () => DUE, text })).toBe('shown');
    expect(a.shown).toEqual([{ ...text, tag: FOLLOW_UP_TAG }]);
    expect(await runDueFollowUp({ storage: s.storage, notifications: a.notifications, now: () => new Date(DUE.getTime() + 1e6), text })).toBe('already');
    expect(a.shown).toHaveLength(1);
    expect(a.requestPermission).not.toHaveBeenCalled();
  });

  it('is in-app only, and still marked, when notifications are not allowed, without prompting', async () => {
    for (const permission of ['default', 'denied', 'unsupported'] as const) {
      const a = adapter(permission);
      const s = await stored();
      expect(await runDueFollowUp({ storage: s.storage, notifications: a.notifications, now: () => DUE, text }), permission).toBe('in_app_only');
      expect(a.shown).toEqual([]);
      expect(a.requestPermission).not.toHaveBeenCalled();
      expect((await loadFollowUp(s.storage))!.notified).toBe(true);
    }
  });

  for (const [lang, messages, banned] of [
    ['en', en, /\b(score|result|crisis|suicid\w*|risk|safe|help|doctor|clinic\w*|mental|depress\w*|anxi\w*)\b|\d/i],
    ['ar', ar, /(أزم|انتحار|خطر|طبيب|عياد|نفس|اكتئاب|قلق|نتيج|نتائج)|\d/],
  ] as const) {
    it(`carries nothing about a crisis or a person’s health in the ${lang} notification`, () => {
      for (const value of [messages.nextDay.notifyTitle, messages.nextDay.notifyBody]) {
        expect(value).not.toMatch(banned);
        expect(value).not.toMatch(/[{}]/);
      }
    });
  }
});

describe('answering', () => {
  it('keeps the answer and when it was given, on the phone only', async () => {
    const { storage } = memoryStorage();
    await scheduleFollowUp(storage, { eventId: 'e1', resolvedAt: RESOLVED });
    expect(await answerFollowUp(storage, 'worse', () => DUE)).toBe(true);
    expect(await loadFollowUp(storage)).toMatchObject({ answer: 'worse', answeredAt: DUE.toISOString() });
  });

  it('answers false with nothing scheduled or a store that will not write', async () => {
    expect(await answerFollowUp(memoryStorage().storage, 'better', () => DUE)).toBe(false);
    const s = memoryStorage();
    await scheduleFollowUp(s.storage, { eventId: 'e1', resolvedAt: RESOLVED });
    s.failures.write = true;
    expect(await answerFollowUp(s.storage, 'better', () => DUE)).toBe(false);
  });
});

describe('the next-day screen’s place in the app', () => {
  it('is a guarded screen, so a crisis block sends the person to the crisis screen first', () => {
    expect(GUARDED_ROUTES).toContain('/next-day');
    expect(isGuardedPath('/ar/next-day/')).toBe(true);
  });

  it('opens offline, and every offline screen is a page that exists', () => {
    expect(OFFLINE_SCREENS).toContain('next-day');
    for (const screen of OFFLINE_SCREENS as string[]) expect(existsSync(join(__dirname, '..', 'app', '[locale]', screen, 'page.tsx')), screen).toBe(true);
  });
});
