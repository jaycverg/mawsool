import { isCompleteScreening } from '@mawsool/rules';
import { PhoneNumberSchema, ReminderIntervalSchema, type PhoneNumber, type ReminderInterval, type Screening } from '@mawsool/types';
import type { NotificationAdapter, StorageAdapter } from '@mawsool/ui';
import { z } from 'zod';
import type { Now } from './clock';
import { KEYS } from './keys';
import { callServer, markServerFootprint, type ServerDeps } from './server';

const WEEK_MS = 7 * 86_400_000;

/** The interval offered first when reminders are turned on. */
export const DEFAULT_REMINDER_INTERVAL: ReminderInterval = 4;

/** The tag every reminder notification carries, so a newer one replaces an older one instead of stacking. */
export const REMINDER_TAG = 'check-in-reminder';

/**
 * The person's reminder settings, kept on the phone under their own key and never inside a check-in. There is no
 * stored "off": turning reminders off removes the whole record. `since` is when they were turned on, `notifiedFor`
 * the due time the last notification was shown for (so each due time notifies once), and `phone` the optional number
 * for text reminders, which the server holds an encrypted copy of for as long as it is here. `serverMayHoldPhone` is written
 * before a number is sent and cleared only after the server confirms it deleted it, so a number whose upload reply was lost,
 * or whose local note failed, is still deleted when the person removes it or turns reminders off.
 */
export const ReminderSettingsSchema = z.object({
  intervalWeeks: ReminderIntervalSchema,
  since: z.iso.datetime({ offset: true }),
  notifiedFor: z.iso.datetime({ offset: true }).nullable(),
  phone: PhoneNumberSchema.nullable(),
  serverMayHoldPhone: z.boolean().default(false),
});
export type ReminderSettings = z.infer<typeof ReminderSettingsSchema>;

/** The reminder settings, or null while reminders are off (or the record cannot be read). */
export async function loadReminders(storage: StorageAdapter): Promise<ReminderSettings | null> {
  const parsed = ReminderSettingsSchema.safeParse(await storage.get<unknown>(KEYS.reminders));
  return parsed.success ? parsed.data : null;
}

export function saveReminders(storage: StorageAdapter, settings: ReminderSettings): Promise<void> {
  return storage.set(KEYS.reminders, settings);
}

function clearReminders(storage: StorageAdapter): Promise<void> {
  return storage.remove(KEYS.reminders);
}

/**
 * When the next reminder is due: one interval after the later of the day reminders were turned on and the person's
 * latest finished check-in. Doing a check-in therefore pushes the next reminder out, and it is computed from the
 * phone's own records, so it needs no job and follows the demo clock.
 */
export function reminderDueAt(settings: ReminderSettings, screenings: readonly Screening[]): Date {
  const last = screenings.filter(isCompleteScreening).reduce((latest, screening) => Math.max(latest, Date.parse(screening.takenAt)), 0);
  return new Date(Math.max(Date.parse(settings.since), last) + settings.intervalWeeks * WEEK_MS);
}

/** True once the next reminder is due. It stays true until the person finishes a check-in. */
export function reminderDue(settings: ReminderSettings, screenings: readonly Screening[], now: Date): boolean {
  return now.getTime() >= reminderDueAt(settings, screenings).getTime();
}

/** The words of a reminder. They come from the message files, never from a score, a band or a service. */
export interface ReminderText {
  title: string;
  body: string;
}

/**
 * - `shown`: a local notification was shown.
 * - `in_app_only`: it is due, but notifications are not allowed here, so only the card on the home screen carries it.
 * - `already`: this due time was already notified.
 * - `not_due`, `off`: nothing to do.
 *
 * The result exists so a test can tell the cases apart, and so deleting the guard for `already` or `not_due` turns a test red; callers ignore it.
 */
export type ReminderRun = 'shown' | 'in_app_only' | 'already' | 'not_due' | 'off';

/**
 * Shows the reminder when it is due, once per due time. The web has no way to wake the page in the background, so this
 * runs when the app opens (and again when the demo clock moves); a reminder that fell due while the app was closed
 * shows the next time it is opened. It always passes the notification adapter the same words the home screen card shows.
 */
export async function runDueReminder(deps: { storage: StorageAdapter; notifications: NotificationAdapter; screenings: readonly Screening[]; now: Now; text: ReminderText }): Promise<ReminderRun> {
  const settings = await loadReminders(deps.storage);
  if (!settings) return 'off';
  const dueAt = reminderDueAt(settings, deps.screenings);
  if (deps.now().getTime() < dueAt.getTime()) return 'not_due';
  if (settings.notifiedFor === dueAt.toISOString()) return 'already';
  const allowed = deps.notifications.permission() === 'granted';
  if (allowed) await deps.notifications.show({ title: deps.text.title, body: deps.text.body, tag: REMINDER_TAG });
  await saveReminders(deps.storage, { ...settings, notifiedFor: dueAt.toISOString() });
  return allowed ? 'shown' : 'in_app_only';
}

