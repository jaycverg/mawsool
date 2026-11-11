'use client';

import {
  ADVERSE_EVENT_SEVERITIES,
  ADVERSE_EVENT_STATUSES,
  ADVERSE_EVENT_TYPES,
  TICKET_REF_PATTERN,
  type AdverseEvent,
  type AdverseEventSeverity,
  type AdverseEventStatus,
  type AdverseEventType,
  type AdverseEventsResponse,
  type Session,
} from '@mawsool/types';
import { useTranslations } from 'next-intl';
import { useEffect, useState, type FormEvent } from 'react';
import { NEXT_STATUSES, NO_LOG_FILTERS, loadLog, moveEvent, recordEvent, type LogFilters } from '../lib/adverse-events';
import { numberFormat } from '../lib/metrics';
import { InfoPanel } from './InfoPanel';

const select = 'tap rounded-input border border-[#9AAAA7] bg-surface px-2.5 text-[15px] font-[inherit] text-ink';
type Load = { k: 'loading' } | { k: 'failed' } | { k: 'ready'; log: AdverseEventsResponse };
type Notice = 'recorded' | 'invalid' | 'failed' | 'moved' | 'conflict' | null;

/** When something happened, in the programme's own time zone (Abu Dhabi), in the page's language. */
const when = (iso: string, lang: 'ar' | 'en') => new Intl.DateTimeFormat(lang === 'ar' ? 'ar-AE-u-nu-latn' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Dubai' }).format(new Date(iso));

/**
 * The adverse-events log: events listed by status and severity, a short form to record one (a coded type, a severity and,
 * if the event concerns a ticket, that ticket's pseudonymous id from the overdue list), and the moves a status can make.
 * It takes no name, number, score or note: nothing about a person can be typed here. It sits inside the ops session.
 */
export function AdverseEvents({ session, signOut, lang }: { session: Session; signOut: () => void; lang: 'ar' | 'en' }) {
  const t = useTranslations('adverse');
  const [filters, setFilters] = useState<LogFilters>(NO_LOG_FILTERS);
  const [load, setLoad] = useState<Load>({ k: 'loading' });
  const [reload, setReload] = useState(0);
  const [notice, setNotice] = useState<Notice>(null);
  const [type, setType] = useState<AdverseEventType>('missed_crisis_follow_up');
  const [severity, setSeverity] = useState<AdverseEventSeverity>('moderate');
  const [ticketRef, setTicketRef] = useState('');
  const [busy, setBusy] = useState(false);
  const format = numberFormat(lang).format;

  useEffect(() => {
    let active = true;
    void loadLog(session, filters).then((result) => {
      if (!active) return;
      if (result.status === 'unauthorized') return signOut();
      setLoad(result.status === 'ok' ? { k: 'ready', log: result.log } : { k: 'failed' });
    });
    return () => {
      active = false;
    };
  }, [session, filters, reload, signOut]);

  const refresh = () => setReload((n) => n + 1);
  const refValid = ticketRef.trim() === '' || TICKET_REF_PATTERN.test(ticketRef.trim());

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!refValid || busy) return;
    setBusy(true);
    setNotice(null);
    const result = await recordEvent(session, { type, severity, ticketRef: ticketRef.trim() || null });
    setBusy(false);
    if (result.status === 'unauthorized') return signOut();
    setNotice(result.status === 'recorded' ? 'recorded' : result.status === 'invalid' ? 'invalid' : 'failed');
    if (result.status === 'recorded') {
      setTicketRef('');
      refresh();
    }
  }

  async function move(item: AdverseEvent, to: AdverseEventStatus) {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    const result = await moveEvent(session, item.id, to);
    setBusy(false);
    if (result.status === 'unauthorized') return signOut();
    setNotice(result.status === 'moved' ? 'moved' : result.status === 'conflict' ? 'conflict' : 'failed');
    refresh();
  }

  return (
    <section aria-label={t('label')} className="flex min-w-0 flex-[1_1_520px] flex-col gap-3 rounded-staff border border-border bg-surface p-[18px]" data-section="adverse-events">
      <h2 className="text-[17px] font-bold">{t('heading')}</h2>
      <InfoPanel id="adverse-events" label={t('heading')} />

      <form onSubmit={(event) => void submit(event)} className="flex flex-wrap items-end gap-2.5 rounded-input bg-ground p-3" data-adverse-form>
        <label className="flex flex-col gap-1 text-[13px] font-semibold">
          {t('type')}
          <select className={select} value={type} onChange={(event) => setType(event.target.value as AdverseEventType)} data-field="type">
            {ADVERSE_EVENT_TYPES.map((entry) => <option key={entry} value={entry}>{t(`types.${entry}`)}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[13px] font-semibold">
          {t('severity')}
          <select className={select} value={severity} onChange={(event) => setSeverity(event.target.value as AdverseEventSeverity)} data-field="severity">
            {ADVERSE_EVENT_SEVERITIES.map((entry) => <option key={entry} value={entry}>{t(`severities.${entry}`)}</option>)}
          </select>
        </label>
        <label className="flex min-w-[150px] flex-1 flex-col gap-1 text-[13px] font-semibold">
          {t('ticketRef')}
          <input
            className={`${select} w-full`}
            dir="ltr"
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="od_0123456789ab"
            value={ticketRef}
            aria-invalid={!refValid}
            aria-describedby="adverse-ref-help"
            onChange={(event) => setTicketRef(event.target.value)}
            data-field="ticket-ref"
          />
        </label>
        <button type="submit" className="btn-primary" disabled={busy || !refValid} data-adverse-record>{t('record')}</button>
        <p id="adverse-ref-help" className={`basis-full text-[12px] ${refValid ? 'text-muted' : 'text-danger'}`}>{refValid ? t('ticketRefHelp') : t('ticketRefInvalid')}</p>
      </form>
      <p className="t-small text-muted">{t('noPerson')}</p>
      {notice && <p role={notice === 'recorded' || notice === 'moved' ? 'status' : 'alert'} className={`t-small font-semibold ${notice === 'recorded' || notice === 'moved' ? 'text-accent-dark' : 'text-danger'}`} data-adverse-notice={notice}>{t(`notice.${notice}`)}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="adverse-status">{t('filterStatus')}</label>
        <select id="adverse-status" className={select} value={filters.status ?? ''} onChange={(event) => { setLoad({ k: 'loading' }); setFilters((current) => ({ ...current, status: (event.target.value || null) as AdverseEventStatus | null })); }} data-filter="adverse-status">
          <option value="">{t('allStatuses')}</option>
          {ADVERSE_EVENT_STATUSES.map((entry) => <option key={entry} value={entry}>{t(`statuses.${entry}`)}</option>)}
        </select>
        <label className="sr-only" htmlFor="adverse-severity">{t('filterSeverity')}</label>
        <select id="adverse-severity" className={select} value={filters.severity ?? ''} onChange={(event) => { setLoad({ k: 'loading' }); setFilters((current) => ({ ...current, severity: (event.target.value || null) as AdverseEventSeverity | null })); }} data-filter="adverse-severity">
          <option value="">{t('allSeverities')}</option>
          {ADVERSE_EVENT_SEVERITIES.map((entry) => <option key={entry} value={entry}>{t(`severities.${entry}`)}</option>)}
        </select>
      </div>

      {load.k === 'loading' && <p role="status" className="t-small text-muted">{t('loading')}</p>}
      {load.k === 'failed' && (
        <div role="alert" className="flex flex-col items-start gap-2">
          <p className="t-small">{t('failed')}</p>
          <button type="button" className="tap rounded-pill border border-border px-4 text-[14px] font-semibold" onClick={() => { setLoad({ k: 'loading' }); refresh(); }}>{t('retry')}</button>
        </div>
      )}
      {load.k === 'ready' && (
        <>
          <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" aria-label={t('counts')} data-adverse-counts>
            {ADVERSE_EVENT_STATUSES.map((entry) => <li key={entry} className="rounded-chip bg-ground px-2.5 py-1 text-[13px]" data-count-status={entry}>{t('countLine', { label: t(`statuses.${entry}`), count: format(load.log.counts.byStatus[entry]) })}</li>)}
            {ADVERSE_EVENT_SEVERITIES.map((entry) => <li key={entry} className="rounded-chip bg-ground px-2.5 py-1 text-[13px]" data-count-severity={entry}>{t('countLine', { label: t(`severities.${entry}`), count: format(load.log.counts.bySeverity[entry]) })}</li>)}
          </ul>
          {load.log.items.length === 0 ? (
            <p className="t-small text-muted" data-adverse-empty>{t('empty')}</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-2 p-0" data-adverse-list>
              {load.log.items.map((item) => (
                <li key={item.id} className="flex flex-col gap-1.5 rounded-input border border-border p-3" data-adverse-event={item.id} data-status={item.status} data-severity={item.severity}>
                  <div className="flex flex-wrap items-center gap-2 text-[14px]">
                    <b>{t(`types.${item.type}`)}</b>
                    <span className="rounded-chip bg-ground px-2 py-0.5 text-[12px] font-semibold" data-badge="severity">{t(`severities.${item.severity}`)}</span>
                    <span className="rounded-chip bg-ground px-2 py-0.5 text-[12px] font-semibold" data-badge="status">{t(`statuses.${item.status}`)}</span>
                  </div>
                  <div className="text-[13px] text-muted">
                    {t('happened', { at: when(item.occurredAt, lang) })} · {t('recorded', { at: when(item.recordedAt, lang) })}
                    {item.ticketRef && <> · <span className="t-code" dir="ltr">{item.ticketRef}</span></>}
                  </div>
                  <details className="text-[13px]">
                    <summary className="tap flex cursor-pointer items-center">{t('history', { count: format(item.history.length) })}</summary>
                    <ol className="m-0 flex list-none flex-col gap-1 p-0 pt-1" data-adverse-history>
                      {item.history.map((entry, index) => (
                        <li key={index}>{entry.from === null ? t('moveFirst', { to: t(`statuses.${entry.to}`), at: when(entry.at, lang), by: t(`roles.${entry.by}`) }) : t('move', { from: t(`statuses.${entry.from}`), to: t(`statuses.${entry.to}`), at: when(entry.at, lang), by: t(`roles.${entry.by}`) })}</li>
                      ))}
                    </ol>
                  </details>
                  {NEXT_STATUSES[item.status].length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {NEXT_STATUSES[item.status].map((to) => (
                        <button key={to} type="button" className="tap rounded-pill border border-[#9AAAA7] bg-surface px-3 text-[13px] font-semibold" disabled={busy} onClick={() => void move(item, to)} data-move={to}>
                          {t(`moveTo.${to}`)}
                        </button>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
