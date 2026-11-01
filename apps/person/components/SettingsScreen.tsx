'use client';

import { isLocale } from '@mawsool/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { API_URL } from '../lib/api';
import { deviceNow } from '../lib/clock';
import { numbersText } from '../lib/crisis-copy';
import { crisisLines } from '../lib/crisis-numbers';
import { flushOutbox } from '../lib/crisis-outbox';
import { exportDeviceData } from '../lib/device-data';
import { eraseEverything, type EraseOutcome } from '../lib/erase';
import { callServer, markServerFootprint } from '../lib/server';
import { loadEquity, saveEquity } from '../lib/share';
import { useDevice } from '../lib/use-device';
import { BottomNav } from './BottomNav';
import { HomeHeader } from './HomeHeader';

type Delete = 'idle' | 'confirming' | 'working' | 'blocked' | 'failed' | { done: Extract<EraseOutcome, { status: 'erased' }> };

/**
 * Privacy and your data: copyable JSON of everything on this phone, and "Delete everything". Deleting first asks the
 * server to revoke every consent and remove what it holds (if this phone ever gave it anything), and only then wipes
 * the encrypted store and its key. If the server holds data and cannot be reached, nothing is deleted and the person
 * is told, because the wipe would destroy the only secret that can ask for the server's copy to go.
 */
export function SettingsScreen() {
  const t = useTranslations('settings');
  const locale = useLocale();
  const lang = isLocale(locale) ? locale : 'en';
  const device = useDevice();
  const [json, setJson] = useState<string | null>(null);
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [removal, setRemoval] = useState<Delete>('idle');
  const [unreadable, setUnreadable] = useState(false);
  const usable = device !== null && device !== 'unavailable';
  const [equityOn, setEquityOn] = useState<boolean | null>(null);
  const [equityState, setEquityState] = useState<'idle' | 'working' | 'removed' | 'failed'>('idle');

  useEffect(() => {
    if (!usable) return;
    void loadEquity(device.storage).then((stored) => setEquityOn(stored.optIn), () => setEquityOn(null));
  }, [device, usable]);

  /** Takes the person out of the equity group totals: the server clears the four buckets, then the phone remembers it. */
  async function optOut() {
    if (!usable) return;
    setEquityState('working');
    try {
      await markServerFootprint(device.storage, deviceNow);
      const done = await callServer(
        { storage: device.storage, fetch: window.fetch.bind(window), apiUrl: API_URL, locale: lang, random: window.crypto },
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
    const server = { storage: device.storage, fetch: window.fetch.bind(window), apiUrl: API_URL, locale: lang, random: window.crypto };
    const outcome = await eraseEverything({
      storage: device.storage,
      tabMark: device.tabMark,
      server,
      flushCrisis: () => flushOutbox({ storage: device.storage, fetch: window.fetch.bind(window), apiUrl: API_URL, locale: lang, random: window.crypto }),
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

        {(equityOn || equityState === 'removed' || equityState === 'failed') && (
          <section className="flex flex-col gap-2.5 rounded-card border border-border bg-surface p-5" data-panel="equity">
            <h2 className="text-[16px] font-semibold">{t('equityTitle')}</h2>
            <p className="t-body text-muted">{t(equityOn ? 'equityOnBody' : 'equityOffBody')}</p>
            {equityOn && (
              <button type="button" className="tap rounded-pill border-[1.5px] border-accent px-4 font-semibold text-accent" disabled={equityState === 'working'} onClick={() => void optOut()}>
                {t('equityOptOut')}
              </button>
            )}
            {equityState === 'removed' && <p role="status" className="text-[15px] font-semibold text-accent-dark">{t('equityRemoved')}</p>}
            {equityState === 'failed' && <p role="alert" className="text-[15px] font-semibold text-danger">{t('equityFailed')}</p>}
          </section>
        )}

        <section className="flex flex-col gap-2.5 rounded-card border border-border bg-surface p-5">
          <h2 className="text-[16px] font-semibold">{t('deleteTitle')}</h2>
          <p className="t-body text-muted">{t('deleteBody')}</p>
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
