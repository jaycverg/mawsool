import { redact, withinWordLimit } from '@mawsool/consent';
import { CreatedTicketSchema, type BundleContent, type CareLanguage, type ConsentElement, type CreateTicketRequest, type CreatedTicket } from '@mawsool/types';
import { clearPendingChoice, saveChoice, type PendingChoice } from './prefs';
import { callServer, markServerFootprint, type ServerDeps } from './server';
import { rememberTicket } from './share';

export type SendOutcome =
  | { status: 'sent'; ticketId: string }
  /** The phone is offline or the server is down: nothing is lost, and sending again is the same request. */
  | { status: 'offline' }
  /** The server said no (409: the ticket can no longer be changed). */
  | { status: 'changed' }
  | { status: 'rejected' };

export interface SendInput {
  pending: PendingChoice;
  elements: readonly ConsentElement[];
  content: BundleContent;
  approvedSummary: string | null;
  summaryRequestId: string | null;
  language: CareLanguage;
  now: () => Date;
}

/** The request body for a ticket: only the ticked elements of the content, redacted here before anything leaves the phone. */
export function ticketRequest(input: SendInput): CreateTicketRequest {
  return {
    clientRequestId: input.pending.requestId,
    serviceId: input.pending.serviceId,
    windowDays: input.pending.windowDays,
    language: input.language,
    consents: [...new Set<ConsentElement>(['ticket', ...input.elements])],
    content: redact(input.content, input.elements),
    approvedSummary: input.approvedSummary && withinWordLimit(input.approvedSummary) ? input.approvedSummary : null,
    summaryRequestId: input.summaryRequestId,
  };
}

/**
 * Sends the referral (a new ticket, or a reroute of the one being replaced). The footprint is noted first, then the
 * request goes with the id made when the option was picked, so a send that is retried after a lost reply returns the
 * same ticket. On success the choice becomes the current support and the waiting pick is cleared.
 */
export async function sendReferral(deps: ServerDeps, input: SendInput): Promise<SendOutcome> {
  const { storage } = deps;
  await markServerFootprint(storage, input.now);
  const body = ticketRequest(input);
  const reroute = input.pending.reroute;
  const path = reroute ? `/me/tickets/${reroute.ticketId}/reroute` : '/tickets';
  const sent = await callServer<CreatedTicket>(deps, 'POST', path, reroute ? { ...body, reason: reroute.reason } : body);
  if (!sent.ok) {
    if (sent.reason === 'rejected' && sent.status === 409) return { status: 'changed' };
    return sent.reason === 'rejected' ? { status: 'rejected' } : { status: 'offline' };
  }
  const parsed = CreatedTicketSchema.safeParse(sent.body);
  if (!parsed.success) return { status: 'rejected' };
  const ticket = parsed.data.ticket;
  await rememberTicket(storage, { id: ticket.id, shortCode: ticket.shortCode, serviceId: ticket.serviceId, tier: ticket.tier, issuedAt: ticket.createdAt });
  await saveChoice(storage, { tier: input.pending.tier, serviceId: input.pending.serviceId, chosenAt: input.pending.chosenAt, confirmed: true });
  await clearPendingChoice(storage);
  return { status: 'sent', ticketId: ticket.id };
}
