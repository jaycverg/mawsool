import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { STAFF_SESSION_KEY, storeStaffSession, verifySignIn } from '../src';
import { StaffSignIn, type StaffSignInLabels } from '../src/components';

const SESSION = {
  sessionToken: 'session-token',
  expiresAt: '2026-11-01T16:00:00.000Z',
  role: 'clinician' as const,
  facilityId: '00000000-0000-4000-8000-00000000fa01',
};
const reply = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));
const run = (fetchFn: ReturnType<typeof reply>, allowedRoles: ('clinician' | 'ops' | 'admin')[] = ['clinician']) =>
  verifySignIn({ fetch: fetchFn as never, apiUrl: 'http://api.test', token: 'tok', allowedRoles });

describe('verifySignIn', () => {
  it('posts only the token to /auth/verify and returns the session', async () => {
    const fetchFn = reply(200, SESSION);
    expect(await run(fetchFn)).toEqual({ status: 'signed_in', session: SESSION });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://api.test/auth/verify');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ token: 'tok' });
  });

  it('fails for an invalid, expired or used link (401) and for any other server answer', async () => {
    expect(await run(reply(401, { error: 'invalid_link' }))).toEqual({ status: 'failed' });
    expect(await run(reply(400, {}))).toEqual({ status: 'failed' });
    expect(await run(reply(500, {}))).toEqual({ status: 'failed' });
  });

  it('fails, without throwing, when the network is down or the answer is not a session', async () => {
    const down = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await run(down as never)).toEqual({ status: 'failed' });
    expect(await run(reply(200, { nope: true }))).toEqual({ status: 'failed' });
  });

  it('refuses a session for a role this app does not serve, and says which app it was for', async () => {
    expect(await run(reply(200, { ...SESSION, role: 'ops', facilityId: null }))).toEqual({ status: 'wrong_app', role: 'ops' });
    expect(await run(reply(200, SESSION), ['ops', 'admin'])).toEqual({ status: 'wrong_app', role: 'clinician' });
  });

  it('accepts every role the app lists', async () => {
    expect((await run(reply(200, { ...SESSION, role: 'admin', facilityId: null }), ['ops', 'admin'])).status).toBe('signed_in');
    expect((await run(reply(200, { ...SESSION, role: 'ops', facilityId: null }), ['ops', 'admin'])).status).toBe('signed_in');
  });
});

describe('storeStaffSession', () => {
  it('keeps the session under one key', () => {
    const setItem = vi.fn();
    expect(storeStaffSession({ setItem }, SESSION)).toBe(true);
    expect(setItem).toHaveBeenCalledWith(STAFF_SESSION_KEY, JSON.stringify(SESSION));
  });

  it('reports false when storage is missing or blocked', () => {
    expect(storeStaffSession(undefined, SESSION)).toBe(false);
    expect(
      storeStaffSession(
        {
          setItem: () => {
            throw new Error('blocked');
          },
        },
        SESSION,
      ),
    ).toBe(false);
  });
});

describe('StaffSignIn page', () => {
  const labels: StaffSignInLabels = {
    heading: 'Staff sign-in',
    action: 'Sign in',
    signingIn: 'Signing in',
    signedIn: 'Signed in',
    failed: 'Link failed',
    wrongApp: 'Wrong app',
    missingToken: 'Open your link',
  };
  const html = (token: string | null) =>
    renderToStaticMarkup(<StaffSignIn token={token} apiUrl="http://api.test" allowedRoles={['clinician']} labels={labels} />);

  it('shows a sign-in button, and does not use the link on load', () => {
    const markup = html('tok');
    expect(markup).toContain('Staff sign-in');
    expect(markup).toContain('>Sign in<');
    expect(markup).not.toContain('role="status"');
  });

  it('shows the missing-link message and no button when the link has no token', () => {
    const markup = html(null);
    expect(markup).toContain('Open your link');
    expect(markup).toContain('data-phase="missing_token"');
    expect(markup).not.toContain('<button');
  });
});
