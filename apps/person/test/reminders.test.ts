import type { Screening } from '@mawsool/types';
import type { NotificationAdapter, NotificationPermissionState } from '@mawsool/ui';
import { setDemoOffsetMs } from '@mawsool/ui';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deviceNow } from '../lib/clock';
import {
  REMINDER_TAG,
  enableReminders,
  loadReminders,
  parsePhone,
  reminderDue,
  reminderDueAt,
  removeReminderNumber,
  runDueReminder,
  saveReminderNumber,
  setReminderInterval,
  turnOffReminders,
  type ReminderSettings,
} from '../lib/reminders';
import { forgetRegistration } from '../lib/server';
import ar from '../messages/ar.json';
import en from '../messages/en.json';
import { memoryStorage } from './helpers/memory';

const DAY = 86_400_000;
const START = '2026-11-01T08:00:00+04:00';
const AT = (days: number) => new Date(Date.parse(START) + days * DAY);
const SETTINGS: ReminderSettings = { intervalWeeks: 4, since: START, notifiedFor: null, phone: null };
const NUMBER = '+971501234567';

function checkIn(takenAt: string, complete = true): Screening {
  return { id: takenAt, instrument: 'gad7', answers: complete ? [0, 0, 0, 0, 0, 0, 0] : [0, 0], total: 0, band: complete ? 'minimal' : null, item9Flag: false, takenAt } as Screening;
}

function adapter(permission: NotificationPermissionState, options: { requestResult?: NotificationPermissionState; showFails?: boolean } = {}) {
  const shown: { title: string; body?: string; tag?: string }[] = [];
  let current = permission;
  const notifications: NotificationAdapter = {
    permission: () => current,
    requestPermission: async () => (current = options.requestResult ?? 'granted'),
    show: async (notification) => {
      if (options.showFails) throw new Error('the browser refused');
      shown.push(notification);
    },
  };
  return { notifications, shown };
}

const text = { title: en.reminder.title, body: en.reminder.body };

afterEach(() => setDemoOffsetMs(0));

describe('the reminder text carries no clinical content', () => {
  // Words that would tell a bystander reading a lock screen something about a person's health or care.
  const CLINICAL_EN = /\b(score|scores|result|results|band|phq|gad|who-5|depress\w*|anxi\w*|mood|crisis|suicid\w*|risk|therap\w*|treat\w*|clinic\w*|doctor|diagnos\w*|referral|ticket|service|symptom\w*|mental)\b|\d/i;
  const CLINICAL_AR = /(نتيج|نتائج|درج|اكتئاب|قلق|مزاج|أزم|انتحار|خطر|علاج|عياد|طبيب|تشخيص|إحالة|تذكرة|خدمة|أعراض|نفس|PHQ|GAD|WHO)|\d/i;

  for (const [lang, messages, banned] of [
    ['en', en, CLINICAL_EN],
    ['ar', ar, CLINICAL_AR],
  ] as const) {
    it(`holds none of the banned words or any number in the ${lang} reminder title, body and button`, () => {
      expect(Object.keys(messages.reminder).sort()).toEqual(['action', 'body', 'title']);
      for (const [key, value] of Object.entries(messages.reminder)) {
        expect(value, `reminder.${key}`).not.toMatch(banned);
        expect(value, `reminder.${key} has a placeholder`).not.toMatch(/[{}]/);
      }
    });
  }

  it('catches clinical wording, so the check above is not vacuous', () => {
    for (const bad of ['Your PHQ-9 score is high', 'Time to check your depression', 'Your clinic referral', 'Your total is 12']) expect(bad).toMatch(CLINICAL_EN);
    for (const bad of ['نتيجة الفحص', 'علاج الاكتئاب', 'عيادتك', 'درجتك 12']) expect(bad).toMatch(CLINICAL_AR);
  });

  it('hands the notification adapter exactly the title and body of the message file in each language, and a neutral tag, even with a severe result on the phone', async () => {
    const screenings = [{ ...checkIn('2026-11-02T08:00:00+04:00'), total: 21, band: 'severe' }] as Screening[];
    for (const messages of [en, ar]) {
      const { notifications, shown } = adapter('granted');
      const { storage } = memoryStorage({ reminders: SETTINGS });
      await runDueReminder({ storage, notifications, screenings, now: () => AT(60), text: { title: messages.reminder.title, body: messages.reminder.body } });
      expect(shown).toEqual([{ title: messages.reminder.title, body: messages.reminder.body, tag: REMINDER_TAG }]);
    }
    expect(REMINDER_TAG).toBe('check-in-reminder');
  });
});

