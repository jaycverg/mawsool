'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Session, StaffRole } from '@mawsool/types';
import { clearStaffSession, readStaffSession } from '../staff-signin';

export interface RequireStaffSessionProps {
  /** Roles this screen serves. A session for any other role is dropped and sent to sign-in. */
  roles: readonly StaffRole[];
  /** The sign-in page for this language. */
  signInHref: string;
  /** Shown while the tab's session is looked up, and until the redirect lands. */
  checkingLabel: string;
  /**
   * Rendered only once a valid session of an allowed role exists. A function is given the session and a way to end it
   * (for a client screen that reads data); plain content (from a server page) is shown as it is.
   */
  children: ReactNode | ((session: Session, signOut: () => void) => ReactNode);
  /** Goes to a page. Defaults to replacing the current history entry, so Back does not return to a screen that sent the person away. */
  navigate?: (href: string) => void;
  /** The current time, so a test can hold it still. */
  now?: () => Date;
}

type Look = { status: 'checking' } | { status: 'session'; session: Session };

const goTo = (href: string) => window.location.replace(href);
const wallClock = () => new Date();

function tabStorage(): Storage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

/**
 * Guards a staff screen. The tab's session is read in the browser after the page loads; with none, an expired one or
 * one for a role this screen does not serve, the person is sent to sign-in and nothing behind the guard is rendered,
 * so no request for wellbeing data is made. The session token is not checked here (the server does that on every
 * call); a screen that gets a 401 later calls the `signOut` it was given.
 */
export function RequireStaffSession({ roles, signInHref, checkingLabel, children, navigate = goTo, now = wallClock }: RequireStaffSessionProps) {
  const [look, setLook] = useState<Look>({ status: 'checking' });
  const roleList = roles.join(',');
  // The look-up runs once per page, however the caller writes these two.
  const latest = useRef({ navigate, now });
  latest.current = { navigate, now };

  // The same function on every render, so a screen can list it as a dependency without reloading its data.
  const signOut = useCallback(() => {
    clearStaffSession(tabStorage());
    latest.current.navigate(signInHref);
  }, [signInHref]);

  useEffect(() => {
    const session = readStaffSession(tabStorage(), latest.current.now());
    if (session && roleList.split(',').includes(session.role)) {
      setLook({ status: 'session', session });
      return;
    }
    if (session) clearStaffSession(tabStorage());
    latest.current.navigate(signInHref);
  }, [roleList, signInHref]);

  if (look.status === 'checking') {
    return (
      <p role="status" aria-live="polite" data-phase="checking_session" className="t-body mx-auto max-w-md p-6">
        {checkingLabel}
      </p>
    );
  }
  return <>{typeof children === 'function' ? children(look.session, signOut) : children}</>;
}
