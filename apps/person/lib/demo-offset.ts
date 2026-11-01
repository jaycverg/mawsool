import { fetchDemoOffsetMs, setDemoOffsetMs, type StorageAdapter } from '@mawsool/ui';
import { API_URL } from './api';
import { KEYS } from './keys';

/**
 * Takes the last offset this phone saw from its own store, so a phone that is offline still agrees with the last date
 * it was told. Fire and forget: a store that will not answer leaves the offset at zero, and nothing waits for this.
 */
export async function restoreDemoOffset(storage: StorageAdapter): Promise<void> {
  try {
    const saved = await storage.get<unknown>(KEYS.demoOffset);
    if (typeof saved === 'number') setDemoOffsetMs(saved);
  } catch {
    // The store would not answer: the offset stays as it is.
  }
}

/**
 * Asks the API for the demo clock's offset and keeps the answer. A failed read keeps the last offset; a read that works
 * replaces it, including with zero, so a phone does not carry a three-week jump into a deployment without a demo.
 *
 * It sends nothing from the phone (a plain GET with no credential and no body), is never awaited by the crisis path or
 * by matching, and logs no console error when the API has no demo running, because the endpoint is always there.
 */
export async function refreshDemoOffset(storage: StorageAdapter, fetcher: typeof fetch = window.fetch.bind(window)): Promise<void> {
  const offset = await fetchDemoOffsetMs({ fetch: fetcher, apiUrl: API_URL });
  if (offset === null) return;
  setDemoOffsetMs(offset);
  try {
    await storage.set(KEYS.demoOffset, offset);
  } catch {
    // Not kept: the next online read tells it again.
  }
}