describe('when a reminder is due', () => {
  it('is off until the person turns it on', async () => {
    expect(await loadReminders(memoryStorage().storage)).toBeNull();
    const { notifications, shown } = adapter('granted');
    expect(await runDueReminder({ storage: memoryStorage().storage, notifications, screenings: [], now: () => AT(400), text })).toBe('off');
    expect(shown).toEqual([]);
  });

  it('counts one interval from the day reminders were turned on, for 2 and for 4 weeks, to the instant', () => {
    expect(reminderDueAt({ ...SETTINGS, intervalWeeks: 2 }, []).toISOString()).toBe(AT(14).toISOString());
    expect(reminderDueAt({ ...SETTINGS, intervalWeeks: 4 }, []).toISOString()).toBe(AT(28).toISOString());
    expect(reminderDue(SETTINGS, [], new Date(AT(28).getTime() - 1))).toBe(false);
    expect(reminderDue(SETTINGS, [], AT(28))).toBe(true);
  });

  it('counts from the latest finished check-in when that is later, and ignores one left half done', () => {
    const done = checkIn(AT(10).toISOString());
    expect(reminderDueAt(SETTINGS, [done]).toISOString()).toBe(AT(38).toISOString());
    expect(reminderDueAt(SETTINGS, [done, checkIn(AT(20).toISOString(), false)]).toISOString()).toBe(AT(38).toISOString());
    expect(reminderDueAt(SETTINGS, [checkIn(AT(-30).toISOString())]).toISOString()).toBe(AT(28).toISOString());
  });

  it('does not show before it is due', async () => {
    const { notifications, shown } = adapter('granted');
    const outcome = await runDueReminder({ storage: memoryStorage({ reminders: SETTINGS }).storage, notifications, screenings: [], now: () => AT(27), text });
    expect(outcome).toBe('not_due');
    expect(shown).toEqual([]);
  });

  it('shows one local notification once the interval has passed, and only once for that due time', async () => {
    const { notifications, shown } = adapter('granted');
    const { storage } = memoryStorage({ reminders: SETTINGS });
    const deps = { storage, notifications, screenings: [], now: () => AT(29), text };
    expect(await runDueReminder(deps)).toBe('shown');
    expect(await runDueReminder(deps)).toBe('already');
    expect(await runDueReminder({ ...deps, now: () => AT(33) })).toBe('already');
    expect(shown).toHaveLength(1);
    expect((await loadReminders(storage))?.notifiedFor).toBe(AT(28).toISOString());
  });

  it('notifies again for the next due time after a check-in', async () => {
    const { notifications, shown } = adapter('granted');
    const { storage } = memoryStorage({ reminders: SETTINGS });
    await runDueReminder({ storage, notifications, screenings: [], now: () => AT(29), text });
    const later = [checkIn(AT(30).toISOString())];
    expect(await runDueReminder({ storage, notifications, screenings: later, now: () => AT(40), text })).toBe('not_due');
    expect(await runDueReminder({ storage, notifications, screenings: later, now: () => AT(58), text })).toBe('shown');
    expect(shown).toHaveLength(2);
  });

  it('shows nothing when notifications are not allowed, and says so, so the home screen card is the only reminder', async () => {
    for (const permission of ['denied', 'default', 'unsupported'] as const) {
      const { notifications, shown } = adapter(permission);
      const { storage } = memoryStorage({ reminders: SETTINGS });
      expect(await runDueReminder({ storage, notifications, screenings: [], now: () => AT(29), text })).toBe('in_app_only');
      expect(shown).toEqual([]);
    }
  });

  it('tries again on the next open when the browser refuses the notification, instead of marking it shown', async () => {
    const { storage } = memoryStorage({ reminders: SETTINGS });
    const failing = adapter('granted', { showFails: true });
    await expect(runDueReminder({ storage, notifications: failing.notifications, screenings: [], now: () => AT(29), text })).rejects.toThrow('refused');
    expect((await loadReminders(storage))?.notifiedFor).toBeNull();
    const working = adapter('granted');
    expect(await runDueReminder({ storage, notifications: working.notifications, screenings: [], now: () => AT(29), text })).toBe('shown');
  });

  it('runs on the care clock: the demo clock moving four weeks makes the reminder due', async () => {
    const { notifications, shown } = adapter('granted');
    const now = () => deviceNow();
    const turnedOn = { ...SETTINGS, since: deviceNow().toISOString() };
    const { storage } = memoryStorage({ reminders: turnedOn });
    expect(await runDueReminder({ storage, notifications, screenings: [], now, text })).toBe('not_due');
    setDemoOffsetMs(4 * 7 * DAY);
    expect(await runDueReminder({ storage, notifications, screenings: [], now, text })).toBe('shown');
    expect(shown).toHaveLength(1);
  });
});

