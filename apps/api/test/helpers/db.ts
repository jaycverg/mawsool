import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { createCipher, type Cipher } from '../../src/crypto';
import { schema, type Db } from '../../src/db/client';
import { MIGRATIONS_FOLDER } from '../../src/db/migrate';
import { ALL_TABLE_NAMES } from '../../src/db/schema';
import { bundleContext } from '../../src/tickets/service';
import { TEST_ENCRYPTION_KEY } from './config';

export interface TestDb {
  db: Db;
  /** The cipher the test app uses, so a seed loaded with it is readable by that app. */
  cipher: Cipher;
  close(): Promise<void>;
}

/** An in-process Postgres with the real migrations applied. No Docker needed. */
export async function createTestDb(): Promise<TestDb> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db: db as unknown as Db, cipher: createCipher(TEST_ENCRYPTION_KEY), close: () => client.close() };
}

/**
 * Every row of every table, in a stable order, for comparing two databases. A bundle's content is stored as ciphertext with a
 * random IV, so two loads of the same seed never match byte for byte; with a `cipher` the content is decrypted first, so the
 * comparison is of what the bundle holds and a changed total or a bundle bound to the wrong ticket still shows.
 */
export async function dumpDatabase(db: Db, cipher?: Cipher): Promise<Record<string, unknown[]>> {
  const dump: Record<string, unknown[]> = {};
  for (const table of [...ALL_TABLE_NAMES].sort()) {
    const result = await db.execute(sql.raw(`SELECT * FROM ${table} ORDER BY 1, 2`));
    dump[table] = cipher && table === 'shared_bundles' ? (result.rows as Record<string, unknown>[]).map((row) => readable(row, cipher)) : result.rows;
  }
  return dump;
}

function readable(row: Record<string, unknown>, cipher: Cipher): Record<string, unknown> {
  const { content_ciphertext: sealed, ...rest } = row;
  return { ...rest, content: typeof sealed === 'string' ? cipher.decrypt(sealed, bundleContext(String(row.ticket_id))) : null };
}
