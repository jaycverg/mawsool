import { CRISIS_HANDOFF_ELEMENT, CRISIS_LINE_RECIPIENT, CrisisHandoffContentSchema, type CreateCrisisHandoffRequest, type CrisisHandoffReceipt, type CrisisHandoffView } from '@mawsool/types';
import { and, asc, eq, isNull, lt, sql } from 'drizzle-orm';
import type { Clock } from '../clock';
import type { Cipher } from '../crypto';
import { schema, type Db } from '../db/client';
import type { Executor } from '../tickets/events';

export interface CrisisHandoffDeps {
  db: Db;
  cipher: Cipher;
  /** The care clock: the contact time sits beside the `shown_at` the phone wrote from its own (demo-shifted) clock. */
  clock: Clock;
}

/** What a hand-off's ciphertext is bound to: its own row. A value copied onto another row does not decrypt there. */
export function crisisHandoffContext(handoffId: string): string {
  return `crisis-handoff:${handoffId}`;
}

type HandoffRow = typeof schema.crisisHandoffs.$inferSelect;

/**
 * Takes a transaction-scoped lock on one hand-off id. Creating, stopping and erasing a hand-off each take it first, so for one
 * id they run one after another: a send cannot miss a stop that is committing, and a stop cannot miss a hand-off that is being
 * written (under READ COMMITTED each would otherwise be blind to the other's uncommitted row). Released at commit or rollback.
 */
