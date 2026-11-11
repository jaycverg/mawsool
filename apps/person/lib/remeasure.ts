import { isCompleteScreening, remeasureAvailableAt } from '@mawsool/rules';
import { RemeasureResultSchema, type PersonTicketView, type RemeasureRequest, type Screening } from '@mawsool/types';
import type { StorageAdapter } from '@mawsool/ui';
import { loadOutcomeStatistics, saveOutcomeStatistics } from './outcome-statistics';
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

/**
 * The two finished questionnaires of a repeat check, found by the ids in the address; null while either is missing or unfinished,
 * or when either was started before the repeat check opened (`opensAt`): an old check-in is not the repeat check.
 */
export function repeatCheck(screenings: readonly Screening[], ids: { phq9: string | null; gad7: string | null }, opensAt: Date | null): RepeatCheck | null {
  if (opensAt === null) return null;
  const find = (instrument: 'phq9' | 'gad7', id: string | null) =>
    screenings.find((screening) => screening.id === id && screening.instrument === instrument && isCompleteScreening(screening) && Date.parse(screening.takenAt) >= opensAt.getTime());
  const phq9 = find('phq9', ids.phq9);
  const gad7 = find('gad7', ids.gad7);
  return phq9 && gad7 ? { phq9, gad7 } : null;
}

/** The address parameter that carries the moment the repeat check opened, in epoch ms, from the ticket to the questionnaires. */
export const SINCE_PARAM = 'since';

/** The moment read from `?since=`, or `Infinity` when it is missing or not a number: then no old check-in can be resumed. */
export function sinceFrom(value: string | null): number {
  const ms = value === null || value.trim() === '' ? Number.NaN : Number(value);
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

/** The totals the person can choose to send: the two totals with their band and date, never an answer. */
export function totalsOf(check: RepeatCheck): RemeasureRequest['scores'] {
  return [check.phq9, check.gad7].map((screening) => ({ instrument: screening.instrument as 'phq9' | 'gad7', total: screening.total, band: screening.band, takenAt: screening.takenAt }));
}

export async function loadRepeatCheck(storage: StorageAdapter, ids: { phq9: string | null; gad7: string | null }, opensAt: Date | null): Promise<RepeatCheck | null> {
  return repeatCheck(await loadScreenings(storage), ids, opensAt);
}

/**
 * - `done`: the ticket moved to remeasured and closed.
 * - `not_ready`: the server refused (409): too early, not `seen` any more, or already finished. Asking again cannot help.
 * - `failed`: the server could not be reached or errored; asking again is safe.
 */
export type RemeasureSent = 'done' | 'not_ready' | 'failed';

/**
 * Sends the finished repeat check. `scores` is empty unless the person ticked the box on the repeat check screen, and then nothing but those two totals is sent.
 * `statisticsOptIn` is the separate choice to count those totals in anonymous group figures: it is sent only with totals (the
 * caller passes `undefined` otherwise, and then the person's stored choice is left alone), and never as part of what the clinic receives.
 */
export async function sendRemeasure(server: ServerDeps, ticketId: string, scores: RemeasureRequest['scores'], statisticsOptIn?: boolean): Promise<RemeasureSent> {
  const sent = await callServer<unknown>(server, 'POST', `/me/tickets/${ticketId}/remeasure`, { scores, ...(statisticsOptIn === undefined ? {} : { statisticsOptIn }) });
  if (sent.ok) return RemeasureResultSchema.safeParse(sent.body).success ? 'done' : 'failed';
  return sent.reason === 'rejected' && sent.status === 409 ? 'not_ready' : 'failed';
}

/**
 * - everything `RemeasureSent` says, and
 * - `note_failed`: the phone could not write its note that the statistics choice may be on at the server, so nothing was sent
 *   (a send that could turn the choice on without a note of it would leave Settings with no way to turn it off).
 */
export type RepeatCheckSent = RemeasureSent | 'note_failed';

/**
 * Finishes the repeat check, keeping the phone's note of the statistics choice honest about what the server may hold, the way the
 * phone notes `serverMayHoldPhone` before it sends a number. The note means "may be on at the server".
 *
 *  - A send that carries `true` writes the note `true` BEFORE it is made, and a note that cannot be written stops the send
 *    (`note_failed`). The note then stays `true` whatever follows: a lost reply or an answer that cannot be read may still have
 *    turned it on. Only a refusal (409), which changed nothing, puts the previous value back.
 *  - A send that carries `false` clears the note only on a confirmed `done`; a lost reply leaves it as it was, and so does a note
 *    that cannot be cleared (the choice then still shows in Settings, where it can be turned off again).
 *  - A send with no choice (`undefined`, the totals were not sent) leaves the note alone.
 */
export async function finishRepeatCheck(server: ServerDeps, ticketId: string, scores: RemeasureRequest['scores'], statisticsOptIn: boolean | undefined): Promise<RepeatCheckSent> {
  if (statisticsOptIn === undefined) return sendRemeasure(server, ticketId, scores);
  const previous = await loadOutcomeStatistics(server.storage).catch(() => false);
  if (statisticsOptIn) {
    try {
      await saveOutcomeStatistics(server.storage, true);
    } catch {
      return 'note_failed';
    }
  }
  const outcome = await sendRemeasure(server, ticketId, scores, statisticsOptIn);
  if (outcome === 'done' && !statisticsOptIn) await saveOutcomeStatistics(server.storage, false).catch(() => undefined);
  if (outcome === 'not_ready' && statisticsOptIn && !previous) await saveOutcomeStatistics(server.storage, previous).catch(() => undefined);
  return outcome;
}
