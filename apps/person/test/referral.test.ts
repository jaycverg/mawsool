import type { BundleContent, Screening } from '@mawsool/types';
import { describe, expect, it, vi } from 'vitest';
import { FOLLOW_UP_DAY, followUpAt, followUpDue } from '../lib/day7';
import { currentTier, loadChoice, loadPendingChoice, pendingFrom, savePendingChoice, saveChoice } from '../lib/prefs';
import { sendReferral, ticketRequest, type SendInput } from '../lib/send-referral';
import { callServer, hasServerFootprint, markServerFootprint, forgetRegistration, type ServerDeps } from '../lib/server';
import { buildContent, loadTickets, parseConditions, rememberTicket, EMPTY_SHARING } from '../lib/share';
import { memoryStorage } from './helpers/memory';

const NOW = () => new Date('2026-11-02T08:00:00+04:00');
const REQUEST_ID = '22222222-2222-4222-8222-222222222222';
const TICKET_ID = '33333333-3333-4333-8333-333333333333';

const phq9 = (id: string, total: number, takenAt: string): Screening => ({ id, instrument: 'phq9', answers: [1, 1, 1, 1, 1, 1, 1, 1, 1].slice(0, 9), total, band: 'moderate', item9Flag: false, takenAt });
const draft: Screening = { id: 'd', instrument: 'gad7', answers: [1, 2], total: 3, band: null, item9Flag: false, takenAt: '2026-10-01T08:00:00+04:00' };

describe('the follow-up check (day 7)', () => {
  const ticket = { createdAt: '2026-10-20T08:00:00+04:00', deadlineAt: '2026-11-03T23:59:59+04:00' };

  it('opens seven days after issue, or at the deadline if that comes first', () => {
    expect(FOLLOW_UP_DAY).toBe(7);
    expect(followUpAt(ticket).toISOString()).toBe('2026-10-27T04:00:00.000Z');
    expect(followUpAt({ createdAt: '2026-10-20T08:00:00+04:00', deadlineAt: '2026-10-23T23:59:59+04:00' }).toISOString()).toBe('2026-10-23T19:59:59.000Z');
  });

  it('is due from that moment while the ticket is still waiting, and not before or after being seen', () => {
    const at = followUpAt(ticket);
    for (const state of ['issued', 'acknowledged', 'overdue'] as const) {
      expect(followUpDue({ ...ticket, state }, new Date(at.getTime() - 1))).toBe(false);
      expect(followUpDue({ ...ticket, state }, at)).toBe(true);
    }
    for (const state of ['seen', 'rerouted', 'declined', 'withdrawn', 'closed', 'remeasured'] as const) expect(followUpDue({ ...ticket, state }, new Date(at.getTime() + 1e9))).toBe(false);
  });
});

describe('what can be shared', () => {
  const screenings = [phq9('a', 7, '2026-10-08T08:00:00+04:00'), phq9('b', 12, '2026-10-29T08:00:00+04:00'), draft];

  it('builds the latest score of each questionnaire and the whole series from finished check-ins only, with no item answers', () => {
    const content = buildContent(screenings, { language: 'ar' }, { note: ' hello ', conditions: ['diabetes'], useAi: false });
    expect(content.scores).toEqual([{ instrument: 'phq9', total: 12, band: 'moderate', takenAt: '2026-10-29T08:00:00+04:00' }]);
    expect(content.trajectory?.map((entry) => entry.total)).toEqual([7, 12]);
    expect(content).toMatchObject({ free_text: 'hello', conditions: ['diabetes'], preferences: { language: 'ar' } });
    expect(JSON.stringify(content)).not.toContain('answers');
  });

  it('leaves out what does not exist', () => {
    expect(buildContent([], {}, EMPTY_SHARING)).toEqual({});
    expect(buildContent([draft], {}, { ...EMPTY_SHARING, note: '   ' })).toEqual({});
  });

  it('reads conditions one per line or comma, trimmed, without blanks or repeats, at most twenty', () => {
    expect(parseConditions(' diabetes ,asthma\n\nDiabetes\ndiabetes،asthma')).toEqual(['diabetes', 'asthma', 'Diabetes']);
    expect(parseConditions(Array.from({ length: 30 }, (_, i) => `c${i}`).join('\n'))).toHaveLength(20);
  });

  it('remembers the tickets this phone issued, once each, and ignores a damaged row', async () => {
    const { storage, data } = memoryStorage();
    const ticket = { id: TICKET_ID, shortCode: 'MW4K7Q', serviceId: 'svc', tier: 'gp' as const, issuedAt: '2026-11-02T08:00:00+04:00' };
    await rememberTicket(storage, ticket);
    await rememberTicket(storage, ticket);
    expect(await loadTickets(storage)).toEqual([ticket]);
    data.set('tickets', [ticket, { broken: true }]);
    expect(await loadTickets(storage)).toEqual([ticket]);
    data.set('tickets', 'not a list');
    expect(await loadTickets(storage)).toEqual([]);
  });
});

