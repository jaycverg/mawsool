'use client';

import { PersonTicketListSchema, PersonTicketViewSchema, REROUTE_REASONS, type ConsentElement, type PersonTicketView, type RerouteReason, type TicketEventView } from '@mawsool/types';
import { isLocale } from '@mawsool/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import { API_URL } from '../lib/api';
import { deviceNow } from '../lib/clock';
import { followUpAt, followUpDue } from '../lib/day7';
import { calendarDaysLeft, formatDate } from '../lib/format';
import { href } from '../lib/routes';
import { callServer, type ServerDeps } from '../lib/server';
import { loadTickets } from '../lib/share';
import { hasServerFootprint } from '../lib/server';
import { useDevice, type Device } from '../lib/use-device';
import { BottomNav } from './BottomNav';
import { HomeHeader } from './HomeHeader';
import { QrCode } from './QrCode';

type Translate = ReturnType<typeof useTranslations>;
type Reads = { at: string; facilityName: string }[] | 'failed';
type Load = { status: 'loading' } | { status: 'none' } | { status: 'failed' } | { status: 'ready'; ticket: PersonTicketView; reads: Reads; all: PersonTicketView[] };
type Panel = 'none' | 'reason' | 'declining' | 'withdrawing';

const ReadsSchema = z.array(z.object({ at: z.string(), role: z.string(), facilityName: z.string() }));
const DAY_MS = 86_400_000;
/** The rings and connectors of the timeline: a step not yet reached is open, and only the next one is in the brand colour. */
const GREY = '#9AAAA7';

/**
 * The ticket: its code and QR, the clinic and the deadline, a progress timeline built from the server's events, the
 * "did you get seen?" check once it is due, and a sharing panel that lists every consent with a control to stop
 * each one and a list of who opened the bundle. The ticket is addressed by `?id=`, or the newest one on this phone.
 */
