'use client';

import { useTranslations } from 'next-intl';
import { RequireStaffSession } from '@mawsool/ui/components';
import { AdminPanel } from './AdminPanel';
import { Dashboard } from './Dashboard';

/**
 * The ops app's home. It reads the tab's session in the browser: an `ops` session sees the dashboard (the metrics routes
 * serve that role alone), an `admin` session sees the demo controls, and anyone else is sent to sign-in with nothing
 * requested.
 */
export function OpsHome({ locale }: { locale: string }) {
  const signIn = useTranslations('signIn');
  return (
    <RequireStaffSession roles={['ops', 'admin']} signInHref={`/${locale}/sign-in/`} checkingLabel={signIn('checking')}>
      {(session, signOut) => (session.role === 'admin' ? <AdminPanel session={session} signOut={signOut} /> : <Dashboard session={session} signOut={signOut} />)}
    </RequireStaffSession>
  );
}
