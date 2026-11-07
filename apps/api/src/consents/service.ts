import { notShared, redact, withoutElement } from '@mawsool/consent';
import { BundleContentSchema, type BundleContent, type ConsentElement, type ConsentRecord, type GrantConsentRequest, type RemeasureRequest, type StaffBundleView, type TicketState } from '@mawsool/types';
import { type AnyColumn, type SQL, and, arrayContains, eq, isNull, or, sql } from 'drizzle-orm';
import type { Clock } from '../clock';
import type { Cipher } from '../crypto';
import { schema, type Db } from '../db/client';
import { removeReminderPhone } from '../reminders/service';
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
  | { kind: 'revoked'; revoked: ConsentRecord[]; ticketState: TicketState; summaryRemoved: boolean }
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
    return { kind: 'revoked', revoked: [], ticketState: last?.state ?? 'issued', summaryRemoved: false };
  }

  return db.transaction(async (tx) => {
    const { revoked, state, summaryRemoved } = consent.element === 'ticket' ? await endShare(tx, personId, ticketId, now) : await dropElement(tx, cipher, consent, now);
    return { kind: 'revoked' as const, revoked: revoked.map(record), ticketState: state, summaryRemoved };
  });
}

interface Revoked {
  revoked: ConsentRow[];
  state: TicketState;
  summaryRemoved: boolean;
}

/**
 * Deletes a ticket's logged summaries: the person's rows linked to it, and any draft made under the ticket's own request
 * id that was never linked (a draft whose page was reloaded before the ticket was sent). With `unclaimed`, also the
 * person's drafts that no ticket ever claimed. With `holding`, only the rows whose `built_from` holds that element go.
 * Returns how many rows went.
 */
async function deleteSummaryLogs(tx: Executor, personId: string, ticketId: string, options: { unclaimed: boolean; holding?: ConsentElement }): Promise<number> {
  const [ticket] = await tx.select({ requestId: schema.tickets.clientRequestId }).from(schema.tickets).where(eq(schema.tickets.id, ticketId)).limit(1);
  const gone = await tx
    .delete(schema.summaryLogs)
    .where(
      and(
        eq(schema.summaryLogs.personId, personId),
        or(eq(schema.summaryLogs.ticketId, ticketId), ticket?.requestId ? eq(schema.summaryLogs.requestId, ticket.requestId) : undefined, options.unclaimed ? isNull(schema.summaryLogs.ticketId) : undefined),
        options.holding ? arrayContains(schema.summaryLogs.builtFrom, [options.holding]) : undefined,
      ),
    )
    .returning({ id: schema.summaryLogs.id });
  return gone.length;
}

/**
 * Stops one optional element. The bundle is rewritten without it, and nothing else in the row changes, with one
 * exception: if the approved summary was written from the element being stopped (the bundle records which elements it
 * was written from), the approved summary and all the ticket's logged drafts go in the same transaction and the result
 * says so. A summary written from other things, or by hand, stays. Either way, every logged draft or approved text of this
 * person's that was made from the stopped element (its `built_from` holds it) goes too, since the words in it came from
 * that element; log rows made from other elements stay.
 */
async function dropElement(tx: Executor, cipher: Cipher, consent: ConsentRow, now: Date): Promise<Revoked> {
  const ticketId = consent.ticketId!;
  const revoked = await tx.update(schema.consents).set({ revokedAt: now }).where(eq(schema.consents.id, consent.id)).returning();
  const [bundle] = await tx.select().from(schema.sharedBundles).where(eq(schema.sharedBundles.ticketId, ticketId)).for('update');
  let summaryRemoved = false;
  if (bundle && bundle.contentCiphertext !== null) {
    const content = withoutElement(readContent(cipher, ticketId, bundle.contentCiphertext), consent.element);
    summaryRemoved = bundle.approvedSummaryCiphertext !== null && bundle.summaryBuiltFrom.includes(consent.element);
    await tx
      .update(schema.sharedBundles)
      .set({ contentCiphertext: cipher.encrypt(JSON.stringify(content), bundleContext(ticketId)), ...(summaryRemoved ? { approvedSummaryCiphertext: null, summaryBuiltFrom: [] } : {}) })
      .where(eq(schema.sharedBundles.id, bundle.id));
  }
  await deleteSummaryLogs(tx, consent.personId, ticketId, { unclaimed: false, holding: summaryRemoved ? undefined : consent.element });
  return { revoked, state: (await lastEvent(tx, ticketId))?.state ?? 'issued', summaryRemoved };
}

/** Ends the whole share of a ticket. See `revokeConsent`. */
async function endShare(tx: Executor, personId: string, ticketId: string, now: Date): Promise<Revoked> {
  const revoked = await tx.update(schema.consents).set({ revokedAt: now }).where(and(eq(schema.consents.ticketId, ticketId), isNull(schema.consents.revokedAt))).returning();
  const [existing] = await tx.select({ summary: schema.sharedBundles.approvedSummaryCiphertext }).from(schema.sharedBundles).where(eq(schema.sharedBundles.ticketId, ticketId));
  await tx
    .update(schema.sharedBundles)
    .set({ contentCiphertext: null, approvedSummaryCiphertext: null, summaryBuiltFrom: [], deletedAt: now })
    .where(eq(schema.sharedBundles.ticketId, ticketId));
  // The ticket's own logs, any draft made under its request id, and this person's other drafts that no ticket ever claimed
  // (a pick they abandoned): none of it outlives the share.
  const deletedLogs = await deleteSummaryLogs(tx, personId, ticketId, { unclaimed: true });
  const summaryRemoved = (existing?.summary ?? null) !== null || deletedLogs > 0;
  const last = await lastEvent(tx, ticketId);
  if (!last || TERMINAL_STATES.includes(last.state)) return { revoked, state: last?.state ?? 'issued', summaryRemoved };
  const moved = await appendEvent(tx, { ticketId, seq: last.seq + 1, from: last.state, to: 'withdrawn', actor: 'person', channel: 'app', reason: 'consent_revoked', at: now });
  if (!moved) throw new StateRace();
  return { revoked, state: 'withdrawn', summaryRemoved };
}