describe('a pick waiting for consent', () => {
  const option = { tier: 'gp' as const, serviceId: 'svc-1', handoffWindowDays: 7 };
  const deps = { now: NOW, newId: () => REQUEST_ID };

  it('never replaces the support the person is already on', async () => {
    const { storage } = memoryStorage();
    await saveChoice(storage, { tier: 'self_help', serviceId: 'helper', chosenAt: '2026-10-01T08:00:00+04:00', confirmed: true });
    await savePendingChoice(storage, pendingFrom(option, deps, null));
    expect(currentTier(await loadChoice(storage))).toBe('self_help');
    expect(await loadPendingChoice(storage)).toMatchObject({ tier: 'gp', serviceId: 'svc-1', windowDays: 7, requestId: REQUEST_ID, reroute: null });
  });

  it('uses the fallback window when the card promised none, and keeps the reroute it was made for', () => {
    expect(pendingFrom({ ...option, handoffWindowDays: null }, deps, { ticketId: TICKET_ID, reason: 'cost' })).toMatchObject({ windowDays: 14, reroute: { ticketId: TICKET_ID, reason: 'cost' } });
  });

  it('reads a damaged pick as none', async () => {
    const { storage, data } = memoryStorage();
    data.set('choice:pending', { tier: 'nonsense' });
    expect(await loadPendingChoice(storage)).toBeNull();
  });
});

describe('the server client', () => {
  function server(handler: (path: string, init?: RequestInit) => Response | Promise<Response>) {
    const { storage, data } = memoryStorage();
    forgetRegistration(storage);
    const calls: string[] = [];
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      if (path === '/persons') return new Response('{}', { status: 201 });
      return handler(path, init);
    }) as unknown as typeof fetch;
    const deps: ServerDeps = { storage, fetch: fetchFn, apiUrl: 'http://api.test', locale: 'en', random: globalThis.crypto };
    return { deps, calls, data };
  }

  it('registers the device once, then sends the credential and parses the answer', async () => {
    const s = server(() => new Response('{"ok":1}', { status: 200 }));
    expect(await callServer(s.deps, 'GET', '/a')).toEqual({ ok: true, status: 200, body: { ok: 1 } });
    await callServer(s.deps, 'GET', '/b');
    expect(s.calls).toEqual(['POST /persons', 'GET /a', 'GET /b']);
  });

  it('maps a network error and a server error to offline, and a refusal to rejected with its status', async () => {
    expect(await callServer(server(() => Promise.reject(new TypeError('down'))).deps, 'GET', '/a')).toEqual({ ok: false, reason: 'offline', status: null });
    expect(await callServer(server(() => new Response('{}', { status: 502 })).deps, 'GET', '/a')).toEqual({ ok: false, reason: 'offline', status: 502 });
    expect(await callServer(server(() => new Response('', { status: 409 })).deps, 'POST', '/a', { x: 1 })).toEqual({ ok: false, reason: 'rejected', status: 409 });
  });

  it('survives an empty success body and reports a device the server will not register', async () => {
    expect(await callServer(server(() => new Response('', { status: 200 })).deps, 'GET', '/a')).toEqual({ ok: true, status: 200, body: null });
    const refused = server(() => new Response('{}'));
    refused.deps.fetch = (async () => new Response('{}', { status: 409 })) as unknown as typeof fetch;
    expect(await callServer(refused.deps, 'GET', '/a')).toEqual({ ok: false, reason: 'not_registered', status: null });
  });

  it('notes the footprint once, before the first thing the server will keep', async () => {
    const { storage, data } = memoryStorage();
    expect(await hasServerFootprint(storage)).toBe(false);
    await markServerFootprint(storage, NOW);
    data.set('server:footprint', { since: 'first' });
    await markServerFootprint(storage, NOW);
    expect(data.get('server:footprint')).toEqual({ since: 'first' });
    expect(await hasServerFootprint(storage)).toBe(true);
  });
});

