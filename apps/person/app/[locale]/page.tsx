import { hasLocale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { LOCALES } from '@mawsool/ui';

export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!hasLocale(LOCALES, locale)) notFound();
  setRequestLocale(locale);
  const t = await getTranslations('home');

  return (
    <main className="mx-auto flex max-w-md flex-col gap-3 p-4">
      <h1 className="t-h1">{t('heading')}</h1>
      <p className="t-body">{t('tagline')}</p>
      <p className="t-small text-muted">{t('privacy')}</p>
    </main>
  );
}
