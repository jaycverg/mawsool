import { isCompleteScreening, remeasureAvailableAt } from '@mawsool/rules';
import { RemeasureResultSchema, type PersonTicketView, type RemeasureRequest, type Screening } from '@mawsool/types';
import type { StorageAdapter } from '@mawsool/ui';
import { loadScreenings } from './screening-store';
import { callServer, type ServerDeps } from './server';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A ticket or screening id taken from the address, or null for anything that is not one. */
export function idFrom(value: string | null): string | null {
  return value !== null && ID.test(value) ? value : null;
}

/** When the ticket most recently became `seen`: the newest event that entered it from another state. */
export function seenAt(ticket: Pick<PersonTicketView, 'events'>): Date | null {
  const entered = ticket.events.filter((event) => event.toState === 'seen' && event.fromState !== event.toState);
  const newest = entered.reduce<(typeof entered)[number] | null>((latest, event) => (latest === null || event.seq > latest.seq ? event : latest), null);
  return newest ? new Date(newest.at) : null;
}

/** The moment the repeat check opens: six weeks after the ticket was seen, the same moment the server holds it to. Null unless the ticket is `seen`. */
export function remeasureOpensAt(ticket: Pick<PersonTicketView, 'state' | 'events'>): Date | null {
  const seen = ticket.state === 'seen' ? seenAt(ticket) : null;
  return seen ? remeasureAvailableAt(seen) : null;
}

/** True once the repeat check is open for the ticket, on the care clock the caller passes in. */
export function remeasureDue(ticket: Pick<PersonTicketView, 'state' | 'events'>, now: Date): boolean {
  const opens = remeasureOpensAt(ticket);
  return opens !== null && now.getTime() >= opens.getTime();
}

export interface RepeatCheck {
  phq9: Screening;
  gad7: Screening;
}

/** The two finished questionnaires of a repeat check, found by the ids in the address; null while either is missing or unfinished. */
export function repeatCheck(screenings: readonly Screening[], ids: { phq9: string | null; gad7: string | null }): RepeatCheck | null {
  const find = (instrument: 'phq9' | 'gad7', id: string | null) => screenings.find((screening) => screening.id === id && screening.instrument === instrument && isCompleteScreening(screening));
  const phq9 = find('phq9', ids.phq9);
  const gad7 = find('gad7', ids.gad7);
  return phq9 && gad7 ? { phq9, gad7 } : null;
}

/** The totals the person can choose to send: the two totals with their band and date, never an answer. */
export function totalsOf(check: RepeatCheck): RemeasureRequest['scores'] {
  return [check.phq9, check.gad7].map((screening) => ({ instrument: screening.instrument as 'phq9' | 'gad7', total: screening.total, band: screening.band, takenAt: screening.takenAt }));
}

export async function loadRepeatCheck(storage: StorageAdapter, ids: { phq9: string | null; gad7: string | null }): Promise<RepeatCheck | null> {
  return repeatCheck(await loadScreenings(storage), ids);
}

/**
 * - `done`: the ticket moved to remeasured and closed.
 * - `not_ready`: the server refused (409): too early, not `seen` any more, or already finished. Asking again cannot help.
 * - `failed`: the server could not be reached or errored; asking again is safe.
 */
export type RemeasureSent = 'done' | 'not_ready' | 'failed';

/** Sends the finished repeat check. `scores` is empty unless the person ticked the box on the repeat check screen, and then nothing but those two totals is sent. */
export async function sendRemeasure(server: ServerDeps, ticketId: string, scores: RemeasureRequest['scores']): Promise<RemeasureSent> {
  const sent = await callServer<unknown>(server, 'POST', `/me/tickets/${ticketId}/remeasure`, { scores });
  if (sent.ok) return RemeasureResultSchema.safeParse(sent.body).success ? 'done' : 'failed';
  return sent.reason === 'rejected' && sent.status === 409 ? 'not_ready' : 'failed';
}
