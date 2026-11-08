'use client';

import { useTranslations } from 'next-intl';
import { RequireStaffSession } from '@mawsool/ui/components';
import { CrisisConsole } from './CrisisConsole';

/** The console's guard: a `crisis_line` session and no other. Any other role is dropped and sent to sign-in with nothing requested. */
export function CrisisLineHome({ locale }: { locale: string }) {
  const signIn = useTranslations('signIn');
  return (
    <RequireStaffSession roles={['crisis_line']} signInHref={`/${locale}/sign-in/`} checkingLabel={signIn('checking')}>
      {(session, signOut) => <CrisisConsole session={session} signOut={signOut} />}
    </RequireStaffSession>
  );
}
