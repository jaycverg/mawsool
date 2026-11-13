'use client';

import { REMINDER_INTERVAL_WEEKS, type ReminderInterval } from '@mawsool/types';
import { isLocale } from '@mawsool/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { API_URL } from '../lib/api';
import { deviceFetch } from '../lib/net';
import { deviceNow } from '../lib/clock';
import { numbersText } from '../lib/crisis-copy';
import { crisisLines } from '../lib/crisis-numbers';
import { flushOutbox } from '../lib/crisis-outbox';
import { exportDeviceData } from '../lib/device-data';
import { eraseEverything, type EraseOutcome } from '../lib/erase';
import { AnonymousLeftNote } from './AnonymousLeftNote';
import { deviceNotifications } from '../lib/notify';
import {
  enableReminders,
  loadReminders,
  removeReminderNumber,
  requestReminderSample,
  saveReminderNumber,
  setReminderInterval,
  turnOffReminders,
  type ReminderChange,
  type ReminderSettings,
} from '../lib/reminders';
import { loadOutcomeStatistics, turnOffOutcomeStatistics } from '../lib/outcome-statistics';
import { takeClearedNote, type ClearedNote } from '../lib/server-choices';
import { learnChoicesNow } from '../lib/sync';
import { callServer, markServerFootprint, type ServerDeps } from '../lib/server';
import { href } from '../lib/routes';
import { loadEquity, saveEquity } from '../lib/share';
import { useDevice, type Device } from '../lib/use-device';
import { BottomNav } from './BottomNav';
import { CrisisHandoffPanel } from './CrisisHandoffPanel';
import { HomeHeader } from './HomeHeader';
import { OutcomeStatisticsPanel, type StatisticsState } from './OutcomeStatisticsPanel';

type ReminderNote = 'none' | 'working' | 'failed' | 'blocked' | 'invalid' | 'denied' | 'sample';

/** The note a reminder change leaves on screen: nothing when it was saved. */
const noteOf = (change: ReminderChange): ReminderNote => (change === 'saved' ? 'none' : change);

type Delete = 'idle' | 'confirming' | 'working' | 'blocked' | 'failed' | { done: Extract<EraseOutcome, { status: 'erased' }> };

/**
 * Privacy and your data: copyable JSON of everything on this phone, and "Delete everything". Deleting first asks the
 * server to revoke every consent and remove what it holds (if this phone ever gave it anything), and only then wipes
 * the encrypted store and its key. If the server holds data and cannot be reached, nothing is deleted and the person
 * is told, because the wipe would destroy the only secret that can ask for the server's copy to go.
 */
