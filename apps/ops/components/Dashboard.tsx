'use client';

import { TICKET_SOURCES, TICKET_TIERS, METRIC_PERIODS, type EquityDimension, type EquityResponse, type MetricPeriod, type Session, type TicketSource, type TicketTier } from '@mawsool/types';
import { isLocale } from '@mawsool/ui';
import { BrandMark } from '@mawsool/ui/components';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { DEFAULT_FILTERS, isSuppressed, loadDashboard, numberFormat, type Dashboard as DashboardData, type Filters } from '../lib/metrics';

type Load = { k: 'loading' } | { k: 'failed' } | { k: 'ready'; data: DashboardData };

type Translate = ReturnType<typeof useTranslations>;

const card = 'rounded-staff border border-border bg-surface p-[18px]';
const select = 'tap rounded-input border border-[#9AAAA7] bg-surface px-2.5 text-[15px] font-[inherit] text-ink';
/** Chart colours the boards use that the tokens do not name: the funnel's last bar, the track, a flagged bar and its label. */
const BAR = '#0E6B63';
const BAR_LIGHT = '#5FA89D';
const TRACK = '#EEF2F1';
const FLAG_BAR = '#C26A12';
const FLAG_INK = '#7A3E06';

/**
 * The programme lead's dashboard, from the Ops board: headline measures, the referral funnel with its note, the equity
 * view by group, timeliness by tier with the overdue list, and crisis response. It shows only what the API returns, and
 * the API has already hidden every number under ten people (and any cell that would give one away), which this screen
 * shows as "Suppressed" and nothing else. Every figure is simulated sample data and the screen says so.
 */
export function Dashboard({ session, signOut }: { session: Session; signOut: () => void }) {
  const t = useTranslations('dash');
  const home = useTranslations('home');
  const locale = useLocale();
  const lang = isLocale(locale) ? locale : 'en';
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [load, setLoad] = useState<Load>({ k: 'loading' });
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    void loadDashboard(session, filters).then((result) => {
      if (!active) return;
      if (result.status === 'unauthorized') return signOut();
      setLoad(result.status === 'ok' ? { k: 'ready', data: result.data } : { k: 'failed' });
    });
    return () => {
      active = false;
    };
  }, [session, filters, reload, signOut]);

  const change = (next: Partial<Filters>) => {
    setLoad({ k: 'loading' });
    setFilters((current) => ({ ...current, ...next }));
  };

  return (
    <main className="mx-auto flex max-w-[1360px] flex-col gap-5 px-6 py-7" data-screen="ops-dashboard">
      <header className="flex flex-wrap items-center gap-3">
        <div className="flex flex-[1_1_320px] items-center gap-2.5">
          <BrandMark className="shrink-0 text-accent" />
          <h1 className="t-h1">{t('title')}</h1>
        </div>
        <label className="sr-only" htmlFor="period">{t('filters.period')}</label>
        <select id="period" className={select} value={filters.period} onChange={(event) => change({ period: event.target.value as MetricPeriod })} data-filter="period">
          {METRIC_PERIODS.map((period) => <option key={period} value={period}>{t(`filters.periods.${period}`)}</option>)}
        </select>
        <label className="sr-only" htmlFor="source">{t('filters.source')}</label>
        <select id="source" className={select} value={filters.source ?? ''} onChange={(event) => change({ source: (event.target.value || null) as TicketSource | null })} data-filter="source">
          <option value="">{t('filters.allSources')}</option>
          {TICKET_SOURCES.map((source) => <option key={source} value={source}>{t(`source.${source}`)}</option>)}
        </select>
        <label className="sr-only" htmlFor="tier">{t('filters.tier')}</label>
        <select id="tier" className={select} value={filters.tier ?? ''} onChange={(event) => change({ tier: (event.target.value || null) as TicketTier | null })} data-filter="tier">
          <option value="">{t('filters.allTiers')}</option>
          {TICKET_TIERS.map((tier) => <option key={tier} value={tier}>{t(`tier.${tier}`)}</option>)}
        </select>
        <span className="t-label rounded-chip bg-mock px-2.5 py-1 font-semibold text-mock-ink" data-simulated>{home('simulated')}</span>
        <button type="button" className="tap rounded-pill border border-border px-4 text-[14px] font-semibold" onClick={signOut}>{t('signOut')}</button>
      </header>
      <p className="t-small -mt-2 text-muted" data-simulated-note>{t('simulatedNote')}</p>

      {load.k === 'loading' && <p role="status" className="t-body text-muted">{t('loading')}</p>}
      {load.k === 'failed' && (
        <div role="alert" className={`${card} flex flex-col items-start gap-2`}>
          <p className="t-body">{t('failed')}</p>
          <button type="button" className="btn-primary" onClick={() => { setLoad({ k: 'loading' }); setReload((n) => n + 1); }}>{t('retry')}</button>
        </div>
      )}
      {load.k === 'ready' && <Ready data={load.data} t={t} lang={lang} />}
    </main>
  );
}

