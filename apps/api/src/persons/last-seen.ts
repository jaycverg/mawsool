import { OPT_IN_IDLE_LIMIT_DAYS } from '@mawsool/rules';
import { and, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { schema, type Db } from '../db/client';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The UTC day of an instant, as the `YYYY-MM-DD` the `date` column holds. */
export function dayOf(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * Records that the person's device reached the server today (`now` is the wall clock, never the demo clock). The write is
 * one guarded update that changes a row only when its day is older, so a person who calls many times a day writes once, and
 * two calls at the same instant cannot move the date backwards. Returns whether the date moved; callers ignore it.
 */
export async function touchLastSeen(db: Db, personId: string, now: Date): Promise<boolean> {
  const today = dayOf(now);
  const moved = await db
    .update(schema.persons)
    .set({ lastSeenOn: today })
    .where(and(eq(schema.persons.id, personId), or(isNull(schema.persons.lastSeenOn), sql`${schema.persons.lastSeenOn} < ${today}`)))
    .returning({ id: schema.persons.id });
  return moved.length > 0;
}

/**
 * Turns off the equity and statistics opt-ins (and deletes the equity buckets) of every person whose device has not reached
 * the server for `OPT_IN_IDLE_LIMIT_DAYS` days, counted on the wall clock. A person who cleared the browser's site data has no
 * device left to turn the choices off, so without this their totals would keep counting. A person with no date (a seeded one,
 * who has no device) is left alone. Returns how many people were changed.
 */
export async function clearIdleOptIns(db: Db, now: Date): Promise<number> {
  const cutoff = dayOf(new Date(now.getTime() - OPT_IN_IDLE_LIMIT_DAYS * DAY_MS));
  const cleared = await db
    .update(schema.persons)
    .set({ equityOptIn: false, outcomeStatsOptIn: false, ageBand: null, gender: null, language: null, region: null })
    .where(and(lte(schema.persons.lastSeenOn, cutoff), or(eq(schema.persons.equityOptIn, true), eq(schema.persons.outcomeStatsOptIn, true))))
    .returning({ id: schema.persons.id });
  return cleared.length;
}
