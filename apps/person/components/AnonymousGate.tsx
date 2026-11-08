'use client';

import { isLocale } from '@mawsool/ui';
import { useLocale, useTranslations } from 'next-intl';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { isAnonymous, reconcileAnonymousStore } from '../lib/anonymous';
import { href, isAnonymousWalledPath, stripLocale } from '../lib/routes';
import { AnonymousFacts } from './AnonymousScreen';

type Mode = 'checking' | 'normal' | 'anonymous';

/**
 * In an anonymous session: a banner on every screen but the crisis screen, saying nothing is sent or kept on a server, and, on
 * the screens that need the server, an explanation in place of the screen. On those screens nothing of the screen renders until
 * the mode is known, and never in an anonymous session, so nothing on them can start a request. Outside an anonymous session it
 * renders its children and nothing more.
 */
export function AnonymousGate({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '/';
  const locale = useLocale();
  const lang = isLocale(locale) ? locale : 'en';
  const t = useTranslations('anonymous');
  const [mode, setMode] = useState<Mode>('checking');
  useEffect(() => {
    setMode(isAnonymous() ? 'anonymous' : 'normal');
    // Start of the app in this tab: the store of an earlier anonymous session, whose tab closed without a chance to wipe it, goes now.
    void reconcileAnonymousStore();
  }, []);

  const walled = isAnonymousWalledPath(pathname);
  if (walled && mode === 'checking') return <main aria-busy="true" className="min-h-dvh" data-anonymous-gate="checking" />;
  const showBanner = mode === 'anonymous' && stripLocale(pathname) !== '/crisis';
  return (
    <>
      {showBanner && (
        <p role="note" className="flex flex-wrap items-center justify-center gap-x-2 bg-mock px-4 py-2 text-center text-[13px] font-semibold text-mock-ink" data-anonymous-banner>
          {t('banner')}
          <a className="underline" href={href(lang, 'anonymous')}>
            {t('bannerLink')}
          </a>
        </p>
      )}
      {walled && mode === 'anonymous' ? (
        <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-4 px-4 py-6" data-anonymous-wall>
          <h1 className="t-h1">{t('wallTitle')}</h1>
          <p className="t-body">{t('wallBody')}</p>
          <AnonymousFacts cannotOnly />
          <a className="btn-primary" href={href(lang, 'anonymous')}>
            {t('wallMeaning')}
          </a>
          <a className="tap flex items-center justify-center text-[15px] font-semibold text-accent" href={href(lang, '')}>
            {t('wallHome')}
          </a>
        </main>
      ) : (
        children
      )}
    </>
  );
}
