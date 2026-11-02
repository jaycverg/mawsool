'use client';

import { useLocale } from 'next-intl';
import { isLocale } from '@mawsool/ui';
import { useEffect } from 'react';
import { refreshDemoClock, refreshDirectory, repairNow, syncNow } from '../lib/sync';
import { getDevice } from '../lib/use-device';

/**
 * Background work on every page load, none of which the person waits for:
 * - sends any crisis event queued while offline, now and whenever the browser says it is back online;
 * - refreshes the saved copy of the sample directory, so matching works offline after one online visit;
 * - reads the demo clock's offset (zero unless a demo is running) so dates agree with the API: the last one seen is
 *   restored from the phone's store first, so an offline phone keeps it. Nothing waits for it and nothing depends on it.
 * All fail quietly: the next load or the next `online` event tries again.
 */
export function DeviceSync() {
  const locale = useLocale();
  useEffect(() => {
    try {
      getDevice();
    } catch {
      return; // no usable storage: nothing is queued and nothing can be saved
    }
    const lang = isLocale(locale) ? locale : 'en';

    syncNow(lang);
    refreshDirectory(lang);
    refreshDemoClock({ restore: true });
    const onOnline = () => {
      void repairNow(lang);
      syncNow(lang);
      refreshDirectory(lang);
      refreshDemoClock({ restore: false });
    };
    // A presenter moves the clock from the admin panel in another tab: coming back to this one asks again.
    const onVisible = () => {
      if (document.visibilityState === 'visible') refreshDemoClock({ restore: false });
    };
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [locale]);
  return null;
}
