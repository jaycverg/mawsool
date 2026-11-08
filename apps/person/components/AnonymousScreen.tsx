'use client';

import { isLocale } from '@mawsool/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { endAnonymousSession, isAnonymous, startAnonymousSession } from '../lib/anonymous';
import { href } from '../lib/routes';
import { BottomNav } from './BottomNav';
import { HomeHeader } from './HomeHeader';

/** The three lists the screen shows, from the message files: what works, what it cannot do, what stays on the phone. */
export function AnonymousFacts({ cannotOnly = false }: { cannotOnly?: boolean }) {
  const t = useTranslations('anonymous');
  return (
    <>
      {!cannotOnly && (
        <section className="flex flex-col gap-1.5" data-anonymous-works>
          <h2 className="text-[16px] font-semibold">{t('worksTitle')}</h2>
          <ul className="m-0 flex list-disc flex-col gap-1 ps-5">
            <li className="t-body">{t('works1')}</li>
            <li className="t-body">{t('works2')}</li>
          </ul>
        </section>
      )}
      <section className="flex flex-col gap-1.5" data-anonymous-cannot>
        <h2 className="text-[16px] font-semibold">{t('cannotTitle')}</h2>
        <ul className="m-0 flex list-disc flex-col gap-1 ps-5">
          <li className="t-body">{t('cannot1')}</li>
          <li className="t-body">{t('cannot2')}</li>
          <li className="t-body">{t('cannot3')}</li>
        </ul>
      </section>
      {!cannotOnly && (
        <section className="flex flex-col gap-1.5" data-anonymous-keeps>
          <h2 className="text-[16px] font-semibold">{t('keepsTitle')}</h2>
          <p className="t-body">{t('keeps')}</p>
        </section>
      )}
    </>
  );
}

/**
 * Anonymous mode, explained, with the one explicit way in and the one explicit way out. Starting and leaving reload the page,
 * so every screen builds its store from the new mode. Leaving deletes the session's encrypted check-ins and their key.
 */
export function AnonymousScreen() {
  const t = useTranslations('anonymous');
  const locale = useLocale();
  const lang = isLocale(locale) ? locale : 'en';
  const [on, setOn] = useState<boolean | null>(null);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => setOn(isAnonymous()), []);

  function start() {
    startAnonymousSession();
    window.location.assign(href(lang, ''));
  }

  function leave() {
    // Refused while a crisis is open: the person lands on the crisis screen, whose block is still on.
    void endAnonymousSession().then((outcome) => window.location.assign(href(lang, outcome === 'left' ? '' : 'crisis')));
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <HomeHeader />
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 py-5" data-screen="anonymous" data-anonymous-state={on === null ? undefined : on ? 'on' : 'off'}>
        <h1 className="t-h1">{t('title')}</h1>
        <p className="t-body text-muted">{on ? t('introOn') : t('introOff')}</p>
        <AnonymousFacts />
        {on === false && (
          <div className="flex flex-col gap-2.5">
            <button type="button" className="btn-primary" onClick={start} data-anonymous-start>
              {t('start')}
            </button>
            <a className="tap flex items-center justify-center text-[15px] font-semibold text-accent" href={href(lang, '')}>
              {t('notNow')}
            </a>
          </div>
        )}
        {on === true && !confirming && (
          <button type="button" className="tap rounded-pill border-[1.5px] border-accent px-4 font-semibold text-accent" onClick={() => setConfirming(true)} data-anonymous-leave>
            {t('leave')}
          </button>
        )}
        {on === true && confirming && (
          <div role="alertdialog" aria-labelledby="leave-text" className="flex flex-col gap-2.5 rounded-staff border border-danger p-3" data-anonymous-confirm>
            <p id="leave-text" className="text-[15px] font-semibold">
              {t('leaveConfirm')}
            </p>
            <button type="button" className="tap rounded-pill bg-danger px-4 font-semibold text-surface" onClick={leave} data-anonymous-leave-yes>
              {t('leaveYes')}
            </button>
            <button type="button" className="tap rounded-pill border-[1.5px] border-border px-4 font-semibold" onClick={() => setConfirming(false)}>
              {t('leaveNo')}
            </button>
          </div>
        )}
      </main>
      <BottomNav />
    </div>
  );
}