/**
 * Turns reminders on (every 4 weeks to start), then asks the browser for permission to notify. The settings are saved first, so a
 * permission prompt that is never answered cannot keep reminders off. Returns the permission it ended with.
 */
export async function enableReminders(deps: { storage: StorageAdapter; notifications: NotificationAdapter; now: Now }): Promise<ReturnType<NotificationAdapter['permission']>> {
  await saveReminders(deps.storage, { intervalWeeks: DEFAULT_REMINDER_INTERVAL, since: deps.now().toISOString(), notifiedFor: null, phone: null, serverMayHoldPhone: false });
  return deps.notifications.permission() === 'default' ? deps.notifications.requestPermission() : deps.notifications.permission();
}

export type ReminderChange = 'saved' | 'failed' | 'invalid';

/**
 * Changes how often reminders come. If a number is held, the server's copy is told the new interval first, and nothing
 * changes on the phone if that fails, so the two never disagree about how often to text.
 */
export async function setReminderInterval(deps: { server: ServerDeps; now: Now }, settings: ReminderSettings, intervalWeeks: ReminderInterval): Promise<ReminderChange> {
  if (settings.phone !== null) {
    const done = await callServer(deps.server, 'PUT', '/me/reminder-phone', { phone: settings.phone, intervalWeeks });
    if (!done.ok) return 'failed';
  }
  try {
    await saveReminders(deps.server.storage, { ...settings, intervalWeeks });
  } catch {
    return 'failed';
  }
  return 'saved';
}

/** A number as typed, reduced to international form: spaces, dashes, dots and brackets dropped, a leading `00` read as `+`. Null if it is not a valid number. */
export function parsePhone(input: string): PhoneNumber | null {
  const compact = input.replace(/[\s\-.()]/g, '');
  const parsed = PhoneNumberSchema.safeParse(compact.startsWith('00') ? `+${compact.slice(2)}` : compact);
  return parsed.success ? parsed.data : null;
}

/**
 * Gives the server a number for text reminders, then keeps it on the phone. The phone writes the footprint mark and
 * `serverMayHoldPhone` first, so "Delete everything", removing the number and turning reminders off all reach the server even
 * if the reply is lost or the local save fails after the server stored it. The number itself is kept on the phone only once the server took it.
 */
export async function saveReminderNumber(deps: { server: ServerDeps; now: Now }, settings: ReminderSettings, input: string): Promise<ReminderChange> {
  const phone = parsePhone(input);
  if (!phone) return 'invalid';
  try {
    await markServerFootprint(deps.server.storage, deps.now);
    await saveReminders(deps.server.storage, { ...settings, serverMayHoldPhone: true });
    const done = await callServer(deps.server, 'PUT', '/me/reminder-phone', { phone, intervalWeeks: settings.intervalWeeks });
    if (!done.ok) return 'failed';
    await saveReminders(deps.server.storage, { ...settings, phone, serverMayHoldPhone: true });
  } catch {
    return 'failed';
  }
  return 'saved';
}

/** Whether the server may hold a number for this person: one the phone knows of, or one whose upload may have been stored without the phone hearing. */
function serverMayHold(settings: ReminderSettings): boolean {
  return settings.phone !== null || settings.serverMayHoldPhone;
}

/** Removes the number: the server's row first, then the phone's copy and the mark. Reminders stay on. */
export async function removeReminderNumber(deps: { server: ServerDeps }, settings: ReminderSettings): Promise<ReminderChange> {
  if (!serverMayHold(settings)) return 'saved';
  const done = await callServer(deps.server, 'DELETE', '/me/reminder-phone');
  if (!done.ok) return 'failed';
  try {
    await saveReminders(deps.server.storage, { ...settings, phone: null, serverMayHoldPhone: false });
  } catch {
    return 'failed';
  }
  return 'saved';
}

/**
 * Turns reminders off. If a number is held, or may be (`serverMayHoldPhone`), it must leave the server first, so the answer is
 * `blocked` when the server cannot be reached and reminders stay on. With no number nothing is asked of the network.
 */
export async function turnOffReminders(deps: { server: ServerDeps }, settings: ReminderSettings): Promise<'off' | 'blocked' | 'failed'> {
  if (serverMayHold(settings)) {
    const done = await callServer(deps.server, 'DELETE', '/me/reminder-phone');
    if (!done.ok) return 'blocked';
  }
  try {
    await clearReminders(deps.server.storage);
  } catch {
    return 'failed';
  }
  return 'off';
}