describe('turning reminders on', () => {
  it('asks for permission when it has not been decided, and saves the settings with the interval at 4 weeks', async () => {
    const { notifications } = adapter('default', { requestResult: 'granted' });
    const { storage } = memoryStorage();
    expect(await enableReminders({ storage, notifications, now: () => AT(0) })).toBe('granted');
    expect(await loadReminders(storage)).toEqual({ intervalWeeks: 4, since: AT(0).toISOString(), notifiedFor: null, phone: null });
  });

  it('keeps reminders on, for the home screen card, when permission is refused', async () => {
    const { notifications } = adapter('default', { requestResult: 'denied' });
    const { storage } = memoryStorage();
    expect(await enableReminders({ storage, notifications, now: () => AT(0) })).toBe('denied');
    expect(await loadReminders(storage)).not.toBeNull();
  });

  it('does not ask again when permission is already decided', async () => {
    const request = vi.fn();
    const notifications = { permission: () => 'denied' as const, requestPermission: request, show: async () => undefined };
    await enableReminders({ storage: memoryStorage().storage, notifications, now: () => AT(0) });
    expect(request).not.toHaveBeenCalled();
  });

  it('reads a damaged record as off', async () => {
    expect(await loadReminders(memoryStorage({ reminders: { intervalWeeks: 3 } }).storage)).toBeNull();
  });
});

