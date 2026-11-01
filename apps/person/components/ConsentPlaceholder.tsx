'use client';

import { isLocale } from '@mawsool/ui';
import { useLocale, useTranslations } from 'next-intl';
import { href } from '../lib/routes';
import { FlowHeader } from './FlowHeader';

/** Where a choice other than self-help lands until the consent screen is built. Nothing is shared from here. */
export function ConsentPlaceholder() {
  const t = useTranslations('consent');
  const locale = useLocale();
  const lang = isLocale(locale) ? locale : 'en';
  return (
    <>
      <FlowHeader leading={{ href: href(lang, 'options'), label: t('back') }} title={t('title')} />
      <main className="mx-auto flex max-w-md flex-col gap-3 p-4">
        <h1 className="t-h1">{t('title')}</h1>
        <p className="t-body">{t('body')}</p>
        <a className="btn-primary" href={href(lang, 'options')}>
          {t('back')}
        </a>
      </main>
    </>
  );
}
