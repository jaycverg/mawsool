'use client';

import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import type { StaffRole } from '@mawsool/types';
import { storeStaffSession, verifySignIn } from '../staff-signin';

export interface StaffSignInLabels {
  heading: string;
  action: string;
  signingIn: string;
  signedIn: string;
  failed: string;
  wrongApp: string;
  missingToken: string;
}

export interface StaffSignInProps {
  /** The one-time token from the link; null when the link had none. */
  token: string | null;
  apiUrl: string;
  allowedRoles: readonly StaffRole[];
  labels: StaffSignInLabels;
}

type Phase = 'idle' | 'signing_in' | 'signed_in' | 'failed' | 'wrong_app';

/**
 * The page a staff sign-in link opens. The link is used only when the person presses the button, because the
 * token works once and a page load must not spend it. Shows one of: ready, signing in, signed in, failed, wrong
 * app, or no token.
 */
export function StaffSignIn({ token, apiUrl, allowedRoles, labels }: StaffSignInProps) {
  const [phase, setPhase] = useState<Phase>('idle');

  async function signIn() {
    if (token === null) return;
    setPhase('signing_in');
    const result = await verifySignIn({ fetch: window.fetch.bind(window), apiUrl, token, allowedRoles });
    if (result.status === 'signed_in') {
      storeStaffSession(safeSessionStorage(), result.session);
      setPhase('signed_in');
    } else {
      setPhase(result.status);
    }
  }

  const message =
    token === null
      ? labels.missingToken
      : { idle: null, signing_in: labels.signingIn, signed_in: labels.signedIn, failed: labels.failed, wrong_app: labels.wrongApp }[phase];

  return (
    <main className="mx-auto flex max-w-md flex-col gap-4 p-6">
      <h1 className="t-h1">{labels.heading}</h1>
      {token !== null && (phase === 'idle' || phase === 'failed' || phase === 'wrong_app') ? (
        <button
          type="button"
          onClick={signIn}
          className="cta tap rounded-card bg-accent px-6 font-semibold text-surface"
        >
          {labels.action}
        </button>
      ) : null}
      {message ? (
        <p role="status" aria-live="polite" data-phase={token === null ? 'missing_token' : phase} className="t-body">
          {message}
        </p>
      ) : null}
    </main>
  );
}

/** Reads `?token=` from the page URL and renders the sign-in form. Wrap in Suspense. */
export function StaffSignInPage(props: Omit<StaffSignInProps, 'token'>) {
  const token = useSearchParams().get('token');
  return <StaffSignIn {...props} token={token} />;
}

function safeSessionStorage(): Storage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}
