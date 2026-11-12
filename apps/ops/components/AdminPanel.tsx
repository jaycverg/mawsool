'use client';

import { AdvanceClockResultSchema, ClockStateSchema, DEMO_ADVANCE_STEPS, DemoResetResultSchema, type ClockState, type DemoAdvanceStep, type DemoResetResult, type Session } from '@mawsool/types';
import { isLocale, staffCall } from '@mawsool/ui';
import { CRISIS_NUMBERS_CONFIG } from '@mawsool/rules';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { API_URL } from '../lib/metrics';

type ClockLoad = { k: 'loading' } | { k: 'failed' } | { k: 'ready'; clock: ClockState };
type Message = { tone: 'ok' | 'error'; text: string } | null;

const DAY_MS = 86_400_000;
const panel = 'rounded-staff border border-border bg-surface p-[18px] flex flex-col gap-3';

function dateTime(at: Date, lang: 'ar' | 'en'): string {
  return new Intl.DateTimeFormat(lang === 'ar' ? 'ar-AE-u-nu-latn' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Dubai' }).format(at);
}

/**
 * The admin panel: the demo clock, the reset and the crisis numbers' `last_verified` date. The clock and reset exist on the
 * server only while `DEMO_MODE` is set, and the panel learns whether they do from `GET /clock`, an open read that always
 * answers; with the demo off the controls are disabled and say so. The crisis numbers come from the same config file the
 * crisis screen reads and show with the demo off too.
 */
export function AdminPanel({ session, signOut }: { session: Session; signOut: () => void }) {
  const t = useTranslations('admin');
  const home = useTranslations('home');
  const locale = useLocale();
  const lang = isLocale(locale) ? locale : 'en';
  const [clock, setClock] = useState<ClockLoad>({ k: 'loading' });
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [reset, setReset] = useState<DemoResetResult | null>(null);
  const [resetMessage, setResetMessage] = useState<Message>(null);

  const readClock = useCallback(async () => {
    try {
      const response = await window.fetch(`${API_URL}/clock`);
      const parsed = ClockStateSchema.safeParse(await response.json());
      setClock(response.ok && parsed.success ? { k: 'ready', clock: parsed.data } : { k: 'failed' });
    } catch {
      setClock({ k: 'failed' });
    }
  }, []);

  useEffect(() => void readClock(), [readClock]);

  const enabled = clock.k === 'ready' && clock.clock.demoMode && !busy;

  async function advance(by: DemoAdvanceStep) {
    setBusy(true);
    setMessage(null);
    const result = await staffCall<unknown>({ fetch: window.fetch.bind(window), apiUrl: API_URL, session, method: 'POST', path: '/demo/clock/advance', body: { by } });
    setBusy(false);
    if (result.status === 'unauthorized') return signOut();
    const parsed = result.status === 'ok' ? AdvanceClockResultSchema.safeParse(result.body) : null;
    if (!parsed?.success) return setMessage({ tone: 'error', text: t('clock.moveFailed') });
    setClock({ k: 'ready', clock: { demoMode: parsed.data.demoMode, offsetMs: parsed.data.offsetMs } });
    setMessage({ tone: 'ok', text: t('clock.moved', { count: parsed.data.markedOverdue }) });
  }

  async function doReset() {
    if (!confirmReset) return setConfirmReset(true);
    setConfirmReset(false);
    setBusy(true);
    setResetting(true);
    setResetMessage(null);
    const result = await staffCall<unknown>({ fetch: window.fetch.bind(window), apiUrl: API_URL, session, method: 'POST', path: '/demo/reset' });
    setBusy(false);
    setResetting(false);
    if (result.status === 'unauthorized') return signOut();
    const parsed = result.status === 'ok' ? DemoResetResultSchema.safeParse(result.body) : null;
    if (!parsed?.success) return setResetMessage({ tone: 'error', text: t('reset.failed') });
    setReset(parsed.data);
    setResetMessage({ tone: 'ok', text: t('reset.done') });
    setMessage(null);
    void readClock();
  }

  const offsetDays = clock.k === 'ready' ? Math.round(clock.clock.offsetMs / DAY_MS) : 0;
  const personOrigin = reset ? new URL(reset.noura.tammUrl.en).origin : null;

  return (
    <main className="mx-auto flex max-w-[960px] flex-col gap-4 px-6 py-7" data-screen="admin-panel">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="t-h1 flex-1 basis-60">{t('heading')}</h1>
        <span className="t-label rounded-chip bg-mock px-2.5 py-1 font-semibold text-mock-ink">{home('simulated')}</span>
        <button type="button" className="tap rounded-pill border border-border px-4 text-[14px] font-semibold" onClick={signOut}>{t('signOut')}</button>
      </div>
      <p className="t-body text-muted">{t('intro')}</p>

      <section aria-label={t('clock.heading')} className={panel} data-section="clock">
        <h2 className="text-[17px] font-bold">{t('clock.heading')}</h2>
        {clock.k === 'loading' && <p role="status" className="t-body text-muted">{t('clock.loading')}</p>}
        {clock.k === 'failed' && (
          <p role="alert" className="t-body" data-clock-state="failed">{t('clock.failed')}</p>
        )}
        {clock.k === 'ready' && !clock.clock.demoMode && <p className="t-body rounded-input bg-warning px-3 py-2.5 text-warning-ink" role="note" data-clock-state="off">{t('clock.off')}</p>}
        {clock.k === 'ready' && clock.clock.demoMode && (
          <div className="flex flex-col gap-1" data-clock-state="on">
            <p className="t-body">{t('clock.on')}</p>
            <p className="t-body"><b>{t('clock.now')}</b>{': '}<span data-demo-now>{dateTime(new Date(Date.now() + clock.clock.offsetMs), lang)}</span></p>
            <p className="t-body text-muted" data-offset-days={offsetDays}>{offsetDays === 0 ? t('clock.offsetZero') : t('clock.offset', { days: offsetDays })}</p>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {DEMO_ADVANCE_STEPS.map((step) => (
            <button key={step} type="button" className="btn-primary" disabled={!enabled} onClick={() => void advance(step)} data-advance={step}>{t(`clock.step${step}`)}</button>
          ))}
        </div>
        {message && <p role="status" aria-live="polite" className={`t-body ${message.tone === 'error' ? 'text-danger' : ''}`} data-clock-message>{message.text}</p>}
        <p className="t-small text-muted">{t('clock.scope')}</p>
      </section>

      <section aria-label={t('reset.heading')} className={panel} data-section="reset">
        <h2 className="text-[17px] font-bold">{t('reset.heading')}</h2>
        <p className="t-body">{t('reset.warning')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn-primary" disabled={!enabled} onClick={() => void doReset()} data-reset>
            {resetting ? t('reset.working') : confirmReset ? t('reset.confirm') : t('reset.action')}
          </button>
          {clock.k === 'ready' && !clock.clock.demoMode && <span className="t-small text-muted">{t('reset.off')}</span>}
        </div>
        {resetMessage && <p role="status" aria-live="polite" className={`t-body ${resetMessage.tone === 'error' ? 'text-danger' : ''}`} data-reset-message>{resetMessage.text}</p>}
      </section>

      <section aria-label={t('personas.heading')} className={panel} data-section="personas">
        <h2 className="text-[17px] font-bold">{t('personas.heading')}</h2>
        <p className="t-body">{t('personas.noura')}</p>
        {reset ? (
          <div className="flex flex-col gap-2" data-noura>
            <p className="t-body"><b>{t('personas.nouraCode')}</b>{': '}<span className="t-code" dir="ltr" data-noura-code>{reset.noura.code}</span></p>
            <div className="flex flex-wrap gap-2">
              <a className="btn-primary" href={reset.noura.tammUrl.ar} target="_blank" rel="noreferrer" data-tamm-link="ar">{t('personas.nouraArabic')}</a>
              <a className="btn-primary" href={reset.noura.tammUrl.en} target="_blank" rel="noreferrer" data-tamm-link="en">{t('personas.nouraEnglish')}</a>
            </div>
          </div>
        ) : null}
        <p className="t-body">{t('personas.rashid')}</p>
        {personOrigin ? <a className="tap inline-flex items-center font-semibold text-accent" href={`${personOrigin}/en/check-in/`} target="_blank" rel="noreferrer" data-rashid-link>{t('personas.rashidOpen')}</a> : null}
        <p className="t-small rounded-input bg-warning px-3 py-2.5 text-warning-ink" role="note">{t('personas.hint')}</p>
      </section>

      <section aria-label={t('crisis.heading')} className={`${panel} overflow-x-auto`} data-section="crisis-numbers">
        <h2 className="text-[17px] font-bold">{t('crisis.heading')}</h2>
        <table className="w-full border-collapse text-[14px]">
          <thead>
            <tr className="text-start text-[12px] uppercase tracking-[0.5px] text-muted">
              {(['number', 'label', 'lastVerified', 'source'] as const).map((column) => <th key={column} scope="col" className="border-b border-border px-1.5 py-2 text-start font-normal">{t(`crisis.${column}`)}</th>)}
            </tr>
          </thead>
          <tbody>
            {CRISIS_NUMBERS_CONFIG.map((line) => (
              <tr key={line.number} data-crisis-number={line.number}>
                <td className="border-b border-[#E6ECEA] px-1.5 py-2.5"><span className="t-code" dir="ltr">{line.number}</span></td>
                <td className="border-b border-[#E6ECEA] px-1.5 py-2.5"><span dir="ltr">{line.label}</span> · {t(`crisis.role.${line.role}`)}</td>
                <td className="border-b border-[#E6ECEA] px-1.5 py-2.5" data-last-verified={line.last_verified ?? ''}>{line.last_verified ?? t('crisis.never')}</td>
                <td className="border-b border-[#E6ECEA] px-1.5 py-2.5 text-muted">
                  {/* The source notes are written in English only, in the rules config. On the Arabic page they say so instead of passing for Arabic. */}
                  {lang !== 'en' && <span className="t-small block font-semibold" data-english-only>{t('crisis.englishOnly')}</span>}
                  <span lang="en" dir="ltr" className="block" data-source-note>{line.note}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="t-small text-muted">{t('crisis.note')}</p>
      </section>
    </main>
  );
}
