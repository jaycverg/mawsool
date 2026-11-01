import { sql } from 'drizzle-orm';
import type { Db } from '../db/client';

export interface LanguageRate {
  language: string;
  tickets: number;
  loopClosed: number;
  /** Percentage, 0 to 100. */
  rate: number;
}

/**
 * Loop-closed rate per ticket language, from the event log. A ticket is loop closed when any of its events
 * reached `seen`, `remeasured` or `closed`, so a ticket that was `seen` and later withdrawn still counts.
 * Used to check the seed's planted gap; the dashboard metric queries are built on the same definition later.
 */
export async function loopClosedByLanguage(db: Db): Promise<LanguageRate[]> {
  type Row = { language: string; tickets: number; loop_closed: number };
  const result = await db.execute<Row>(sql`
    SELECT t.language::text AS language,
           count(*)::int AS tickets,
           (count(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM ticket_events e
              WHERE e.ticket_id = t.id AND e.to_state IN ('seen', 'remeasured', 'closed')
           )))::int AS loop_closed
    FROM tickets t
    GROUP BY t.language
    ORDER BY t.language
  `);
  return (result.rows as Row[]).map((row) => ({
    language: row.language,
    tickets: row.tickets,
    loopClosed: row.loop_closed,
    rate: (row.loop_closed / row.tickets) * 100,
  }));
}

export interface UrduGap {
  overallRate: number;
  urduRate: number;
  /** Overall rate minus the Urdu rate, in percentage points. */
  gapPoints: number;
}

/** The planted equity gap: how far the Urdu loop-closed rate sits below the overall rate. */
export async function urduGap(db: Db): Promise<UrduGap> {
  const rows = await loopClosedByLanguage(db);
  const tickets = rows.reduce((sum, row) => sum + row.tickets, 0);
  const closed = rows.reduce((sum, row) => sum + row.loopClosed, 0);
  const urdu = rows.find((row) => row.language === 'ur');
  if (!urdu) throw new Error('no Urdu-language tickets in the database');
  const overallRate = (closed / tickets) * 100;
  return { overallRate, urduRate: urdu.rate, gapPoints: overallRate - urdu.rate };
}
