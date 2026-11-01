import { sql } from 'drizzle-orm';
import { schema, type Db } from '../db/client';
import { ALL_TABLE_NAMES } from '../db/schema';
import { SEED_ANCHOR } from './fixtures';
import { generateSeed, type SeedData } from './generate';

const CHUNK = 250;

async function insertChunked<T>(rows: T[], insert: (chunk: T[]) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK) await insert(rows.slice(i, i + CHUNK));
}

/**
 * Replaces the whole database content with the deterministic seed, in one transaction. Existing rows in every
 * table are removed first, so running it twice leaves exactly the same data as running it once.
 */
export async function runSeed(db: Db, anchor: Date = SEED_ANCHOR): Promise<SeedData> {
  const data = generateSeed(anchor);
  await db.transaction(async (tx) => {
    await tx.execute(sql.raw(`TRUNCATE TABLE ${ALL_TABLE_NAMES.join(', ')} RESTART IDENTITY CASCADE`));
    await tx.insert(schema.facilities).values(data.facilities);
    await tx.insert(schema.services).values(data.services);
    await tx.insert(schema.staffUsers).values(data.staffUsers);
    await insertChunked(data.persons, (chunk) => tx.insert(schema.persons).values(chunk));
    await insertChunked(data.tickets, (chunk) => tx.insert(schema.tickets).values(chunk));
    await insertChunked(data.ticketEvents, (chunk) => tx.insert(schema.ticketEvents).values(chunk));
    await insertChunked(data.crisisEvents, (chunk) => tx.insert(schema.crisisEvents).values(chunk));
  });
  return data;
}
