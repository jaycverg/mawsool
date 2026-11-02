import type { Locale } from '@mawsool/types';
import { eq } from 'drizzle-orm';
import { schema, type Db } from './db/client';

/**
 * The text in the reader's language. A row keeps its English text and, where someone has written it, an Arabic version.
 * An Arabic reader gets the Arabic version when there is one and otherwise the English text as stored: nothing is ever
 * translated or made up here, so a gap shows as English instead of as invented Arabic.
 */
export function localized(english: string, arabic: string | null, locale: Locale): string {
  return locale === 'ar' && arabic !== null && arabic.trim() !== '' ? arabic : english;
}

/**
 * The language a person's own data is served in: the one the phone asked for (the page it is on), else the one it
 * registered with. A person the database does not hold is served English.
 */
export async function personLocale(db: Db, personId: string, requested: Locale | undefined): Promise<Locale> {
  if (requested) return requested;
  const [person] = await db.select({ locale: schema.persons.locale }).from(schema.persons).where(eq(schema.persons.id, personId)).limit(1);
  return person?.locale ?? 'en';
}