export function TicketScreen() {
  const t = useTranslations('ticket');
  const locale = useLocale();
  const lang = isLocale(locale) ? locale : 'en';
  const params = useSearchParams();
  const requested = params.get('id');
  const unsavedLocally = params.get('saved') === '0';
  const device = useDevice();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [panel, setPanel] = useState<Panel>('none');
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const serverDeps = useCallback((d: Device): ServerDeps => ({ storage: d.storage, fetch: window.fetch.bind(window), apiUrl: API_URL, locale: lang, random: window.crypto }), [lang]);

  const refresh = useCallback(async () => {
    if (device === null || device === 'unavailable') return;
    setLoad({ status: 'loading' });
    const deps = serverDeps(device);
    let id = requested ?? (await loadTickets(device.storage).catch(() => [])).at(-1)?.id;
    if (!id) {
      // This phone has no note of a ticket. If it has never given the server anything there is nothing to ask for, and
      // no request is made; if it has (a send whose local note failed), the server's own list says what exists.
      if (!(await hasServerFootprint(device.storage).catch(() => false))) return setLoad({ status: 'none' });
      const list = await callServer<unknown>(deps, 'GET', '/me/tickets');
      const newest = list.ok ? PersonTicketListSchema.safeParse(list.body) : null;
      if (!newest?.success) return setLoad({ status: 'failed' });
      id = newest.data.at(-1)?.id;
      if (!id) return setLoad({ status: 'none' });
    }
    const [ticket, reads, list] = await Promise.all([
      callServer<unknown>(deps, 'GET', `/me/tickets/${id}`),
      callServer<unknown>(deps, 'GET', `/me/tickets/${id}/reads`),
      callServer<unknown>(deps, 'GET', '/me/tickets'),
    ]);
    const parsed = ticket.ok ? PersonTicketViewSchema.safeParse(ticket.body) : null;
    if (!parsed?.success) return setLoad({ status: 'failed' });
    // A reads call that failed is not "nobody opened it": it is shown as unknown.
    const readList = reads.ok ? ReadsSchema.safeParse(reads.body) : null;
    const everyTicket = list.ok ? PersonTicketListSchema.safeParse(list.body) : null;
    setLoad({ status: 'ready', ticket: parsed.data, reads: readList?.success ? readList.data : 'failed', all: everyTicket?.success ? everyTicket.data : [parsed.data] });
  }, [device, requested, serverDeps]);

  useEffect(() => void refresh(), [refresh]);

  async function act(run: (d: Device) => Promise<boolean>) {
    if (device === null || device === 'unavailable') return;
    setBusy(true);
    setFailed(false);
    setNotice(null);
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
            all={load.all}
            savedWarning={unsavedLocally}
            notice={notice}
            onStop={(consentId) =>
              void act(async (d) => {
                const stopped = await callServer<{ summaryRemoved?: boolean }>(serverDeps(d), 'DELETE', `/consents/${consentId}`);
                if (stopped.ok && stopped.body?.summaryRemoved) setNotice('summaryRemoved');
                return stopped.ok;
              })
            }
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
  reads: Reads;
  all: PersonTicketView[];
  savedWarning: boolean;
  notice: string | null;
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

function Ready({ t, lang, ticket, reads, all, savedWarning, notice, panel, setPanel, busy, failed, onSeen, onDecline, onWithdraw, onStop, onReroute }: ReadyProps) {
  const now = deviceNow();
  const live = ['issued', 'acknowledged', 'overdue'].includes(ticket.state);
  const daysLeft = calendarDaysLeft(ticket.deadlineAt, now);
  const shareEnded = ticket.consents.some((consent) => consent.element === 'ticket' && consent.revokedAt !== null);
  const earlier = ticket.parentTicketId ? all.find((candidate) => candidate.id === ticket.parentTicketId) : undefined;
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
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-[17px] font-semibold" dir="auto">{ticket.serviceName}</span>
            <span className="inline-flex whitespace-nowrap rounded-chip bg-mock px-2 py-[3px] text-[12px] font-semibold text-mock-ink" data-sample>{t('sample')}</span>
          </span>
          <span className="flex items-center gap-1.5 text-[15px]" data-deadline>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#0E6B63" strokeWidth="2" strokeLinecap="round" aria-hidden="true" className="shrink-0">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 2" />
            </svg>
            <span>
              {t('beSeenBy')} <b>{formatDate(ticket.deadlineAt, lang, 'long')}</b>
              {live && <> · {t('daysLeft', { count: daysLeft })}</>}
            </span>
          </span>
          <span className="t-small text-muted" dir="auto">{ticket.clinicName}</span>
        </div>
      </section>

      {savedWarning && <p role="status" className="rounded-staff bg-warning px-3.5 py-3 text-[14px] text-warning-ink">{t('savedWarning')}</p>}
      {shareEnded && <p role="status" className="rounded-staff bg-accent-tint px-3.5 py-3 text-[14px]" data-share-ended>{t('withdrawnNote')}</p>}
      {earlier && (
        <p className="t-small text-muted" data-earlier>
          {t('earlier')} · <a className="inline-flex min-h-tap items-center font-semibold text-accent" href={href(lang, 'ticket', { id: earlier.id })}>{`${earlier.shortCode.slice(0, 2)}-${earlier.shortCode.slice(2)}`}</a>
        </p>
      )}
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
        <p className="text-[14px]" data-clinic-contact dir="auto">{ticket.clinicContact}</p>
        <h2 className="mt-1 text-[13px] font-semibold">{t('whatToBring')}</h2>
        <p className="text-[14px]">{t('bring')}</p>
        {live && <p className="mt-1 text-[14px] leading-5">{t('askNote', { date: formatDate(followUpAt(ticket).toISOString(), lang, 'long') })}</p>}
      </section>

      {live && panel !== 'declining' && (
        <div className="flex gap-2.5">
          <button type="button" className="flex h-12 flex-1 items-center justify-center rounded-[24px] border-[1.5px] border-accent px-3 text-[15px] font-semibold text-accent" onClick={() => onReroute('change_option')}>{t('changeOption')}</button>
          <button type="button" className="flex h-12 flex-1 items-center justify-center rounded-[24px] px-3 text-[15px] font-semibold text-accent" onClick={() => setPanel('declining')}>{t('decline')}</button>
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
        {notice === 'summaryRemoved' && <p role="status" className="rounded-chip bg-accent-tint px-3 py-2 text-[14px]" data-notice="summary-removed">{t('summaryRemoved')}</p>}
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
        {reads === 'failed' ? <p role="alert" className="t-small text-danger" data-reads-failed>{t('readsFailed')}</p> : reads.length === 0 ? <p className="t-small text-muted">{t('readsNone')}</p> : <ul className="m-0 list-none p-0 text-[14px]" data-reads>{reads.map((read) => <li key={read.at}>{t('readLine', { facility: read.facilityName, date: formatDate(read.at, lang) })}</li>)}</ul>}
      </section>
      {failed && <p role="alert" className="t-body text-danger">{t('actionFailed')}</p>}
      {all.length > 1 && (
        <section className="flex flex-col gap-1 rounded-card border border-border bg-surface p-4" data-panel="referrals">
          <h2 className="text-[16px] font-semibold">{t('yourReferrals')}</h2>
          <ul className="m-0 flex list-none flex-col p-0">
            {[...all].reverse().map((entry) => (
              <li key={entry.id}>
                <a className="flex min-h-tap items-center justify-between gap-2 text-[15px]" href={href(lang, 'ticket', { id: entry.id })} data-ticket-link={entry.shortCode} aria-current={entry.id === ticket.id ? 'page' : undefined}>
                  <span className="t-code" dir="ltr">{`${entry.shortCode.slice(0, 2)}-${entry.shortCode.slice(2)}`}</span>
                  <span className="text-[13px] text-muted">{entry.id === ticket.id ? t('currentReferral') : t(`step.${entry.state}`)}</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function Timeline({ t, lang, ticket }: { t: Translate; lang: 'ar' | 'en'; ticket: PersonTicketView }) {
  const at = (state: string): TicketEventView | undefined => ticket.events.findLast((event) => event.toState === state && event.fromState !== event.toState);
  const issued = at('issued');
  const acknowledged = at('acknowledged');
  const seen = at('seen');
  const ended = (['rerouted', 'declined', 'withdrawn', 'closed'] as const).map((state) => at(state)).find(Boolean);
  const all: { key: string; title: string; detail: string; done: boolean }[] = [
    { key: 'issued', title: t('step.issued'), detail: issued ? formatDate(issued.at, lang, 'long') : '', done: true },
    { key: 'acknowledged', title: t('step.acknowledged'), detail: acknowledged ? t('acknowledgedDetail', { date: formatDate(acknowledged.at, lang, 'long') }) : '', done: Boolean(acknowledged) },
    ...(ticket.events.some((event) => event.toState === 'overdue') ? [{ key: 'overdue', title: t('step.overdue'), detail: formatDate(at('overdue')!.at, lang, 'long'), done: true }] : []),
    { key: 'seen', title: t('step.seen'), detail: seen ? (seen.selfConfirmed ? t('selfConfirmed', { date: formatDate(seen.at, lang, 'long') }) : formatDate(seen.at, lang, 'long')) : t('byDate', { date: formatDate(ticket.deadlineAt, lang, 'long') }), done: Boolean(seen) },
    ...(ended ? [{ key: ended.toState, title: t(`step.${ended.toState as 'closed'}`), detail: formatDate(ended.at, lang, 'long'), done: true }] : [{ key: 'followUp', title: t('step.followUp'), detail: t('aroundDate', { date: formatDate(new Date(Date.parse((seen ?? issued)!.at) + 42 * DAY_MS).toISOString(), lang, 'long') }), done: false }]),
  ];
  // Once the ticket has ended, steps that were never reached are not shown as still to come.
  const steps = ended ? all.filter((step) => step.done) : all;
  const nextIndex = steps.findIndex((step) => !step.done);
  return (
    <section aria-label={t('progress')} className="flex flex-col rounded-card border border-border bg-surface p-4" data-timeline>
      {steps.map((step, index) => {
        const next = step.done ? undefined : index === nextIndex ? 'next' : 'later';
        const joinsNext = step.done && steps[index + 1]?.done;
        return (
          <div key={step.key} className={`flex gap-3 ${index < steps.length - 1 ? 'min-h-[52px]' : ''}`} data-step={step.key} data-done={step.done} data-pending={next}>
            <div className="flex flex-col items-center">
              {step.done ? (
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
                    <path d="M5 12l5 5 9-10" />
                  </svg>
                </span>
              ) : (
                <span className="size-6 shrink-0 rounded-full border-2 bg-surface" style={{ borderColor: next === 'next' ? '#0E6B63' : GREY }} />
              )}
              {index < steps.length - 1 && <span className={`w-0.5 flex-1 ${joinsNext ? 'bg-accent' : 'bg-border'}`} />}
            </div>
            <div>
              <div className={`text-[15px] font-semibold ${next === 'later' ? 'text-muted' : ''}`}>{step.title}</div>
              {step.detail !== '' && <div className="text-[13px] text-muted">{step.detail}</div>}
            </div>
          </div>
        );
      })}
    </section>
  );
}
