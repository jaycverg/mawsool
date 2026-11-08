import { randomUUID } from 'node:crypto';
import { CRISIS_HANDOFF_ELEMENT, CRISIS_LINE_RECIPIENT, CrisisHandoffContentSchema, type CreateCrisisHandoffRequest, type CrisisHandoffReceipt, type CrisisHandoffView } from '@mawsool/types';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
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

export type CreateHandoffResult = { kind: 'created' | 'replayed'; receipt: CrisisHandoffReceipt } | { kind: 'unknown_event' } | { kind: 'conflict' };

/**
 * Records the person's consent to hand a short template to the crisis line, and stores the template, in one
 * transaction. The ledger row (element `crisis_handoff`, recipient `crisis_line`, no ticket) and the encrypted row are
 * written together or not at all. The crisis event must already be on the server (the phone sends it first); the
 * event is marked "context shared" and nothing else about it changes. The same crisis event handed off twice, by the
 * same person, answers the first one again; a different person's id on it is a conflict.
 */
export async function createHandoff(deps: CrisisHandoffDeps, personId: string, request: CreateCrisisHandoffRequest): Promise<CreateHandoffResult> {
  const { db, cipher } = deps;
  const { crisisEventId, consented: _consented, ...content } = request;
  const now = deps.clock.now();
  try {
    return await db.transaction(async (tx) => {
      const [event] = await tx.select({ id: schema.crisisEvents.id }).from(schema.crisisEvents).where(eq(schema.crisisEvents.id, crisisEventId)).for('update');
      if (!event) return { kind: 'unknown_event' as const };
      const [consent] = await tx.insert(schema.consents).values({ personId, ticketId: null, recipient: CRISIS_LINE_RECIPIENT, element: CRISIS_HANDOFF_ELEMENT, grantedAt: now }).returning();
      const id = randomUUID();
      const inserted = await tx
        .insert(schema.crisisHandoffs)
        .values({ id, personId, crisisEventId, consentId: consent!.id, contentCiphertext: cipher.encrypt(JSON.stringify(content), crisisHandoffContext(id)), createdAt: now })
        .onConflictDoNothing({ target: schema.crisisHandoffs.crisisEventId })
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
    .select({ id: schema.crisisHandoffs.id, personId: schema.crisisHandoffs.personId, consentId: schema.crisisHandoffs.consentId, grantedAt: schema.consents.grantedAt })
    .from(schema.crisisHandoffs)
    .innerJoin(schema.consents, eq(schema.consents.id, schema.crisisHandoffs.consentId))
    .where(eq(schema.crisisHandoffs.crisisEventId, crisisEventId))
    .limit(1);
  if (!existing || existing.personId !== personId) return { kind: 'conflict' };
  return { kind: 'replayed', receipt: { handoffId: existing.id, consentId: existing.consentId, grantedAt: existing.grantedAt.toISOString(), created: false } };
}

export type RevokeHandoffResult = { kind: 'revoked'; revokedAt: Date } | { kind: 'not_found' };

/**
 * The person stops the hand-off: the ledger row is revoked and the stored template is deleted in one transaction, so
 * after it the console has nothing to read. Only the caller's own hand-off can be reached; anyone else's is not found.
 */
export async function revokeHandoff(deps: CrisisHandoffDeps, personId: string, handoffId: string): Promise<RevokeHandoffResult> {
  const now = deps.clock.now();
  return deps.db.transaction(async (tx) => {
    const [row] = await tx.select().from(schema.crisisHandoffs).where(and(eq(schema.crisisHandoffs.id, handoffId), eq(schema.crisisHandoffs.personId, personId))).for('update');
    if (!row) return { kind: 'not_found' as const };
    await tx.update(schema.consents).set({ revokedAt: now }).where(and(eq(schema.consents.id, row.consentId), isNull(schema.consents.revokedAt)));
    await tx.delete(schema.crisisHandoffs).where(eq(schema.crisisHandoffs.id, row.id));
    return { kind: 'revoked' as const, revokedAt: now };
  });
}

/**
 * "Delete everything": revokes every live hand-off consent of the person and deletes their hand-off rows, inside the
 * caller's transaction or on the database. Returns how many hand-offs went. The ledger keeps the revocations.
 */
export async function eraseHandoffs(executor: Executor, personId: string, now: Date): Promise<number> {
  await executor
    .update(schema.consents)
    .set({ revokedAt: now })
    .where(and(eq(schema.consents.personId, personId), eq(schema.consents.element, CRISIS_HANDOFF_ELEMENT), isNull(schema.consents.revokedAt)));
  const gone = await executor.delete(schema.crisisHandoffs).where(eq(schema.crisisHandoffs.personId, personId)).returning({ id: schema.crisisHandoffs.id });
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
