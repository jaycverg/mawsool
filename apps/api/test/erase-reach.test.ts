import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getTableName, is } from 'drizzle-orm';
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';

/**
 * Every table with a link to a person, and what "Delete everything" does to it. A table added with a person link must be
 * listed here, with the test that shows its raw rows after the erase: the wipe on the phone destroys the only secret that
 * can ask the server to delete anything, so a row nobody erased can never be removed later, and nothing else would fail.
 */
const REVIEWED: Record<string, { fate: 'deleted' | 'kept'; why: string; proof: string }> = {
  persons: { fate: 'kept', why: 'holds only the hash of the device secret; the equity buckets are cleared', proof: 'consent.test.ts' },
  tickets: { fate: 'kept', why: 'a ticket and its events stay as pseudonymous timings with no data', proof: 'consent.test.ts' },
  consents: { fate: 'kept', why: 'the append-only ledger keeps the revocation', proof: 'consent.test.ts' },
  summary_logs: { fate: 'deleted', why: 'logged summaries are health text', proof: 'revoke-reach.test.ts' },
  inbound_invites: { fate: 'deleted', why: 'ties a person to a positive screen, a front door and a time', proof: 'inbound.test.ts' },
  reminder_phones: { fate: 'deleted', why: 'the optional number for text reminders', proof: 'reminders.test.ts' },
};

/** The tables, by SQL name, that hold a foreign key to `persons`. */
function personLinked(): string[] {
  const persons = getTableName(schema.persons);
  const linked = new Set<string>();
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    const config = getTableConfig(value);
    if (config.name === persons) continue;
    if (config.foreignKeys.some((fk) => getTableName(fk.reference().foreignTable) === persons)) linked.add(config.name);
  }
  linked.add(persons);
  return [...linked].sort();
}

describe('every table that holds a person is reached by Delete everything', () => {
  it('has a reviewed fate and a proof for each person-linked table, and no entry for one that is gone', () => {
    expect(personLinked()).toEqual(Object.keys(REVIEWED).sort());
  });

  it('names a test file that exists and mentions the table', () => {
    for (const [table, { proof }] of Object.entries(REVIEWED)) {
      const file = join(import.meta.dirname, proof);
      expect(existsSync(file), proof).toBe(true);
      const accessor = Object.entries(schema).find(([, value]) => is(value, PgTable) && getTableName(value) === table)![0];
      expect(readFileSync(file, 'utf8'), `${proof} should mention ${table}`).toMatch(new RegExp(`${accessor}|${table}`));
    }
  });
});
