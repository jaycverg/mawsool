'use client';

import { PersonTicketViewSchema, REROUTE_REASONS, type ConsentElement, type PersonTicketView, type RerouteReason, type TicketEventView } from '@mawsool/types';
import { isLocale } from '@mawsool/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import { API_URL } from '../lib/api';
import { deviceNow } from '../lib/clock';
import { followUpAt, followUpDue } from '../lib/day7';
import { formatDate } from '../lib/format';
import { href } from '../lib/routes';
import { callServer, type ServerDeps } from '../lib/server';
import { loadTickets } from '../lib/share';
import { useDevice, type Device } from '../lib/use-device';
import { BottomNav } from './BottomNav';
import { HomeHeader } from './HomeHeader';
import { QrCode } from './QrCode';

type Translate = ReturnType<typeof useTranslations>;
type Load = { status: 'loading' } | { status: 'none' } | { status: 'failed' } | { status: 'ready'; ticket: PersonTicketView; reads: { at: string; facilityName: string }[] };
type Panel = 'none' | 'reason' | 'declining' | 'withdrawing';

const ReadsSchema = z.array(z.object({ at: z.string(), role: z.string(), facilityName: z.string() }));
const DAY_MS = 86_400_000;

/**
 * The ticket: its code and QR, the clinic and the deadline, a progress timeline built from the server's events, the
 * "did you get seen?" check once it is due, and a sharing panel that lists every consent with a control to stop
 * each one and a list of who opened the bundle. The ticket is addressed by `?id=`, or the newest one on this phone.
 */
export function TicketScreen() {
  const t = useTranslations('ticket');
  const locale = useLocale();
  const lang = isLocale(locale) ? locale : 'en';
  const requested = useSearchParams().get('id');
  const device = useDevice();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [panel, setPanel] = useState<Panel>('none');
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const serverDeps = useCallback((d: Device): ServerDeps => ({ storage: d.storage, fetch: window.fetch.bind(window), apiUrl: API_URL, locale: lang, random: window.crypto }), [lang]);

  const refresh = useCallback(async () => {
    if (device === null || device === 'unavailable') return;
    setLoad({ status: 'loading' });
    const id = requested ?? (await loadTickets(device.storage).catch(() => [])).at(-1)?.id;
    if (!id) return setLoad({ status: 'none' });
    const deps = serverDeps(device);
    const [ticket, reads] = await Promise.all([callServer<unknown>(deps, 'GET', `/me/tickets/${id}`), callServer<unknown>(deps, 'GET', `/me/tickets/${id}/reads`)]);
    const parsed = ticket.ok ? PersonTicketViewSchema.safeParse(ticket.body) : null;
    if (!parsed?.success) return setLoad({ status: 'failed' });
    const readList = reads.ok ? ReadsSchema.safeParse(reads.body) : null;
    setLoad({ status: 'ready', ticket: parsed.data, reads: readList?.success ? readList.data : [] });
  }, [device, requested, serverDeps]);

  useEffect(() => void refresh(), [refresh]);

  async function act(run: (d: Device) => Promise<boolean>) {
    if (device === null || device === 'unavailable') return;
    setBusy(true);
    setFailed(false);
    const ok = await run(device).catch(() => false);
    setBusy(false);
    setPanel('none');
    if (ok) await refresh();
    else setFailed(true);
  }

  const post = (d: Device, ticketId: string, body: object) => callServer(serverDeps(d), 'POST', `/me/tickets/${ticketId}/events`, body).then((result) => result.ok);

  return (
    <div className="flex min-h-dvh flex-col">
      <HomeHeader />
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-3.5 p-4" data-screen="ticket">
        <h1 className="t-h1">{t('heading')}</h1>
        {load.status === 'loading' && <p className="t-body text-muted" role="status">{t('loading')}</p>}
        {load.status === 'none' && (
          <>
            <p className="t-body">{t('noTicket')}</p>
            <a className="btn-primary" href={href(lang, 'options')}>{t('seeOptions')}</a>
          </>
        )}
        {load.status === 'failed' && (
          <div role="alert" className="flex flex-col gap-2">
            <p className="t-body">{t('loadFailed')}</p>
            <button type="button" className="btn-primary" onClick={() => void refresh()}>{t('retry')}</button>
          </div>
        )}
        {load.status === 'ready' && (
          <Ready
            t={t}
            lang={lang}
            ticket={load.ticket}
            reads={load.reads}
            panel={panel}
            setPanel={setPanel}
            busy={busy}
            failed={failed}
            onSeen={() => void act((d) => post(d, load.ticket.id, { to: 'seen', selfConfirmed: true }))}
            onDecline={() => void act((d) => post(d, load.ticket.id, { to: 'declined' }))}
            onWithdraw={() => void act((d) => post(d, load.ticket.id, { to: 'withdrawn' }))}
            onStop={(consentId) => void act((d) => callServer(serverDeps(d), 'DELETE', `/consents/${consentId}`).then((result) => result.ok))}
            onReroute={(reason) => window.location.assign(href(lang, 'options', { reroute: load.ticket.id, reason }))}
          />
        )}
      </main>
      <BottomNav />
    </div>
  );
}

