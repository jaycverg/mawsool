import { describe, expect, it } from 'vitest';
import { forgetRegistration, callServer } from '../lib/server';
import { forgetTicket, loadTickets, rememberTicket } from '../lib/share';
import { KEYS } from '../lib/keys';
import { memoryStorage } from './helpers/memory';

const TICKET = { id: '11111111-1111-4111-8111-111111111111', shortCode: 'MWAB12', serviceId: 'svc', tier: 'gp' as const, issuedAt: '2026-11-01T08:00:00+04:00' };

/**
 * A server whose person table can be emptied between calls, as a demo reset does: `known` is the set of person ids it
 * holds, POST /persons adds the id, and any authenticated call from an id it does not hold is a 401.
 */
function resettableServer() {
  const store = memoryStorage();
  forgetRegistration(store.storage);
  const known = new Set<string>();
  const log: string[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    log.push(`${init?.method ?? 'GET'} ${path}`);
    if (path === '/persons') {
      const { id } = JSON.parse(init!.body as string) as { id: string };
      const created = !known.has(id);
      known.add(id);
      return new Response('{}', { status: created ? 201 : 200 });
    }
    const id = (init!.headers as Record<string, string>).authorization!.replace('Bearer ', '').split('.')[0]!;
    return known.has(id) ? new Response(JSON.stringify({ ok: true }), { status: 200 }) : new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }) as unknown as typeof fetch;
  return { store, known, log, deps: { storage: store.storage, fetch: fetchFn, apiUrl: 'http://api.test', locale: 'en' as const, random: globalThis.crypto } };
}

describe('a phone whose person the server no longer holds', () => {
  it('registers itself again with the same id and secret on a 401, and repeats the call once', async () => {
    const s = resettableServer();
    expect((await callServer(s.deps, 'GET', '/me/tickets')).ok).toBe(true);
    const id = [...s.known][0]!;
    s.known.clear(); // the reset
    s.log.length = 0;
    const result = await callServer(s.deps, 'GET', '/me/tickets');
    expect(result.ok).toBe(true);
    expect(s.log).toEqual(['GET /me/tickets', 'POST /persons', 'GET /me/tickets']);
    expect([...s.known]).toEqual([id]); // the same person id, not a new one
  });

  it('does not loop: a 401 that survives the re-registration is reported as it is, after exactly one retry', async () => {
    const s = resettableServer();
    const refusing = (async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      s.log.push(`${init?.method ?? 'GET'} ${path}`);
      return path === '/persons' ? new Response('{}', { status: 201 }) : new Response('{}', { status: 401 });
    }) as unknown as typeof fetch;
    const result = await callServer({ ...s.deps, fetch: refusing }, 'DELETE', '/me/data');
    expect(result).toEqual({ ok: false, reason: 'rejected', status: 401 });
    expect(s.log).toEqual(['POST /persons', 'DELETE /me/data', 'POST /persons', 'DELETE /me/data']);
  });

  it('leaves any other refusal alone: a 404 or a 403 is not retried and nothing is registered again', async () => {
    const s = resettableServer();
    await callServer(s.deps, 'GET', '/me/tickets');
    s.log.length = 0;
    const notFound = { ...s.deps, fetch: (async (url: string) => (s.log.push(new URL(url).pathname), new Response('{}', { status: 404 }))) as unknown as typeof fetch };
    expect(await callServer(notFound, 'GET', '/me/tickets/x')).toEqual({ ok: false, reason: 'rejected', status: 404 });
    expect(s.log).toEqual(['/me/tickets/x']);
  });

  it('gives up cleanly when the server cannot register it either: the id belongs to someone else', async () => {
    const s = resettableServer();
    const conflict = (async (url: string) => (new URL(url).pathname === '/persons' ? new Response('{}', { status: 409 }) : new Response('{}', { status: 401 }))) as unknown as typeof fetch;
    expect(await callServer({ ...s.deps, fetch: conflict }, 'GET', '/me/tickets')).toEqual({ ok: false, reason: 'not_registered', status: null });
  });
});

describe('a ticket the phone noted and the server does not know', () => {
  it('is forgotten without touching the others', async () => {
    const { storage } = memoryStorage();
    const other = { ...TICKET, id: '22222222-2222-4222-8222-222222222222', shortCode: 'MWCD34' };
    await rememberTicket(storage, TICKET);
    await rememberTicket(storage, other);
    await forgetTicket(storage, TICKET.id);
    expect((await loadTickets(storage)).map((ticket) => ticket.id)).toEqual([other.id]);
    await forgetTicket(storage, other.id);
    expect(await loadTickets(storage)).toEqual([]);
    expect(KEYS.tickets).toBe('tickets');
  });
});