/**
 * The condition "the person has ended the share of this ticket", for a ticket id column or value: it was issued with a
 * `ticket` consent and none is live now. A ticket that never had a consent (a seeded one) is not "ended". This is the
 * one definition: the single-ticket check below and the queue's list both use it, so they cannot disagree.
 */
export function shareEndedSql(ticketId: AnyColumn | SQL): SQL {
  const ticketConsent = (live: boolean) =>
    sql`SELECT 1 FROM ${schema.consents} WHERE ${schema.consents.ticketId} = ${ticketId} AND ${schema.consents.element} = 'ticket'${live ? sql` AND ${schema.consents.revokedAt} IS NULL` : sql``}`;
  return sql`(EXISTS (${ticketConsent(false)}) AND NOT EXISTS (${ticketConsent(true)}))`;
}

/**
 * True once the person has ended the share of a ticket (see `shareEndedSql`). Staff routes answer 410 for an ended share.
 */
export async function shareEnded(db: Db, ticketId: string): Promise<boolean> {
  const [row] = await db.select({ id: schema.tickets.id }).from(schema.tickets).where(and(eq(schema.tickets.id, ticketId), shareEndedSql(schema.tickets.id))).limit(1);
  return row !== undefined;
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

/**
 * Sends the totals of a repeat check to the ticket's clinic, inside the caller's transaction. It is the person's explicit
 * choice on that screen, so it is recorded the way every consent is: if `scores` is not shared right now, a ledger row
 * grants it (a person who stopped sharing scores earlier is asked again by the tick, never re-granted silently), and the
 * totals join the bundle's `scores` ciphertext next to the referral's own. The one element means a later "stop sharing
 * scores", the ticket's withdrawal and "Delete everything" take these totals out exactly as they take out the rest.
 * Returns the new ledger row (null when `scores` was already shared), or `'none'` when nothing is shared for the ticket,
 * which the caller must treat as a reason to abandon the transaction.
 */
export async function shareRemeasureScores(tx: Executor, cipher: Cipher, input: { personId: string; ticketId: string; scores: RemeasureRequest['scores']; now: Date }): Promise<ConsentRecord | null | 'none'> {
  const { personId, ticketId, scores, now } = input;
  const [bundle] = await tx.select().from(schema.sharedBundles).where(eq(schema.sharedBundles.ticketId, ticketId)).for('update');
  const live = await liveElements(tx, ticketId);
  if (!bundle || bundle.deletedAt !== null || !live.includes('ticket')) return 'none';
  const granted = live.includes('scores') ? null : (await tx.insert(schema.consents).values({ personId, ticketId, recipient: bundle.recipient, element: 'scores', grantedAt: now }).returning())[0]!;
  const existing = readContent(cipher, ticketId, bundle.contentCiphertext);
  const content: BundleContent = { ...existing, scores: [...(existing.scores ?? []), ...scores] };
  await tx.update(schema.sharedBundles).set({ contentCiphertext: cipher.encrypt(JSON.stringify(content), bundleContext(ticketId)) }).where(eq(schema.sharedBundles.id, bundle.id));
  return granted ? record(granted) : null;
}

/** `granted` is the elements consented to at the moment of the read, for a caller that builds something else from the bundle (the FHIR export). */
export type BundleReadResult = { kind: 'ok'; view: StaffBundleView; granted: ConsentElement[] } | { kind: 'withdrawn' } | { kind: 'none' };

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
  return { kind: 'ok', view: { ticketId, shortCode: row.shortCode, content, notShared: notShared(live), approvedSummary }, granted: live };
}

export interface EraseResult {
  ticketsWithdrawn: number;
  consentsRevoked: number;
  summariesDeleted: number;
}

/**
 * "Delete everything" on the server: revokes the `ticket` consent of every ticket the person holds that is still
 * shared (which revokes the rest and withdraws what is live), deletes every logged summary the person has, and
 * clears the equity buckets. The invites the person claimed and the number they gave for text reminders are deleted too (see below). The tickets themselves
 * and their events remain, as pseudonymous timings with no data: an event's reason is a code from a fixed list, never free text.
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
  // The invites this person claimed tie their id to a positive screen, the front door and the time. They are deleted, not
  // unclaimed: an unclaimed invite could be claimed again, and a used one cannot be unclaimed. A ticket keeps its own `source`.
  await db.delete(schema.inboundInvites).where(eq(schema.inboundInvites.claimedBy, personId));
  await removeReminderPhone(db, personId);
  await db
    .update(schema.persons)
    .set({ equityOptIn: false, ageBand: null, gender: null, language: null, region: null })
    .where(eq(schema.persons.id, personId));
  return { ticketsWithdrawn, consentsRevoked, summariesDeleted: deleted.length };
}
