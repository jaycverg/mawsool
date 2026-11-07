'use client';

import { PersonTicketViewSchema, type PersonTicketView } from '@mawsool/types';
import { isLocale } from '@mawsool/ui';
import { useDemoOffsetMs } from '@mawsool/ui/components';
import { useLocale, useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { API_URL } from '../lib/api';
import { INSTRUMENT_TAG } from '../lib/bands';
import { deviceNow } from '../lib/clock';
import { formatDate } from '../lib/format';
import { idFrom, loadRepeatCheck, remeasureDue, remeasureOpensAt, sendRemeasure, totalsOf, type RepeatCheck } from '../lib/remeasure';
import { href } from '../lib/routes';
import { callServer } from '../lib/server';
import { useDevice } from '../lib/use-device';
import { FlowHeader } from './FlowHeader';

type Load =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'missing' }
  | { status: 'ready'; ticket: PersonTicketView; check: RepeatCheck | null };

type Send = 'idle' | 'sending' | 'failed' | 'not_ready';

/**
 * The end of the repeat check. With both questionnaires done it shows the two totals and one choice, off until ticked:
 * send those two totals to the clinic. Finishing moves the ticket on, and without the tick nothing but that move leaves
 * the phone. Before both are done it offers to start; before six weeks after the clinic saw the person, or when the
 * ticket is not waiting for one, it says so and does not offer the questionnaires.
 */
export function RemeasureScreen() {
  const t = useTranslations('remeasure');
  const tb = useTranslations('result.bands');
  const ti = useTranslations('instrument');
  const tf = useTranslations('flow');
  const locale = useLocale();
  const lang = isLocale(locale) ? locale : 'en';
  const params = useSearchParams();
  const ticketId = idFrom(params.get('id'));
  const phq9Id = idFrom(params.get('p'));
  const gad7Id = idFrom(params.get('g'));
  const device = useDevice();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [share, setShare] = useState(false);
  const [send, setSend] = useState<Send>('idle');
  // Re-render when the demo clock moves, so a repeat check that the clock made due opens.
  useDemoOffsetMs();

  const refresh = useCallback(async () => {
    if (device === null || device === 'unavailable') return;
    if (!ticketId) return setLoad({ status: 'missing' });
    setLoad({ status: 'loading' });
    const server = { storage: device.storage, fetch: window.fetch.bind(window), apiUrl: API_URL, locale: lang, random: window.crypto };
    const fetched = await callServer<unknown>(server, 'GET', `/me/tickets/${ticketId}?locale=${lang}`);
    if (!fetched.ok && fetched.reason === 'rejected' && fetched.status === 404) return setLoad({ status: 'missing' });
    const parsed = fetched.ok ? PersonTicketViewSchema.safeParse(fetched.body) : null;
    if (!parsed?.success) return setLoad({ status: 'failed' });
    const check = await loadRepeatCheck(device.storage, { phq9: phq9Id, gad7: gad7Id }).catch(() => null);
    setLoad({ status: 'ready', ticket: parsed.data, check });
  }, [device, ticketId, phq9Id, gad7Id, lang]);

  useEffect(() => void refresh(), [refresh]);

  const toTicket = ticketId ? href(lang, 'ticket', { id: ticketId }) : href(lang, 'ticket');
  const bandNames: Record<string, string> = {
    minimal: tb('minimal'),
    mild: tb('mild'),
    moderate: tb('moderate'),
    moderately_severe: tb('moderately_severe'),
    severe: tb('severe'),
  };

  async function finish(ticket: PersonTicketView, check: RepeatCheck) {
    if (device === null || device === 'unavailable') return;
    setSend('sending');
    const server = { storage: device.storage, fetch: window.fetch.bind(window), apiUrl: API_URL, locale: lang, random: window.crypto };
    const outcome = await sendRemeasure(server, ticket.id, share ? totalsOf(check) : []);
    if (outcome === 'done') return window.location.assign(href(lang, 'ticket', { id: ticket.id }));
    setSend(outcome === 'not_ready' ? 'not_ready' : 'failed');
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <FlowHeader leading={{ href: toTicket, label: t('back') }} title={t('heading')} />
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 p-4" data-screen="remeasure">
        {device === 'unavailable' && <p role="alert" className="t-body">{t('unavailable')}</p>}
        {load.status === 'loading' && device !== 'unavailable' && <p className="t-body text-muted" role="status">{tf('loading')}</p>}
        {load.status === 'missing' && (
          <>
            <p className="t-body">{t('missing')}</p>
            <a className="btn-primary" href={toTicket}>{t('toTicket')}</a>
          </>
        )}
        {load.status === 'failed' && (
          <div role="alert" className="flex flex-col gap-2">
            <p className="t-body">{t('loadFailed')}</p>
            <button type="button" className="btn-primary" onClick={() => void refresh()}>{tf('retry')}</button>
          </div>
        )}
        {load.status === 'ready' && !remeasureDue(load.ticket, deviceNow()) && (
          <>
            <p className="t-body" data-remeasure-state="not-open">
              {remeasureOpensAt(load.ticket) ? t('opensOn', { date: formatDate(remeasureOpensAt(load.ticket)!.toISOString(), lang, 'long') }) : t('notWaiting')}
            </p>
            <a className="btn-primary" href={toTicket}>{t('toTicket')}</a>
          </>
        )}
        {load.status === 'ready' && remeasureDue(load.ticket, deviceNow()) && !load.check && (
          <>
            <h1 className="t-h1">{t('introTitle')}</h1>
            <p className="t-body text-muted">{t('intro')}</p>
            <a className="btn-primary" href={href(lang, 'check-in', { i: 'phq9', rm: load.ticket.id })} data-remeasure-start>{t('start')}</a>
          </>
        )}
        {load.status === 'ready' && remeasureDue(load.ticket, deviceNow()) && load.check && (
          <Totals
            check={load.check}
            ticket={load.ticket}
            bandNames={bandNames}
            names={{ phq9: ti('phq9Full'), gad7: ti('gad7Full') }}
            share={share}
            setShare={setShare}
            send={send}
            onFinish={() => void finish(load.ticket, load.check!)}
          />
        )}
      </main>
    </div>
  );
}

