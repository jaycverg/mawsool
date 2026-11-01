'use client';

import { useLocale, useTranslations } from 'next-intl';
import { href } from '../lib/routes';

/**
 * The red "Help now" pill every screen carries. It goes straight to the crisis screen and logs nothing: it is a way
 * to reach help, not a trigger. A plain link, so it works before scripts load and offline.
 */
export function HelpNowLink() {
  const t = useTranslations('common');
  const locale = useLocale();
  return (
    <a
      href={href(locale, 'crisis')}
      className="inline-flex min-h-tap items-center gap-1.5 rounded-pill border-[1.5px] border-danger px-3.5 rtl:px-3 text-[15px] font-semibold text-danger"
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
        <path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a1 1 0 0 1-1 1A16 16 0 0 1 4 5a1 1 0 0 1 1-1z" />
      </svg>
      {t('helpNow')}
    </a>
  );
}