async function lockHandoffId(executor: Executor, handoffId: string): Promise<void> {
  await executor.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${handoffId}, 0))`);
}

class AlreadyHandedOff extends Error {}

/** The ledger condition that makes a hand-off readable: its consent is for this element and recipient and is not revoked. */
function liveHandoffConsent() {
  return and(
    eq(schema.consents.element, CRISIS_HANDOFF_ELEMENT),
    eq(schema.consents.recipient, CRISIS_LINE_RECIPIENT),
    isNull(schema.consents.revokedAt),
  );
}

function view(cipher: Cipher, row: HandoffRow): CrisisHandoffView {
  const content = CrisisHandoffContentSchema.parse(JSON.parse(cipher.decrypt(row.contentCiphertext, crisisHandoffContext(row.id))));
  return { id: row.id, receivedAt: row.createdAt.toISOString(), contactMadeAt: row.contactMadeAt?.toISOString() ?? null, ...content };
}

export type CreateHandoffResult = { kind: 'created' | 'replayed'; receipt: CrisisHandoffReceipt } | { kind: 'unknown_event' } | { kind: 'conflict' } | { kind: 'stopped' };

/**
 * Records the person's consent to hand a short template to the crisis line, and stores the template, in one
 * transaction. The ledger row (element `crisis_handoff`, recipient `crisis_line`, no ticket) and the encrypted row are
 * written together or not at all. The crisis event must already be on the server (the phone sends it first); the
 * event is marked "context shared" and nothing else about it changes. The same hand-off id sent again for the same event
 * answers the first one (a lost reply); a crisis event that already has another hand-off, or an id that is another person's,
 * is a conflict. An id the person already stopped (or erased) is refused too, so a send still on its way when they pressed
 * Stop cannot bring the hand-off back: `stopped`, with nothing written.
 */
export async function createHandoff(deps: CrisisHandoffDeps, personId: string, request: CreateCrisisHandoffRequest): Promise<CreateHandoffResult> {
  const { db, cipher } = deps;
  const { handoffId: id, crisisEventId, consented: _consented, ...content } = request;
  const now = deps.clock.now();
  try {
    return await db.transaction(async (tx) => {
      await lockHandoffId(tx, id);
      const [event] = await tx.select({ id: schema.crisisEvents.id }).from(schema.crisisEvents).where(eq(schema.crisisEvents.id, crisisEventId)).for('update');
      if (!event) return { kind: 'unknown_event' as const };
      const [stopped] = await tx.select({ id: schema.revokedHandoffs.handoffId }).from(schema.revokedHandoffs).where(eq(schema.revokedHandoffs.handoffId, id));
      if (stopped) return { kind: 'stopped' as const };
      const [consent] = await tx.insert(schema.consents).values({ personId, ticketId: null, recipient: CRISIS_LINE_RECIPIENT, element: CRISIS_HANDOFF_ELEMENT, grantedAt: now }).returning();
      const inserted = await tx
        .insert(schema.crisisHandoffs)
        .values({ id, personId, crisisEventId, consentId: consent!.id, contentCiphertext: cipher.encrypt(JSON.stringify(content), crisisHandoffContext(id)), createdAt: now })
        .onConflictDoNothing()
        .returning({ id: schema.crisisHandoffs.id });
      if (inserted.length === 0) throw new AlreadyHandedOff();
      await tx.update(schema.crisisEvents).set({ contextShared: true }).where(eq(schema.crisisEvents.id, crisisEventId));
      return { kind: 'created' as const, receipt: { handoffId: id, consentId: consent!.id, grantedAt: now.toISOString(), created: true } };
    });
  } catch (error) {
    if (!(error instanceof AlreadyHandedOff)) throw error;
  }
  // The transaction above was abandoned, so its consent row is gone with it. Answer from the hand-off that is already there.
  const [existing] = await db
    .select({ id: schema.crisisHandoffs.id, personId: schema.crisisHandoffs.personId, crisisEventId: schema.crisisHandoffs.crisisEventId, consentId: schema.crisisHandoffs.consentId, grantedAt: schema.consents.grantedAt })
    .from(schema.crisisHandoffs)
    .innerJoin(schema.consents, eq(schema.consents.id, schema.crisisHandoffs.consentId))
    .where(eq(schema.crisisHandoffs.id, id))
    .limit(1);
  if (!existing || existing.personId !== personId || existing.crisisEventId !== crisisEventId) return { kind: 'conflict' };
  return { kind: 'replayed', receipt: { handoffId: existing.id, consentId: existing.consentId, grantedAt: existing.grantedAt.toISOString(), created: false } };
}

export type RevokeHandoffResult = { kind: 'revoked'; revokedAt: Date } | { kind: 'not_found' };

/**
 * The person stops the hand-off: the stored template and its ledger row are deleted in one transaction, so
 * after it the console has nothing to read. Only the caller's own hand-off can be reached; anyone else's is not found.
 */
export async function revokeHandoff(deps: CrisisHandoffDeps, personId: string, handoffId: string): Promise<RevokeHandoffResult> {
  const now = deps.clock.now();
  return deps.db.transaction(async (tx) => {
    await lockHandoffId(tx, handoffId);
    // The id is remembered whether or not a row exists yet: a send that is still on its way must find it stopped.
    await tx.insert(schema.revokedHandoffs).values({ handoffId, revokedAt: now }).onConflictDoNothing();
    const [row] = await tx.select().from(schema.crisisHandoffs).where(and(eq(schema.crisisHandoffs.id, handoffId), eq(schema.crisisHandoffs.personId, personId))).for('update');
    if (!row) return { kind: 'not_found' as const };
    await tx.delete(schema.crisisHandoffs).where(eq(schema.crisisHandoffs.id, row.id));
    // The ledger row goes too: left behind it would keep the person's name against the time of the hand-off.
    await tx.delete(schema.consents).where(eq(schema.consents.id, row.consentId));
    return { kind: 'revoked' as const, revokedAt: now };
  });
}

/**
 * "Delete everything": deletes every hand-off of the person and every ledger row of the hand-off consent, and remembers the
 * ids of the hand-offs it deleted together with `unseenIds`, the ids the phone made for sends the server may not have seen yet,
 * so a send still on its way cannot recreate one. Must run in a transaction. Nothing of the person is kept: the ledger row is
 * deleted, not revoked, and the remembered ids carry no person. Returns how many hand-offs went.
 */
export async function eraseHandoffs(executor: Executor, personId: string, now: Date, unseenIds: readonly string[] = []): Promise<number> {
  const standing = await executor.select({ id: schema.crisisHandoffs.id }).from(schema.crisisHandoffs).where(eq(schema.crisisHandoffs.personId, personId));
  const ids = [...new Set([...standing.map((row) => row.id), ...unseenIds])].sort();
  // Always in the same order, so two erases (or an erase and a send) that share an id cannot wait on each other in a circle.
  for (const id of ids) await lockHandoffId(executor, id);
  if (ids.length > 0) await executor.insert(schema.revokedHandoffs).values(ids.map((handoffId) => ({ handoffId, revokedAt: now }))).onConflictDoNothing();
  const gone = await executor.delete(schema.crisisHandoffs).where(eq(schema.crisisHandoffs.personId, personId)).returning({ id: schema.crisisHandoffs.id });
  await executor.delete(schema.consents).where(and(eq(schema.consents.personId, personId), eq(schema.consents.element, CRISIS_HANDOFF_ELEMENT)));
  return gone.length;
}

/**
 * The console's list: hand-offs whose consent is live, those still waiting for a call first (oldest first), then those
 * already contacted. A hand-off whose consent was revoked is not listed even if its row somehow remained.
 */
export async function listHandoffs(deps: CrisisHandoffDeps): Promise<CrisisHandoffView[]> {
  const rows = await deps.db
    .select({ handoff: schema.crisisHandoffs })
    .from(schema.crisisHandoffs)
    .innerJoin(schema.consents, eq(schema.consents.id, schema.crisisHandoffs.consentId))
    .where(liveHandoffConsent())
    .orderBy(sql`${schema.crisisHandoffs.contactMadeAt} IS NOT NULL`, asc(schema.crisisHandoffs.createdAt));
  return rows.map((row) => view(deps.cipher, row.handoff));
}

/** One hand-off for the console, or null when there is none or its consent is no longer live. */
export async function readHandoff(deps: CrisisHandoffDeps, handoffId: string): Promise<CrisisHandoffView | null> {
  const [row] = await deps.db
    .select({ handoff: schema.crisisHandoffs })
    .from(schema.crisisHandoffs)
    .innerJoin(schema.consents, eq(schema.consents.id, schema.crisisHandoffs.consentId))
    .where(and(eq(schema.crisisHandoffs.id, handoffId), liveHandoffConsent()))
    .limit(1);
  return row ? view(deps.cipher, row.handoff) : null;
}

/**
 * The operator marks contact made. In one transaction the hand-off is stamped and its crisis event is completed: human
 * contact confirmed by the mock line and resolved. An event whose contact the person already confirmed keeps that
 * confirmation and its time (one contact is counted once), and a second press changes nothing. Returns null when the
 * hand-off is gone or its consent is revoked, and then nothing is written.
 */
export async function markContactMade(deps: CrisisHandoffDeps, handoffId: string): Promise<CrisisHandoffView | null> {
  const now = deps.clock.now();
  return deps.db.transaction(async (tx) => {
    const [found] = await tx
      .select({ handoff: schema.crisisHandoffs })
      .from(schema.crisisHandoffs)
      .innerJoin(schema.consents, eq(schema.consents.id, schema.crisisHandoffs.consentId))
      .where(and(eq(schema.crisisHandoffs.id, handoffId), liveHandoffConsent()))
      .for('update', { of: schema.crisisHandoffs });
    if (!found) return null;
    const [event] = await tx.select().from(schema.crisisEvents).where(eq(schema.crisisEvents.id, found.handoff.crisisEventId)).for('update');
    if (event && !event.humanContactConfirmed) {
      await tx.update(schema.crisisEvents).set({ humanContactConfirmed: true, contactSource: 'mock_line', contactAt: now, resolvedAt: event.resolvedAt ?? now }).where(eq(schema.crisisEvents.id, event.id));
    } else if (event && event.resolvedAt === null) {
      await tx.update(schema.crisisEvents).set({ resolvedAt: now }).where(eq(schema.crisisEvents.id, event.id));
    }
    const contactMadeAt = found.handoff.contactMadeAt ?? now;
    if (found.handoff.contactMadeAt === null) await tx.update(schema.crisisHandoffs).set({ contactMadeAt }).where(eq(schema.crisisHandoffs.id, found.handoff.id));
    return view(deps.cipher, { ...found.handoff, contactMadeAt });
  });
}

/** How long a remembered stop is kept: far longer than any request still on its way can take. */
export const REVOKED_HANDOFF_TTL_MS = 60 * 60 * 1000;

/** Deletes the remembered stops older than an hour. Called by the sweep, as it purges spent request nonces. */
export async function deleteStaleRevokedHandoffs(db: Pick<Db, 'delete'>, now: Date): Promise<number> {
  const gone = await db.delete(schema.revokedHandoffs).where(lt(schema.revokedHandoffs.revokedAt, new Date(now.getTime() - REVOKED_HANDOFF_TTL_MS))).returning({ id: schema.revokedHandoffs.handoffId });
  return gone.length;
}
