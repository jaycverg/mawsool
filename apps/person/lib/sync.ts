import type { Locale } from '@mawsool/types';
import { isAnonymous } from './anonymous';
import { API_URL } from './api';
import { deviceNow } from './clock';
import { refreshDemoOffset, restoreDemoOffset } from './demo-offset';
import { flushOutbox } from './crisis-outbox';
import { keepSeenToday } from './presence';
import { loadDirectory } from './directory';
import { KEYS } from './keys';
import { deviceFetch } from './net';
import { getDevice } from './use-device';

/**
 * Every function here is background work that talks to the server, and none of it runs in an anonymous session: each asks
 * `isAnonymous()` first and returns before it so much as opens the store.
 */

/** Sends any queued crisis events now. Fire and forget: a failure leaves them queued for the next try. */
export function syncNow(locale: Locale): void {
  if (isAnonymous()) return;
  try {
    const { storage } = getDevice();
    void flushOutbox({ storage, fetch: deviceFetch(), apiUrl: API_URL, locale, random: window.crypto }).catch(() => undefined);
  } catch {
    // No usable storage, so nothing is queued.
  }
}

/**
 * Repairs an open crisis whose block or event never reached storage, then sends what is queued. Fire and forget:
 * it does nothing when no crisis is open, and a failure leaves things as they were for the next try. In an anonymous session
 * the repair still runs, since it is local, and nothing is sent afterwards.
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
  if (isAnonymous()) return;
  try {
    const { storage } = getDevice();
    void loadDirectory({ storage, fetch: deviceFetch(), apiUrl: API_URL, locale, now: deviceNow }).catch(() => undefined);
  } catch {
    // No usable storage, so there is nowhere to save it.
  }
}

/**
 * Brings the demo clock's offset up to date. With `restore`, the last offset this phone kept is applied first, so an
 * offline phone starts from it. Fire and forget, and never part of the crisis path or of matching. An anonymous session
 * reads no offset and restores none: its care clock is the device clock.
 */
export function refreshDemoClock(options: { restore: boolean }): void {
  if (isAnonymous()) return;
  try {
    const { storage } = getDevice();
    void (options.restore ? restoreDemoOffset(storage) : Promise.resolve()).then(() => refreshDemoOffset(storage)).catch(() => undefined);
  } catch {
    // No usable storage: the offset stays as it is.
  }
}

/**
 * Keeps the server's note of the person's last visit moving while a choice that would otherwise time out is on (see
 * `keepSeenToday`). Fire and forget, a failure is silent and tried again at the next start, and it runs after the crisis
 * outbox has been handed its turn and never while a crisis is open. An anonymous session makes no request.
 */
export function reportPresence(locale: Locale): void {
  if (isAnonymous()) return;
  try {
    const { storage } = getDevice();
    void keepSeenToday({
      server: { storage, fetch: deviceFetch(), apiUrl: API_URL, locale, random: window.crypto },
      now: () => new Date(),
      isAnonymous,
      isOnline: () => navigator.onLine,
      crisisOpen: async (store) => ((await store.get<{ blocked?: unknown } | undefined>(KEYS.crisisBlock))?.blocked === true) || getDevice().tabMark.get() !== null,
    }).catch(() => undefined);
  } catch {
    // No usable storage, so there is no choice to keep.
  }
}
