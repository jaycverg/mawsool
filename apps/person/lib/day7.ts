import type { TicketState } from '@mawsool/types';

const DAY_MS = 86_400_000;

/** States in which the person has not yet been seen, so "did you get seen?" still makes sense. */
const WAITING: readonly TicketState[] = ['issued', 'acknowledged', 'overdue'];

/**
 * True while the clinic's latest word on the ticket is "unable to see": the newest event is one the clinic fired that
 * left the state where it was, and the ticket is still in a state that allows a reroute. The person is then offered
 * another option. An acknowledgement, an overdue mark or a reroute after it ends the prompt.
 */
export function clinicCouldNotSee(ticket: { state: TicketState; events: readonly { seq: number; fromState: TicketState | null; toState: TicketState; actor: string }[] }): boolean {
  if (!WAITING.includes(ticket.state)) return false;
  const latest = ticket.events.reduce<(typeof ticket.events)[number] | null>((newest, event) => (newest === null || event.seq > newest.seq ? event : newest), null);
  return latest !== null && latest.actor === 'clinic' && latest.fromState === latest.toState;
}

/** The days after issue at which the person is asked whether they were seen. */
export const FOLLOW_UP_DAY = 7;

/**
 * The moment the "did you get seen?" check opens: seven days after the ticket was issued, or its deadline if that
 * comes first. Computed from the ticket's own dates, so it needs no job and works on the demo clock.
 */
export function followUpAt(ticket: { createdAt: string; deadlineAt: string }): Date {
  return new Date(Math.min(Date.parse(ticket.createdAt) + FOLLOW_UP_DAY * DAY_MS, Date.parse(ticket.deadlineAt)));
}

/** True once the check is due and the ticket is still waiting to be seen. */
export function followUpDue(ticket: { state: TicketState; createdAt: string; deadlineAt: string }, now: Date): boolean {
  return WAITING.includes(ticket.state) && now.getTime() >= followUpAt(ticket).getTime();
}
