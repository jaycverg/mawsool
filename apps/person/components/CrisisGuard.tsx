'use client';

import { useLocale } from 'next-intl';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { isBlocking } from '../lib/crisis';
import { href, isGuardedPath } from '../lib/routes';
import { getDevice } from '../lib/use-device';

type Check = 'checking' | 'clear';

/**
 * Keeps matching and ticket screens shut while a crisis trigger is unresolved.
 *
 * On a guarded path nothing of the screen renders until the persisted block has been read, and a block that is on,
 * or cannot be read, sends the person to the crisis screen. The check runs on every arrival: a reload, a deep link,
 * client navigation, and a page restored from the back/forward cache (`pageshow`). The redirect is a full
 * navigation, which the service worker answers from its cache offline. The static HTML of a guarded page holds the
 * waiting state only, never the screen itself.
 */
export function CrisisGuard({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '/';
  const locale = useLocale();
  const guarded = isGuardedPath(pathname);
  const [checked, setChecked] = useState<{ path: string; result: Check } | null>(null);

  useEffect(() => {
    if (!guarded) return;
    let cancelled = false;

    const check = async () => {
      let blocked = true; // failing safe: an unreadable block counts as blocked
      try {
        blocked = isBlocking(await getDevice().crisis.read());
      } catch {
        // Storage is unavailable; nothing can be matched without it, and the crisis screen needs none.
      }
      if (cancelled) return;
      if (blocked) window.location.replace(href(locale, 'crisis'));
      else setChecked({ path: pathname, result: 'clear' });
    };

    void check();
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        setChecked(null);
        void check();
      }
    };
    window.addEventListener('pageshow', onPageShow);
    return () => {
      cancelled = true;
      window.removeEventListener('pageshow', onPageShow);
    };
  }, [guarded, pathname, locale]);

  if (guarded && checked?.path !== pathname) {
    return <main aria-busy="true" className="min-h-dvh" data-crisis-guard="checking" />;
  }
  return <>{children}</>;
}
