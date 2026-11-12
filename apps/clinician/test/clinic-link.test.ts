import { describe, expect, it, vi } from 'vitest';
import { actOnLink, credentialFromFragment, dropFragment, openLink } from '../lib/clinic-link';
import ar from '../messages/ar.json';
import en from '../messages/en.json';

const ID = '5b5d2f6e-0a0e-4a45-9d2c-3c7e1a4e9a11';
const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE';
const credential = { ticketId: ID, token: TOKEN };

/** A fetch that answers as told and remembers what it was asked. */
function server(reply: { status: number; body?: unknown } | 'network') {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (reply === 'network') throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

const TICKET = { shortCode: 'MW4K7Q', tier: 'gp', state: 'issued', deadlineAt: '2026-11-08T08:00:00.000Z', moves: ['acknowledged', 'seen'], expiresAt: '2026-11-03T08:00:00.000Z' };

describe('the clinic link’s address', () => {
  it('reads the ticket id and the token from the fragment, with or without the hash sign', () => {
    expect(credentialFromFragment(`#${ID}.${TOKEN}`)).toEqual(credential);
    expect(credentialFromFragment(`${ID}.${TOKEN}`)).toEqual(credential);
  });

  it.each(['', '#', `#${ID}`, `#${ID}.`, `#${ID}.short`, `#not-an-id.${TOKEN}`, `#${ID}.${TOKEN}.extra`, `#${ID}.${TOKEN}?x=1`, `#${ID}.${'a'.repeat(201)}`])('reads nothing from %s', (hash) => {
    expect(credentialFromFragment(hash)).toBeNull();
  });
});

describe('opening and acting with a link', () => {
  it('sends the credential in the body of a POST with no cookie, and never in the URL', async () => {
    const { fetchFn, calls } = server({ status: 200, body: TICKET });
    expect(await openLink(fetchFn, 'http://api.test', credential)).toEqual({ status: 'ok', body: TICKET });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://api.test/clinic-link/open');
    expect(calls[0]!.url).not.toContain(TOKEN);
    expect(calls[0]!.url).not.toContain(ID);
    expect(calls[0]!.init).toMatchObject({ method: 'POST', credentials: 'omit' });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual(credential);
    expect(Object.keys((calls[0]!.init.headers ?? {}) as object).map((name) => name.toLowerCase())).toEqual(['content-type']);
  });

  it('adds the move to the body of an act, and reads whether a fresh link was logged', async () => {
    const { fetchFn, calls } = server({ status: 200, body: { state: 'acknowledged', nextLink: 'issued' } });
    expect(await actOnLink(fetchFn, 'http://api.test', credential, 'acknowledged')).toEqual({ status: 'ok', body: { state: 'acknowledged', nextLink: 'issued' } });
    expect(calls[0]!.url).toBe('http://api.test/clinic-link/act');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ ...credential, to: 'acknowledged' });
  });

  it.each([
    [401, 'invalid'],
    [404, 'not_found'],
    [410, 'withdrawn'],
    [409, 'conflict'],
    [500, 'failed'],
    [400, 'failed'],
  ] as const)('maps HTTP %s to %s', async (status, expected) => {
    expect((await openLink(server({ status }).fetchFn, 'http://api.test', credential)).status).toBe(expected);
    expect((await actOnLink(server({ status }).fetchFn, 'http://api.test', credential, 'seen')).status).toBe(expected);
  });

  it('is a failure, not a crash, when the network is down or the answer is not a ticket', async () => {
    expect((await openLink(server('network').fetchFn, 'http://api.test', credential)).status).toBe('failed');
    expect((await openLink(server({ status: 200, body: { shortCode: 'MW4K7Q' } }).fetchFn, 'http://api.test', credential)).status).toBe('failed');
  });
});

describe('the clinic link page’s words', () => {
  const keys = ['mock', 'heading', 'loading', 'missing', 'summary', 'noMoves', 'acknowledge', 'markSeen', 'onlyThis', 'doneAcknowledged', 'doneSeen', 'freshLink', 'noFreshLink', 'nextStepFailed'] as const;

  it('exist in both languages, the Arabic in Arabic, and name the channel as a sample', () => {
    for (const key of keys) {
      expect(en.clinicLink[key].length, key).toBeGreaterThan(3);
      expect(ar.clinicLink[key], key).toMatch(/[؀-ۿ]/);
    }
    for (const group of ['refused', 'note'] as const) expect(Object.keys(ar.clinicLink[group]).sort()).toEqual(Object.keys(en.clinicLink[group]).sort());
    expect(en.clinicLink.mock).toMatch(/^Sample channel/);
    expect(ar.clinicLink.mock).toContain('قناة تجريبية');
  });
});

describe('taking the credential out of the address', () => {
  /** A window whose history keeps every entry, as a browser does, so the test can look at what is left in it. */
  function fakeWindow(address: string) {
    const url = new URL(address);
    const entries = [{ url: address, state: { page: 1 } }];
    const win = {
      location: { get pathname() { return url.pathname; }, get search() { return url.search; } },
      history: {
        get state() { return entries.at(-1)!.state; },
        replaceState(state: unknown, _title: string, next: string) {
          entries[entries.length - 1] = { url: new URL(next, url).href, state: state as { page: number } };
        },
      },
    };
    return { win, entries };
  }

  it('replaces the history entry with the same path and query and no fragment, and keeps its state', () => {
    const { win, entries } = fakeWindow(`https://clinic.test/en/clinic-link/?lang=en#${ID}.${TOKEN}`);
    dropFragment(win);
    expect(entries).toEqual([{ url: 'https://clinic.test/en/clinic-link/?lang=en', state: { page: 1 } }]);
    expect(JSON.stringify(entries)).not.toContain(TOKEN);
    expect(JSON.stringify(entries)).not.toContain(ID);
  });
});