export function SettingsScreen() {
  const t = useTranslations('settings');
  const ta = useTranslations('anonymous');
  const locale = useLocale();
  const lang = isLocale(locale) ? locale : 'en';
  const device = useDevice();
  const [json, setJson] = useState<string | null>(null);
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [removal, setRemoval] = useState<Delete>('idle');
  const [unreadable, setUnreadable] = useState(false);
  const usable = device !== null && device !== 'unavailable';
  const anonymous = usable && device.anonymous;
  const [equityOn, setEquityOn] = useState<boolean | null>(null);
  const [equityState, setEquityState] = useState<'idle' | 'working' | 'removed' | 'failed'>('idle');
  const [statisticsOn, setStatisticsOn] = useState<boolean | null>(null);
  const [statisticsState, setStatisticsState] = useState<StatisticsState>('idle');
  const [cleared, setCleared] = useState<ClearedNote>({ equity: false, statistics: false });
  const [reminders, setReminders] = useState<ReminderSettings | null>(null);
  const [reminderNote, setReminderNote] = useState<ReminderNote>('none');
  const [phoneInput, setPhoneInput] = useState('');

  useEffect(() => {
    if (!usable) return;
    /** Reads the phone's notes of the two choices, and takes (once) the note of a choice the server switched off. */
    const showChoices = async () => {
      void loadEquity(device.storage).then((stored) => setEquityOn(stored.optIn), () => setEquityOn(null));
      void loadOutcomeStatistics(device.storage).then(setStatisticsOn, () => setStatisticsOn(null));
      if (device.anonymous) return;
      const taken = await takeClearedNote(device.storage);
      if (taken) setCleared((earlier) => ({ equity: earlier.equity || taken.equity, statistics: earlier.statistics || taken.statistics }));
    };
    void showChoices();
    // Settings shows what the server holds: a choice it switched off while the phone was idle is shown off, once the read comes back.
    void learnChoicesNow(lang).then(() => showChoices());
    void loadReminders(device.storage).then(setReminders, () => setReminders(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device, usable]);

  const serverFor = (d: Device): ServerDeps => ({ storage: d.storage, fetch: deviceFetch(), apiUrl: API_URL, locale: lang, random: window.crypto });

  /** Runs one reminder change, re-reads the saved settings and shows how it ended. A saved number field is cleared. */
  async function changeReminders(run: (d: Device) => Promise<ReminderNote>) {
    if (!usable) return;
    setReminderNote('working');
    let note: ReminderNote;
    try {
      note = await run(device);
    } catch {
      note = 'failed';
    }
    setReminders(await loadReminders(device.storage).catch(() => null));
    setReminderNote(note);
    if (note === 'none') setPhoneInput('');
  }

  const toggleReminders = (on: boolean) =>
    changeReminders(async (d) => {
      if (on) return (await enableReminders({ storage: d.storage, notifications: await deviceNotifications(), now: deviceNow })) === 'granted' ? 'none' : 'denied';
      if (!reminders) return 'none';
      const outcome = await turnOffReminders({ server: serverFor(d) }, reminders);
      return outcome === 'off' ? 'none' : outcome;
    });

  const chooseInterval = (weeks: ReminderInterval) => changeReminders(async (d) => noteOf(await setReminderInterval({ server: serverFor(d), now: deviceNow }, reminders!, weeks)));
  const saveNumber = () => changeReminders(async (d) => noteOf(await saveReminderNumber({ server: serverFor(d), now: deviceNow }, reminders!, phoneInput)));
  const removeNumber = () => changeReminders(async (d) => noteOf(await removeReminderNumber({ server: serverFor(d) }, reminders!)));
  const showSample = () => changeReminders(async (d) => ((await requestReminderSample({ server: serverFor(d) })) === 'prepared' ? 'sample' : 'failed'));

  /** Takes the person out of the equity group totals: the server clears the four buckets, then the phone remembers it. */
  async function optOut() {
    if (!usable) return;
    setEquityState('working');
    try {
      await markServerFootprint(device.storage, deviceNow);
      const done = await callServer(
        { storage: device.storage, fetch: deviceFetch(), apiUrl: API_URL, locale: lang, random: window.crypto },
        'PUT',
        '/me/equity',
        { optIn: false },
      );
      if (!done.ok) return setEquityState('failed');
      await saveEquity(device.storage, { optIn: false, buckets: {} });
      setEquityOn(false);
      setEquityState('removed');
    } catch {
      setEquityState('failed');
    }
  }

  /** Stops the person's totals counting in anonymous statistics: the server first (so the next read of the figures leaves them out), then the phone's note. */
  async function turnOffStatistics() {
    if (!usable) return;
    setStatisticsState('working');
    try {
      const outcome = await turnOffOutcomeStatistics(serverFor(device));
      if (outcome === 'failed') return setStatisticsState('failed');
      setStatisticsOn(false);
      setStatisticsState('removed');
    } catch {
      setStatisticsState('failed');
    }
  }

  async function show() {
    if (!usable) return;
    try {
      setJson(await exportDeviceData(device.storage, deviceNow));
      setCopy('idle');
    } catch {
      setUnreadable(true);
    }
  }

  async function copyJson() {
    try {
      await navigator.clipboard.writeText(json ?? '');
      setCopy('copied');
    } catch {
      setCopy('failed');
    }
  }

  async function wipe() {
    if (!usable) return;
    setRemoval('working');
    const server = { storage: device.storage, fetch: deviceFetch(), apiUrl: API_URL, locale: lang, random: window.crypto };
    const outcome = await eraseEverything({
      storage: device.storage,
      tabMark: device.tabMark,
      server,
      flushCrisis: () => flushOutbox({ storage: device.storage, fetch: deviceFetch(), apiUrl: API_URL, locale: lang, random: window.crypto }),
      crisisIsOpen: async () => (await device.crisis.read()).status === 'blocked',
    });
    if (outcome.status === 'erased') {
      setJson(null);
      setRemoval({ done: outcome });
    } else {
      setRemoval(outcome.status);
    }
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <HomeHeader />
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 py-5">
        <h1 className="t-h1">{t('title')}</h1>
        <p className="t-body text-muted">{t('intro')}</p>
        <p className="t-small text-muted" data-exception>{t('exception')}</p>
        {(device === 'unavailable' || unreadable) && <p role="alert" className="rounded-chip bg-warning px-3 py-2 text-small text-warning-ink">{t('unavailable')}</p>}

        <section className="flex flex-col gap-2.5 rounded-card border border-border bg-surface p-5">
          <h2 className="text-[16px] font-semibold">{t('downloadTitle')}</h2>
          <p className="t-body text-muted">{t('downloadBody')}</p>
          <button type="button" className="btn-primary" disabled={!usable} onClick={() => void show()}>
            {t('download')}
          </button>
          {json !== null && (
            <>
              <label htmlFor="export" className="text-[13px] font-semibold text-muted">
                {t('dataLabel')}
              </label>
              <textarea id="export" readOnly dir="ltr" rows={8} value={json} className="w-full rounded-input border border-[#9AAAA7] bg-ground p-2 font-mono text-[12px]" />
              <button type="button" className="tap rounded-pill border-[1.5px] border-accent px-4 font-semibold text-accent" onClick={() => void copyJson()}>
                {t('copy')}
              </button>
              {copy !== 'idle' && <p role="status" className="t-small text-muted">{t(copy === 'copied' ? 'copied' : 'copyFailed')}</p>}
            </>
          )}
        </section>

        <section className="flex flex-col gap-2.5 rounded-card border border-border bg-surface p-5" data-panel="anonymous">
          <h2 className="text-[16px] font-semibold">{ta(anonymous ? 'settingsTitle' : 'title')}</h2>
          <p className="t-body text-muted">{anonymous ? ta('settingsBody') : ta('homeBody')}</p>
          <a className="tap inline-flex items-center font-semibold text-accent" href={href(lang, 'anonymous')} data-anonymous-link>
            {anonymous ? ta('leave') : ta('homeAction')}
          </a>
        </section>

        {!anonymous && (
        <section className="flex flex-col gap-2.5 rounded-card border border-border bg-surface p-5" data-panel="reminders">
          <h2 className="text-[16px] font-semibold">{t('remindersTitle')}</h2>
          <p className="t-body text-muted">{t('remindersBody')}</p>
          <label className="flex min-h-tap cursor-pointer items-center justify-between gap-3 text-[15px] font-semibold">
            {t('remindersSwitch')}
            <input
              type="checkbox"
              role="switch"
              checked={reminders !== null}
              disabled={!usable || reminderNote === 'working'}
              onChange={(event) => void toggleReminders(event.target.checked)}
              className="size-[22px] accent-accent"
              data-reminders-switch
            />
          </label>
          {reminders !== null && (
            <>
              <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
                <legend className="mb-1 p-0 text-[13px] font-semibold text-muted">{t('remindersEvery')}</legend>
                {REMINDER_INTERVAL_WEEKS.map((weeks) => (
                  <label key={weeks} className="flex min-h-tap cursor-pointer items-center gap-3 text-[15px]">
                    <input
                      type="radio"
                      name="reminder-interval"
                      value={weeks}
                      checked={reminders.intervalWeeks === weeks}
                      disabled={reminderNote === 'working'}
                      onChange={() => void chooseInterval(weeks)}
                      className="size-[22px] accent-accent"
                    />
                    {t('remindersWeeks', { count: weeks })}
                  </label>
                ))}
              </fieldset>
              <p className="t-small text-muted" data-reminders-limit>{t('remindersLimit')}</p>

              <div className="flex flex-col gap-2 border-t border-border pt-2.5" data-panel="reminder-number">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-[15px] font-semibold">{t('remindersTextTitle')}</h3>
                  <span className="inline-flex whitespace-nowrap rounded-chip bg-mock px-2 py-[3px] text-[12px] font-semibold text-mock-ink" data-sample>{t('remindersSample')}</span>
                </div>
                <p className="t-small text-muted">{t('remindersTextBody')}</p>
                {reminders.phone !== null ? (
                  <>
                    <p className="text-[15px]" dir="ltr" data-reminder-number>{reminders.phone}</p>
                    <button type="button" className="tap rounded-pill border-[1.5px] border-accent px-4 font-semibold text-accent" disabled={reminderNote === 'working'} onClick={() => void showSample()} data-reminder-sample>
                      {t('remindersSampleButton')}
                    </button>
                    <button type="button" className="tap rounded-pill border-[1.5px] border-danger px-4 font-semibold text-danger" disabled={reminderNote === 'working'} onClick={() => void removeNumber()}>
                      {t('remindersRemoveNumber')}
                    </button>
                  </>
                ) : (
                  <>
                    <label htmlFor="reminder-phone" className="text-[13px] font-semibold text-muted">{t('remindersNumberLabel')}</label>
                    <input
                      id="reminder-phone"
                      type="tel"
                      inputMode="tel"
                      autoComplete="off"
                      dir="ltr"
                      placeholder="+971 5X XXX XXXX"
                      value={phoneInput}
                      onChange={(event) => setPhoneInput(event.target.value)}
                      className="min-h-tap w-full rounded-input border border-[#9AAAA7] bg-ground px-3 text-[15px]"
                    />
                    <button type="button" className="tap rounded-pill border-[1.5px] border-accent px-4 font-semibold text-accent" disabled={phoneInput.trim() === '' || reminderNote === 'working'} onClick={() => void saveNumber()}>
                      {t('remindersSaveNumber')}
                    </button>
                  </>
                )}
              </div>
            </>
          )}
          {reminderNote === 'sample' && <p role="status" className="t-small text-muted" data-reminder-note="sample">{t('remindersSampleDone')}</p>}
          {reminderNote === 'denied' && <p role="status" className="t-small text-muted" data-reminder-note="denied">{t('remindersDenied')}</p>}
          {reminderNote === 'invalid' && <p role="alert" className="text-[15px] font-semibold text-danger" data-reminder-note="invalid">{t('remindersInvalid')}</p>}
          {reminderNote === 'failed' && <p role="alert" className="text-[15px] font-semibold text-danger" data-reminder-note="failed">{t('remindersFailed')}</p>}
          {reminderNote === 'blocked' && <p role="alert" className="text-[15px] font-semibold text-danger" data-reminder-note="blocked">{t('remindersBlocked')}</p>}
        </section>
        )}

        {(cleared.equity || cleared.statistics) && (
          <section className="flex flex-col gap-2.5 rounded-card border border-border bg-surface p-5" data-panel="opt-ins-cleared">
            <p role="status" className="t-body text-muted" data-opt-ins-cleared={cleared.equity && cleared.statistics ? 'both' : cleared.equity ? 'equity' : 'statistics'}>
              {t(cleared.equity && cleared.statistics ? 'optInsClearedBoth' : cleared.equity ? 'optInsClearedEquity' : 'optInsClearedStatistics')}
            </p>
          </section>
        )}

        {(equityOn || equityState === 'removed' || equityState === 'failed') && (
          <section className="flex flex-col gap-2.5 rounded-card border border-border bg-surface p-5" data-panel="equity">
            <h2 className="text-[16px] font-semibold">{t('equityTitle')}</h2>
            <p className="t-body text-muted">{t(equityOn ? 'equityOnBody' : 'equityOffBody')}</p>
            {equityOn && <p className="t-small text-muted" data-idle-note>{t('optInIdleNote')}</p>}
            {equityOn && (
              <button type="button" className="tap rounded-pill border-[1.5px] border-accent px-4 font-semibold text-accent" disabled={equityState === 'working'} onClick={() => void optOut()}>
                {t('equityOptOut')}
              </button>
            )}
            {equityState === 'removed' && <p role="status" className="text-[15px] font-semibold text-accent-dark">{t('equityRemoved')}</p>}
            {equityState === 'failed' && <p role="alert" className="text-[15px] font-semibold text-danger">{t('equityFailed')}</p>}
          </section>
        )}

        <OutcomeStatisticsPanel on={statisticsOn === true} state={statisticsState} onTurnOff={() => void turnOffStatistics()} />

        {usable && !anonymous && <CrisisHandoffPanel device={device} lang={lang} mode="settings" />}

        <section className="flex flex-col gap-2.5 rounded-card border border-border bg-surface p-5">
          <h2 className="text-[16px] font-semibold">{t('deleteTitle')}</h2>
          <p className="t-body text-muted">{anonymous ? ta('deleteBody') : t('deleteBody')}</p>
          {(removal === 'idle' || removal === 'failed' || removal === 'blocked') && (
            <button type="button" className="tap rounded-pill border-[1.5px] border-danger px-4 font-semibold text-danger" disabled={!usable} onClick={() => setRemoval('confirming')}>
              {t('delete')}
            </button>
          )}
          {removal === 'confirming' && (
            <div role="alertdialog" aria-labelledby="confirm-text" className="flex flex-col gap-2.5 rounded-staff border border-danger p-3">
              <p id="confirm-text" className="text-[15px] font-semibold">
                {t('deleteConfirm')}
              </p>
              <button type="button" className="tap rounded-pill bg-danger px-4 font-semibold text-surface" onClick={() => void wipe()}>
                {t('deleteYes')}
              </button>
              <button type="button" className="tap rounded-pill border-[1.5px] border-border px-4 font-semibold" onClick={() => setRemoval('idle')}>
                {t('deleteNo')}
              </button>
            </div>
          )}
          {removal === 'working' && <p role="status" className="t-body text-muted">{t('deleting')}</p>}
          {typeof removal === 'object' && (
            <div role="status" className="flex flex-col gap-1.5" data-erased>
              <p className="text-[15px] font-semibold text-accent-dark">{t('deleted')}</p>
              {removal.done.crisisRecord === 'sent' && <p className="t-small text-muted">{t('deletedCrisisSent')}</p>}
              {removal.done.crisisRecord === 'deleted' && <p className="t-small text-muted">{t('deletedCrisisLost')}</p>}
              {removal.done.crisisWasOpen && <p className="t-small text-muted">{t('deletedCrisisOpen')}</p>}
              <AnonymousLeftNote left={removal.done.anonymousLeft} />
            </div>
          )}
          {removal === 'blocked' && <p role="alert" className="text-[15px] font-semibold text-danger">{t('blocked')}</p>}
          {removal === 'failed' && <p role="alert" className="text-[15px] font-semibold text-danger">{t('deleteFailed')}</p>}
        </section>

        <section className="flex flex-col gap-1 px-1">
          <h2 className="text-[14px] font-semibold">{t('numbersTitle')}</h2>
          <p className="t-small text-muted">{numbersText(t, crisisLines())}</p>
        </section>
      </main>
      <BottomNav />
    </div>
  );
}
