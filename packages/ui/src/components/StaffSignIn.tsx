'use client';

import { useSearchParams } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { ClockStateSchema, type StaffRole } from '@mawsool/types';
import { requestSignInLink, startGuestSession, storeStaffSession, verifySignIn } from '../staff-signin';

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
  /** The heading of the demo block, shown only with demo access (`guestAccounts` and a demo API). */
  demoHeading?: string;
  /** "Demo only: synthetic data, shared with everyone using this demo". */
  demoNote?: string;
  /** The guest sign-in did not work (the API was not reachable, or refused). */
  demoFailed?: string;
}

/** One demo account a guest may sign in as: its seeded address and the button's wording. */
export interface GuestAccount {
  email: string;
  label: string;
}

export interface StaffSignInProps {
  /** The one-time token from the link; null when the link had none. */
  token: string | null;
  apiUrl: string;
  allowedRoles: readonly StaffRole[];
  labels: StaffSignInLabels;
  /** Where "Continue" goes after signing in: the app's home for this language. */
  homeHref: string;
  /** A different "Continue" target for a role whose screen is not the app's home (the crisis-line console). */
  homeHrefByRole?: Partial<Record<StaffRole, string>>;
  /**
   * The demo accounts a guest may sign in as, one button each. They show only when `GET /clock` says the API is a demo
   * (`demoMode: true`); with none given the page never asks. A failed read shows nothing and leaves the link form as it is.
   */
  guestAccounts?: readonly GuestAccount[];
  /** Where to go after a guest signs in. Defaults to `window.location.assign`; a test passes its own. */
  navigate?: (href: string) => void;
}

type GuestPhase = 'idle' | 'signing_in' | 'failed' | 'wrong_app' | 'not_saved';
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
export function StaffSignIn({ token, apiUrl, allowedRoles, labels, homeHref, homeHrefByRole, guestAccounts = [], navigate }: StaffSignInProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [demoMode, setDemoMode] = useState(false);
  const [guestPhase, setGuestPhase] = useState<GuestPhase>('idle');
  const hasGuestAccounts = guestAccounts.length > 0;

  // Asks the API whether it is a demo, only when there is a guest button to show. Never touches /auth/verify: the one-time link is not spent.
  useEffect(() => {
    if (!hasGuestAccounts) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await globalThis.fetch(`${apiUrl}/clock`);
        const parsed = ClockStateSchema.safeParse(await response.json());
        if (!cancelled && response.ok && parsed.success && parsed.data.demoMode) setDemoMode(true);
      } catch {
        // No answer: no demo block, and the link form is all there is.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiUrl, hasGuestAccounts]);

  async function continueAsGuest(email: string) {
    setGuestPhase('signing_in');
    const result = await startGuestSession({ fetch: globalThis.fetch.bind(globalThis), apiUrl, email, allowedRoles });
    if (result.status !== 'signed_in') return setGuestPhase(result.status);
    if (!storeStaffSession(safeSessionStorage(), result.session)) return setGuestPhase('not_saved');
    const href = homeHrefByRole?.[result.session.role] || homeHref;
    (navigate ?? ((to: string) => window.location.assign(to)))(href);
  }
  const [role, setRole] = useState<StaffRole | null>(null);
  const [requestPhase, setRequestPhase] = useState<RequestPhase>('idle');
  const [email, setEmail] = useState('');

  async function signIn() {
    if (token === null) return;
    setPhase('signing_in');
    const result = await verifySignIn({ fetch: globalThis.fetch.bind(globalThis), apiUrl, token, allowedRoles });
    if (result.status === 'signed_in') {
      setRole(result.session.role);
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
      {demoMode && hasGuestAccounts ? (
        <section aria-labelledby="demo-access" data-demo-access className="flex flex-col gap-3">
          {labels.demoHeading ? (
            <h2 id="demo-access" className="t-label">
              {labels.demoHeading}
            </h2>
          ) : null}
          {guestAccounts.map((account) => (
            <button key={account.email} type="button" disabled={guestPhase === 'signing_in'} onClick={() => void continueAsGuest(account.email)} className="btn-primary" data-guest={account.email}>
              {account.label}
            </button>
          ))}
          {labels.demoNote ? <p className="t-body">{labels.demoNote}</p> : null}
          {guestPhase === 'failed' || guestPhase === 'wrong_app' || guestPhase === 'not_saved' ? (
            <p role="status" aria-live="polite" data-phase={`guest_${guestPhase}`} className="t-body">
              {{ failed: labels.demoFailed ?? labels.failed, wrong_app: labels.wrongApp, not_saved: labels.notSaved }[guestPhase]}
            </p>
          ) : null}
        </section>
      ) : null}
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
        <a href={(role && homeHrefByRole?.[role]) || homeHref} className="btn-primary" data-continue>
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
            className="tap rounded-input border border-[#9AAAA7] bg-surface px-3 t-body"
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
