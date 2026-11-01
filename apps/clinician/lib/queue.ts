import { QueueStateFilterSchema, TierSchema, type BundleContent, type QueueStateFilter, type ScoreEntry, type Tier } from '@mawsool/types';

/** Base URL of the Ticket API, fixed at build time. */
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

/** Tiers a clinic receives. Guided self-help never becomes a ticket. */
export const QUEUE_TIERS: readonly Tier[] = ['community', 'tele', 'gp', 'specialist'];

/** The view the queue shows: a state filter and an optional tier, as they sit in the page address. */
export interface QueueView {
  state: QueueStateFilter;
  tier: Tier | null;
}

/** Reads the view from the address's query. Anything unknown falls back to "all open" and no tier, never to an error. */
export function viewFromQuery(params: Pick<URLSearchParams, 'get'>): QueueView {
  const tier = TierSchema.safeParse(params.get('tier'));
  return {
    state: QueueStateFilterSchema.safeParse(params.get('state')).data ?? 'open',
    tier: tier.success && QUEUE_TIERS.includes(tier.data) ? tier.data : null,
  };
}

/** The query string for the API call: `limit` is the largest page the API allows, so one call fills the table. */
export function queueQuery(view: QueueView, limit = 100): string {
  const query = new URLSearchParams({ state: view.state, limit: String(limit) });
  if (view.tier) query.set('tier', view.tier);
  return `?${query.toString()}`;
}

/** The address query for a view, leaving out what is the default and keeping the open ticket. */
export function addressQuery(view: QueueView, ticketId: string | null): string {
  const query = new URLSearchParams();
  if (view.state !== 'open') query.set('state', view.state);
  if (view.tier) query.set('tier', view.tier);
  if (ticketId) query.set('ticket', ticketId);
  const text = query.toString();
  return text === '' ? '' : `?${text}`;
}

/** A ticket id from the address, only if it is a UUID, so nothing else is ever put into an API path. */
export function ticketIdFromQuery(params: Pick<URLSearchParams, 'get'>): string | null {
  const value = params.get('ticket');
  return value !== null && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : null;
}

/** Ticket codes are shown as `MW-4K7Q`. */
export const displayCode = (shortCode: string) => `${shortCode.slice(0, 2)}-${shortCode.slice(2)}`;

export type Deadline = { kind: 'left'; days: number } | { kind: 'late'; days: number };

/** How the deadline reads against today: days left (0 is due today) or days late. `daysUntil` is the signed calendar-day count. */
export function deadlineOf(daysUntil: number): Deadline {
  return daysUntil >= 0 ? { kind: 'left', days: daysUntil } : { kind: 'late', days: -daysUntil };
}

/** The states in which the clinic can still act on a ticket: the ones that allow a move to seen. */
export const ACTIONABLE_STATES = ['issued', 'acknowledged', 'overdue'] as const;

export interface Series {
  instrument: ScoreEntry['instrument'];
  entries: ScoreEntry[];
}

/**
 * The trajectory grouped by instrument, each oldest first, in the order the instruments first appear. A series of one
 * is still a series: the screen shows it as a single value.
 */
export function trajectoryByInstrument(content: BundleContent): Series[] {
  const groups = new Map<Series['instrument'], ScoreEntry[]>();
  for (const entry of content.trajectory ?? []) groups.set(entry.instrument, [...(groups.get(entry.instrument) ?? []), entry]);
  return [...groups.entries()].map(([instrument, entries]) => ({ instrument, entries: [...entries].sort((a, b) => Date.parse(a.takenAt) - Date.parse(b.takenAt)) }));
}

/** Points of a sparkline in a width x height box: time runs along the x axis, the totals are spread between the lowest and the highest. */
export function sparkline(entries: readonly ScoreEntry[], width: number, height: number, pad = 4): string {
  if (entries.length === 0) return '';
  const first = Date.parse(entries[0]!.takenAt);
  const span = Date.parse(entries[entries.length - 1]!.takenAt) - first;
  const totals = entries.map((entry) => entry.total);
  const low = Math.min(...totals);
  const range = Math.max(...totals) - low;
  return entries
    .map((entry, index) => {
      const fraction = entries.length === 1 ? 0.5 : span === 0 ? index / (entries.length - 1) : (Date.parse(entry.takenAt) - first) / span;
      const lift = range === 0 ? 0.5 : (entry.total - low) / range;
      return `${(pad + fraction * (width - 2 * pad)).toFixed(1)},${(height - pad - lift * (height - 2 * pad)).toFixed(1)}`;
    })
    .join(' ');
}
