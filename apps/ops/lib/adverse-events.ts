import { AdverseEventSchema, AdverseEventsResponseSchema, type AdverseEvent, type AdverseEventSeverity, type AdverseEventStatus, type AdverseEventType, type AdverseEventsResponse, type Session } from '@mawsool/types';
import { staffCall } from '@mawsool/ui';
import { API_URL } from './metrics';

/** What the log is filtered by; a filter that is null means every value. */
export interface LogFilters {
  status: AdverseEventStatus | null;
  severity: AdverseEventSeverity | null;
}

export const NO_LOG_FILTERS: LogFilters = { status: null, severity: null };

export type LogLoad = { status: 'ok'; log: AdverseEventsResponse } | { status: 'unauthorized' } | { status: 'failed' };

/** Reads the log by status and severity. An answer in the wrong shape is `failed`. */
export async function loadLog(session: Pick<Session, 'sessionToken'>, filters: LogFilters, fetcher: typeof fetch = window.fetch.bind(window)): Promise<LogLoad> {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.severity) params.set('severity', filters.severity);
  const result = await staffCall<unknown>({ fetch: fetcher, apiUrl: API_URL, session, path: `/adverse-events${params.size > 0 ? `?${params.toString()}` : ''}` });
  if (result.status === 'unauthorized') return { status: 'unauthorized' };
  const parsed = result.status === 'ok' ? AdverseEventsResponseSchema.safeParse(result.body) : null;
  return parsed?.success ? { status: 'ok', log: parsed.data } : { status: 'failed' };
}

export type RecordResult = { status: 'recorded'; event: AdverseEvent } | { status: 'invalid' } | { status: 'unauthorized' } | { status: 'failed' };

/** Records an event: a coded type and severity, and optionally a ticket by its pseudonymous id. The time it happened is the care clock's now. */
export async function recordEvent(
  session: Pick<Session, 'sessionToken'>,
  entry: { type: AdverseEventType; severity: AdverseEventSeverity; ticketRef: string | null },
  fetcher: typeof fetch = window.fetch.bind(window),
): Promise<RecordResult> {
  const body = { type: entry.type, severity: entry.severity, ...(entry.ticketRef ? { ticketRef: entry.ticketRef } : {}) };
  const result = await staffCall<unknown>({ fetch: fetcher, apiUrl: API_URL, session, method: 'POST', path: '/adverse-events', body });
  if (result.status === 'unauthorized') return { status: 'unauthorized' };
  if (result.status === 'refused' && result.httpStatus === 400) return { status: 'invalid' };
  const parsed = result.status === 'ok' ? AdverseEventSchema.safeParse(result.body) : null;
  return parsed?.success ? { status: 'recorded', event: parsed.data } : { status: 'failed' };
}

/** `conflict` is a 409: the move is not (or no longer) allowed, so the list should be read again. */
export type MoveResult = { status: 'moved'; event: AdverseEvent } | { status: 'conflict' } | { status: 'unauthorized' } | { status: 'failed' };

export async function moveEvent(session: Pick<Session, 'sessionToken'>, id: string, to: AdverseEventStatus, fetcher: typeof fetch = window.fetch.bind(window)): Promise<MoveResult> {
  const result = await staffCall<unknown>({ fetch: fetcher, apiUrl: API_URL, session, method: 'POST', path: `/adverse-events/${id}/status`, body: { to } });
  if (result.status === 'unauthorized') return { status: 'unauthorized' };
  if (result.status === 'refused' && (result.httpStatus === 409 || result.httpStatus === 404)) return { status: 'conflict' };
  const parsed = result.status === 'ok' ? AdverseEventSchema.safeParse(result.body) : null;
  return parsed?.success ? { status: 'moved', event: parsed.data } : { status: 'failed' };
}

/** The moves a status can make, the same table the API enforces; the screen only offers these. */
export const NEXT_STATUSES: Record<AdverseEventStatus, readonly AdverseEventStatus[]> = { open: ['investigating', 'closed'], investigating: ['closed'], closed: [] };
