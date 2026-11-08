import type { ClinicLinkMove, ClinicLinkTicket } from '@mawsool/types';
import { and, eq, inArray, isNotNull, isNull, lt, or, gt } from 'drizzle-orm';
import type { Clock } from '../clock';
import { shareEndedSql } from '../consents/service';
import { schema, type Db } from '../db/client';
import type { ClinicLinkNotifier } from '../notifier';
import { randomToken, sha256Hex } from '../security';
import { clinicLink } from '../staff-links';
import { appendEvent, lastEvent, type Executor } from '../tickets/events';
import { evaluate } from '../tickets/transitions';

/** A clinic link works for 48 hours, on the wall clock: a demo clock jump neither ends it early nor keeps it alive. */
export const CLINIC_LINK_TTL_MS = 48 * 60 * 60 * 1000;

/** How long a spent or expired link row is kept before the sweep deletes it. */
export const CLINIC_LINK_KEEP_MS = 24 * 60 * 60 * 1000;

/** The only moves a link can make, as the state machine's own names. They are the clinic's moves from the states below. */
const LINK_MOVES: readonly ClinicLinkMove[] = ['acknowledged', 'seen'];

export interface ClinicLinkDeps {
  db: Db;
  /** The care clock: the ticket's events are written on it, as every event is. */
  clock: Clock;
  /** The wall clock: whether a link has expired, and when it was used. */
  securityClock: Clock;
  notifier: ClinicLinkNotifier;
  clinicianAppUrl: string;
  log: { error(object: Record<string, unknown>, message: string): void };
}

/** The moves the clinic can still make from a state, through the transition table and nowhere else. */
export function linkMovesFrom(state: Parameters<typeof evaluate>[0]): ClinicLinkMove[] {
  return LINK_MOVES.filter((move) => evaluate(state, move, 'clinic') === 'ok');
}

/**
 * Makes a one-time link for a ticket and hands it to the notifier (which logs it), if the ticket's facility has no portal and
 * the clinic still has a move to make. Only the token's SHA-256 is stored. Nothing here can fail the caller: the ticket is already
 * made, and a notifier that fails leaves a link nobody has, which expires. Returns whether a link was logged.
 */
export async function issueClinicLink(deps: ClinicLinkDeps, ticketId: string): Promise<boolean> {
  try {
    const [row] = await deps.db
      .select({ ticket: schema.tickets, facility: schema.facilities })
      .from(schema.tickets)
      .innerJoin(schema.services, eq(schema.tickets.serviceId, schema.services.id))
      .innerJoin(schema.facilities, eq(schema.services.facilityId, schema.facilities.id))
      .where(eq(schema.tickets.id, ticketId))
      .limit(1);
    if (!row || row.facility.portalAccess || linkMovesFrom(row.ticket.state).length === 0) return false;
    const now = deps.securityClock.now();
    const token = randomToken();
    const expiresAt = new Date(now.getTime() + CLINIC_LINK_TTL_MS);
    await deps.db.insert(schema.clinicLinks).values({ tokenHash: sha256Hex(token), ticketId, facilityId: row.facility.id, createdAt: now, expiresAt });
    await deps.notifier.sendClinicLink({ facility: row.facility.name, ticketCode: row.ticket.shortCode, link: clinicLink(deps.clinicianAppUrl, ticketId, token), expiresAt });
    return true;
  } catch (error) {
    deps.log.error({ err: error }, 'could not issue the clinic link');
    return false;
  }
}

type LinkRow = typeof schema.clinicLinks.$inferSelect;

/** The live link for a credential: this ticket's, unspent and unexpired. Anything else is null, whichever way it failed. */
async function liveLink(executor: Executor, now: Date, credential: { ticketId: string; token: string }): Promise<LinkRow | null> {
  const [link] = await executor
    .select()
    .from(schema.clinicLinks)
    .where(and(eq(schema.clinicLinks.tokenHash, sha256Hex(credential.token)), eq(schema.clinicLinks.ticketId, credential.ticketId), isNull(schema.clinicLinks.usedAt), gt(schema.clinicLinks.expiresAt, now)))
    .limit(1);
  return link ?? null;
}

export type OpenResult =
  | { kind: 'ok'; ticket: ClinicLinkTicket }
  /** The credential is not a live link: unknown, tampered, used, expired or for another ticket. One refusal for all. */
  | { kind: 'invalid' }
  /** The ticket is not (or no longer) addressed to the facility the link was made for. */
  | { kind: 'not_found' }
  /** The person ended the share. */
  | { kind: 'withdrawn' };

/** The ticket as the link's page shows it, resolved through the link's own facility and the same share rule the staff routes apply. */
async function visibleTicket(executor: Executor, link: LinkRow): Promise<{ kind: 'ok'; ticket: typeof schema.tickets.$inferSelect } | { kind: 'not_found' | 'withdrawn' }> {
  const [row] = await executor
    .select({ ticket: schema.tickets })
    .from(schema.tickets)
    .innerJoin(schema.services, eq(schema.tickets.serviceId, schema.services.id))
    .where(and(eq(schema.tickets.id, link.ticketId), eq(schema.services.facilityId, link.facilityId)))
    .limit(1);
  if (!row) return { kind: 'not_found' };
  const [ended] = await executor.select({ id: schema.tickets.id }).from(schema.tickets).where(and(eq(schema.tickets.id, row.ticket.id), shareEndedSql(schema.tickets.id))).limit(1);
  return ended ? { kind: 'withdrawn' } : { kind: 'ok', ticket: row.ticket };
}

