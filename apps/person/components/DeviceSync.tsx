'use client';

import { useLocale } from 'next-intl';
import { isLocale } from '@mawsool/ui';
import { useEffect } from 'react';
import { refreshDirectory, repairNow, syncNow } from '../lib/sync';
import { getDevice } from '../lib/use-device';

/**
 * Background work on every page load, none of which the person waits for:
 * - sends any crisis event queued while offline, now and whenever the browser says it is back online;
 * - refreshes the saved copy of the sample directory, so matching works offline after one online visit.
 * Both fail quietly: the next load or the next `online` event tries again.
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
    refreshDirectory();
    const onOnline = () => {
      void repairNow(lang);
      syncNow(lang);
      refreshDirectory();
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [locale]);
  return null;
}
