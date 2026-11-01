import { sql } from 'drizzle-orm';
import { schema, type Db } from '../db/client';
import { ALL_TABLE_NAMES } from '../db/schema';
import { SEED_ANCHOR } from './fixtures';
import { generateSeed, type SeedData } from './generate';

const CHUNK = 250;

async function insertChunked<T>(rows: T[], insert: (chunk: T[]) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK) await insert(rows.slice(i, i + CHUNK));
}

/** Staff sign-ins a reload keeps, so nobody who is signed in is signed out by it. */
export interface KeptStaffAccess {
  sessions: (typeof schema.staffSessions.$inferSelect)[];
  magicLinks: (typeof schema.staffMagicLinks.$inferSelect)[];
}

/** The sign-ins in the database now, to be handed back to `runSeed` as `keep`. */
export async function readStaffAccess(db: Db): Promise<KeptStaffAccess> {
  return { sessions: await db.select().from(schema.staffSessions), magicLinks: await db.select().from(schema.staffMagicLinks) };
}

/**
 * Replaces the whole database content with the deterministic seed, in one transaction. Existing rows in every
 * table are removed first, so running it twice leaves exactly the same data as running it once.
 *
 * `keep` puts staff sessions and unspent sign-in links back after the reload (the seed's staff keep their ids, so they
 * still point at a user); a demo reset passes the ones that existed, so the admin who pressed the button is not signed out.
 */
export async function runSeed(db: Db, anchor: Date = SEED_ANCHOR, keep?: KeptStaffAccess): Promise<SeedData> {
  const data = generateSeed(anchor);
  await db.transaction(async (tx) => {
    await tx.execute(sql.raw(`TRUNCATE TABLE ${ALL_TABLE_NAMES.join(', ')} RESTART IDENTITY CASCADE`));
    await tx.insert(schema.facilities).values(data.facilities);
    await tx.insert(schema.services).values(data.services);
    await tx.insert(schema.staffUsers).values(data.staffUsers);
    const staffIds = new Set(data.staffUsers.map((user) => user.id));
    const kept = {
      sessions: keep?.sessions.filter((session) => staffIds.has(session.staffUserId)) ?? [],
      magicLinks: keep?.magicLinks.filter((link) => staffIds.has(link.staffUserId)) ?? [],
    };
    if (kept.sessions.length > 0) await tx.insert(schema.staffSessions).values(kept.sessions);
    if (kept.magicLinks.length > 0) await tx.insert(schema.staffMagicLinks).values(kept.magicLinks);
    await insertChunked(data.persons, (chunk) => tx.insert(schema.persons).values(chunk));
    await insertChunked(data.tickets, (chunk) => tx.insert(schema.tickets).values(chunk));
    await insertChunked(data.ticketEvents, (chunk) => tx.insert(schema.ticketEvents).values(chunk));
    await insertChunked(data.crisisEvents, (chunk) => tx.insert(schema.crisisEvents).values(chunk));
    await insertChunked(data.inboundInvites, (chunk) => tx.insert(schema.inboundInvites).values(chunk));
  });
  return data;
}