interface ReadyProps {
  t: Translate;
  lang: 'ar' | 'en';
  ticket: PersonTicketView;
  reads: { at: string; facilityName: string }[];
  panel: Panel;
  setPanel: (panel: Panel) => void;
  busy: boolean;
  failed: boolean;
  onSeen: () => void;
  onDecline: () => void;
  onWithdraw: () => void;
  onStop: (consentId: string) => void;
  onReroute: (reason: RerouteReason) => void;
}

function Ready({ t, lang, ticket, reads, panel, setPanel, busy, failed, onSeen, onDecline, onWithdraw, onStop, onReroute }: ReadyProps) {
  const now = deviceNow();
  const live = ['issued', 'acknowledged', 'overdue'].includes(ticket.state);
  const daysLeft = Math.ceil((Date.parse(ticket.deadlineAt) - now.getTime()) / DAY_MS);
  const due = followUpDue(ticket, now);
  return (
    <>
      <section className="overflow-hidden rounded-ticket border border-border bg-surface" data-ticket={ticket.shortCode}>
        <div className="flex items-center gap-3.5 bg-accent p-4 text-surface">
          <div className="flex flex-1 flex-col gap-0.5">
            <span className="text-[12px] font-semibold uppercase tracking-[0.8px] text-[#CDEAE3]">{t('referralTicket')}</span>
            <span className="t-code text-[28px] tracking-[2px]" dir="ltr" data-code>{`${ticket.shortCode.slice(0, 2)}-${ticket.shortCode.slice(2)}`}</span>
            <span className="text-[13px] text-[#CDEAE3]">{t('showAtReception')}</span>
          </div>
          <QrCode payload={ticket.qrPayload} label={t('qrLabel', { code: ticket.shortCode })} />
        </div>
        <div className="flex flex-col gap-1.5 px-4 py-3.5">
          <span className="text-[17px] font-semibold">{ticket.serviceName}</span>
          <span className="flex items-center gap-2 text-[15px]">
            {t('beSeenBy')} <b>{formatDate(ticket.deadlineAt, lang, 'long')}</b> · {live ? t('daysLeft', { count: Math.max(0, daysLeft) }) : ''}
          </span>
          <span className="t-small text-muted">{ticket.clinicName}</span>
        </div>
      </section>

      {ticket.state === 'withdrawn' && <p role="status" className="rounded-staff bg-accent-tint px-3.5 py-3 text-[14px]">{t('withdrawnNote')}</p>}
      {ticket.state === 'overdue' && (
        <section role="alert" className="flex flex-col gap-2 rounded-staff bg-warning px-3.5 py-3 text-warning-ink" data-prompt="overdue">
          <p className="text-[14px] font-semibold">{t('overduePrompt')}</p>
          <button type="button" className="btn-primary" onClick={() => onReroute('wait_too_long')}>{t('findAnother')}</button>
        </section>
      )}

      <Timeline t={t} lang={lang} ticket={ticket} />

      {due && (
        <section className="flex flex-col gap-2 rounded-card border-2 border-accent bg-surface p-4" data-prompt="follow-up">
          <h2 className="text-[16px] font-semibold">{t('followUpTitle')}</h2>
          {panel !== 'reason' ? (
            <>
              <button type="button" className="btn-primary" disabled={busy} onClick={onSeen}>{t('followUpYes')}</button>
              <button type="button" className="tap rounded-pill border-[1.5px] border-accent px-4 font-semibold text-accent" onClick={() => setPanel('reason')}>{t('followUpNotYet')}</button>
              <button type="button" className="tap rounded-pill border-[1.5px] border-border px-4 font-semibold" onClick={() => setPanel('declining')}>{t('followUpNo')}</button>
            </>
          ) : (
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-[14px] font-semibold">{t('reasonTitle')}</legend>
              {REROUTE_REASONS.filter((reason) => ['could_not_book', 'cost', 'wait_too_long', 'other'].includes(reason)).map((reason) => (
                <button key={reason} type="button" data-reason={reason} className="tap rounded-pill border-[1.5px] border-accent px-4 font-semibold text-accent" onClick={() => onReroute(reason)}>
                  {t(`reason.${reason as 'could_not_book'}`)}
                </button>
              ))}
              <p className="t-small text-muted">{t('reasonThen')}</p>
            </fieldset>
          )}
        </section>
      )}

      <section className="flex flex-col gap-1 rounded-staff bg-accent-tint px-3.5 py-3">
        <h2 className="text-[13px] font-semibold">{t('clinicContact')}</h2>
        <p className="text-[14px]" data-clinic-contact>{ticket.clinicContact}</p>
        <h2 className="mt-1 text-[13px] font-semibold">{t('whatToBring')}</h2>
        <p className="text-[14px]">{t('bring')}</p>
        {live && <p className="mt-1 text-[14px] leading-5">{t('askNote', { date: formatDate(followUpAt(ticket).toISOString(), lang, 'long') })}</p>}
      </section>

      {live && panel !== 'declining' && (
        <div className="flex gap-2.5">
          <button type="button" className="tap flex-1 rounded-pill border-[1.5px] border-accent px-3 font-semibold text-accent" onClick={() => onReroute('change_option')}>{t('changeOption')}</button>
          <button type="button" className="tap flex-1 rounded-pill px-3 font-semibold text-accent" onClick={() => setPanel('declining')}>{t('decline')}</button>
        </div>
      )}
      {panel === 'declining' && (
        <section role="alertdialog" aria-labelledby="decline-text" className="flex flex-col gap-2 rounded-staff border border-danger p-3">
          <p id="decline-text" className="text-[15px] font-semibold">{t('declineConfirm')}</p>
          <button type="button" className="tap rounded-pill bg-danger px-4 font-semibold text-surface" disabled={busy} onClick={onDecline}>{t('declineYes')}</button>
          <button type="button" className="tap rounded-pill border-[1.5px] border-border px-4 font-semibold" onClick={() => setPanel('none')}>{t('keep')}</button>
        </section>
      )}

      <section className="flex flex-col gap-2 rounded-card border border-border bg-surface p-4" data-panel="sharing">
        <h2 className="text-[16px] font-semibold">{t('sharingTitle')}</h2>
        <p className="t-small text-muted">{t('sharingBody')}</p>
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {ticket.consents.map((consent) => (
            <li key={consent.id} className="flex min-h-tap items-center justify-between gap-2" data-consent={consent.element} data-revoked={consent.revokedAt !== null || undefined}>
              <span className="text-[15px]">{t(`element.${consent.element as ConsentElement}`)}</span>
              {consent.revokedAt !== null ? (
                <span className="text-[13px] text-muted">{t('stopped')}</span>
              ) : consent.element === 'ticket' ? (
                <span className="text-[13px] text-muted">{t('shared')}</span>
              ) : (
                <button type="button" className="tap rounded-pill border-[1.5px] border-danger px-3 text-[14px] font-semibold text-danger" disabled={busy} aria-label={t('stop', { element: t(`element.${consent.element as ConsentElement}`) })} onClick={() => onStop(consent.id)}>
                  {t('stopButton')}
                </button>
              )}
            </li>
          ))}
        </ul>
        {ticket.consents.some((consent) => consent.element === 'ticket' && consent.revokedAt === null) && panel !== 'withdrawing' && (
          <button type="button" className="tap rounded-pill border-[1.5px] border-danger px-4 font-semibold text-danger" onClick={() => setPanel('withdrawing')}>{t('withdraw')}</button>
        )}
        {panel === 'withdrawing' && (
          <div role="alertdialog" aria-labelledby="withdraw-text" className="flex flex-col gap-2 rounded-staff border border-danger p-3">
            <p id="withdraw-text" className="text-[15px] font-semibold">{t('withdrawConfirm')}</p>
            <button type="button" className="tap rounded-pill bg-danger px-4 font-semibold text-surface" disabled={busy} onClick={onWithdraw}>{t('withdrawYes')}</button>
            <button type="button" className="tap rounded-pill border-[1.5px] border-border px-4 font-semibold" onClick={() => setPanel('none')}>{t('keep')}</button>
          </div>
        )}
        <h3 className="mt-1 text-[13px] font-semibold text-muted">{t('readsTitle')}</h3>
        {reads.length === 0 ? <p className="t-small text-muted">{t('readsNone')}</p> : <ul className="m-0 list-none p-0 text-[14px]" data-reads>{reads.map((read) => <li key={read.at}>{t('readLine', { facility: read.facilityName, date: formatDate(read.at, lang) })}</li>)}</ul>}
      </section>
      {failed && <p role="alert" className="t-body text-danger">{t('actionFailed')}</p>}
    </>
  );
}