function Ready({ data, t, lang }: { data: DashboardData; t: Translate; lang: 'ar' | 'en' }) {
  const format = numberFormat(lang).format;
  return (
    <>
      <Tiles data={data} t={t} format={format} />
      <div className="flex flex-wrap items-stretch gap-3.5">
        <Funnel data={data} t={t} format={format} />
        <Equity equity={data.equity} t={t} format={format} />
      </div>
      <div className="flex flex-wrap gap-3.5">
        <Timeliness data={data} t={t} format={format} />
        <Safety data={data} t={t} format={format} />
      </div>
    </>
  );
}

function Tile({ id, label, value, note }: { id: string; label: string; value: string | null; note: string | null }) {
  const t = useTranslations('dash');
  return (
    <div className="rounded-staff border border-border bg-surface px-[18px] py-4" data-tile={id}>
      <div className="text-[14px] text-muted">{label}</div>
      <div className="text-[36px] font-bold leading-[44px]" data-value>{value ?? <span className="text-[16px] font-normal text-muted" data-suppressed>{t('suppressed')}</span>}</div>
      <div className="text-[13px] text-muted">{note}</div>
    </div>
  );
}

function Tiles({ data, t, format }: { data: DashboardData; t: Translate; format: (value: number) => string }) {
  const { equity, timeliness, crisis } = data;
  const overall = equity.overall;
  const within = timeliness.overall;
  const withinRate = isSuppressed(within) || isSuppressed(within.withinTarget) ? null : within.withinTarget;
  const median = isSuppressed(within) ? null : within.medianDaysToSeen;
  const p90 = isSuppressed(within) ? null : within.p90DaysToSeen;
  const confirmed = crisis.contactConfirmed;
  return (
    <section aria-label={t('tiles.label')} className="grid gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(240px,1fr))]">
      <Tile id="loop-closed" label={t('tiles.loopClosed')} value={isSuppressed(overall) ? null : `${format(overall.ratePercent)}%`} note={isSuppressed(overall) ? null : t('tiles.loopClosedOf', { count: format(overall.loopClosed), of: format(overall.tickets) })} />
      <Tile id="within-target" label={t('tiles.withinTarget')} value={withinRate ? `${format(withinRate.percent)}%` : null} note={withinRate ? t('tiles.withinTargetOf', { count: format(withinRate.count), of: format(withinRate.of) }) : null} />
      <Tile
        id="median-seen"
        label={t('tiles.medianSeen')}
        value={typeof median === 'number' ? t('tiles.medianSeenDays', { days: format(median) }) : null}
        note={typeof p90 === 'number' ? t('tiles.medianSeenP90', { days: format(p90) }) : null}
      />
      <Tile id="crisis-contact" label={t('tiles.crisisContact')} value={isSuppressed(confirmed) ? null : `${format(confirmed.percent)}%`} note={isSuppressed(confirmed) ? null : t('tiles.crisisContactOf', { count: format(confirmed.count), of: format(confirmed.of) })} />
    </section>
  );
}

