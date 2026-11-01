import type { Locale } from '@mawsool/types';
import { API_URL } from './api';
import { deviceNow } from './clock';
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

/** Refreshes the saved copy of the sample directory so matching works offline. Fire and forget. */
export function refreshDirectory(): void {
  try {
    const { storage } = getDevice();
    void loadDirectory({ storage, fetch: window.fetch.bind(window), apiUrl: API_URL, now: deviceNow }).catch(() => undefined);
  } catch {
    // No usable storage, so there is nowhere to save it.
  }
}