describe('the optional number for text reminders', () => {
  function setup(reply: 'ok' | 'offline' | 'rejected' = 'ok', initial: ReminderSettings = SETTINGS) {
    const store = memoryStorage({ reminders: initial, screenings: [] });
    forgetRegistration(store.storage);
    const calls: { method: string; path: string; body: unknown }[] = [];
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === '/persons') return new Response('{}', { status: 201 });
      calls.push({ method: init?.method ?? 'GET', path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (reply === 'offline') throw new TypeError('network down');
      return new Response(JSON.stringify({ stored: true, intervalWeeks: 4 }), { status: reply === 'rejected' ? 400 : 200 });
    }) as unknown as typeof fetch;
    const server = { storage: store.storage, fetch: fetchFn, apiUrl: 'http://api.test', locale: 'en' as const, random: globalThis.crypto };
    return { store, calls, server, deps: { server, now: () => AT(0) } };
  }

  it('reads international numbers from what people type and rejects the rest', () => {
    expect(parsePhone('+971 50 123 4567')).toBe(NUMBER);
    expect(parsePhone('00971-50-123-4567')).toBe(NUMBER);
    expect(parsePhone('(+971) 50.123.4567')).toBe(NUMBER);
    for (const bad of ['', '0501234567', '+0123456789', '+97150', '+971501234567890123', 'phone', '+971 50 abc 4567']) expect(parsePhone(bad), bad).toBeNull();
  });

  it('sends the number only after the person gives it, keeps it in the reminder record and out of every check-in', async () => {
    const { store, calls, deps } = setup();
    expect(await saveReminderNumber(deps, SETTINGS, '050 123 4567')).toBe('invalid');
    expect(calls).toEqual([]);
    expect(await saveReminderNumber(deps, SETTINGS, '+971 50 123 4567')).toBe('saved');
    expect(calls).toEqual([{ method: 'PUT', path: '/me/reminder-phone', body: { phone: NUMBER, intervalWeeks: 4 } }]);
    expect((await loadReminders(store.storage))?.phone).toBe(NUMBER);
    expect(await store.storage.keys()).toContain('server:footprint');
    expect(JSON.stringify(await store.storage.get('screenings'))).not.toContain('971');
  });

  it('keeps nothing on the phone when the server does not take the number', async () => {
    for (const reply of ['offline', 'rejected'] as const) {
      const { store, deps } = setup(reply);
      expect(await saveReminderNumber(deps, SETTINGS, NUMBER)).toBe('failed');
      expect((await loadReminders(store.storage))?.phone).toBeNull();
    }
  });

  it('removes the server row before the phone forgets the number, and keeps the number when the server cannot be reached', async () => {
    const held = { ...SETTINGS, phone: NUMBER };
    const ok = setup('ok', held);
    expect(await removeReminderNumber(ok.deps, held)).toBe('saved');
    expect(ok.calls).toEqual([{ method: 'DELETE', path: '/me/reminder-phone', body: undefined }]);
    expect((await loadReminders(ok.store.storage))?.phone).toBeNull();

    const down = setup('offline', held);
    expect(await removeReminderNumber(down.deps, held)).toBe('failed');
    expect((await loadReminders(down.store.storage))?.phone).toBe(NUMBER);
  });

  it('asks nothing of the network to remove a number that was never given', async () => {
    const { calls, deps } = setup();
    expect(await removeReminderNumber(deps, SETTINGS)).toBe('saved');
    expect(calls).toEqual([]);
  });

  it('turning reminders off deletes the server row first, and only then the phone record', async () => {
    const held = { ...SETTINGS, phone: NUMBER };
    const { store, calls, deps } = setup('ok', held);
    expect(await turnOffReminders(deps, held)).toBe('off');
    expect(calls).toEqual([{ method: 'DELETE', path: '/me/reminder-phone', body: undefined }]);
    expect(await loadReminders(store.storage)).toBeNull();
    expect(await store.storage.keys()).not.toContain('reminders');
  });

  it('stays on, with the number, when the server cannot be reached to delete it', async () => {
    const held = { ...SETTINGS, phone: NUMBER };
    const { store, deps } = setup('offline', held);
    expect(await turnOffReminders(deps, held)).toBe('blocked');
    expect((await loadReminders(store.storage))?.phone).toBe(NUMBER);
  });

  it('turns off with no network at all when no number is held', async () => {
    const { store, calls, deps } = setup('offline');
    expect(await turnOffReminders(deps, SETTINGS)).toBe('off');
    expect(calls).toEqual([]);
    expect(await loadReminders(store.storage)).toBeNull();
  });

  it('tells the server the new interval when a number is held, and changes nothing if it cannot', async () => {
    const held = { ...SETTINGS, phone: NUMBER };
    const ok = setup('ok', held);
    expect(await setReminderInterval(ok.deps, held, 2)).toBe('saved');
    expect(ok.calls).toEqual([{ method: 'PUT', path: '/me/reminder-phone', body: { phone: NUMBER, intervalWeeks: 2 } }]);
    expect((await loadReminders(ok.store.storage))?.intervalWeeks).toBe(2);

    const down = setup('offline', held);
    expect(await setReminderInterval(down.deps, held, 2)).toBe('failed');
    expect((await loadReminders(down.store.storage))?.intervalWeeks).toBe(4);
  });

  it('changes the interval with no network when no number is held', async () => {
    const { store, calls, deps } = setup('offline');
    expect(await setReminderInterval(deps, SETTINGS, 2)).toBe('saved');
    expect(calls).toEqual([]);
    expect((await loadReminders(store.storage))?.intervalWeeks).toBe(2);
  });
});
