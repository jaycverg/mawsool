import type { Metadata, Viewport } from 'next';
import { NextIntlClientProvider, hasLocale } from 'next-intl';
import { getMessages, getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { LOCALES, htmlAttributes } from '@mawsool/ui';
import { CrisisGuard } from '../../components/CrisisGuard';
import { DeviceSync } from '../../components/DeviceSync';
import { ServiceWorkerRegistration } from '../../components/ServiceWorkerRegistration';
import '../globals.css';

type Params = Promise<{ locale: string }>;

export function generateStaticParams() {
  return LOCALES.map((locale) => ({ locale }));
}

export const dynamicParams = false;

export const viewport: Viewport = { themeColor: '#0e6b63', width: 'device-width', initialScale: 1 };

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'meta' });
  return {
    title: t('title'),
    description: t('description'),
    manifest: '/manifest.webmanifest',
  };
}

export default async function LocaleLayout({ children, params }: { children: ReactNode; params: Params }) {
  const { locale } = await params;
  if (!hasLocale(LOCALES, locale)) notFound();
  setRequestLocale(locale);
  const messages = await getMessages();

  return (
    <html {...htmlAttributes(locale)}>
      <body className="min-h-dvh bg-ground font-sans text-ink">
        <NextIntlClientProvider locale={locale} messages={messages}>
          <CrisisGuard>{children}</CrisisGuard>
          <DeviceSync />
          <ServiceWorkerRegistration />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
