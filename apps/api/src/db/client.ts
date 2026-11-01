import { drizzle } from 'drizzle-orm/node-postgres';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import pg from 'pg';
import * as schema from './schema';

/**
 * The database handle every module takes. Both the node-postgres driver (Compose Postgres) and PGlite
 * (in-process, used by tests) produce a subtype, so the same queries run against either.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = PgDatabase<any, typeof schema>;

export interface DbConnection {
  db: Db;
  close(): Promise<void>;
}

/** Connects to Postgres over TCP. */
export function connect(databaseUrl: string): DbConnection {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  return {
    db: drizzle(pool, { schema }),
    close: () => pool.end(),
  };
}

export { schema };
