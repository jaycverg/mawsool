import { hasLocale } from 'next-intl';
import { setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { LOCALES } from '@mawsool/ui';
import { CrisisLineHome } from '../../../components/CrisisLineHome';

/** The mock crisis-line console. Only a crisis-line session opens it; anyone else is sent to sign-in. */
export default async function CrisisLinePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!hasLocale(LOCALES, locale)) notFound();
  setRequestLocale(locale);
  return <CrisisLineHome locale={locale} />;
}
