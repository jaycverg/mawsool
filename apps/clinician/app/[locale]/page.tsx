import { hasLocale } from 'next-intl';
import { setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { LOCALES } from '@mawsool/ui';
import { QueueScreen } from '../../components/QueueScreen';

/** The staff home is the incoming queue. It reads the tab's session in the browser and sends the person to sign-in without one. */
export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!hasLocale(LOCALES, locale)) notFound();
  setRequestLocale(locale);

  return (
    <Suspense>
      <QueueScreen />
    </Suspense>
  );
}
