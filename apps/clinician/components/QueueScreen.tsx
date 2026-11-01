'use client';

import { QUEUE_STATE_FILTERS, StaffQueueSchema, type QueueStateFilter, type Session, type StaffQueue, type StaffTicketView, type Tier } from '@mawsool/types';
import { calendarDaysUntil, demoNow, formatDate, isLocale, staffCall } from '@mawsool/ui';
import { BrandMark, LanguageToggle, RequireStaffSession, useDemoClockSync } from '@mawsool/ui/components';
import { useLocale, useTranslations } from 'next-intl';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { API_URL, QUEUE_TIERS, addressQuery, deadlineOf, displayCode, queueQuery, ticketIdFromQuery, viewFromQuery, type QueueView } from '../lib/queue';
import { TicketDetail } from './TicketDetail';

type Load = { k: 'loading' } | { k: 'failed' } | { k: 'ready'; queue: StaffQueue };

/** The staff home: the incoming queue beside the ticket that is open, behind the sign-in guard. */
export function QueueScreen() {
  const locale = useLocale();
  const root = useTranslations();
  return (
    <RequireStaffSession roles={['clinician']} signInHref={`/${locale}/sign-in/`} checkingLabel={root('signIn.checking')}>
      {(session, signOut) => <Queue session={session} signOut={signOut} />}
    </RequireStaffSession>
  );
}

