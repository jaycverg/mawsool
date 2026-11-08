import { hasLocale } from 'next-intl';
import { setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { LOCALES } from '@mawsool/ui';
import { AppHeader } from '@mawsool/ui/components';
import { ClinicLinkScreen } from '../../../components/ClinicLinkScreen';

/**
 * The page a no-login clinic link opens. It needs no sign-in: the link's one-time token, read from the address's fragment in the
 * browser, is its only credential, and it can act on one ticket (a mock channel, see the screen).
 */
export default async function ClinicLinkPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!hasLocale(LOCALES, locale)) notFound();
  setRequestLocale(locale);
  const common = await getTranslations('common');
  return (
    <>
      <AppHeader locale={locale} appName={common('appName')} languageLabel={common('language')} />
      <ClinicLinkScreen />
    </>
  );
}
