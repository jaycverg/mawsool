'use client';

import { usePathname } from 'next/navigation';
import { safeLocalStorage } from '../browser';
import { LOCALE_LABELS, otherLocale, storeLocale, swapLocaleInPath, type Locale } from '../i18n';

export interface LanguageToggleProps {
  /** The locale the page is in now. */
  locale: Locale;
  /** Accessible name, translated by the caller ("Language" / "اللغة"). */
  ariaLabel: string;
  className?: string;
}

/**
 * Switches between Arabic and English on every screen and remembers the choice on the device. It is a real link
 * to the same page in the other locale, so it works before scripts load and in a static export; the click
 * handler only adds the remembered choice and keeps the query string and hash.
 */
export function LanguageToggle({ locale, ariaLabel, className }: LanguageToggleProps) {
  const pathname = usePathname() ?? `/${locale}/`;
  const target = otherLocale(locale);
  const href = swapLocaleInPath(pathname, target);
  return (
    <a
      href={href}
      lang={target}
      hrefLang={target}
      aria-label={ariaLabel}
      className={
        className ?? 'lang-toggle tap'
      }
      onClick={(event) => {
        event.preventDefault();
        storeLocale(safeLocalStorage(), target);
        window.location.assign(`${href}${window.location.search}${window.location.hash}`);
      }}
    >
      {LOCALE_LABELS[target]}
    </a>
  );
}
