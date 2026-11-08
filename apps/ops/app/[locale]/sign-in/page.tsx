import { hasLocale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { LOCALES } from '@mawsool/ui';
import { StaffSignInPage } from '@mawsool/ui/components';

/** The page a staff sign-in link opens. The one-time token is read in the browser and used only on a button press. */
export default async function SignInPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!hasLocale(LOCALES, locale)) notFound();
  setRequestLocale(locale);
  const t = await getTranslations('signIn');

  return (
    <Suspense>
      <StaffSignInPage
        apiUrl={process.env.NEXT_PUBLIC_API_URL ?? ''}
        allowedRoles={['ops', 'admin', 'crisis_line']}
        homeHref={`/${locale}/`}
        homeHrefByRole={{ crisis_line: `/${locale}/crisis-line/` }}
        labels={{
          heading: t('heading'),
          action: t('action'),
          signingIn: t('signingIn'),
          signedIn: t('signedIn'),
          notSaved: t('notSaved'),
          continue: t('continue'),
          failed: t('failed'),
          wrongApp: t('wrongApp'),
          missingToken: t('missingToken'),
          emailLabel: t('emailLabel'),
          requestAction: t('requestAction'),
          requestSent: t('requestSent'),
          requestFailed: t('requestFailed'),
        }}
      />
    </Suspense>
  );
}