function Funnel({ data, t, format }: { data: DashboardData; t: Translate; format: (value: number) => string }) {
  const { stages } = data.funnel;
  const top = stages.reduce((max, stage) => (typeof stage.count === 'number' && stage.count > max ? stage.count : max), 0);
  return (
    <section aria-label={t('funnel.label')} className={`${card} flex min-w-0 flex-[1_1_520px] flex-col gap-3`} data-section="funnel">
      <h2 className="text-[17px] font-semibold">{t('funnel.heading')}</h2>
      {stages.map((stage, index) => {
        const count = stage.count;
        const width = typeof count === 'number' && top > 0 ? Math.max(2, Math.round((count / top) * 100)) : 0;
        return (
          <div key={stage.stage} className="flex flex-col gap-1" data-funnel-stage={stage.stage}>
            <div className="flex justify-between text-[14px]">
              <span>{t(`funnel.stage.${stage.stage}`)}</span>
              {isSuppressed(count) ? <span className="text-muted" data-suppressed>{t('suppressed')}</span> : <b data-count>{format(count)}</b>}
            </div>
            <div className="h-[22px] rounded bg-[#EEF2F1]" aria-hidden>
              <div className="h-[22px] rounded" style={{ width: `${width}%`, background: index === stages.length - 1 ? BAR_LIGHT : BAR }} />
            </div>
            {stage.carriedOn !== null && (
              <div className="text-[12px] text-muted" data-carried-on>
                {isSuppressed(stage.carriedOn) ? t('suppressedShort') : t('funnel.carriedOn', { percent: format(stage.carriedOn) })}
              </div>
            )}
          </div>
        );
      })}
      <p className="t-small rounded-input bg-warning px-3 py-2.5 text-warning-ink" role="note" data-funnel-note>{t('funnel.note')}</p>
      <p className="t-small text-muted">{t('funnel.journeys')}</p>
      <p className="t-small text-muted" data-filter-scope>{t('filters.scope')}</p>
    </section>
  );
}

const DIMENSIONS: readonly EquityDimension[] = ['language', 'age_band', 'gender', 'region'];

function Equity({ equity, t, format }: { equity: EquityResponse; t: Translate; format: (value: number) => string }) {
  const [dimension, setDimension] = useState<EquityDimension>('language');
  const rows = equity.dimensions.find((entry) => entry.dimension === dimension)?.rows ?? [];
  const overall = isSuppressed(equity.overall) ? null : equity.overall.ratePercent;
  const flagged = rows.flatMap((row) => (!isSuppressed(row.cell) && row.cell.flagged ? [{ value: row.value, cell: row.cell }] : []));
  return (
    <section aria-label={t('equity.label')} className={`${card} flex min-w-0 flex-[1_1_440px] flex-col gap-3`} data-section="equity">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="min-w-[200px] flex-1 text-[17px] font-semibold">{t('equity.heading')}</h2>
        <div role="group" aria-label={t('equity.groupBy')} className="flex flex-wrap gap-1.5">
          {DIMENSIONS.map((entry) => (
            <button
              key={entry}
              type="button"
              aria-pressed={entry === dimension}
              data-dimension={entry}
              onClick={() => setDimension(entry)}
              className={`tap rounded-pill px-3 text-[13px] ${entry === dimension ? 'bg-ink text-surface' : 'border border-[#9AAAA7] bg-surface text-ink'}`}
            >
              {t(`equity.dimension.${entry}`)}
            </button>
          ))}
        </div>
      </div>
      <div className="grid items-center gap-x-3 gap-y-2.5 text-[14px] [grid-template-columns:110px_1fr_92px]" data-equity-rows={dimension}>
        {rows.map((row) => {
          const cell = row.cell;
          if (isSuppressed(cell)) {
            return (
              <div key={row.value} className="contents" data-equity-row={row.value} data-suppressed>
                <span className="text-muted">{t(`equity.value.${row.value}`)}</span>
                <span className="text-[13px] text-muted">{t('suppressed')}</span>
                <span className="text-muted">{t('suppressedShort')}</span>
              </div>
            );
          }
          return (
            <div key={row.value} className="contents" data-equity-row={row.value} data-flagged={cell.flagged} data-gap={cell.gapPoints}>
              <span className={cell.flagged ? 'font-semibold' : ''} style={cell.flagged ? { color: FLAG_INK } : undefined}>{t(`equity.value.${row.value}`)}</span>
              <div className="relative h-[18px] rounded" style={{ background: TRACK }} aria-hidden>
                <div className="h-[18px] rounded" style={{ width: `${cell.ratePercent}%`, background: cell.flagged ? FLAG_BAR : BAR }} />
                {overall !== null && <div className="absolute -top-1 h-[26px] w-0.5 bg-ink" style={{ insetInlineStart: `${overall}%` }} />}
              </div>
              <span><b>{`${format(cell.ratePercent)}%`}</b> {t('equity.n', { count: format(cell.tickets) })}</span>
            </div>
          );
        })}
      </div>
      {flagged.map(({ value, cell }) => (
        <p key={value} className="flex gap-2 rounded-input bg-warning px-3 py-2.5 text-[14px] leading-5 text-warning-ink" role="note" data-flag={value}>
          <span>
            <b>{t(cell.gapPoints < 0 ? 'equity.flagBelow' : 'equity.flagAbove', { group: t(`equity.value.${value}`), points: format(Math.abs(cell.gapPoints)), overall: format(overall ?? 0) })}</b>
          </span>
        </p>
      ))}
      <p className="t-small text-muted">{t('equity.basis')}</p>
    </section>
  );
}

