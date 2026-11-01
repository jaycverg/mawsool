// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STAFF_SESSION_KEY, clearStaffSession, readStaffSession, staffCall } from '../src';
import { RequireStaffSession } from '../src/components';

const NOW = new Date('2026-11-01T08:00:00Z');
const SESSION = { sessionToken: 'session-token', expiresAt: '2026-11-01T16:00:00.000Z', role: 'clinician' as const, facilityId: '00000000-0000-4000-8000-00000000fa01' };
const keep = (session: object) => window.sessionStorage.setItem(STAFF_SESSION_KEY, JSON.stringify(session));

beforeEach(() => window.sessionStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('readStaffSession and clearStaffSession', () => {
  it('reads a stored session that has not expired', () => {
    keep(SESSION);
    expect(readStaffSession(window.sessionStorage, NOW)).toEqual(SESSION);
  });

  it('is no session when nothing is stored, the value is not JSON, has the wrong shape, or has expired', () => {
    expect(readStaffSession(window.sessionStorage, NOW)).toBeNull();
    window.sessionStorage.setItem(STAFF_SESSION_KEY, '{not json');
    expect(readStaffSession(window.sessionStorage, NOW)).toBeNull();
    keep({ sessionToken: 'x' });
    expect(readStaffSession(window.sessionStorage, NOW)).toBeNull();
    keep(SESSION);
    expect(readStaffSession(window.sessionStorage, new Date('2026-11-01T16:00:00.000Z'))).toBeNull();
    expect(readStaffSession(window.sessionStorage, new Date('2026-11-01T15:59:59.999Z'))).toEqual(SESSION);
  });

  it('is no session, without throwing, when storage is missing or throws', () => {
    expect(readStaffSession(undefined, NOW)).toBeNull();
    expect(readStaffSession({ getItem: () => { throw new Error('blocked'); } }, NOW)).toBeNull();
  });

  it('clears the session, and does not throw when storage is missing or throws', () => {
    keep(SESSION);
    clearStaffSession(window.sessionStorage);
    expect(window.sessionStorage.getItem(STAFF_SESSION_KEY)).toBeNull();
    clearStaffSession(undefined);
    expect(() => clearStaffSession({ removeItem: () => { throw new Error('blocked'); } })).not.toThrow();
  });
});

describe('RequireStaffSession', () => {
  const show = (navigate = vi.fn(), roles: ('clinician' | 'ops' | 'admin')[] = ['clinician']) => {
    const view = render(
      <RequireStaffSession roles={roles} signInHref="/en/sign-in/" checkingLabel="Checking" navigate={navigate} now={() => NOW}>
        {(session, signOut) => (
          <div>
            <span>queue for {session.facilityId}</span>
            <button type="button" onClick={signOut}>Sign out</button>
          </div>
        )}
      </RequireStaffSession>,
    );
    return { navigate, view };
  };

  it('shows what is behind it, given the session, when a valid session of an allowed role is kept', () => {
    keep(SESSION);
    const { navigate } = show();
    expect(screen.getByText(`queue for ${SESSION.facilityId}`)).toBeTruthy();
    expect(screen.queryByText('Checking')).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('sends the person to sign-in, and shows nothing behind it, when there is no session', () => {
    const { navigate } = show();
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/en/sign-in/');
    expect(screen.getByText('Checking')).toBeTruthy();
    expect(screen.queryByText(/queue for/)).toBeNull();
  });

  it('sends the person to sign-in when the session has expired, and forgets it', () => {
    keep({ ...SESSION, expiresAt: '2026-11-01T07:59:59.000Z' });
    const { navigate } = show();
    expect(navigate).toHaveBeenCalledWith('/en/sign-in/');
    expect(screen.queryByText(/queue for/)).toBeNull();
  });

  it('refuses a session of another role, forgets it, and sends the person to sign-in', () => {
    keep({ ...SESSION, role: 'ops', facilityId: null });
    const { navigate } = show();
    expect(navigate).toHaveBeenCalledWith('/en/sign-in/');
    expect(screen.queryByText(/queue for/)).toBeNull();
    expect(window.sessionStorage.getItem(STAFF_SESSION_KEY)).toBeNull();
  });

  it('serves several roles when the screen lists them', () => {
    keep({ ...SESSION, role: 'admin', facilityId: null });
    show(vi.fn(), ['ops', 'admin']);
    expect(screen.getByText('queue for')).toBeTruthy();
  });

  it('signing out forgets the session and goes to sign-in', () => {
    keep(SESSION);
    const { navigate } = show();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(window.sessionStorage.getItem(STAFF_SESSION_KEY)).toBeNull();
    expect(navigate).toHaveBeenCalledWith('/en/sign-in/');
  });

  it('shows plain content as it is, for a page that is not given the session', () => {
    keep(SESSION);
    render(
      <RequireStaffSession roles={['clinician']} signInHref="/en/sign-in/" checkingLabel="Checking" navigate={vi.fn()} now={() => NOW}>
        <p>plain page</p>
      </RequireStaffSession>,
    );
    expect(screen.getByText('plain page')).toBeTruthy();
  });

  it('does not look the session up again when the caller passes new functions on every render', () => {
    keep(SESSION);
    const navigate = vi.fn();
    const view = render(
      <RequireStaffSession roles={['clinician']} signInHref="/en/sign-in/" checkingLabel="Checking" navigate={(href) => navigate(href)} now={() => NOW}>
        <p>plain page</p>
      </RequireStaffSession>,
    );
    view.rerender(
      <RequireStaffSession roles={['clinician']} signInHref="/en/sign-in/" checkingLabel="Checking" navigate={(href) => navigate(href)} now={() => NOW}>
        <p>plain page</p>
      </RequireStaffSession>,
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it('leaves the tab for the real location when no navigate is given', () => {
    const replace = vi.fn();
    vi.stubGlobal('location', { ...window.location, replace });
    render(
      <RequireStaffSession roles={['clinician']} signInHref="/en/sign-in/" checkingLabel="Checking">
        <p>plain page</p>
      </RequireStaffSession>,
    );
    expect(replace).toHaveBeenCalledWith('/en/sign-in/');
  });
});

describe('staffCall', () => {
  const call = (fetchFn: ReturnType<typeof vi.fn>, extra: object = {}) => staffCall({ fetch: fetchFn as never, apiUrl: 'http://api.test', session: SESSION, path: '/tickets', ...extra });
  const answer = (status: number, body: unknown = {}) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

  it('sends the session as a bearer token and returns the body of a success', async () => {
    const fetchFn = answer(200, { items: [] });
    expect(await call(fetchFn)).toEqual({ status: 'ok', httpStatus: 200, body: { items: [] } });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://api.test/tickets');
    expect(init.method).toBe('GET');
    expect(init.headers).toEqual({ authorization: 'Bearer session-token' });
    expect(init.body).toBeUndefined();
  });

  it('sends a JSON body with a POST', async () => {
    const fetchFn = answer(200, {});
    await call(fetchFn, { method: 'POST', path: '/tickets/x/events', body: { to: 'seen' } });
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ authorization: 'Bearer session-token', 'content-type': 'application/json' });
    expect(init.body).toBe('{"to":"seen"}');
  });

  it('says unauthorized for a 401 so the screen can end the session', async () => {
    expect(await call(answer(401, { error: 'unauthorized' }))).toEqual({ status: 'unauthorized' });
  });

  it('keeps the API’s error code for any other refusal, and none when the body has none', async () => {
    expect(await call(answer(410, { error: 'withdrawn' }))).toEqual({ status: 'refused', httpStatus: 410, error: 'withdrawn' });
    expect(await call(answer(404, { error: 'not_found' }))).toEqual({ status: 'refused', httpStatus: 404, error: 'not_found' });
    expect(await call(vi.fn(async () => new Response('nope', { status: 502 })))).toEqual({ status: 'refused', httpStatus: 502, error: null });
    expect(await call(answer(409, { error: 42 }))).toEqual({ status: 'refused', httpStatus: 409, error: null });
  });

  it('says unreachable when the network fails', async () => {
    expect(await call(vi.fn(async () => { throw new TypeError('Failed to fetch'); }))).toEqual({ status: 'unreachable' });
  });
});
