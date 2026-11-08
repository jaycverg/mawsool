'use client';

import type { CrisisTrigger, Locale, Screening } from '@mawsool/types';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { API_URL } from '../lib/api';
import { deviceNow } from '../lib/clock';
import { buildHandoffPreview, handoffFor, loadHandoffs, offerState, sendHandoff, stopHandoff, type HandoffRecord, type SendOutcome } from '../lib/crisis-handoff';
import { flushOutbox } from '../lib/crisis-outbox';
import { parsePhone } from '../lib/reminders';
import { loadScreenings } from '../lib/screening-store';
import type { ServerDeps } from '../lib/server';
import type { Device } from '../lib/use-device';

type Phase = 'idle' | 'sending' | 'stopping' | SendOutcome | 'stopped' | 'stop_failed';

/** The secondary button of the crisis screen's own choices, so the panel's buttons are as tall and as round as their neighbours. */
const CHOICE = 'min-h-cta rounded-cta border-[1.5px] border-[#6B4A46] bg-surface px-4 text-[16px] font-semibold text-[#2A1414]';

/** When a note was made, as the person reads it: date and time in Dubai, in the page's language. */
function when(iso: string, lang: Locale): string {
  return new Intl.DateTimeFormat(lang === 'ar' ? 'ar-AE-u-nu-latn' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Dubai' }).format(new Date(iso));
}

const INSTRUMENT_NAMES = { who5: 'WHO-5', phq9: 'PHQ-9', gad7: 'GAD-7' } as const;
const FAILURES: Partial<Record<Phase, string>> = {
  offline: 'handoffOffline',
  not_ready: 'handoffNotReady',
  rejected: 'handoffRejected',
  invalid_number: 'handoffInvalidNumber',
  failed: 'handoffFailed',
  stopped: 'handoffStoppedNote',
  stop_failed: 'handoffStopFailed',
};

/**
 * The optional hand-off of a short note to the (sample) crisis line. It is offered under the crisis screen's own choices,
 * after the screen has rendered, and it is a separate action: nothing here is part of showing the numbers, taking a call
 * or releasing the block, and a failure of any kind only changes the words in this panel. It shows exactly what would be
 * sent, sends only on an explicit tick and a press, needs a connection, and can be stopped, which deletes it from the server.
 *
 * One note is kept per crisis. The crisis screen decides what to show from the record of the crisis that is open and from no
 * other; an earlier crisis's note never stands in for this one. `mode="settings"` lists every note still held, each with its
 * own stop control, and nothing when there is none.
 */
export function CrisisHandoffPanel({ device, lang, mode, open }: { device: Device; lang: Locale; mode: 'crisis' | 'settings'; open?: { eventId: string; trigger: CrisisTrigger } | null }) {
  const t = useTranslations('crisis');
  const ts = useTranslations('settings');
  const [records, setRecords] = useState<HandoffRecord[]>([]);
  const [stopping, setStopping] = useState<string | null>(null);
  const [stopped, setStopped] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [screenings, setScreenings] = useState<Screening[]>([]);
  const [callback, setCallback] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');

  const reload = () => loadHandoffs(device.storage).then(setRecords, () => setRecords([]));
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device]);
  useEffect(() => {
    if (expanded) void loadScreenings(device.storage).then(setScreenings, () => setScreenings([]));
  }, [expanded, device]);

  const server: ServerDeps = { storage: device.storage, fetch: window.fetch.bind(window), apiUrl: API_URL, locale: lang, random: window.crypto };

  async function send() {
    if (!open || !agreed) return;
    setPhase('sending');
    const outcome = await sendHandoff(
      { server, flush: () => flushOutbox({ storage: device.storage, fetch: window.fetch.bind(window), apiUrl: API_URL, locale: lang, random: window.crypto }), now: deviceNow, newId: () => crypto.randomUUID() },
      { crisisEventId: open.eventId, screenings, language: lang, trigger: open.trigger, callbackInput: callback },
    );
    setPhase(outcome);
    // A note the person stopped is not offered again as it stands: the form stays open with its answer, but a new send needs a fresh tick.
    if (outcome === 'stopped') {
      setAgreed(false);
      setExpanded(true);
    }
    await reload();
  }

  async function stop(record: HandoffRecord) {
    setStopping(record.handoffId);
    setStopped(false);
    const outcome = await stopHandoff({ server }, record);
    setStopping(null);
    setPhase(outcome === 'stopped' ? 'idle' : 'stop_failed');
    setStopped(outcome === 'stopped');
    await reload();
  }

  const failure = FAILURES[phase];

  if (mode === 'settings') {
    if (records.length === 0 && !stopped) return null;
    return (
      <section className="flex flex-col gap-2.5 rounded-card border border-border bg-surface p-5" data-panel="crisis-handoff">
        <h2 className="text-[16px] font-semibold">{ts('handoffTitle')}</h2>
        <p className="t-body text-muted">{ts('handoffBody')}</p>
        {records.map((record, index) => (
          <div key={record.handoffId} className="flex flex-col gap-1.5" data-handoff-record={record.state}>
            <p id={`note-${record.handoffId}`} className="t-body font-semibold" data-handoff-note>
              {t('handoffNote', { n: index + 1, total: records.length, when: when(record.startedAt, lang) })}
            </p>
            {record.state === 'sending' && <p className="t-small text-muted">{t('handoffUnconfirmed')}</p>}
            <button type="button" className="tap rounded-pill border-[1.5px] border-danger px-4 font-semibold text-danger" aria-describedby={`note-${record.handoffId}`} disabled={stopping === record.handoffId} onClick={() => void stop(record)} data-handoff-stop>
              {t('handoffStop')}
            </button>
          </div>
        ))}
        {stopped && <p role="status" className="text-[15px] font-semibold text-accent-dark">{t('handoffStopped')}</p>}
        {failure && phase === 'stop_failed' && <p role="alert" className="t-body">{t(failure)}</p>}
      </section>
    );
  }

  // The crisis screen: only a crisis that is open has anything to offer, and only its own record counts.
  if (!open) return null;
  const mine = handoffFor(records, open.eventId);
  const state = offerState(records, open.eventId);
  const sent = state === 'sent';
  const number = parsePhone(callback.trim());
  const preview = buildHandoffPreview({ screenings, language: lang, trigger: open.trigger, callback: number });

  return (
    <section aria-labelledby="handoff-title" className="flex flex-col gap-2.5 rounded-card border border-[#E3C9C5] bg-surface p-4" data-panel="crisis-handoff" data-handoff-state={sent ? 'sent' : mine ? 'sending' : 'none'}>
      {!sent && !expanded && (
        <button type="button" className={CHOICE} aria-expanded={false} onClick={() => setExpanded(true)} data-handoff-offer>
          {t('handoffOffer')}
        </button>
      )}
      {(sent || expanded) && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="handoff-title" className="flex-1 text-[16px] font-semibold">{t('handoffTitle')}</h2>
            <span className="rounded-chip bg-mock px-2 py-[3px] text-[12px] font-semibold text-mock-ink" data-mock-label>{t('handoffMock')}</span>
          </div>
          {sent ? (
            <p role="status" className="t-body" data-handoff-sent>{t('handoffSent')}</p>
          ) : (
            <>
              <p className="t-body">{t('handoffIntro')}</p>
              <div className="flex flex-col gap-1 rounded-input bg-ground p-3 text-[14px]" data-handoff-preview>
                <b>{t('handoffPreviewTitle')}</b>
                <span>{t('handoffLanguage', { language: t(`handoffLang.${preview.language}`) })}</span>
                <span>{t(`handoffReason.${preview.trigger}`)}</span>
                <span>
                  {preview.scores.length === 0
                    ? t('handoffNoScores')
                    : t('handoffScores', { scores: preview.scores.map((score) => `${INSTRUMENT_NAMES[score.instrument]} ${score.total}`).join(' · ') })}
                </span>
                <span>
                  {preview.callbackNumber ? (
                    <>
                      {t('handoffNumberLabel')} <bdi dir="ltr" className="whitespace-nowrap">{preview.callbackNumber}</bdi>
                    </>
                  ) : (
                    t('handoffNoNumber')
                  )}
                </span>
              </div>
              <label className="flex flex-col gap-1 text-[14px]">
                {t('handoffCallbackLabel')}
                <input type="tel" inputMode="tel" dir="ltr" autoComplete="off" value={callback} onChange={(event) => setCallback(event.target.value)} className="h-11 rounded-input border border-[#9AAAA7] bg-surface px-2.5 text-[16px]" data-handoff-number />
                <span className="text-[13px] text-[#4D3330]">{t.rich('handoffCallbackHint', { num: (chunks) => <bdi dir="ltr" className="whitespace-nowrap">{chunks}</bdi> })}</span>
              </label>
              <label className="flex min-h-tap cursor-pointer items-center gap-3 text-[15px] font-semibold">
                <input type="checkbox" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} className="size-[22px] accent-accent" data-handoff-consent />
                {t('handoffConsent')}
              </label>
              <button type="button" className="btn-primary" disabled={!agreed || phase === 'sending'} onClick={() => void send()} data-handoff-send>
                {phase === 'sending' ? t('handoffSending') : t('handoffSend')}
              </button>
            </>
          )}
          {mine && (
            <button type="button" className={CHOICE} disabled={stopping === mine.handoffId} onClick={() => void stop(mine)} data-handoff-stop>
              {t('handoffStop')}
            </button>
          )}
          {stopped && <p role="status" className="t-body">{t('handoffStopped')}</p>}
          {failure && <p role="status" className="t-body" data-handoff-failure={phase}>{t(failure)}</p>}
        </>
      )}
    </section>
  );
}
