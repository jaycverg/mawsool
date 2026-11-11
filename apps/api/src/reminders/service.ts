import type { ReminderPhoneRequest } from '@mawsool/types';
import { eq } from 'drizzle-orm';
import type { Clock } from '../clock';
import type { Cipher } from '../crypto';
import type { Notifier } from '../notifier';
import { schema, type Db } from '../db/client';

export interface ReminderDeps {
  db: Db;
  cipher: Cipher;
  clock: Clock;
}

export interface ReminderSampleDeps extends ReminderDeps {
  notifier: Notifier;
}

/**
 * Hands a sample text reminder for the person's own stored number to the notifier, which is a mock: nothing is sent. It is
 * the person's own request, never a schedule, so it changes no reminder rule. The number is decrypted only to be given to the
 * notifier and goes nowhere else; the text is in the person's language (English when it is not one of ours). `none` when the person
 * holds no number, `failed` when the notifier could not deliver it.
 */
export async function sendReminderSample(deps: ReminderSampleDeps, personId: string): Promise<'sample' | 'none' | 'failed'> {
  const [row] = await deps.db
    .select({ phoneCiphertext: schema.reminderPhones.phoneCiphertext, locale: schema.persons.locale })
    .from(schema.reminderPhones)
    .innerJoin(schema.persons, eq(schema.persons.id, schema.reminderPhones.personId))
    .where(eq(schema.reminderPhones.personId, personId))
    .limit(1);
  if (!row) return 'none';
  try {
    await deps.notifier.send({ template: 'reminder_text', locale: row.locale, to: deps.cipher.decrypt(row.phoneCiphertext, reminderPhoneContext(personId)) });
    return 'sample';
  } catch {
    return 'failed';
  }
}

/** What a stored number is bound to: the person it belongs to. A ciphertext copied onto another person's row does not decrypt. */
export function reminderPhoneContext(personId: string): string {
  return `reminder-phone:${personId}`;
}

/**
 * Stores the person's number for text reminders, replacing the one they gave before. Only the ciphertext is written,
 * and nothing here logs the number. The row is the person's alone: it joins no ticket, bundle or screening.
 */
export async function saveReminderPhone(deps: ReminderDeps, personId: string, request: ReminderPhoneRequest): Promise<void> {
  const now = deps.clock.now();
  const phoneCiphertext = deps.cipher.encrypt(request.phone, reminderPhoneContext(personId));
  await deps.db
    .insert(schema.reminderPhones)
    .values({ personId, intervalWeeks: request.intervalWeeks, phoneCiphertext, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: schema.reminderPhones.personId, set: { intervalWeeks: request.intervalWeeks, phoneCiphertext, updatedAt: now } });
}

/** Deletes the person's number. Returns whether there was one. Used when reminders are turned off or the number is removed, and by "Delete everything". */
export async function removeReminderPhone(db: Pick<Db, 'delete'>, personId: string): Promise<boolean> {
  const gone = await db.delete(schema.reminderPhones).where(eq(schema.reminderPhones.personId, personId)).returning({ personId: schema.reminderPhones.personId });
  return gone.length > 0;
}
