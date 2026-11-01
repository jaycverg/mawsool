import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { schema, type Db } from '../../src/db/client';
import { MIGRATIONS_FOLDER } from '../../src/db/migrate';
import { ALL_TABLE_NAMES } from '../../src/db/schema';

export interface TestDb {
  db: Db;
  close(): Promise<void>;
}

/** An in-process Postgres with the real migrations applied. No Docker needed. */
export async function createTestDb(): Promise<TestDb> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db: db as unknown as Db, close: () => client.close() };
}

/** Every row of every table, in a stable order, for comparing two databases. */
export async function dumpDatabase(db: Db): Promise<Record<string, unknown[]>> {
  const dump: Record<string, unknown[]> = {};
  for (const table of [...ALL_TABLE_NAMES].sort()) {
    const result = await db.execute(sql.raw(`SELECT * FROM ${table} ORDER BY 1, 2`));
    dump[table] = result.rows;
  }
  return dump;
}
