import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { CreateTicketRequest } from '@mawsool/types';
import { createCipher } from '../../src/crypto';
import { schema, type Db } from '../../src/db/client';
import { FACILITY_A_ID, FACILITY_B_ID } from '../../src/seed/fixtures';
import type { TestApp } from './app';
import { TEST_ENCRYPTION_KEY } from './config';

export const cipher = createCipher(TEST_ENCRYPTION_KEY);

export const FREE_TEXT = 'FREE-TEXT-MARKER-4471';
export const CONDITION = 'CONDITION-MARKER-9023';

export interface TestPerson {
  id: string;
  headers: { authorization: string };
}

/** A device that has registered through the real route. */
export async function registerPerson({ app }: Pick<TestApp, 'app'>): Promise<TestPerson> {
  const id = randomUUID();
  const secret = randomBytes(32).toString('base64url');
  const res = await app.inject({ method: 'POST', url: '/persons', payload: { id, secret, locale: 'en' } });
  if (res.statusCode !== 201) throw new Error(`register failed: ${res.statusCode}`);
  return { id, headers: { authorization: `Bearer ${id}.${secret}` } };
}

/** The first seeded service of a tier at a facility. */
export async function serviceAt(db: Db, facility: 'A' | 'B', tier: 'gp' | 'specialist' | 'tele' | 'community'): Promise<string> {
  const [row] = await db
    .select({ id: schema.services.id })
    .from(schema.services)
    .where(and(eq(schema.services.facilityId, facility === 'A' ? FACILITY_A_ID : FACILITY_B_ID), eq(schema.services.tier, tier)))
    .orderBy(schema.services.id)
    .limit(1);
  if (!row) throw new Error(`no ${tier} service at ${facility}`);
  return row.id;
}

export function ticketRequest(serviceId: string, overrides: Partial<CreateTicketRequest> = {}): CreateTicketRequest {
  return {
    clientRequestId: randomUUID(),
    serviceId,
    windowDays: 14,
    language: 'en',
    consents: ['ticket', 'scores', 'free_text'],
    content: {
      scores: [{ instrument: 'phq9', total: 12, band: 'moderate', takenAt: '2026-10-29T08:00:00+04:00' }],
      free_text: FREE_TEXT,
      conditions: [CONDITION],
      preferences: { language: 'ar' },
    },
    approvedSummary: null,
    summaryRequestId: null,
    ...overrides,
  };
}

export async function issue(ctx: Pick<TestApp, 'app'>, person: TestPerson, request: CreateTicketRequest) {
  const res = await ctx.app.inject({ method: 'POST', url: '/tickets', headers: person.headers, payload: request });
  if (res.statusCode !== 201) throw new Error(`issue failed: ${res.statusCode} ${res.body}`);
  return res.json().ticket as { id: string; shortCode: string; state: string; consents: { id: string; element: string }[] };
}

/** The raw ciphertext row, as the database holds it. */
export async function rawBundle(db: Db, ticketId: string) {
  const [row] = await db.select().from(schema.sharedBundles).where(eq(schema.sharedBundles.ticketId, ticketId));
  return row!;
}

/** The bundle content as the database holds it, decrypted with the key. */
export async function storedContent(db: Db, ticketId: string): Promise<Record<string, unknown> | null> {
  const row = await rawBundle(db, ticketId);
  return row.contentCiphertext === null ? null : (JSON.parse(cipher.decrypt(row.contentCiphertext, `bundle:${ticketId}`)) as Record<string, unknown>);
}

export async function eventStates(db: Db, ticketId: string) {
  const rows = await db.select().from(schema.ticketEvents).where(eq(schema.ticketEvents.ticketId, ticketId)).orderBy(schema.ticketEvents.seq);
  return rows.map((row) => ({ seq: row.seq, from: row.fromState, to: row.toState, actor: row.actor }));
}

export const ONE_DAY = 24 * 60 * 60 * 1000;
