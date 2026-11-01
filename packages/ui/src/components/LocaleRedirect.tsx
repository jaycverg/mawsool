'use client';

import { useEffect } from 'react';
import { safeLocalStorage } from '../browser';
import { LOCALES, LOCALE_LABELS, readStoredLocale, resolveInitialLocale } from '../i18n';

/**
 * The root page of every app. A static export cannot redirect on the server, so the first visit picks the
 * remembered locale, else the browser's, else English, and replaces the URL. Plain links to each locale remain
 * for visitors without scripts.
 */
export function LocaleRedirect() {
  useEffect(() => {
    const stored = readStoredLocale(safeLocalStorage());
    const target = resolveInitialLocale(stored, navigator.languages ?? [navigator.language]);
    window.location.replace(`/${target}/`);
  }, []);

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col items-center justify-center gap-3 p-4">
      {LOCALES.map((locale) => (
        <a key={locale} href={`/${locale}/`} lang={locale} className="tap inline-flex items-center t-body text-accent underline">
          {LOCALE_LABELS[locale]}
        </a>
      ))}
    </main>
  );
}
