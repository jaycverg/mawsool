import { and, gt, isNull, sql } from 'drizzle-orm';
import type { Cipher } from '../crypto';
import { schema, type Db } from '../db/client';
import { bundleContext } from '../tickets/service';
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

/**
 * The sign-ins in the database that are still good at `now`, to be handed back to `runSeed` as `keep`: sessions not yet
 * expired, and links neither spent nor expired. `now` is the security (wall) clock, the one these windows run on. Expired and
 * spent rows are dropped, so a public guest sign-in that makes a session on every press cannot grow what a reset re-inserts.
 */
export async function readStaffAccess(db: Db, now: Date): Promise<KeptStaffAccess> {
  return {
    sessions: await db.select().from(schema.staffSessions).where(gt(schema.staffSessions.expiresAt, now)),
    magicLinks: await db
      .select()
      .from(schema.staffMagicLinks)
      .where(and(isNull(schema.staffMagicLinks.usedAt), gt(schema.staffMagicLinks.expiresAt, now))),
  };
}

/**
 * Replaces the whole database content with the deterministic seed, in one transaction. Existing rows in every
 * table are removed first, so running it twice leaves exactly the same data as running it once.
 *
 * `cipher` is the API's own bundle cipher: the seeded tickets that share their repeat totals get a bundle stored the way the
 * real flow stores it, as ciphertext bound to its ticket, so the same key must open it. The ciphertext differs on every run
 * (a random IV); the plain content is what is deterministic.
 *
 * `keep` puts staff sessions and unspent sign-in links back after the reload (the seed's staff keep their ids, so they
 * still point at a user); a demo reset passes the ones that existed, so the admin who pressed the button is not signed out.
 */
export async function runSeed(db: Db, cipher: Cipher, anchor: Date = SEED_ANCHOR, keep?: KeptStaffAccess): Promise<SeedData> {
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
    await insertChunked(kept.sessions, (chunk) => tx.insert(schema.staffSessions).values(chunk));
    await insertChunked(kept.magicLinks, (chunk) => tx.insert(schema.staffMagicLinks).values(chunk));
    await insertChunked(data.persons, (chunk) => tx.insert(schema.persons).values(chunk));
    await insertChunked(data.tickets, (chunk) => tx.insert(schema.tickets).values(chunk));
    await insertChunked(data.ticketEvents, (chunk) => tx.insert(schema.ticketEvents).values(chunk));
    await insertChunked(data.consents, (chunk) => tx.insert(schema.consents).values(chunk));
    await insertChunked(data.sharedBundles, (chunk) =>
      tx.insert(schema.sharedBundles).values(
        chunk.map(({ content, ...bundle }) => ({ ...bundle, contentCiphertext: cipher.encrypt(JSON.stringify(content), bundleContext(bundle.ticketId)) })),
      ),
    );
    await insertChunked(data.crisisEvents, (chunk) => tx.insert(schema.crisisEvents).values(chunk));
    await insertChunked(data.inboundInvites, (chunk) => tx.insert(schema.inboundInvites).values(chunk));
  });
  return data;
}