/**
 * Reads what a link may show: the ticket's code, tier, state, deadline and the moves open to the clinic. It writes nothing and
 * reveals no wellbeing data: no bundle, no summary, no score, no note. The refusal for a bad credential is the same whatever
 * was wrong with it, and is given before anything about the ticket.
 */
export async function openClinicLink(deps: ClinicLinkDeps, credential: { ticketId: string; token: string }): Promise<OpenResult> {
  const link = await liveLink(deps.db, deps.securityClock.now(), credential);
  if (!link) return { kind: 'invalid' };
  const found = await visibleTicket(deps.db, link);
  if (found.kind !== 'ok') return found;
  const ticket = found.ticket;
  return {
    kind: 'ok',
    ticket: { shortCode: ticket.shortCode, tier: ticket.tier, state: ticket.state, deadlineAt: ticket.deadlineAt.toISOString(), moves: linkMovesFrom(ticket.state), expiresAt: link.expiresAt.toISOString() },
  };
}

export type ActResult =
  | { kind: 'done'; state: ClinicLinkTicket['state']; freshLink: boolean }
  | { kind: 'invalid' }
  | { kind: 'not_found' }
  | { kind: 'withdrawn' }
  /** The ticket cannot make that move from where it is (or moved while the request was running). The link is not spent. */
  | { kind: 'conflict' };

class Refused extends Error {
  constructor(readonly result: Exclude<ActResult, { kind: 'done' }>) {
    super(result.kind);
  }
}

/**
 * Fires one move through the transition table as the clinic, and spends the link, in one transaction. The link is spent by a
 * single update that only matches an unspent, unexpired link, so two presses of one link cannot both pass it: the second finds it
 * spent and is refused like any bad link, and the ticket moves once. A move the table does not allow, a lost race on the ticket's
 * sequence number, or a share that has ended rolls the spend back with it, so a refused request writes nothing.
 *
 * When the move leaves the clinic another one to make, a fresh link is made and logged after the commit.
 */
export async function actOnClinicLink(deps: ClinicLinkDeps, credential: { ticketId: string; token: string }, to: ClinicLinkMove): Promise<ActResult> {
  const securityNow = deps.securityClock.now();
  let moved: { state: ClinicLinkTicket['state'] };
  try {
    moved = await deps.db.transaction(async (tx) => {
      const [spent] = await tx
        .update(schema.clinicLinks)
        .set({ usedAt: securityNow })
        .where(and(eq(schema.clinicLinks.tokenHash, sha256Hex(credential.token)), eq(schema.clinicLinks.ticketId, credential.ticketId), isNull(schema.clinicLinks.usedAt), gt(schema.clinicLinks.expiresAt, securityNow)))
        .returning();
      if (!spent) throw new Refused({ kind: 'invalid' });
      const found = await visibleTicket(tx, spent);
      if (found.kind !== 'ok') throw new Refused({ kind: found.kind });
      const last = await lastEvent(tx, found.ticket.id);
      if (!last || evaluate(last.state, to, 'clinic') !== 'ok') throw new Refused({ kind: 'conflict' });
      const appended = await appendEvent(tx, { ticketId: found.ticket.id, seq: last.seq + 1, from: last.state, to, actor: 'clinic', channel: 'link', at: deps.clock.now() });
      if (!appended) throw new Refused({ kind: 'conflict' });
      return { state: to };
    });
  } catch (error) {
    if (error instanceof Refused) return error.result;
    throw error;
  }
  // `issueClinicLink` makes none when the clinic has no move left or the facility has the portal.
  const freshLink = await issueClinicLink(deps, credential.ticketId);
  return { kind: 'done', state: moved.state, freshLink };
}

/** Deletes the links that were spent, or expired, more than a day ago. Called by the sweep, as it purges spent request nonces. */
export async function deleteStaleClinicLinks(db: Pick<Db, 'delete'>, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - CLINIC_LINK_KEEP_MS);
  const gone = await db
    .delete(schema.clinicLinks)
    .where(or(and(isNotNull(schema.clinicLinks.usedAt), lt(schema.clinicLinks.usedAt, cutoff)), lt(schema.clinicLinks.expiresAt, cutoff)))
    .returning({ id: schema.clinicLinks.id });
  return gone.length;
}

/** "Delete everything": deletes every link of the person's tickets. Must run where the caller can see the ticket ids (inside the erase). */
export async function deleteClinicLinksOf(executor: Executor, personId: string): Promise<number> {
  const tickets = await executor.select({ id: schema.tickets.id }).from(schema.tickets).where(eq(schema.tickets.personId, personId));
  if (tickets.length === 0) return 0;
  const gone = await executor
    .delete(schema.clinicLinks)
    .where(inArray(schema.clinicLinks.ticketId, tickets.map((ticket) => ticket.id)))
    .returning({ id: schema.clinicLinks.id });
  return gone.length;
}
