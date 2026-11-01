'use client';

import { useLocale, useTranslations } from 'next-intl';
import { isLocale } from '@mawsool/ui';
import { AppHeader } from '@mawsool/ui/components';
import { HelpNowLink } from './HelpNowLink';

/** The wordmark header with the language toggle and "Help now", used on the home, check-ins, ticket and privacy screens. */
export function HomeHeader({ helpNow = true }: { helpNow?: boolean }) {
  const t = useTranslations('common');
  const locale = useLocale();
  return <AppHeader locale={isLocale(locale) ? locale : 'en'} appName={t('appName')} languageLabel={t('language')} action={helpNow ? <HelpNowLink /> : undefined} />;
}
