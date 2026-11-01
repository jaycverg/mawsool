'use client';

import { useEffect } from 'react';

/** Registers the service worker in production builds, so development never serves stale cached pages. */
export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // The app works without it; a failed registration only means no offline shell.
    });
  }, []);
  return null;
}