function Timeliness({ data, t, format }: { data: DashboardData; t: Translate; format: (value: number) => string }) {
  const { timeliness } = data;
  const rows = [{ id: 'overall', label: t('timeliness.overall'), cell: timeliness.overall }, ...timeliness.tiers.map((entry) => ({ id: entry.tier, label: t(`tier.${entry.tier}`), cell: entry.cell }))];
  const overdue = timeliness.overdue;
  return (
    <section aria-label={t('timeliness.label')} className={`${card} flex min-w-0 flex-[1_1_420px] flex-col gap-3 overflow-x-auto`} data-section="timeliness">
      <h2 className="text-[17px] font-semibold">{t('timeliness.heading')}</h2>
      <table className="w-full border-collapse text-[14px]">
        <thead>
          <tr className="text-start text-[12px] uppercase tracking-[0.5px] text-muted">
            {(['tier', 'tickets', 'within', 'median', 'p90'] as const).map((column) => <th key={column} scope="col" className="border-b border-border px-1.5 py-2 text-start font-normal">{t(`timeliness.${column}`)}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ id, label, cell }) => {
            const hidden = isSuppressed(cell);
            const withinHidden = hidden || isSuppressed(cell.withinTarget);
            return (
              <tr key={id} data-tier-row={id} data-suppressed={hidden ? '' : undefined}>
                <td className="border-b border-[#E6ECEA] px-1.5 py-2.5">{label}</td>
                {hidden ? (
                  <td colSpan={4} className="border-b border-[#E6ECEA] px-1.5 py-2.5 text-muted">{t('suppressed')}</td>
                ) : (
                  <>
                    <td className="border-b border-[#E6ECEA] px-1.5 py-2.5">{format(cell.tickets)}</td>
                    <td className="border-b border-[#E6ECEA] px-1.5 py-2.5">{withinHidden || isSuppressed(cell.withinTarget) ? t('suppressedShort') : `${format(cell.withinTarget.percent)}%`}</td>
                    <td className="border-b border-[#E6ECEA] px-1.5 py-2.5">{isSuppressed(cell.medianDaysToSeen) ? t('suppressedShort') : t('timeliness.days', { days: format(cell.medianDaysToSeen) })}</td>
                    <td className="border-b border-[#E6ECEA] px-1.5 py-2.5">{isSuppressed(cell.p90DaysToSeen) ? t('suppressedShort') : t('timeliness.days', { days: format(cell.p90DaysToSeen) })}</td>
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="t-small text-muted">{t('timeliness.basis')}</p>

      <h3 className="text-[15px] font-semibold">{t('timeliness.overdueHeading')}</h3>
      {isSuppressed(overdue) ? (
        <p className="t-small text-muted" data-overdue-suppressed>{t('suppressed')}</p>
      ) : (
        <div data-overdue-list className="flex flex-col gap-1.5">
          <p className="t-small">{t('timeliness.overdueCount', { count: format(overdue.count) })}{overdue.shown < overdue.count ? ` · ${t('timeliness.overdueShown', { shown: format(overdue.shown) })}` : ''}</p>
          <ul className="flex flex-col gap-1">
            {overdue.tickets.map((ticket) => (
              <li key={ticket.id} className="flex justify-between gap-2 border-b border-[#E6ECEA] py-1 text-[14px]">
                <span className="t-code" dir="ltr">{ticket.id}</span>
                <span>{t('timeliness.daysOverdue', { days: format(ticket.daysOverdue) })}</span>
              </li>
            ))}
          </ul>
          <p className="t-small text-muted">{t('timeliness.overdueIds')}</p>
        </div>
      )}

      <details className="text-[14px]">
        <summary className="tap flex cursor-pointer items-center font-semibold">{t('timeliness.waitHeading')}</summary>
        <p className="t-small mb-2 rounded-chip bg-mock px-2 py-1 text-mock-ink">{t('timeliness.waitNote')}</p>
        <ul className="flex flex-col gap-1">
          {timeliness.indicativeWait.map((service) => (
            <li key={service.service} className="flex justify-between gap-2 border-b border-[#E6ECEA] py-1">
              <span dir="auto">{service.service}</span>
              <span>{t('timeliness.waitDays', { days: format(service.days) })}</span>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

function Safety({ data, t, format }: { data: DashboardData; t: Translate; format: (value: number) => string }) {
  const { crisis } = data;
  const stat = (id: string, label: string, value: string | null) => (
    <div className="rounded-input bg-ground px-3 py-2.5" data-crisis-stat={id}>
      <div className="text-[12px] text-muted">{label}</div>
      <div className="text-[22px] font-bold" data-value>{value ?? <span className="text-[13px] font-normal text-muted" data-suppressed>{t('suppressed')}</span>}</div>
    </div>
  );
  return (
    <section aria-label={t('safety.label')} className={`${card} flex min-w-0 flex-[1_1_420px] flex-col gap-2.5`} data-section="safety">
      <h2 className="text-[17px] font-semibold">{t('safety.heading')}</h2>
      <div className="grid grid-cols-3 gap-2.5">
        {stat('shown', t('safety.shown'), isSuppressed(crisis.shown) ? null : format(crisis.shown))}
        {stat('called', t('safety.called'), isSuppressed(crisis.calledALine) ? null : t('safety.of', { count: format(crisis.calledALine.count), of: format(crisis.calledALine.of) }))}
        {stat('median', t('safety.median'), isSuppressed(crisis.medianMinutesToContact) ? null : t('safety.minutes', { minutes: format(crisis.medianMinutesToContact) }))}
      </div>
      <div className="rounded-input bg-ground px-3 py-2.5" data-crisis-stat="confirmed">
        <div className="text-[12px] text-muted">{t('safety.confirmed')}</div>
        <div className="text-[22px] font-bold" data-value>
          {isSuppressed(crisis.contactConfirmed) ? <span className="text-[13px] font-normal text-muted" data-suppressed>{t('suppressed')}</span> : t('safety.of', { count: format(crisis.contactConfirmed.count), of: format(crisis.contactConfirmed.of) })}
        </div>
      </div>
      <p className="t-small text-muted">{t('safety.note')}</p>
    </section>
  );
}
