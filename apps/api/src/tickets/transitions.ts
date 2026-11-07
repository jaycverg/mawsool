import type { Actor, TicketState } from '@mawsool/types';

/** States nothing leaves. A ticket in one of them accepts no event, and a revoke after one changes no state. */
export const TERMINAL_STATES: readonly TicketState[] = ['rerouted', 'closed', 'declined', 'withdrawn'];

/** States from which a person can still be moved on: the ones that allow a reroute, and so an "unable to see". */
export const REROUTABLE_STATES: readonly TicketState[] = ['issued', 'acknowledged', 'overdue'];

const OPEN_STATES: readonly TicketState[] = ['issued', 'acknowledged', 'overdue', 'seen', 'remeasured'];

interface Rule {
  to: TicketState;
  from: readonly TicketState[];
  /** Who may fire it. Anyone else gets 403, even when the state would allow the move. */
  actors: readonly Actor[];
}

/**
 * The whole state machine. The spec's table, widened where its stories need more (see the plan's decisions):
 * `declined`, `rerouted` and `seen` can also fire from `acknowledged`, `overdue` or `issued`, and `withdrawn` from
 * every state that is not terminal. A move to a state that has no rule from the current state is illegal (409).
 *
 * The end of the loop is exact: `remeasured` is the person's, from `seen` only (through the re-measure route, which
 * also holds the six-week wait); `closed` from `seen` is the person ending the ticket; `closed` from `remeasured` is the
 * system's, appended in the same transaction as the re-measure. Nobody else can fire either, and nothing else fires `closed`.
 */
export const RULES: readonly Rule[] = [
  { to: 'acknowledged', from: ['issued'], actors: ['clinic'] },
  { to: 'overdue', from: ['issued', 'acknowledged'], actors: ['system'] },
  { to: 'seen', from: REROUTABLE_STATES, actors: ['clinic', 'person'] },
  { to: 'rerouted', from: REROUTABLE_STATES, actors: ['person'] },
  { to: 'declined', from: REROUTABLE_STATES, actors: ['person'] },
  { to: 'withdrawn', from: OPEN_STATES, actors: ['person'] },
  { to: 'remeasured', from: ['seen'], actors: ['person'] },
  { to: 'closed', from: ['seen'], actors: ['person'] },
  { to: 'closed', from: ['remeasured'], actors: ['system'] },
];

export type Verdict =
  /** The move is allowed for this actor. */
  | 'ok'
  /** The move is a real one from this state, but this actor may not make it: 403. */
  | 'forbidden'
  /** No rule allows this move from the current state: 409. */
  | 'illegal';

/** Whether `actor` may move a ticket from `from` to `to`. */
export function evaluate(from: TicketState, to: TicketState, actor: Actor): Verdict {
  const rule = RULES.find((candidate) => candidate.to === to && candidate.from.includes(from));
  if (!rule) return 'illegal';
  return rule.actors.includes(actor) ? 'ok' : 'forbidden';
}

/**
 * "Unable to see": a clinic reports that it cannot see the person, as an event whose state does not change and whose
 * reason is required. It is accepted only in states that allow a reroute, so the person app can then offer one.
 */
export function evaluateUnable(state: TicketState, actor: Actor): Verdict {
  if (!REROUTABLE_STATES.includes(state)) return 'illegal';
  return actor === 'clinic' ? 'ok' : 'forbidden';
}

/** The state a ticket is in, derived from its events: the last event's target. */
export function deriveState(events: readonly { seq: number; toState: TicketState }[]): TicketState | null {
  let last: { seq: number; toState: TicketState } | null = null;
  for (const event of events) if (!last || event.seq > last.seq) last = event;
  return last ? last.toState : null;
}
