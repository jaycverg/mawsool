import { randomInt } from 'node:crypto';
import { INVITE_CODE_LENGTH, SHORT_CODE_ALPHABET, type InboundSource, type InboundScreenRequest } from '@mawsool/types';
import { and, eq, gt, isNull, lt } from 'drizzle-orm';
import type { Clock } from '../clock';
import { schema, type Db } from '../db/client';
import { sha256Hex } from '../security';
import type { Executor } from '../tickets/events';

/** An invite can be claimed for 30 days after the front door handed it over. */
export const INVITE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** A nonce only has to outlive the request window to stop a replay; after an hour it is deleted. */
export const NONCE_RETENTION_MS = 60 * 60 * 1000;

/** A random claim code from the ticket code's unambiguous alphabet. */
export function generateInviteCode(): string {
  let code = '';
  for (let i = 0; i < INVITE_CODE_LENGTH; i += 1) code += SHORT_CODE_ALPHABET[randomInt(SHORT_CODE_ALPHABET.length)];
  return code;
}

/** `ABCDEFGH` as `ABCD-EFGH`, the way it is read out and typed. */
export function formatInviteCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** What is stored for a code: its hash. A normalised code (upper case, no dash) goes in. */
export function inviteCodeHash(code: string): string {
  return sha256Hex(code);
}

export type NonceOutcome = 'accepted' | 'replayed';

/** Records a nonce for a source. A nonce seen before inside the retention window is a replay. */
export async function takeNonce(db: Executor, clock: Clock, source: InboundSource, nonce: string): Promise<NonceOutcome> {
  const taken = await db
    .insert(schema.inboundNonces)
    .values({ source, nonce, seenAt: clock.now() })
    .onConflictDoNothing()
    .returning({ nonce: schema.inboundNonces.nonce });
  return taken.length > 0 ? 'accepted' : 'replayed';
}

/** Deletes nonces older than the retention window. Returns how many went. */
export async function deleteStaleNonces(db: Db, clock: Clock): Promise<number> {
  const gone = await db
    .delete(schema.inboundNonces)
    .where(lt(schema.inboundNonces.seenAt, new Date(clock.now().getTime() - NONCE_RETENTION_MS)))
    .returning({ nonce: schema.inboundNonces.nonce });
  return gone.length;
}

export interface CreatedInvite {
  inviteId: string;
  /** The plain code, shown to the front door once; only its hash is kept. */
  code: string;
  expiresAt: Date;
}

/** Stores an invite for a verified front door and returns its claim code. Never creates a ticket. */
export async function createInvite(db: Executor, clock: Clock, source: InboundSource, request: InboundScreenRequest): Promise<CreatedInvite> {
  const now = clock.now();
  const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = generateInviteCode();
    const [row] = await db
      .insert(schema.inboundInvites)
      .values({ source, codeHash: inviteCodeHash(code), screenedAt: new Date(request.screenedAt), locale: request.locale, createdAt: now, expiresAt })
      .onConflictDoNothing({ target: schema.inboundInvites.codeHash })
      .returning({ id: schema.inboundInvites.id });
    if (row) return { inviteId: row.id, code, expiresAt };
  }
  throw new Error('could not find a free invite code');
}

export type ScreenOutcome = ({ kind: 'created' } & CreatedInvite) | { kind: 'replayed' };

/**
 * Takes a verified front door's screen: spends its nonce and stores the invite in one transaction. If the invite cannot
 * be written, the nonce is not spent either, so the same signed request can be sent again and is not mistaken for a
 * replay of something that never arrived. A nonce used before is `replayed` and nothing is written.
 */
export async function acceptScreen(db: Db, clock: Clock, source: InboundSource, nonce: string, request: InboundScreenRequest): Promise<ScreenOutcome> {
  return db.transaction(async (tx) => {
    if ((await takeNonce(tx, clock, source, nonce)) === 'replayed') return { kind: 'replayed' as const };
    return { kind: 'created' as const, ...(await createInvite(tx, clock, source, request)) };
  });
}

export type ClaimOutcome = { kind: 'claimed' | 'already'; invite: { id: string; source: InboundSource; screenedAt: Date } } | { kind: 'not_found' };

/**
 * Binds an invite to a person by its code. One statement does the check and the write, so two people typing the same
 * code cannot both get it. The person who holds it can claim again and gets the same answer. An unknown code, an
 * expired one and one somebody else holds are all `not_found`, so a code cannot be probed.
 */
export async function claimInvite(db: Db, clock: Clock, personId: string, code: string): Promise<ClaimOutcome> {
  const now = clock.now();
  const hash = inviteCodeHash(code);
  const [claimed] = await db
    .update(schema.inboundInvites)
    .set({ claimedBy: personId, claimedAt: now })
    .where(and(eq(schema.inboundInvites.codeHash, hash), isNull(schema.inboundInvites.claimedBy), gt(schema.inboundInvites.expiresAt, now)))
    .returning({ id: schema.inboundInvites.id, source: schema.inboundInvites.source, screenedAt: schema.inboundInvites.screenedAt });
  if (claimed) return { kind: 'claimed', invite: { id: claimed.id, source: claimed.source as InboundSource, screenedAt: claimed.screenedAt } };
  const [mine] = await db
    .select({ id: schema.inboundInvites.id, source: schema.inboundInvites.source, screenedAt: schema.inboundInvites.screenedAt })
    .from(schema.inboundInvites)
    .where(and(eq(schema.inboundInvites.codeHash, hash), eq(schema.inboundInvites.claimedBy, personId)))
    .limit(1);
  return mine ? { kind: 'already', invite: { id: mine.id, source: mine.source as InboundSource, screenedAt: mine.screenedAt } } : { kind: 'not_found' };
}
