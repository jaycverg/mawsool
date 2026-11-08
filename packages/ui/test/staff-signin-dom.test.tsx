// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STAFF_SESSION_KEY } from '../src';
import { SearchParamsContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import { StaffSignIn, StaffSignInPage, type StaffSignInLabels } from '../src/components';

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
  notSaved: 'Not saved',
  continue: 'Continue',
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
  render(<StaffSignIn token={token} apiUrl="http://api.test" allowedRoles={roles} labels={labels} homeHref="/en/" />);
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

  it('shows the same page for any address, so it cannot be used to find out who has an account', async () => {
    // The API answers 202 either way; here its body differs too, as a leaky server's could. The page after the request must
    // be the same markup for both: not just the same message text, but nothing else that depends on the address or the body.
    const pages: string[] = [];
    for (const [email, body] of [
      ['clinician.a@demo.mawsool.test', { status: 'accepted', account: 'exists' }],
      ['nobody@example.test', { status: 'accepted' }],
    ] as const) {
      vi.stubGlobal('fetch', reply(202, body));
      const view = show(null);
      fireEvent.change(screen.getByLabelText(labels.emailLabel), { target: { value: email } });
      fireEvent.click(screen.getByRole('button', { name: labels.requestAction }));
      await screen.findByText(labels.requestSent);
      pages.push(view.container.innerHTML);
      view.unmount();
    }
    expect(pages[0]).toContain(labels.requestSent);
    expect(pages[0]).not.toContain('demo.mawsool.test');
    expect(pages[0]).toBe(pages[1]);
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

describe('when this browser will not keep the session', () => {
  const blockStorage = () => vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('quota', 'QuotaExceededError');
  });

  afterEach(() => vi.restoreAllMocks());

  it('does not say the person is signed in, says the session was not kept, and offers a new link', async () => {
    vi.stubGlobal('fetch', reply(200, SESSION));
    const blocked = blockStorage();
    show('tok');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    const message = await screen.findByText(labels.notSaved);
    expect(blocked).toHaveBeenCalled();
    expect(message.getAttribute('data-phase')).toBe('not_saved');
    expect(screen.queryByText(labels.signedIn)).toBeNull();
    expect(screen.queryByText(labels.continue)).toBeNull();
    expect(window.sessionStorage.getItem(STAFF_SESSION_KEY)).toBeNull();
    // The link is spent, so signing in again with it is not offered; a new one is.
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    expect(screen.getByLabelText(labels.emailLabel)).toBeTruthy();
  });

  it('says it was kept, and links on to the app, only when the session is stored', async () => {
    vi.stubGlobal('fetch', reply(200, SESSION));
    show('tok');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByText(labels.signedIn);
    expect(screen.getByText(labels.continue).closest('a')?.getAttribute('href')).toBe('/en/');
    expect(screen.queryByText(labels.notSaved)).toBeNull();
  });

  it('says not saved too when the browser has no session storage at all', async () => {
    vi.stubGlobal('fetch', reply(200, SESSION));
    vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    show('tok');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByText(labels.notSaved);
    expect(screen.queryByText(labels.signedIn)).toBeNull();
  });
});

describe('the page reads the token from the link it was opened with', () => {
  // The link is built the way the API builds it: <app>/<locale>/sign-in/?token=<url-encoded token>.
  const TOKEN = 'q3vK-8_Zr0T5mP2xLw9cHd1YtB7nJfEaUoSgRi4VkXs';
  const link = `http://localhost:3001/en/sign-in/?token=${encodeURIComponent(TOKEN)}`;

  const openAt = (url: string) =>
    render(
      <SearchParamsContext.Provider value={new URL(url).searchParams}>
        <StaffSignInPage apiUrl="http://api.test" allowedRoles={['clinician']} labels={labels} homeHref="/en/" />
      </SearchParamsContext.Provider>,
    );

  it('posts the token from the link’s query string to /auth/verify when Sign in is pressed, and not before', async () => {
    const fetchFn = reply(200, SESSION);
    vi.stubGlobal('fetch', fetchFn);
    openAt(link);
    expect(fetchFn).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByText(labels.signedIn);
    expect(JSON.parse(callOf(fetchFn)[1].body as string)).toEqual({ token: TOKEN });
    expect(JSON.parse(window.sessionStorage.getItem(STAFF_SESSION_KEY)!)).toEqual(SESSION);
  });

  it('decodes a token that was percent-encoded in the link', async () => {
    const fetchFn = reply(200, SESSION);
    vi.stubGlobal('fetch', fetchFn);
    openAt('http://localhost:3001/en/sign-in/?token=ab%2Bcd%2Fef%3D');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByText(labels.signedIn);
    expect(JSON.parse(callOf(fetchFn)[1].body as string)).toEqual({ token: 'ab+cd/ef=' });
  });

  it('shows the missing-link message, with no Sign in button, when the link carries no token', () => {
    openAt('http://localhost:3001/en/sign-in/');
    expect(screen.getByText(labels.missingToken)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
  });

  it('ignores a token in some other parameter', () => {
    openAt('http://localhost:3001/en/sign-in/?tok=abc&next=token');
    expect(screen.getByText(labels.missingToken)).toBeTruthy();
  });
});

describe('where Continue goes', () => {
  const operator = { ...SESSION, role: 'crisis_line' as const, facilityId: null };
  const showWith = () => render(<StaffSignIn token="tok" apiUrl="http://api.test" allowedRoles={['ops', 'crisis_line']} labels={labels} homeHref="/en/" homeHrefByRole={{ crisis_line: '/en/crisis-line/' }} />);

  it('sends a role with its own screen there, and every other role to the app home', async () => {
    vi.stubGlobal('fetch', reply(200, operator));
    showWith();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    const link = await screen.findByRole('link', { name: 'Continue' });
    expect(link.getAttribute('href')).toBe('/en/crisis-line/');
    cleanup();
    window.sessionStorage.clear();
    vi.stubGlobal('fetch', reply(200, { ...SESSION, role: 'ops', facilityId: null }));
    showWith();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect((await screen.findByRole('link', { name: 'Continue' })).getAttribute('href')).toBe('/en/');
  });
});
