import { randomInt } from 'node:crypto';
import { redact, withinWordLimit } from '@mawsool/consent';
import { HANDOFF_WINDOWS_DAYS, computeDeadline } from '@mawsool/rules';
import { SHORT_CODE_ALPHABET, type CreateTicketRequest, type PersonTicketView, type TicketState } from '@mawsool/types';
import { asc, eq } from 'drizzle-orm';
import type { Clock } from '../clock';
import type { Cipher } from '../crypto';
import { schema, type Db } from '../db/client';
import { appendEvent, lastEvent, type Executor } from './events';
import { evaluate } from './transitions';

export interface TicketDeps {
  db: Db;
  cipher: Cipher;
  clock: Clock;
}

/** What the QR on the ticket encodes. A reception desk scans it, or reads the six-character code beside it. */
export function qrPayload(shortCode: string): string {
  return `MAWSOOL:TICKET:${shortCode}`;
}

export function bundleContext(ticketId: string): string {
  return `bundle:${ticketId}`;
}

export function summaryContext(ticketId: string): string {
  return `summary:${ticketId}`;
}

export const SUMMARY_LOG_CONTEXT = 'summary-log';

/** `MW` and four characters from the unambiguous alphabet. */
function randomShortCode(): string {
  let code = 'MW';
  for (let i = 0; i < 4; i += 1) code += SHORT_CODE_ALPHABET[randomInt(SHORT_CODE_ALPHABET.length)];
  return code;
}

async function freeShortCode(executor: Executor): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = randomShortCode();
    const [taken] = await executor.select({ id: schema.tickets.id }).from(schema.tickets).where(eq(schema.tickets.shortCode, code)).limit(1);
    if (!taken) return code;
  }
  throw new Error('could not find a free ticket code');
}

export type IssueResult =
  | { kind: 'created' | 'replayed'; ticketId: string }
  | { kind: 'invalid'; message: string }
  /** The request id belongs to someone else, or the parent can no longer be rerouted. */
  | { kind: 'conflict'; message: string }
  | { kind: 'not_found' };

/** Thrown inside the transaction to abandon it when another request with the same id won. */
class ReplayRace extends Error {}
class StateRace extends Error {}

export interface IssueOptions {
  /** Set for a reroute: the stalled ticket that moves to `rerouted` in the same transaction. */
  parent?: { ticketId: string; reason: string };
}

async function existingByRequestId(db: Db, clientRequestId: string): Promise<{ id: string; personId: string } | null> {
  const [row] = await db
    .select({ id: schema.tickets.id, personId: schema.tickets.personId })
    .from(schema.tickets)
    .where(eq(schema.tickets.clientRequestId, clientRequestId))
    .limit(1);
  return row ?? null;
}

/**
 * Issues a ticket: the ticket, its first event, the consent ledger rows, the encrypted bundle and the logged approved
 * summary, all in one transaction. A repeated request id returns the first ticket (`replayed`) and writes nothing; the
 * unique constraint on the id settles two requests that arrive together. For a reroute the parent moves to `rerouted`
 * in the same transaction, and the child's bundle is built only from this request, never from the parent.
 */
