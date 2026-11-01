import { notShared, redact, withoutElement } from '@mawsool/consent';
import { BundleContentSchema, type BundleContent, type ConsentElement, type ConsentRecord, type GrantConsentRequest, type StaffBundleView, type TicketState } from '@mawsool/types';
import { and, eq, isNull, or } from 'drizzle-orm';
import type { Clock } from '../clock';
import type { Cipher } from '../crypto';
import { schema, type Db } from '../db/client';
import { appendEvent, lastEvent, type Executor } from '../tickets/events';
import { bundleContext, summaryContext } from '../tickets/service';
import { TERMINAL_STATES } from '../tickets/transitions';

export interface ConsentDeps {
  db: Db;
  cipher: Cipher;
  clock: Clock;
}

type ConsentRow = typeof schema.consents.$inferSelect;

function record(row: ConsentRow): ConsentRecord {
  return { id: row.id, element: row.element, recipient: row.recipient, grantedAt: row.grantedAt.toISOString(), revokedAt: row.revokedAt?.toISOString() ?? null };
}

/** The elements of a ticket that are consented to right now. */
async function liveElements(executor: Executor, ticketId: string): Promise<ConsentElement[]> {
  const rows = await executor.select({ element: schema.consents.element }).from(schema.consents).where(and(eq(schema.consents.ticketId, ticketId), isNull(schema.consents.revokedAt)));
  return rows.map((row) => row.element);
}

function readContent(cipher: Cipher, ticketId: string, ciphertext: string | null): BundleContent {
  if (ciphertext === null) return {};
  return BundleContentSchema.parse(JSON.parse(cipher.decrypt(ciphertext, bundleContext(ticketId))));
}

export type RevokeResult =
  | { kind: 'revoked'; revoked: ConsentRecord[]; ticketState: TicketState }
  | { kind: 'not_found' };

class StateRace extends Error {}

/**
 * Revokes one consent, in one transaction. Revoking an optional element rewrites the bundle without it. Revoking the
 * required `ticket` element ends the whole share: every consent of the ticket is revoked, the bundle's content and
 * approved summary are emptied (`deleted_at` is set), the logged summaries of the ticket are deleted, and a ticket
 * that is not yet terminal moves to `withdrawn`. After a terminal state the data goes and the state stays. Revoking
 * something already revoked changes nothing and succeeds.
 */
export async function revokeConsent(deps: ConsentDeps, personId: string, consentId: string): Promise<RevokeResult> {
  const { db, cipher, clock } = deps;
  const [consent] = await db.select().from(schema.consents).where(and(eq(schema.consents.id, consentId), eq(schema.consents.personId, personId))).limit(1);
  if (!consent || consent.ticketId === null) return { kind: 'not_found' };
  const ticketId = consent.ticketId;
  const now = clock.now();

  if (consent.revokedAt !== null) {
    const last = await lastEvent(db, ticketId);
    return { kind: 'revoked', revoked: [], ticketState: last?.state ?? 'issued' };
  }

  return db.transaction(async (tx) => {
    const { revoked, state } = consent.element === 'ticket' ? await endShare(tx, personId, ticketId, now) : await dropElement(tx, cipher, consent, now);
    return { kind: 'revoked' as const, revoked: revoked.map(record), ticketState: state };
  });
}

interface Revoked {
  revoked: ConsentRow[];
  state: TicketState;
}

async function dropElement(tx: Executor, cipher: Cipher, consent: ConsentRow, now: Date): Promise<Revoked> {
  const ticketId = consent.ticketId!;
  const revoked = await tx.update(schema.consents).set({ revokedAt: now }).where(eq(schema.consents.id, consent.id)).returning();
  const [bundle] = await tx.select().from(schema.sharedBundles).where(eq(schema.sharedBundles.ticketId, ticketId)).for('update');
  if (bundle && bundle.contentCiphertext !== null) {
    const content = withoutElement(readContent(cipher, ticketId, bundle.contentCiphertext), consent.element);
    await tx.update(schema.sharedBundles).set({ contentCiphertext: cipher.encrypt(JSON.stringify(content), bundleContext(ticketId)) }).where(eq(schema.sharedBundles.id, bundle.id));
  }
  return { revoked, state: (await lastEvent(tx, ticketId))?.state ?? 'issued' };
}

/** Ends the whole share of a ticket. See `revokeConsent`. */
async function endShare(tx: Executor, personId: string, ticketId: string, now: Date): Promise<Revoked> {
  const revoked = await tx.update(schema.consents).set({ revokedAt: now }).where(and(eq(schema.consents.ticketId, ticketId), isNull(schema.consents.revokedAt))).returning();
  await tx
    .update(schema.sharedBundles)
    .set({ contentCiphertext: null, approvedSummaryCiphertext: null, deletedAt: now })
    .where(eq(schema.sharedBundles.ticketId, ticketId));
  const [ticket] = await tx.select({ requestId: schema.tickets.clientRequestId }).from(schema.tickets).where(eq(schema.tickets.id, ticketId)).limit(1);
  await tx
    .delete(schema.summaryLogs)
    .where(and(eq(schema.summaryLogs.personId, personId), or(eq(schema.summaryLogs.ticketId, ticketId), ticket?.requestId ? eq(schema.summaryLogs.requestId, ticket.requestId) : undefined)));

  const last = await lastEvent(tx, ticketId);
  if (!last || TERMINAL_STATES.includes(last.state)) return { revoked, state: last?.state ?? 'issued' };
  const moved = await appendEvent(tx, { ticketId, seq: last.seq + 1, from: last.state, to: 'withdrawn', actor: 'person', channel: 'app', reason: 'consent_revoked', at: now });
  if (!moved) throw new StateRace();
  return { revoked, state: 'withdrawn' };
}

