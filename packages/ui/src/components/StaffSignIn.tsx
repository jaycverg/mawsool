'use client';

import { useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import type { StaffRole } from '@mawsool/types';
import { requestSignInLink, storeStaffSession, verifySignIn } from '../staff-signin';

export interface StaffSignInLabels {
  heading: string;
  action: string;
  signingIn: string;
  signedIn: string;
  /** The link worked but this browser would not keep the session, so nothing is signed in. */
  notSaved: string;
  /** The link to the app's home, shown once signed in. */
  continue: string;
  failed: string;
  wrongApp: string;
  missingToken: string;
  emailLabel: string;
  requestAction: string;
  requestSent: string;
  requestFailed: string;
}

export interface StaffSignInProps {
  /** The one-time token from the link; null when the link had none. */
  token: string | null;
  apiUrl: string;
  allowedRoles: readonly StaffRole[];
  labels: StaffSignInLabels;
  /** Where "Continue" goes after signing in: the app's home for this language. */
  homeHref: string;
}

type Phase = 'idle' | 'signing_in' | 'signed_in' | 'not_saved' | 'failed' | 'wrong_app';
type RequestPhase = 'idle' | 'sending' | 'sent' | 'failed';

/**
 * The page a staff sign-in link opens. The link is used only when the person presses the button, because the
 * token works once and a page load must not spend it. Shows one of: ready, signing in, signed in, not saved, failed,
 * wrong app, or no token. "Signed in" is said only when the session was kept: if the browser refuses to store it, the
 * page says so, since the link is spent and the next screen would find no session.
 *
 * With no token, or after a link that failed, belonged to the other app or could not be kept, it offers a form to
 * request a new link. The form's answer is the same whether or not the address is registered.
 */
export function StaffSignIn({ token, apiUrl, allowedRoles, labels, homeHref }: StaffSignInProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [requestPhase, setRequestPhase] = useState<RequestPhase>('idle');
  const [email, setEmail] = useState('');

  async function signIn() {
    if (token === null) return;
    setPhase('signing_in');
    const result = await verifySignIn({ fetch: globalThis.fetch.bind(globalThis), apiUrl, token, allowedRoles });
    if (result.status === 'signed_in') {
      setPhase(storeStaffSession(safeSessionStorage(), result.session) ? 'signed_in' : 'not_saved');
    } else {
      setPhase(result.status);
    }
  }

  async function requestLink(event: FormEvent) {
    event.preventDefault();
    setRequestPhase('sending');
    const result = await requestSignInLink({ fetch: globalThis.fetch.bind(globalThis), apiUrl, email: email.trim() });
    setRequestPhase(result === 'accepted' ? 'sent' : 'failed');
  }

  const message =
    token === null
      ? labels.missingToken
      : { idle: null, signing_in: labels.signingIn, signed_in: labels.signedIn, not_saved: labels.notSaved, failed: labels.failed, wrong_app: labels.wrongApp }[phase];
  const canSignIn = token !== null && (phase === 'idle' || phase === 'failed' || phase === 'wrong_app');
  const canRequest = (token === null || phase === 'failed' || phase === 'wrong_app' || phase === 'not_saved') && requestPhase !== 'sent';

  return (
    <main className="mx-auto flex max-w-md flex-col gap-4 p-6">
      <h1 className="t-h1">{labels.heading}</h1>
      {canSignIn ? (
        <button type="button" onClick={signIn} className="btn-primary">
          {labels.action}
        </button>
      ) : null}
      {message ? (
        <p role="status" aria-live="polite" data-phase={token === null ? 'missing_token' : phase} className="t-body">
          {message}
        </p>
      ) : null}
      {phase === 'signed_in' ? (
        <a href={homeHref} className="btn-primary" data-continue>
          {labels.continue}
        </a>
      ) : null}
      {canRequest ? (
        <form onSubmit={requestLink} className="flex flex-col gap-3">
          <label htmlFor="staff-email" className="t-body font-medium">
            {labels.emailLabel}
          </label>
          <input
            id="staff-email"
            name="email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="tap rounded-input border border-border bg-surface px-3 t-body"
          />
          <button type="submit" disabled={requestPhase === 'sending'} className="btn-primary">
            {labels.requestAction}
          </button>
          {requestPhase === 'failed' ? (
            <p role="status" aria-live="polite" data-phase="request_failed" className="t-body">
              {labels.requestFailed}
            </p>
          ) : null}
        </form>
      ) : null}
      {requestPhase === 'sent' ? (
        <p role="status" aria-live="polite" data-phase="request_sent" className="t-body">
          {labels.requestSent}
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