export async function issueTicket(deps: TicketDeps, personId: string, request: CreateTicketRequest, options: IssueOptions = {}): Promise<IssueResult> {
  const { db, cipher, clock } = deps;

  const replay = async (): Promise<IssueResult | null> => {
    const existing = await existingByRequestId(db, request.clientRequestId);
    if (!existing) return null;
    return existing.personId === personId ? { kind: 'replayed', ticketId: existing.id } : { kind: 'conflict', message: 'This request id is already used' };
  };
  const earlier = await replay();
  if (earlier) return earlier;

  if (!request.consents.includes('ticket')) return { kind: 'invalid', message: 'The ticket element is required' };
  if (!HANDOFF_WINDOWS_DAYS.includes(request.windowDays)) return { kind: 'invalid', message: 'That hand-off window is not offered' };
  if (request.approvedSummary !== null && !withinWordLimit(request.approvedSummary)) return { kind: 'invalid', message: 'The summary is over the word limit' };

  const [service] = await db.select().from(schema.services).where(eq(schema.services.id, request.serviceId)).limit(1);
  if (!service || service.facilityId === null || service.tier === 'self_help') return { kind: 'invalid', message: 'That service takes no referral' };

  let parentLast: Awaited<ReturnType<typeof lastEvent>> = null;
  if (options.parent) {
    const [parent] = await db.select().from(schema.tickets).where(eq(schema.tickets.id, options.parent.ticketId)).limit(1);
    if (!parent || parent.personId !== personId) return { kind: 'not_found' };
    parentLast = await lastEvent(db, parent.id);
    if (!parentLast || evaluate(parentLast.state, 'rerouted', 'person') !== 'ok') return { kind: 'conflict', message: 'This ticket can no longer be rerouted' };
  }

  const now = clock.now();
  try {
    const ticketId = await db.transaction(async (tx) => {
      if (options.parent && parentLast) {
        const moved = await appendEvent(tx, {
          ticketId: options.parent.ticketId,
          seq: parentLast.seq + 1,
          from: parentLast.state,
          to: 'rerouted',
          actor: 'person',
          channel: 'app',
          reason: options.parent.reason,
          at: now,
        });
        if (!moved) throw new StateRace();
      }
      const shortCode = await freeShortCode(tx);
      const [ticket] = await tx
        .insert(schema.tickets)
        .values({
          shortCode,
          personId,
          tier: service.tier,
          serviceId: service.id,
          state: 'issued',
          language: request.language,
          deadlineAt: computeDeadline(now, request.windowDays),
          source: 'app',
          parentTicketId: options.parent?.ticketId ?? null,
          clientRequestId: request.clientRequestId,
          createdAt: now,
        })
        .onConflictDoNothing({ target: schema.tickets.clientRequestId })
        .returning({ id: schema.tickets.id });
      if (!ticket) throw new ReplayRace();

      await appendEvent(tx, { ticketId: ticket.id, seq: 1, from: null, to: 'issued', actor: 'person', channel: 'app', at: now });
      await tx.insert(schema.consents).values(request.consents.map((element) => ({ personId, ticketId: ticket.id, recipient: service.id, element, grantedAt: now })));

      const content = redact(request.content, request.consents);
      await tx.insert(schema.sharedBundles).values({
        ticketId: ticket.id,
        recipient: service.id,
        contentCiphertext: cipher.encrypt(JSON.stringify(content), bundleContext(ticket.id)),
        approvedSummaryCiphertext: request.approvedSummary ? cipher.encrypt(request.approvedSummary, summaryContext(ticket.id)) : null,
        createdAt: now,
      });

      if (request.approvedSummary) {
        await tx.insert(schema.summaryLogs).values({
          personId,
          ticketId: ticket.id,
          requestId: request.summaryRequestId ?? request.clientRequestId,
          kind: 'approved',
          ciphertext: cipher.encrypt(request.approvedSummary, SUMMARY_LOG_CONTEXT),
          createdAt: now,
        });
      }
      if (request.summaryRequestId) {
        await tx.update(schema.summaryLogs).set({ ticketId: ticket.id }).where(eq(schema.summaryLogs.requestId, request.summaryRequestId));
      }
      return ticket.id;
    });
    return { kind: 'created', ticketId };
  } catch (error) {
    if (error instanceof ReplayRace) return (await replay()) ?? { kind: 'conflict', message: 'This request id is already used' };
    if (error instanceof StateRace) return { kind: 'conflict', message: 'This ticket changed while it was being rerouted' };
    throw error;
  }
}

/** A ticket as its owner sees it: the timeline, the clinic's contact and the consents behind it. */
export async function personTicketView(db: Db, ticketId: string): Promise<PersonTicketView | null> {
  const [row] = await db
    .select({ ticket: schema.tickets, service: schema.services, facility: schema.facilities })
    .from(schema.tickets)
    .innerJoin(schema.services, eq(schema.tickets.serviceId, schema.services.id))
    .innerJoin(schema.facilities, eq(schema.services.facilityId, schema.facilities.id))
    .where(eq(schema.tickets.id, ticketId))
    .limit(1);
  if (!row) return null;
  const events = await db.select().from(schema.ticketEvents).where(eq(schema.ticketEvents.ticketId, ticketId)).orderBy(asc(schema.ticketEvents.seq));
  const consents = await db.select().from(schema.consents).where(eq(schema.consents.ticketId, ticketId)).orderBy(asc(schema.consents.grantedAt), asc(schema.consents.element));
  const { ticket } = row;
  return {
    id: ticket.id,
    shortCode: ticket.shortCode,
    qrPayload: qrPayload(ticket.shortCode),
    tier: ticket.tier,
    state: ticket.state as TicketState,
    language: ticket.language,
    deadlineAt: ticket.deadlineAt.toISOString(),
    source: ticket.source,
    serviceId: ticket.serviceId,
    serviceName: row.service.name,
    clinicName: row.facility.name,
    clinicContact: row.facility.contactText,
    parentTicketId: ticket.parentTicketId,
    createdAt: ticket.createdAt.toISOString(),
    events: events.map((event) => ({
      seq: event.seq,
      fromState: event.fromState,
      toState: event.toState,
      actor: event.actor,
      reason: event.reason,
      selfConfirmed: event.selfConfirmed,
      at: event.at.toISOString(),
    })),
    consents: consents.map((consent) => ({
      id: consent.id,
      element: consent.element,
      recipient: consent.recipient,
      grantedAt: consent.grantedAt.toISOString(),
      revokedAt: consent.revokedAt?.toISOString() ?? null,
    })),
  };
}