function Queue({ session, signOut }: { session: Session; signOut: () => void }) {
  // The deadlines and "days late" are counted on the same clock as the API's sweep, so they move with the demo clock.
  useDemoClockSync(API_URL);
  const t = useTranslations('queue');
  const nav = useTranslations('nav');
  const root = useTranslations();
  const locale = useLocale();
  const lang = isLocale(locale) ? locale : 'en';
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const view = viewFromQuery(params);
  const openId = ticketIdFromQuery(params);
  const [load, setLoad] = useState<Load>({ k: 'loading' });
  const [reload, setReload] = useState(0);
  const state = view.state;
  const tier = view.tier;

  const go = useCallback(
    (next: QueueView, ticketId: string | null) => router.replace(`${pathname}${addressQuery(next, ticketId)}`),
    [router, pathname],
  );

  useEffect(() => {
    let active = true;
    void staffCall<unknown>({ fetch: window.fetch.bind(window), apiUrl: API_URL, session, path: `/tickets${queueQuery({ state, tier })}` }).then((result) => {
      if (!active) return;
      if (result.status === 'unauthorized') return signOut();
      const parsed = result.status === 'ok' ? StaffQueueSchema.safeParse(result.body) : null;
      setLoad(parsed?.success ? { k: 'ready', queue: parsed.data } : { k: 'failed' });
    });
    return () => {
      active = false;
    };
  }, [session, state, tier, reload, signOut]);

  const counts = load.k === 'ready' ? load.queue.counts : {};
  const count = (states: readonly QueueStateFilter[]) => (load.k === 'ready' ? states.reduce((sum, s) => sum + (s === 'open' ? (counts.issued ?? 0) + (counts.acknowledged ?? 0) + (counts.overdue ?? 0) : (counts[s] ?? 0)), 0) : null);
  const shortcuts: { id: QueueStateFilter; label: string; tone?: string }[] = [
    { id: 'open', label: nav('open') },
    { id: 'issued', label: nav('incoming') },
    { id: 'acknowledged', label: nav('acknowledged') },
    { id: 'overdue', label: nav('overdue'), tone: 'text-[#F6C784]' },
    { id: 'seen', label: nav('seen') },
  ];

  return (
    <div className="flex min-h-dvh flex-wrap">
      <nav aria-label={nav('label')} className="flex flex-[1_1_220px] flex-col gap-5 bg-ink px-4 py-6 text-surface md:max-w-[260px]">
        <div className="flex items-center gap-2" data-brand>
          <BrandMark className="shrink-0 text-[#7FD1C2]" />
          <span className="wordmark">{root('common.appName')}</span>
          <span className="text-[13px] text-[#B9CFCB]">{nav('label')}</span>
        </div>
        <div className="rounded-input bg-[#1B4440] px-3 py-2.5" data-facility>
          <div className="text-[12px] text-[#B9CFCB]">{nav('facility')}</div>
          <div className="text-[14px] font-semibold" dir="auto">{load.k === 'ready' ? load.queue.facility.name : '…'}</div>
        </div>
        <div className="flex flex-col gap-1" role="group" aria-label={nav('filters')}>
          {shortcuts.map((shortcut) => {
            const current = state === shortcut.id;
            const n = count([shortcut.id]);
            return (
              <button
                key={shortcut.id}
                type="button"
                data-shortcut={shortcut.id}
                aria-pressed={current}
                onClick={() => go({ state: shortcut.id, tier }, null)}
                className={`flex min-h-tap items-center justify-between rounded-input px-3 text-start text-[15px] ${current ? 'bg-accent font-semibold text-surface' : (shortcut.tone ?? 'text-[#E1ECEA]')}`}
              >
                {shortcut.label}
                {n !== null && <span className="text-[13px]" data-count={shortcut.id}>{n}</span>}
              </button>
            );
          })}
        </div>
        <div className="mt-auto flex flex-col gap-2 text-[13px] text-[#B9CFCB]">
          <span>{nav('logged')}</span>
          <button type="button" className="tap self-start rounded-pill border border-[#B9CFCB] px-4 text-[14px] font-semibold text-surface" onClick={signOut}>{root('signIn.signOut')}</button>
        </div>
      </nav>

      <main className="flex min-w-0 flex-[999_1_560px] flex-col gap-4 p-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="t-h1 flex-1 basis-60">{root('home.heading')}</h1>
          <label className="flex items-center gap-2 text-[14px]">
            {t('stateFilter')}
            <select className="tap rounded-input border border-[#9AAAA7] bg-surface px-3 text-[15px]" value={state} onChange={(event) => go({ state: event.target.value as QueueStateFilter, tier }, null)} data-filter="state">
              {QUEUE_STATE_FILTERS.map((option) => <option key={option} value={option}>{root(`state.${option}`)}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-2 text-[14px]">
            {t('tierFilter')}
            <select className="tap rounded-input border border-[#9AAAA7] bg-surface px-3 text-[15px]" value={tier ?? ''} onChange={(event) => go({ state, tier: (event.target.value || null) as Tier | null }, null)} data-filter="tier">
              <option value="">{t('allTiers')}</option>
              {QUEUE_TIERS.map((option) => <option key={option} value={option}>{root(`tier.${option}`)}</option>)}
            </select>
          </label>
          <span className="t-label rounded-chip bg-mock px-2.5 py-1 font-semibold text-mock-ink">{root('home.simulated')}</span>
          <LanguageToggle locale={lang} ariaLabel={root('common.language')} />
        </div>

        <div className="flex flex-wrap items-start gap-4">
          <section aria-label={t('label')} className="min-w-0 flex-[3_1_520px] overflow-x-auto rounded-staff border border-border bg-surface" data-queue>
            {load.k === 'loading' && <p role="status" className="t-body p-4 text-muted">{t('loading')}</p>}
            {load.k === 'failed' && (
              <div role="alert" className="flex flex-col gap-2 p-4">
                <p className="t-body">{t('failed')}</p>
                <button type="button" className="btn-primary self-start" onClick={() => { setLoad({ k: 'loading' }); setReload((n) => n + 1); }}>{t('retry')}</button>
              </div>
            )}
            {load.k === 'ready' && load.queue.items.length === 0 && <p className="t-body p-4 text-muted" data-empty>{t('empty')}</p>}
            {load.k === 'ready' && load.queue.items.length > 0 && (
              <>
                <table className="w-full min-w-[620px] border-collapse text-[14px]">
                  <thead>
                    <tr className="text-start text-[12px] uppercase tracking-[0.5px] text-muted">
                      {(['ticket', 'need', 'beSeenBy', 'language', 'source', 'status'] as const).map((column) => <th key={column} scope="col" className="border-b border-border px-3.5 py-3 text-start font-normal">{t(column)}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {load.queue.items.map((item) => <Row key={item.id} item={item} lang={lang} selected={item.id === openId} onOpen={() => go(view, item.id)} />)}
                  </tbody>
                </table>
                {load.queue.total > load.queue.items.length && <p className="t-small border-t border-border p-3 text-muted" data-showing>{t('showing', { shown: load.queue.items.length, total: load.queue.total })}</p>}
              </>
            )}
          </section>

          <div className="min-w-0 flex-[2_1_340px]">
            {openId ? (
              <TicketDetail key={openId} session={session} ticketId={openId} onChanged={() => setReload((n) => n + 1)} onUnauthorized={signOut} />
            ) : (
              <p className="t-body rounded-staff border border-border bg-surface p-[18px] text-muted" data-detail-empty>{root('detail.none')}</p>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function Row({ item, lang, selected, onOpen }: { item: StaffTicketView; lang: 'ar' | 'en'; selected: boolean; onOpen: () => void }) {
  const t = useTranslations('queue');
  const root = useTranslations();
  const late = item.state === 'overdue';
  const daysUntil = calendarDaysUntil(item.deadlineAt, demoNow());
  const deadline = deadlineOf(daysUntil);
  const cell = 'border-b border-[#E6ECEA] px-3.5 py-3';
  return (
    <tr className={`${late ? 'bg-warning' : selected ? 'bg-accent-tint' : ''} ${selected ? 'shadow-[inset_4px_0_0_#0E6B63] rtl:shadow-[inset_-4px_0_0_#0E6B63]' : ''}`} data-ticket={item.shortCode} data-state={item.state} data-selected={selected || undefined}>
      <td className={cell}>
        <button type="button" className="tap t-code whitespace-nowrap text-start" dir="ltr" aria-label={`${t('open')} ${displayCode(item.shortCode)}`} aria-current={selected ? 'true' : undefined} onClick={onOpen}>
          {displayCode(item.shortCode)}
        </button>
      </td>
      <td className={cell}>{root(`tier.${item.tier}`)}</td>
      <td className={`${cell} ${late ? 'font-semibold text-[#7A3E06]' : ''}`} data-days-until={daysUntil}>
        {formatDate(item.deadlineAt, lang, 'long')} · {deadline.kind === 'left' ? t('daysLeft', { count: deadline.days }) : t('daysLate', { count: deadline.days })}
      </td>
      <td className={cell}>{root(`language.${item.language}`)}</td>
      <td className={cell}>{root(`source.${item.source}`)}</td>
      <td className={cell}>
        <span className={`whitespace-nowrap rounded-chip px-2 py-[3px] text-[12px] font-semibold ${chipClass(item.state, selected)}`}>{root(`state.${item.state}`)}</span>
      </td>
    </tr>
  );
}

/** The status chip of a row, from the board: overdue in the warning amber, acknowledged in white on the selected row (the same tint as the detail's chip elsewhere), every other state in the plain grey. */
function chipClass(state: string, selected: boolean): string {
  if (state === 'overdue') return 'bg-[#F6D9A8] text-warning-ink';
  if (state === 'acknowledged') return `${selected ? 'bg-surface' : 'bg-accent-tint'} text-accent-dark`;
  return 'bg-[#EEF2F1]';
}
