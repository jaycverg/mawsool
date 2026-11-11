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
  // The banner and the screen share one viewport-high column, and the screen's own root (`min-h-dvh`, or a `main` sized to the viewport) gives up the banner's height, so
  // the banner adds no scroll to a short page. The wrappers render in every mode (as `contents`, which lays out nothing), so the
  // screen below is never remounted when the mode becomes known.
  return (
    <div className={showBanner ? 'flex min-h-dvh flex-col' : 'contents'}>
      {showBanner && (
        <div role="note" className="flex items-center justify-between gap-x-3 bg-mock px-4 text-[13px] font-semibold text-mock-ink" data-anonymous-banner>
          <p className="py-2">{t('banner')}</p>
          <a className="tap inline-flex shrink-0 items-center underline" href={href(lang, 'anonymous')}>
            {t('bannerLink')}
          </a>
        </div>
      )}
      <div className={showBanner ? 'flex flex-1 flex-col [&>.min-h-dvh]:min-h-0 [&>.min-h-dvh]:flex-1 [&>main]:min-h-0 [&>main]:w-full [&>main]:flex-1' : 'contents'}>
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
      </div>
    </div>
  );
}
