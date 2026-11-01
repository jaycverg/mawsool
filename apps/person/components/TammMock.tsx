'use client';

import { InviteCodeSchema } from '@mawsool/types';
import { isLocale } from '@mawsool/ui';
import { LanguageToggle } from '@mawsool/ui/components';
import { useLocale, useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { href } from '../lib/routes';

/**
 * A stand-in for the page TAMM would show after a screening: a positive result and a "Continue with Mawsool" link
 * carrying the invite code the front door received. It is not TAMM and says so at the top of the screen. Its only job
 * is to show the deep link into the claim screen; it never calls the API and knows no signing key.
 */
export function TammMock() {
  const t = useTranslations('tamm');
  const common = useTranslations('common');
  const locale = useLocale();
  const lang = isLocale(locale) ? locale : 'en';
  const code = useSearchParams().get('code') ?? '';
  const valid = InviteCodeSchema.safeParse(code).success;

  return (
    <div className="flex min-h-dvh flex-col bg-surface">
      <p role="note" className="bg-mock px-4 py-2.5 text-center text-[13px] font-semibold text-mock-ink" data-mock-banner>{t('mockBanner')}</p>
      <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3.5">
        <span className="text-[17px] font-semibold">{t('portal')}</span>
        <LanguageToggle locale={lang} ariaLabel={common('language')} />
      </header>
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-3.5 px-4 py-5" data-screen="tamm-mock">
        <h1 className="t-h1">{t('heading')}</h1>
        <p className="t-body">{t('result')}</p>
        <p className="t-body text-muted">{t('next')}</p>
        {valid ? (
          <a className="btn-primary" href={href(lang, 'claim', { code })} data-continue-with-mawsool>{t('continue')}</a>
        ) : (
          <p role="alert" className="t-body text-danger" data-no-code>{t('noCode')}</p>
        )}
        <p className="t-small text-muted">{t('mockNote')}</p>
      </main>
    </div>
  );
}
