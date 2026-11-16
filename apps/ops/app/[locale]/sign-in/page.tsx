import { hasLocale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { DEMO_GUEST_ACCOUNTS, type StaffRole } from '@mawsool/types';
import { LOCALES } from '@mawsool/ui';
import { StaffSignInPage } from '@mawsool/ui/components';

/** The roles this app serves; the guest buttons are the demo accounts with one of them. */
const ALLOWED_ROLES: readonly StaffRole[] = ['ops', 'admin', 'crisis_line'];

/** The page a staff sign-in link opens. The one-time token is read in the browser and used only on a button press. */
export default async function SignInPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!hasLocale(LOCALES, locale)) notFound();
  setRequestLocale(locale);
  const t = await getTranslations('signIn');
  const demo = await getTranslations('demoAccounts');

  return (
    <Suspense>
      <StaffSignInPage
        apiUrl={process.env.NEXT_PUBLIC_API_URL ?? ''}
        allowedRoles={ALLOWED_ROLES}
        guestAccounts={DEMO_GUEST_ACCOUNTS.filter((account) => ALLOWED_ROLES.includes(account.role)).map((account) => ({ email: account.email, label: demo(account.key) }))}
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
          demoHeading: t('demoHeading'),
          demoNote: t('demoNote'),
          demoFailed: t('demoFailed'),
        }}
      />
    </Suspense>
  );
}