export type GrantResult = { kind: 'granted'; consent: ConsentRecord } | { kind: 'not_found' } | { kind: 'gone' } | { kind: 'conflict' };

/** Adds one optional element to a live ticket after the fact: a ledger row, and the element's content in the bundle. */
export async function grantConsent(deps: ConsentDeps, personId: string, request: GrantConsentRequest): Promise<GrantResult> {
  const { db, cipher, clock } = deps;
  const [ticket] = await db.select().from(schema.tickets).where(and(eq(schema.tickets.id, request.ticketId), eq(schema.tickets.personId, personId))).limit(1);
  if (!ticket) return { kind: 'not_found' };
  const now = clock.now();
  return db.transaction(async (tx) => {
    const [bundle] = await tx.select().from(schema.sharedBundles).where(eq(schema.sharedBundles.ticketId, ticket.id)).for('update');
    const live = await liveElements(tx, ticket.id);
    if (!bundle || !live.includes('ticket')) return { kind: 'gone' as const };
    if (live.includes(request.element)) return { kind: 'conflict' as const };
    const [row] = await tx.insert(schema.consents).values({ personId, ticketId: ticket.id, recipient: bundle.recipient, element: request.element, grantedAt: now }).returning();
    const content = { ...readContent(cipher, ticket.id, bundle.contentCiphertext), ...redact(request.content, [request.element]) };
    await tx.update(schema.sharedBundles).set({ contentCiphertext: cipher.encrypt(JSON.stringify(content), bundleContext(ticket.id)) }).where(eq(schema.sharedBundles.id, bundle.id));
    return { kind: 'granted' as const, consent: record(row!) };
  });
}

export type BundleReadResult = { kind: 'ok'; view: StaffBundleView } | { kind: 'withdrawn' } | { kind: 'none' };

/**
 * The clinician's read of a ticket's bundle. It checks live consent every time: with the `ticket` element revoked
 * the answer is `withdrawn` (410) and no data is touched; a ticket that never had a bundle is `none` (404). Otherwise the stored content is redacted again to the
 * elements consented to now, the optional elements that were not shared are named, and an audit row is written
 * before the data is returned.
 */
export async function readBundle(deps: ConsentDeps, ticketId: string, staff: { staffUserId: string; facilityId: string }): Promise<BundleReadResult> {
  const { db, cipher, clock } = deps;
  const live = await liveElements(db, ticketId);
  const [row] = await db
    .select({ bundle: schema.sharedBundles, shortCode: schema.tickets.shortCode })
    .from(schema.sharedBundles)
    .innerJoin(schema.tickets, eq(schema.tickets.id, schema.sharedBundles.ticketId))
    .where(eq(schema.sharedBundles.ticketId, ticketId))
    .limit(1);
  if (!row) return { kind: 'none' };
  if (row.bundle.deletedAt !== null || !live.includes('ticket')) return { kind: 'withdrawn' };
  const content = redact(readContent(cipher, ticketId, row.bundle.contentCiphertext), live);
  const approvedSummary = row.bundle.approvedSummaryCiphertext ? cipher.decrypt(row.bundle.approvedSummaryCiphertext, summaryContext(ticketId)) : null;
  await db.insert(schema.bundleReads).values({ ticketId, staffUserId: staff.staffUserId, facilityId: staff.facilityId, at: clock.now() });
  return { kind: 'ok', view: { ticketId, shortCode: row.shortCode, content, notShared: notShared(live), approvedSummary } };
}

export interface EraseResult {
  ticketsWithdrawn: number;
  consentsRevoked: number;
  summariesDeleted: number;
}

/**
 * "Delete everything" on the server: revokes the `ticket` consent of every ticket the person holds that is still
 * shared (which revokes the rest and withdraws what is live), deletes every logged summary the person has, and
 * clears the equity buckets. The tickets themselves and their events remain, as pseudonymous timings with no data.
 */
export async function eraseEverything(deps: ConsentDeps, personId: string): Promise<EraseResult> {
  const { db } = deps;
  const live = await db
    .select({ id: schema.consents.id, ticketId: schema.consents.ticketId })
    .from(schema.consents)
    .where(and(eq(schema.consents.personId, personId), eq(schema.consents.element, 'ticket'), isNull(schema.consents.revokedAt)));
  let ticketsWithdrawn = 0;
  let consentsRevoked = 0;
  for (const consent of live) {
    const result = await revokeConsent(deps, personId, consent.id);
    if (result.kind === 'revoked') {
      consentsRevoked += result.revoked.length;
      if (result.ticketState === 'withdrawn') ticketsWithdrawn += 1;
    }
  }
  const deleted = await db.delete(schema.summaryLogs).where(eq(schema.summaryLogs.personId, personId)).returning({ id: schema.summaryLogs.id });
  await db
    .update(schema.persons)
    .set({ equityOptIn: false, ageBand: null, gender: null, language: null, region: null })
    .where(eq(schema.persons.id, personId));
  return { ticketsWithdrawn, consentsRevoked, summariesDeleted: deleted.length };
}
