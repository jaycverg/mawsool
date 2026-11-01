// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STAFF_SESSION_KEY } from '../src';
import { StaffSignIn, type StaffSignInLabels } from '../src/components';

const SESSION = {
  sessionToken: 'session-token',
  expiresAt: '2026-11-01T16:00:00.000Z',
  role: 'clinician' as const,
  facilityId: '00000000-0000-4000-8000-00000000fa01',
};

const labels: StaffSignInLabels = {
  heading: 'Staff sign-in',
  action: 'Sign in',
  signingIn: 'Signing in',
  signedIn: 'Signed in',
  failed: 'Link failed',
  wrongApp: 'Wrong app',
  missingToken: 'Open your link',
  emailLabel: 'Work email address',
  requestAction: 'Request a sign-in link',
  requestSent: 'If that address is registered, a sign-in link has been issued.',
  requestFailed: 'Request not sent',
};

const reply = (status: number, body: unknown = {}) => vi.fn(async () => new Response(JSON.stringify(body), { status }));
const show = (token: string | null, roles: ('clinician' | 'ops' | 'admin')[] = ['clinician']) =>
  render(<StaffSignIn token={token} apiUrl="http://api.test" allowedRoles={roles} labels={labels} />);
const callOf = (fetchFn: ReturnType<typeof reply>) => fetchFn.mock.calls[0] as unknown as [string, RequestInit];

beforeEach(() => window.sessionStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('pressing Sign in', () => {
  it('does nothing until the button is pressed, so loading the page cannot spend the one-time link', () => {
    const fetchFn = reply(200, SESSION);
    vi.stubGlobal('fetch', fetchFn);
    show('tok');
    expect(fetchFn).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(STAFF_SESSION_KEY)).toBeNull();
  });

  it('posts the token to /auth/verify, stores the session, and says it worked', async () => {
    const fetchFn = reply(200, SESSION);
    vi.stubGlobal('fetch', fetchFn);
    show('tok');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByText('Signed in');

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = callOf(fetchFn);
    expect(url).toBe('http://api.test/auth/verify');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ token: 'tok' });
    expect(JSON.parse(window.sessionStorage.getItem(STAFF_SESSION_KEY)!)).toEqual(SESSION);
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    expect(screen.queryByLabelText(labels.emailLabel)).toBeNull();
  });

  it('shows the failure, stores nothing, and offers the request form when the link is refused', async () => {
    vi.stubGlobal('fetch', reply(401, { error: 'invalid_link' }));
    show('tok');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByText('Link failed');
    expect(window.sessionStorage.getItem(STAFF_SESSION_KEY)).toBeNull();
    expect(screen.getByLabelText(labels.emailLabel)).toBeTruthy();
  });

  it('stores nothing and offers the request form when the link belongs to the other app', async () => {
    vi.stubGlobal('fetch', reply(200, { ...SESSION, role: 'ops', facilityId: null }));
    show('tok', ['clinician']);
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByText('Wrong app');
    expect(window.sessionStorage.getItem(STAFF_SESSION_KEY)).toBeNull();
    expect(screen.getByLabelText(labels.emailLabel)).toBeTruthy();
  });

  it('does not show the request form while a link is ready to use', () => {
    show('tok');
    expect(screen.queryByLabelText(labels.emailLabel)).toBeNull();
  });
});

describe('requesting a sign-in link', () => {
  it('is offered when the link has no token, with the missing-link message and no Sign in button', () => {
    show(null);
    expect(screen.getByText('Open your link')).toBeTruthy();
    expect(screen.getByLabelText(labels.emailLabel)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
  });

  it('posts the address to /auth/magic-link and shows the neutral message', async () => {
    const fetchFn = reply(202, { status: 'accepted' });
    vi.stubGlobal('fetch', fetchFn);
    show(null);
    fireEvent.change(screen.getByLabelText(labels.emailLabel), { target: { value: ' clinician.a@demo.mawsool.test ' } });
    fireEvent.click(screen.getByRole('button', { name: labels.requestAction }));
    await screen.findByText(labels.requestSent);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = callOf(fetchFn);
    expect(url).toBe('http://api.test/auth/magic-link');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ email: 'clinician.a@demo.mawsool.test' });
    expect(screen.queryByLabelText(labels.emailLabel)).toBeNull();
  });

  it('gives the same message for any address, so it cannot be used to find out who has an account', async () => {
    const texts: string[] = [];
    for (const email of ['clinician.a@demo.mawsool.test', 'nobody@example.test']) {
      vi.stubGlobal('fetch', reply(202, { status: 'accepted' }));
      const view = show(null);
      fireEvent.change(screen.getByLabelText(labels.emailLabel), { target: { value: email } });
      fireEvent.click(screen.getByRole('button', { name: labels.requestAction }));
      texts.push((await screen.findByText(labels.requestSent)).textContent ?? '');
      view.unmount();
    }
    expect(texts[0]).toBe(texts[1]);
  });

  it('is offered again after a failed link, and says plainly when the request could not be sent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    show(null);
    fireEvent.change(screen.getByLabelText(labels.emailLabel), { target: { value: 'a@demo.mawsool.test' } });
    fireEvent.click(screen.getByRole('button', { name: labels.requestAction }));
    await screen.findByText('Request not sent');
    await waitFor(() => expect((screen.getByRole('button', { name: labels.requestAction }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByText(labels.requestSent)).toBeNull();
  });

  it('shows a failure, not the neutral message, when the API refuses the request', async () => {
    vi.stubGlobal('fetch', reply(400, { error: 'invalid_request' }));
    show(null);
    fireEvent.change(screen.getByLabelText(labels.emailLabel), { target: { value: 'a@demo.mawsool.test' } });
    fireEvent.click(screen.getByRole('button', { name: labels.requestAction }));
    await screen.findByText('Request not sent');
    expect(screen.queryByText(labels.requestSent)).toBeNull();
  });
});
