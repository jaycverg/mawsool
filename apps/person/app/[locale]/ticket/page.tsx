import { hasLocale } from 'next-intl';
import { setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { LOCALES } from '@mawsool/ui';
import { TicketLookup } from './TicketLookup';

/**
 * Static export has no dynamic route segments for data, so a ticket is addressed by query string:
 * `/[locale]/ticket/?id=<ticket id>`. The page itself is prerendered once per locale.
 */
export default async function TicketPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!hasLocale(LOCALES, locale)) notFound();
  setRequestLocale(locale);
  return (
    <Suspense>
      <TicketLookup />
    </Suspense>
  );
}
