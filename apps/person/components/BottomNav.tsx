'use client';

import { useLocale, useTranslations } from 'next-intl';
import { usePathname } from 'next/navigation';
import { href, stripLocale } from '../lib/routes';

type Tab = 'home' | 'checkIns' | 'ticket' | 'privacy';

const TABS: { id: Tab; screen: string; path: string; icon: string }[] = [
  { id: 'home', screen: '', path: '/', icon: 'M4 11l8-7 8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z' },
  { id: 'checkIns', screen: 'check-ins', path: '/check-ins', icon: 'M5 19V9M12 19V5M19 19v-8' },
  { id: 'ticket', screen: 'ticket', path: '/ticket', icon: 'M4 8a2 2 0 0 0 0 4v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3a2 2 0 0 1 0-4V6a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1z' },
  { id: 'privacy', screen: 'settings', path: '/settings', icon: 'M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6z' },
];

/** The four-tab bar of the main screens. It is not shown on the check-in, result, options or crisis screens. */
export function BottomNav() {
  const t = useTranslations('nav');
  const locale = useLocale();
  const current = stripLocale(usePathname() ?? '/');
  return (
    <nav aria-label={t('label')} className="sticky bottom-0 flex justify-around border-t border-border bg-surface px-2 pb-3 pt-1.5">
      {TABS.map((tab) => {
        const active = current === tab.path;
        return (
          <a
            key={tab.id}
            href={href(locale, tab.screen)}
            aria-current={active ? 'page' : undefined}
            className={`flex min-h-12 min-w-16 flex-col items-center justify-center gap-0.5 text-[12px] ${active ? 'font-semibold text-accent' : 'text-muted'}`}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d={tab.icon} />
            </svg>
            {t(tab.id)}
          </a>
        );
      })}
    </nav>
  );
}