function Timeline({ t, lang, ticket }: { t: Translate; lang: 'ar' | 'en'; ticket: PersonTicketView }) {
  const at = (state: string): TicketEventView | undefined => ticket.events.findLast((event) => event.toState === state && event.fromState !== event.toState);
  const issued = at('issued');
  const acknowledged = at('acknowledged');
  const seen = at('seen');
  const ended = (['rerouted', 'declined', 'withdrawn', 'closed'] as const).map((state) => at(state)).find(Boolean);
  const steps: { key: string; title: string; detail: string; done: boolean }[] = [
    { key: 'issued', title: t('step.issued'), detail: issued ? formatDate(issued.at, lang, 'long') : '', done: true },
    { key: 'acknowledged', title: t('step.acknowledged'), detail: acknowledged ? t('acknowledgedDetail', { date: formatDate(acknowledged.at, lang, 'long') }) : '', done: Boolean(acknowledged) },
    ...(ticket.events.some((event) => event.toState === 'overdue') ? [{ key: 'overdue', title: t('step.overdue'), detail: formatDate(at('overdue')!.at, lang, 'long'), done: true }] : []),
    { key: 'seen', title: t('step.seen'), detail: seen ? (seen.selfConfirmed ? t('selfConfirmed', { date: formatDate(seen.at, lang, 'long') }) : formatDate(seen.at, lang, 'long')) : t('byDate', { date: formatDate(ticket.deadlineAt, lang, 'long') }), done: Boolean(seen) },
    ...(ended ? [{ key: ended.toState, title: t(`step.${ended.toState as 'closed'}`), detail: formatDate(ended.at, lang, 'long'), done: true }] : [{ key: 'followUp', title: t('step.followUp'), detail: t('aroundDate', { date: formatDate(new Date(Date.parse((seen ?? issued)!.at) + 42 * DAY_MS).toISOString(), lang, 'long') }), done: false }]),
  ];
  return (
    <section aria-label={t('progress')} className="flex flex-col rounded-card border border-border bg-surface p-4" data-timeline>
      {steps.map((step, index) => (
        <div key={step.key} className={`flex gap-3 ${index < steps.length - 1 ? 'min-h-[52px]' : ''}`} data-step={step.key} data-done={step.done}>
          <div className="flex flex-col items-center">
            <span className={`flex size-6 shrink-0 items-center justify-center rounded-full ${step.done ? 'bg-accent' : 'border-2 border-accent bg-surface'}`}>
              {step.done && (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
                  <path d="M5 12l5 5 9-10" />
                </svg>
              )}
            </span>
            {index < steps.length - 1 && <span className={`w-0.5 flex-1 ${step.done ? 'bg-accent' : 'bg-border'}`} />}
          </div>
          <div>
            <div className="text-[15px] font-semibold">{step.title}</div>
            <div className="text-[13px] text-muted">{step.detail}</div>
          </div>
        </div>
      ))}
    </section>
  );
}
