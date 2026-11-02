import type { Locale } from '@mawsool/types';
import { API_URL } from './api';
import { deviceNow } from './clock';
import { refreshDemoOffset, restoreDemoOffset } from './demo-offset';
import { flushOutbox } from './crisis-outbox';
import { loadDirectory } from './directory';
import { getDevice } from './use-device';

/** Sends any queued crisis events now. Fire and forget: a failure leaves them queued for the next try. */
export function syncNow(locale: Locale): void {
  try {
    const { storage } = getDevice();
    void flushOutbox({ storage, fetch: window.fetch.bind(window), apiUrl: API_URL, locale, random: window.crypto }).catch(() => undefined);
  } catch {
    // No usable storage, so nothing is queued.
  }
}

/**
 * Repairs an open crisis whose block or event never reached storage, then sends what is queued. Fire and forget:
 * it does nothing when no crisis is open, and a failure leaves things as they were for the next try.
 */
export function repairNow(locale: Locale): Promise<void> {
  try {
    return getDevice()
      .crisis.repair(locale)
      .then((outcome) => {
        if (outcome === 'repaired') syncNow(locale);
      });
  } catch {
    return Promise.resolve();
  }
}

/** Refreshes the saved copy of the sample directory, in the page's language, so matching works offline. Fire and forget. */
export function refreshDirectory(locale: Locale): void {
  try {
    const { storage } = getDevice();
    void loadDirectory({ storage, fetch: window.fetch.bind(window), apiUrl: API_URL, locale, now: deviceNow }).catch(() => undefined);
  } catch {
    // No usable storage, so there is nowhere to save it.
  }
}

/**
 * Brings the demo clock's offset up to date. With `restore`, the last offset this phone kept is applied first, so an
 * offline phone starts from it. Fire and forget, and never part of the crisis path or of matching.
 */
export function refreshDemoClock(options: { restore: boolean }): void {
  try {
    const { storage } = getDevice();
    void (options.restore ? restoreDemoOffset(storage) : Promise.resolve()).then(() => refreshDemoOffset(storage)).catch(() => undefined);
  } catch {
    // No usable storage: the offset stays as it is.
  }
}
