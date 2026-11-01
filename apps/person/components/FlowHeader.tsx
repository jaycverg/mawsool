'use client';

import { useLocale, useTranslations } from 'next-intl';
import { isLocale } from '@mawsool/ui';
import { LanguageToggle } from '@mawsool/ui/components';
import type { ReactNode } from 'react';
import { HelpNowLink } from './HelpNowLink';

export interface FlowHeaderProps {
  /** A link back to where the person came from. */
  leading: { href: string; label: string };
  title: string;
  /** Replaces the default arrow, for a close cross. */
  icon?: 'back' | 'close';
  children?: ReactNode;
}

/**
 * The header of the screens inside a flow (check-in, result, options): a back or close control, the screen title,
 * the language toggle and "Help now". The back arrow mirrors in right-to-left layouts.
 */
export function FlowHeader({ leading, title, icon = 'back' }: FlowHeaderProps) {
  const locale = useLocale();
  const t = useTranslations('common');
  return (
    <header className="flex items-center justify-between gap-2 border-b border-border bg-surface px-4 py-3.5">
      <a href={leading.href} aria-label={leading.label} className="flex size-tap shrink-0 items-center justify-center rounded-pill text-ink">
        {icon === 'close' ? (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        ) : (
          <svg className="rtl-flip" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 5l-7 7 7 7" />
          </svg>
        )}
      </a>
      <span className="min-w-0 flex-1 text-[16px] font-semibold leading-tight">{title}</span>
      <div className="flex shrink-0 items-center gap-1.5">
        <LanguageToggle locale={isLocale(locale) ? locale : 'en'} ariaLabel={t('language')} />
        <HelpNowLink />
      </div>
    </header>
  );
}
