'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { demoOffsetMs, fetchDemoOffsetMs, setDemoOffsetMs, subscribeDemoOffset } from '../demo-clock';

/** Re-renders with the demo clock's offset, so a screen that shows a date moves when the clock does. */
export function useDemoOffsetMs(): number {
  return useSyncExternalStore(subscribeDemoOffset, demoOffsetMs, () => 0);
}

/**
 * Keeps the demo clock's offset up to date for a screen that compares dates (the clinic queue's overdue marks): it asks
 * the API once when the screen opens and again whenever the tab becomes visible, since the presenter moves the clock from
 * another tab. A failed read leaves the offset as it was. Returns the offset, so the screen re-renders when it changes.
 */
export function useDemoClockSync(apiUrl: string): number {
  useEffect(() => {
    const read = () => void fetchDemoOffsetMs({ fetch: window.fetch.bind(window), apiUrl }).then((offset) => offset !== null && setDemoOffsetMs(offset));
    read();
    const onVisible = () => {
      if (document.visibilityState === 'visible') read();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [apiUrl]);
  return useDemoOffsetMs();
}
