import { hasLocale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { LOCALES } from '@mawsool/ui';
import { RequireStaffSession } from '@mawsool/ui/components';

export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!hasLocale(LOCALES, locale)) notFound();
  setRequestLocale(locale);
  const t = await getTranslations('home');
  const signIn = await getTranslations('signIn');

  return (
    <RequireStaffSession roles={['ops', 'admin']} signInHref={`/${locale}/sign-in/`} checkingLabel={signIn('checking')}>
      <main className="mx-auto flex max-w-5xl flex-col gap-3 p-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="t-h1 flex-1">{t('heading')}</h1>
          <span className="t-label rounded-chip bg-mock px-2.5 py-1 font-semibold text-mock-ink">{t('simulated')}</span>
        </div>
      </main>
    </RequireStaffSession>
  );
}
