import type { NotificationAdapter, StorageAdapter } from '@mawsool/ui';
import { z } from 'zod';
import type { Now } from './clock';
import { KEYS } from './keys';

/** How long after a crisis is resolved the next-day check is due. */
export const FOLLOW_UP_DELAY_MS = 24 * 60 * 60 * 1000;

/** The tag of the notification, so a newer one replaces an older one instead of stacking. */
export const FOLLOW_UP_TAG = 'next-day-check';

export const FOLLOW_UP_ANSWERS = ['better', 'same', 'worse'] as const;
export const FollowUpAnswerSchema = z.enum(FOLLOW_UP_ANSWERS);
export type FollowUpAnswer = z.infer<typeof FollowUpAnswerSchema>;

/**
 * The next-day check after a crisis, kept on the phone under its own key. `dueAt` is a day after the person resolved the
 * crisis screen, on the care clock (the demo clock moves it); `notified` records that the notification was shown, so it
 * shows once; the answer is the person's alone and goes nowhere. Only `eventId` links it to the crisis record, and it holds
 * no score, no item answer and no person id.
 */
export const FollowUpSchema = z.object({
  eventId: z.string().min(1),
  dueAt: z.iso.datetime({ offset: true }),
  notified: z.boolean(),
  answer: FollowUpAnswerSchema.nullable(),
  answeredAt: z.iso.datetime({ offset: true }).nullable(),
});
export type FollowUp = z.infer<typeof FollowUpSchema>;

/** The follow-up, or null when none is scheduled (or the record cannot be read). */
export async function loadFollowUp(storage: StorageAdapter): Promise<FollowUp | null> {
  const parsed = FollowUpSchema.safeParse(await storage.get<unknown>(KEYS.followUp));
  return parsed.success ? parsed.data : null;
}

/**
 * Schedules the check for a crisis that was just resolved. The same crisis event keeps the schedule it has (so resolving
 * twice does not push it back or undo an answer); a newer crisis replaces an older one's. Never throws: the next-day check
 * is a courtesy, and nothing on the crisis path waits on it.
 */
export async function scheduleFollowUp(storage: StorageAdapter, input: { eventId: string; resolvedAt: Date }): Promise<'scheduled' | 'kept' | 'failed'> {
  try {
    const current = await loadFollowUp(storage);
    if (current?.eventId === input.eventId) return 'kept';
    const dueAt = new Date(input.resolvedAt.getTime() + FOLLOW_UP_DELAY_MS).toISOString();
    await storage.set(KEYS.followUp, { eventId: input.eventId, dueAt, notified: false, answer: null, answeredAt: null } satisfies FollowUp);
    return 'scheduled';
  } catch {
    return 'failed';
  }
}

/** True from the due time until the person answers. */
export function followUpDue(followUp: FollowUp | null, now: Date): followUp is FollowUp {
  return followUp !== null && followUp.answeredAt === null && now.getTime() >= Date.parse(followUp.dueAt);
}

export interface FollowUpText {
  title: string;
  body: string;
}

/**
 * - `shown`: a local notification was shown.
 * - `in_app_only`: it is due, but notifications are not allowed here, so only the home screen's card carries it.
 * - `already`: it was shown before. `not_due`: the day has not passed. `none`: nothing is scheduled, or it was answered.
 *
 * The result exists so a test can tell the cases apart, and so deleting a guard turns a test red; callers ignore it.
 */
export type FollowUpRun = 'shown' | 'in_app_only' | 'already' | 'not_due' | 'none';

/**
 * Shows the next-day notification once, when it is due. The web cannot wake the page in the background, so this runs when
 * a page opens and when the demo clock moves; a check that fell due while the app was closed shows the next time it opens.
 * It never asks for notification permission (a person who has just been through a crisis is not interrupted with a prompt):
 * without permission the home screen's card is the reminder.
 */
export async function runDueFollowUp(deps: { storage: StorageAdapter; notifications: NotificationAdapter; now: Now; text: FollowUpText }): Promise<FollowUpRun> {
  const followUp = await loadFollowUp(deps.storage);
  if (!followUp || followUp.answeredAt !== null) return 'none';
  if (!followUpDue(followUp, deps.now())) return 'not_due';
  if (followUp.notified) return 'already';
  const allowed = deps.notifications.permission() === 'granted';
  if (allowed) await deps.notifications.show({ title: deps.text.title, body: deps.text.body, tag: FOLLOW_UP_TAG });
  await deps.storage.set(KEYS.followUp, { ...followUp, notified: true } satisfies FollowUp);
  return allowed ? 'shown' : 'in_app_only';
}

/** Records how the person is. The answer stays on the phone. Returns false when it could not be kept. */
export async function answerFollowUp(storage: StorageAdapter, answer: FollowUpAnswer, now: Now): Promise<boolean> {
  try {
    const followUp = await loadFollowUp(storage);
    if (!followUp) return false;
    await storage.set(KEYS.followUp, { ...followUp, answer, answeredAt: now().toISOString() } satisfies FollowUp);
    return true;
  } catch {
    return false;
  }
}
