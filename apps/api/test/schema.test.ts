import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import { FACILITY_A_ID } from '../src/seed/fixtures';
import { runSeed } from '../src/seed/run';
import { createTestDb, type TestDb } from './helpers/db';

const NOW = new Date('2026-11-01T08:00:00+04:00');

/** Drizzle wraps the driver error, so the constraint name is read from the cause chain. */
async function violation(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    let current: unknown = error;
    const parts: string[] = [];
    while (current instanceof Error) {
      parts.push(current.message);
      current = current.cause;
    }
    return parts.join(' | ');
  }
  return 'NO ERROR';
}

describe('database constraints', () => {
  let testDb: TestDb;
  let serviceId: string;
  let personId: string;

  beforeAll(async () => {
    testDb = await createTestDb();
    const data = await runSeed(testDb.db);
    serviceId = data.services.find((s) => s.tier === 'gp')!.id;
    personId = data.persons[0]!.id;
  });

  afterAll(async () => {
    await testDb.close();
  });

  const service = (overrides: Partial<typeof schema.services.$inferInsert>) => ({
    name: 'x',
    tier: 'gp' as const,
    modality: 'in_person' as const,
    languages: ['ar' as const],
    clinicianGenders: [],
    insuranceClasses: [],
    region: 'abu_dhabi_city' as const,
    indicativeWaitDays: 1,
    facilityId: FACILITY_A_ID,
    ...overrides,
  });

  it('requires a facility on every service except self-help, and none on self-help', async () => {
    expect(await violation(() => testDb.db.insert(schema.services).values(service({ facilityId: null })))).toMatch(/services_facility_unless_self_help/);
    expect(await violation(() => testDb.db.insert(schema.services).values(service({ tier: 'tele', modality: 'tele', facilityId: null })))).toMatch(/services_facility_unless_self_help/);
    expect(await violation(() => testDb.db.insert(schema.services).values(service({ tier: 'self_help', facilityId: FACILITY_A_ID })))).toMatch(/services_facility_unless_self_help/);
    expect(await violation(() => testDb.db.insert(schema.services).values(service({ tier: 'self_help', facilityId: null })))).toBe('NO ERROR');
  });

  it('refuses equity buckets for a person who did not opt in', async () => {
    const row = { id: randomUUID(), secretHash: 'h', locale: 'ar' as const, createdAt: NOW };
    expect(await violation(() => testDb.db.insert(schema.persons).values({ ...row, equityOptIn: false, ageBand: '25_34' }))).toMatch(/persons_buckets_only_when_opted_in/);
    expect(await violation(() => testDb.db.insert(schema.persons).values({ ...row, id: randomUUID(), equityOptIn: true, ageBand: '25_34' }))).toBe('NO ERROR');
  });

  it('requires a facility on clinicians and none on ops or admin', async () => {
    const base = { name: 'n', createdAt: NOW };
    expect(await violation(() => testDb.db.insert(schema.staffUsers).values({ ...base, email: 'a@x.test', role: 'clinician', facilityId: null }))).toMatch(/staff_users_clinician_has_facility/);
    expect(await violation(() => testDb.db.insert(schema.staffUsers).values({ ...base, email: 'b@x.test', role: 'ops', facilityId: FACILITY_A_ID }))).toMatch(/staff_users_clinician_has_facility/);
  });

  it('stores staff emails in lowercase only', async () => {
    expect(await violation(() => testDb.db.insert(schema.staffUsers).values({ name: 'n', createdAt: NOW, email: 'Upper@x.test', role: 'ops' }))).toMatch(/staff_users_email_lowercase/);
  });

  it('refuses a ticket on a self-help tier', async () => {
    const ticket = {
      shortCode: 'MW2222',
      personId,
      serviceId,
      state: 'issued' as const,
      language: 'ar' as const,
      deadlineAt: NOW,
      source: 'app' as const,
      createdAt: NOW,
    };
    expect(await violation(() => testDb.db.insert(schema.tickets).values({ ...ticket, tier: 'self_help' }))).toMatch(/tickets_not_self_help/);
  });

  it('refuses a duplicate (ticket, seq) event, so a racing writer loses', async () => {
    const [ticket] = await testDb.db.select({ id: schema.tickets.id }).from(schema.tickets).limit(1);
    const event = { ticketId: ticket!.id, seq: 1, toState: 'issued' as const, actor: 'system' as const, channel: 'x', at: NOW };
    expect(await violation(() => testDb.db.insert(schema.ticketEvents).values(event))).toMatch(/ticket_events_ticket_seq_unique/);
    expect(await violation(() => testDb.db.insert(schema.ticketEvents).values({ ...event, seq: 0 }))).toMatch(/ticket_events_seq_positive/);
  });

  it('refuses a duplicate client request id and a duplicate short code', async () => {
    const [existing] = await testDb.db.select().from(schema.tickets).limit(1);
    const clone = { ...existing!, id: randomUUID() };
    expect(await violation(() => testDb.db.insert(schema.tickets).values(clone))).toMatch(/tickets_short_code_unique/);
    const withRequest = { ...clone, shortCode: 'MW3333', clientRequestId: randomUUID() };
    expect(await violation(() => testDb.db.insert(schema.tickets).values(withRequest))).toBe('NO ERROR');
    expect(await violation(() => testDb.db.insert(schema.tickets).values({ ...withRequest, id: randomUUID(), shortCode: 'MW4444' }))).toMatch(/tickets_client_request_id_unique/);
  });

  it('keeps contact confirmed and contact time together on a crisis event', async () => {
    const base = { id: randomUUID(), trigger: 'phq9_item9' as const, shownAt: NOW, locale: 'ar' as const };
    expect(await violation(() => testDb.db.insert(schema.crisisEvents).values({ ...base, humanContactConfirmed: true }))).toMatch(/crisis_events_contact_pair/);
    expect(await violation(() => testDb.db.insert(schema.crisisEvents).values({ ...base, id: randomUUID(), contactAt: NOW }))).toMatch(/crisis_events_contact_pair/);
    expect(await violation(() => testDb.db.insert(schema.crisisEvents).values({ ...base, id: randomUUID(), humanContactConfirmed: true, contactAt: NOW, contactSource: 'phone_call' }))).toMatch(/crisis_events_contact_source/);
  });

  it('has no person id and no answers column on crisis events, in the real database', async () => {
    const result = await testDb.db.execute(
      sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'crisis_events'`,
    );
    const names = (result.rows as { column_name: string }[]).map((row) => row.column_name);
    expect(names.length).toBeGreaterThan(8);
    expect(names.filter((name) => /person|answer|item/.test(name))).toEqual([]);
  });

  it('never defaults a timestamp to the database clock', () => {
    const tables = [schema.persons, schema.tickets, schema.ticketEvents, schema.consents, schema.crisisEvents, schema.staffUsers, schema.staffSessions, schema.staffMagicLinks, schema.sharedBundles, schema.adverseEvents];
    for (const table of tables) {
      for (const [name, column] of Object.entries(table) as [string, { columnType?: string; hasDefault?: boolean }][]) {
        if (column?.columnType === 'PgTimestamp') expect(column.hasDefault, name).toBe(false);
      }
    }
  });
});