interface TotalsProps {
  check: RepeatCheck;
  ticket: PersonTicketView;
  bandNames: Record<string, string>;
  names: { phq9: string; gad7: string };
  share: boolean;
  setShare: (share: boolean) => void;
  send: Send;
  onFinish: () => void;
}

function Totals({ check, ticket, bandNames, names, share, setShare, send, onFinish }: TotalsProps) {
  const t = useTranslations('remeasure');
  /** The clinic can be sent the totals only while the person is still sharing the ticket with it. */
  const sharing = ticket.consents.some((consent) => consent.element === 'ticket' && consent.revokedAt === null);
  return (
    <>
      <h1 className="t-h1">{t('summaryTitle')}</h1>
      <ul className="m-0 flex list-none flex-col gap-2 p-0" data-totals>
        {([check.phq9, check.gad7] as const).map((screening) => (
          <li key={screening.id} className="flex flex-col gap-0.5 rounded-card border border-border bg-surface p-4" data-total={screening.instrument}>
            <span className="text-[15px] font-semibold">{names[screening.instrument as 'phq9' | 'gad7']}</span>
            <span className="text-[20px] font-semibold">
              <span dir="ltr">{INSTRUMENT_TAG[screening.instrument]}</span> · {t('total', { total: screening.total })}
              {screening.band && <> · {bandNames[screening.band]}</>}
            </span>
          </li>
        ))}
      </ul>
      {sharing ? (
        <label className="flex min-h-tap cursor-pointer items-start gap-3 rounded-staff border border-border bg-surface p-3.5 text-[15px]">
          <input type="checkbox" checked={share} onChange={(event) => setShare(event.target.checked)} className="mt-0.5 size-[22px] shrink-0 accent-accent" data-control="share-totals" />
          <span className="flex flex-col gap-1">
            <span className="font-semibold">{t('shareLabel')}</span>
            <span className="t-small text-muted">{t('shareHelp')}</span>
          </span>
        </label>
      ) : (
        <p className="t-small text-muted" data-share-unavailable>{t('shareUnavailable')}</p>
      )}
      <p className="t-small text-muted">{t('stays')}</p>
      {send === 'failed' && <p role="alert" className="t-body text-danger">{t('failed')}</p>}
      {send === 'not_ready' && <p role="alert" className="t-body text-danger">{t('conflict')}</p>}
      <button type="button" className="btn-primary" disabled={send === 'sending'} onClick={onFinish} data-control="finish-remeasure">
        {send === 'sending' ? t('sending') : t('finish')}
      </button>
    </>
  );
}