describe('sending the referral', () => {
  const content: BundleContent = { free_text: 'NOTE-MARKER', conditions: ['COND-MARKER'], scores: [{ instrument: 'phq9', total: 12, band: 'moderate', takenAt: '2026-10-29T08:00:00+04:00' }] };
  const pending = pendingFrom({ tier: 'gp', serviceId: 'svc-1', handoffWindowDays: 7 }, { now: NOW, newId: () => REQUEST_ID }, null);
  const input = (overrides: Partial<SendInput> = {}): SendInput => ({ pending, elements: ['ticket', 'scores'], content, approvedSummary: null, summaryRequestId: null, language: 'en', now: NOW, ...overrides });
  const created = { created: true, ticket: { id: TICKET_ID, shortCode: 'MW4K7Q', serviceId: 'svc-1', tier: 'gp', createdAt: '2026-11-02T08:00:00+04:00' } };

  it('keeps out of the request every element that was not ticked, and always sends the ticket element', () => {
    const request = ticketRequest(input({ elements: ['scores'] }));
    expect(request.consents).toEqual(['ticket', 'scores']);
    expect(request.content).toEqual({ scores: content.scores });
    expect(JSON.stringify(request)).not.toContain('NOTE-MARKER');
    expect(JSON.stringify(request)).not.toContain('COND-MARKER');
    expect(request).toMatchObject({ clientRequestId: REQUEST_ID, serviceId: 'svc-1', windowDays: 7 });
  });

  it('sends an approved summary only when it is within the word limit', () => {
    expect(ticketRequest(input({ approvedSummary: 'short note' })).approvedSummary).toBe('short note');
    expect(ticketRequest(input({ approvedSummary: Array(121).fill('w').join(' ') })).approvedSummary).toBeNull();
  });

  function deps(reply: () => Response | Promise<Response>) {
    const store = memoryStorage();
    forgetRegistration(store.storage);
    const bodies: string[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      if (new URL(url).pathname === '/persons') return new Response('{}', { status: 201 });
      bodies.push(`${init?.method} ${new URL(url).pathname}`);
      return reply();
    }) as unknown as typeof fetch;
    return { store, bodies, server: { storage: store.storage, fetch: fetchFn, apiUrl: 'http://api.test', locale: 'en' as const, random: globalThis.crypto } };
  }

  it('on success makes the pick the current support, clears the waiting pick and remembers the ticket', async () => {
    const d = deps(() => new Response(JSON.stringify({ ...created, ticket: fullTicket() }), { status: 201 }));
    await savePendingChoice(d.store.storage, pending);
    expect(await sendReferral(d.server, input())).toEqual({ status: 'sent', ticketId: TICKET_ID });
    expect(d.bodies).toEqual(['POST /tickets']);
    expect(currentTier(await loadChoice(d.store.storage))).toBe('gp');
    expect(await loadPendingChoice(d.store.storage)).toBeNull();
    expect((await loadTickets(d.store.storage)).map((ticket) => ticket.id)).toEqual([TICKET_ID]);
    expect(await hasServerFootprint(d.store.storage)).toBe(true);
  });

  it('sends a reroute to the stalled ticket’s own route with the reason', async () => {
    const d = deps(() => new Response(JSON.stringify({ ...created, ticket: fullTicket() }), { status: 201 }));
    const rerouted = { ...pending, reroute: { ticketId: '44444444-4444-4444-8444-444444444444', reason: 'cost' as const } };
    await sendReferral(d.server, input({ pending: rerouted }));
    expect(d.bodies).toEqual(['POST /me/tickets/44444444-4444-4444-8444-444444444444/reroute']);
  });

  it('when offline, loses nothing: the pick stays, the current support is unchanged and a retry is the same request', async () => {
    const d = deps(() => Promise.reject(new TypeError('down')));
    await savePendingChoice(d.store.storage, pending);
    await saveChoice(d.store.storage, { tier: 'self_help', serviceId: 'helper', chosenAt: '2026-10-01T08:00:00+04:00', confirmed: true });
    expect(await sendReferral(d.server, input())).toEqual({ status: 'offline' });
    expect(await loadPendingChoice(d.store.storage)).toEqual(pending);
    expect(currentTier(await loadChoice(d.store.storage))).toBe('self_help');
    expect(await loadTickets(d.store.storage)).toEqual([]);
  });

  it('tells apart a ticket that can no longer change (409), another refusal and an answer it cannot read', async () => {
    expect(await sendReferral(deps(() => new Response('{}', { status: 409 })).server, input())).toEqual({ status: 'changed' });
    expect(await sendReferral(deps(() => new Response('{}', { status: 400 })).server, input())).toEqual({ status: 'rejected' });
    expect(await sendReferral(deps(() => new Response('{"nope":1}', { status: 201 })).server, input())).toEqual({ status: 'rejected' });
  });

  function fullTicket() {
    return {
      id: TICKET_ID, shortCode: 'MW4K7Q', qrPayload: 'MAWSOOL:TICKET:MW4K7Q', tier: 'gp', state: 'issued', language: 'en', deadlineAt: '2026-11-09T23:59:59+04:00', source: 'app',
      serviceId: '55555555-5555-4555-8555-555555555555', serviceName: 'Sample PHC', clinicName: 'Sample', clinicContact: 'Call', parentTicketId: null, createdAt: '2026-11-02T08:00:00+04:00', events: [], consents: [],
    };
  }
});
