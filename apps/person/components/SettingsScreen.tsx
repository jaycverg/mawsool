'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { deviceNow } from '../lib/clock';
import { deleteDeviceData, exportDeviceData } from '../lib/device-data';
import { useDevice } from '../lib/use-device';
import { BottomNav } from './BottomNav';
import { HomeHeader } from './HomeHeader';

type Delete = 'idle' | 'confirming' | 'deleted' | 'failed';

/**
 * Privacy and your data: copyable JSON of everything on this phone, and "Delete everything". Deleting wipes the
 * encrypted store and its key. Nothing on a server is touched here: nothing has been shared yet, and once tickets
 * exist, deleting will revoke every consent first.
 */
export function SettingsScreen() {
  const t = useTranslations('settings');
  const device = useDevice();
  const [json, setJson] = useState<string | null>(null);
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [removal, setRemoval] = useState<Delete>('idle');
  const [unreadable, setUnreadable] = useState(false);
  const usable = device !== null && device !== 'unavailable';

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
    try {
      await deleteDeviceData(device.storage, device.tabFlag);
      setJson(null);
      setRemoval('deleted');
    } catch {
      setRemoval('failed');
    }
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <HomeHeader />
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 py-5">
        <h1 className="t-h1">{t('title')}</h1>
        <p className="t-body text-muted">{t('intro')}</p>
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

        <section className="flex flex-col gap-2.5 rounded-card border border-border bg-surface p-5">
          <h2 className="text-[16px] font-semibold">{t('deleteTitle')}</h2>
          <p className="t-body text-muted">{t('deleteBody')}</p>
          {removal !== 'confirming' && (
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
          {removal === 'deleted' && <p role="status" className="text-[15px] font-semibold text-accent-dark">{t('deleted')}</p>}
          {removal === 'failed' && <p role="alert" className="text-[15px] font-semibold text-danger">{t('deleteFailed')}</p>}
        </section>

        <section className="flex flex-col gap-1 px-1">
          <h2 className="text-[14px] font-semibold">{t('numbersTitle')}</h2>
          <p className="t-small text-muted">{t('numbersBody')}</p>
        </section>
      </main>
      <BottomNav />
    </div>
  );
}
