'use client';

import type { CrisisTrigger, Locale, Screening } from '@mawsool/types';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { API_URL } from '../lib/api';
import { deviceNow } from '../lib/clock';
import { buildHandoffPreview, loadHandoff, sendHandoff, stopHandoff, type HandoffRecord, type SendOutcome } from '../lib/crisis-handoff';
import { flushOutbox } from '../lib/crisis-outbox';
import { parsePhone } from '../lib/reminders';
import { loadScreenings } from '../lib/screening-store';
import type { ServerDeps } from '../lib/server';
import type { Device } from '../lib/use-device';

type Phase = 'idle' | 'sending' | 'stopping' | SendOutcome | 'stopped' | 'stop_failed';

const INSTRUMENT_NAMES = { who5: 'WHO-5', phq9: 'PHQ-9', gad7: 'GAD-7' } as const;
const FAILURES: Partial<Record<Phase, string>> = {
  offline: 'handoffOffline',
  not_ready: 'handoffNotReady',
  rejected: 'handoffRejected',
  invalid_number: 'handoffInvalidNumber',
  failed: 'handoffFailed',
  stop_failed: 'handoffStopFailed',
};

/**
 * The optional hand-off of a short note to the (sample) crisis line. It is offered under the crisis screen's own choices,
 * after the screen has rendered, and it is a separate action: nothing here is part of showing the numbers, taking a call
 * or releasing the block, and a failure of any kind only changes the words in this panel. It shows exactly what would be
 * sent, sends only on an explicit tick and a press, needs a connection, and can be stopped, which deletes it from the server.
 *
 * `mode="settings"` shows only the stop control, and only while a hand-off exists.
 */
export function CrisisHandoffPanel({ device, lang, mode, open }: { device: Device; lang: Locale; mode: 'crisis' | 'settings'; open?: { eventId: string; trigger: CrisisTrigger } | null }) {
  const t = useTranslations('crisis');
  const ts = useTranslations('settings');
  const [record, setRecord] = useState<HandoffRecord | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [screenings, setScreenings] = useState<Screening[]>([]);
  const [callback, setCallback] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');

  useEffect(() => {
    void loadHandoff(device.storage).then(setRecord, () => setRecord(null));
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
    setRecord(await loadHandoff(device.storage).catch(() => null));
  }

  async function stop() {
    if (!record) return;
    setPhase('stopping');
    const outcome = await stopHandoff({ server }, record);
    setPhase(outcome === 'stopped' ? 'stopped' : 'stop_failed');
    setRecord(await loadHandoff(device.storage).catch(() => null));
  }

  const failure = FAILURES[phase];
  const sent = record?.state === 'sent';

  if (mode === 'settings') {
    if (!record && phase !== 'stopped') return null;
    return (
      <section className="flex flex-col gap-2.5 rounded-card border border-border bg-surface p-5" data-panel="crisis-handoff">
        <h2 className="text-[16px] font-semibold">{ts('handoffTitle')}</h2>
        <p className="t-body text-muted">{ts('handoffBody')}</p>
        {record && (
          <button type="button" className="tap rounded-pill border-[1.5px] border-danger px-4 font-semibold text-danger" disabled={phase === 'stopping'} onClick={() => void stop()} data-handoff-stop>
            {t('handoffStop')}
          </button>
        )}
        {phase === 'stopped' && <p role="status" className="text-[15px] font-semibold text-accent-dark">{t('handoffStopped')}</p>}
        {failure && phase === 'stop_failed' && <p role="alert" className="t-body">{t(failure)}</p>}
      </section>
    );
  }

  if (!open && !record) return null;
  const number = parsePhone(callback.trim());
  const preview = buildHandoffPreview({ screenings, language: lang, trigger: open?.trigger ?? 'phq9_item9', callback: number });

  return (
    <section aria-labelledby="handoff-title" className="flex flex-col gap-2.5 rounded-card border border-[#E3C9C5] bg-surface p-4" data-panel="crisis-handoff" data-handoff-state={sent ? 'sent' : record ? 'sending' : 'none'}>
      {!sent && !expanded && open && (
        <button type="button" className="min-h-tap rounded-pill border-[1.5px] border-[#6B4A46] px-3 text-left font-semibold" aria-expanded={false} onClick={() => setExpanded(true)} data-handoff-offer>
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
                <span dir="auto">{preview.callbackNumber ? t('handoffNumberSent', { number: preview.callbackNumber }) : t('handoffNoNumber')}</span>
              </div>
              <label className="flex flex-col gap-1 text-[14px]">
                {t('handoffCallbackLabel')}
                <input type="tel" inputMode="tel" dir="ltr" autoComplete="off" value={callback} onChange={(event) => setCallback(event.target.value)} className="h-11 rounded-input border border-[#9AAAA7] bg-surface px-2.5 text-[16px]" data-handoff-number />
                <span className="text-[13px] text-[#4D3330]">{t('handoffCallbackHint')}</span>
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
          {record && (
            <button type="button" className="min-h-tap rounded-pill border-[1.5px] border-[#6B4A46] px-3 font-semibold" disabled={phase === 'stopping'} onClick={() => void stop()} data-handoff-stop>
              {t('handoffStop')}
            </button>
          )}
          {phase === 'stopped' && <p role="status" className="t-body">{t('handoffStopped')}</p>}
          {failure && <p role="status" className="t-body" data-handoff-failure={phase}>{t(failure)}</p>}
        </>
      )}
    </section>
  );
}
