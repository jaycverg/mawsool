import {
  EQUITY_PERIOD,
  CrisisResponseSchema,
  EquityResponseSchema,
  FunnelResponseSchema,
  OutcomesResponseSchema,
  TimelinessResponseSchema,
  type CrisisResponse,
  type EquityResponse,
  type FunnelResponse,
  type MetricPeriod,
  type OutcomesResponse,
  type Session,
  type SuppressedValue,
  type TicketSource,
  type TicketTier,
  type TimelinessResponse,
} from '@mawsool/types';
import { staffCall } from '@mawsool/ui';

/** Base URL of the Ticket API, fixed at build time. */
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

/**
 * What the dashboard filters on. Period applies to every figure except the equity section and the loop-closed tile, which
 * read equity and so always show the last 90 days (the tile says so); source and tier narrow the funnel.
 */
export interface Filters {
  period: MetricPeriod;
  source: TicketSource | null;
  tier: TicketTier | null;
}

/** The board's default: the last 90 days. */
export const DEFAULT_FILTERS: Filters = { period: '90d', source: null, tier: null };

export interface Dashboard {
  funnel: FunnelResponse;
  timeliness: TimelinessResponse;
  crisis: CrisisResponse;
  equity: EquityResponse;
  outcomes: OutcomesResponse;
}

export type DashboardResult = { status: 'ok'; data: Dashboard } | { status: 'unauthorized' } | { status: 'failed' };

/** True for the answer a metric gives in place of a number it may not show. */
export function isSuppressed(value: unknown): value is SuppressedValue {
  return typeof value === 'object' && value !== null && 'suppressed' in value;
}

function query(filters: Filters, withFunnelFilters: boolean): string {
  const params = new URLSearchParams({ period: filters.period });
  if (withFunnelFilters && filters.source) params.set('source', filters.source);
  if (withFunnelFilters && filters.tier) params.set('tier', filters.tier);
  return `?${params.toString()}`;
}

/** Loads the five metric routes together. Any 401 is `unauthorized`; an answer that is missing or the wrong shape is `failed`. */
export async function loadDashboard(session: Pick<Session, 'sessionToken'>, filters: Filters): Promise<DashboardResult> {
  // The equity section ignores the period filter: it is always the one period the API serves it for (see `EQUITY_PERIOD`).
  const call = (path: string, withFunnelFilters = false, period?: MetricPeriod) =>
    staffCall<unknown>({ fetch: window.fetch.bind(window), apiUrl: API_URL, session, path: `${path}${query(period ? { ...filters, period } : filters, withFunnelFilters)}` });
  const [funnel, timeliness, crisis, equity, outcomes] = await Promise.all([call('/metrics/funnel', true), call('/metrics/timeliness'), call('/metrics/crisis'), call('/metrics/equity', false, EQUITY_PERIOD), call('/metrics/outcomes')]);
  const all = [funnel, timeliness, crisis, equity, outcomes];
  if (all.some((result) => result.status === 'unauthorized')) return { status: 'unauthorized' };
  if (all.some((result) => result.status !== 'ok')) return { status: 'failed' };
  const parsed = {
    funnel: funnel.status === 'ok' ? FunnelResponseSchema.safeParse(funnel.body) : null,
    timeliness: timeliness.status === 'ok' ? TimelinessResponseSchema.safeParse(timeliness.body) : null,
    crisis: crisis.status === 'ok' ? CrisisResponseSchema.safeParse(crisis.body) : null,
    equity: equity.status === 'ok' ? EquityResponseSchema.safeParse(equity.body) : null,
    outcomes: outcomes.status === 'ok' ? OutcomesResponseSchema.safeParse(outcomes.body) : null,
  };
  if (!parsed.funnel?.success || !parsed.timeliness?.success || !parsed.crisis?.success || !parsed.equity?.success || !parsed.outcomes?.success) return { status: 'failed' };
  return { status: 'ok', data: { funnel: parsed.funnel.data, timeliness: parsed.timeliness.data, crisis: parsed.crisis.data, equity: parsed.equity.data, outcomes: parsed.outcomes.data } };
}

/** Whole numbers and Latin digits in both languages, like the boards (67%, 7 days). The API keeps its precision. */
export function numberFormat(lang: 'ar' | 'en'): Intl.NumberFormat {
  return new Intl.NumberFormat(lang === 'ar' ? 'ar-AE-u-nu-latn' : 'en-GB', { maximumFractionDigits: 0 });
}

/** One decimal, for a mean change in points; a sign is shown for any change, and none for zero. */
export function decimalFormat(lang: 'ar' | 'en'): Intl.NumberFormat {
  return new Intl.NumberFormat(lang === 'ar' ? 'ar-AE-u-nu-latn' : 'en-GB', { maximumFractionDigits: 1, signDisplay: 'exceptZero' });
}
