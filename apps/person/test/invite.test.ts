import type { BundleContent } from '@mawsool/types';
import { describe, expect, it } from 'vitest';
import { clinicCouldNotSee } from '../lib/day7';
import { claimInvite, clearInvite, loadInvite, saveInvite } from '../lib/invite';
import { KEYS } from '../lib/keys';
import { pendingFrom, savePendingChoice } from '../lib/prefs';
import { sendReferral, ticketRequest, type SendInput } from '../lib/send-referral';
import { forgetRegistration, hasServerFootprint } from '../lib/server';
import { memoryStorage } from './helpers/memory';

const NOW = () => new Date('2026-11-02T08:00:00+04:00');
const INVITE = { inviteId: '66666666-6666-4666-8666-666666666666', source: 'tamm' as const, screenedAt: '2026-11-01T04:00:00.000Z' };

function server(reply: (path: string, body: unknown) => Response | Promise<Response>) {
  const store = memoryStorage();
  forgetRegistration(store.storage);
  const calls: { path: string; body: unknown }[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === '/persons') return new Response('{}', { status: 201 });
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ path, body });
    return reply(path, body);
  }) as unknown as typeof fetch;
  return { store, calls, deps: { storage: store.storage, fetch: fetchFn, apiUrl: 'http://api.test', locale: 'en' as const, random: globalThis.crypto } };
}

describe('claiming an invite on the phone', () => {
  it('sends the normalised code, keeps the invite it gets back, and notes that the server now holds something', async () => {
    const s = server(() => new Response(JSON.stringify(INVITE), { status: 200 }));
    expect(await claimInvite(s.deps, ' abcd-efgh ', NOW)).toEqual({ status: 'claimed', invite: INVITE });
    expect(s.calls).toEqual([{ path: '/me/invites/claim', body: { code: 'ABCDEFGH' } }]);
    expect(await loadInvite(s.store.storage)).toEqual(INVITE);
    expect(await hasServerFootprint(s.store.storage)).toBe(true);
  });

  it('sends nothing for what is not a code', async () => {
    const s = server(() => new Response('{}', { status: 200 }));
    for (const typed of ['', 'ABC', 'ABCD-EFG0', 'ABCDEFGHJ']) expect(await claimInvite(s.deps, typed, NOW), typed).toEqual({ status: 'bad_code' });
    expect(s.calls).toEqual([]);
    expect(await hasServerFootprint(s.store.storage)).toBe(false);
  });

  it('says not found for a code the server does not know, bad code for any other refusal, and keeps nothing', async () => {
    expect(await claimInvite(server(() => new Response('{}', { status: 404 })).deps, 'ABCD-EFGH', NOW)).toEqual({ status: 'not_found' });
    const refused = server(() => new Response('{}', { status: 400 }));
    expect(await claimInvite(refused.deps, 'ABCD-EFGH', NOW)).toEqual({ status: 'bad_code' });
    expect(await loadInvite(refused.store.storage)).toBeNull();
  });

  it('says offline when the server cannot be reached or fails, or answers with something that is not an invite, and keeps nothing', async () => {
    const down = server(() => Promise.reject(new TypeError('down')));
    expect(await claimInvite(down.deps, 'ABCD-EFGH', NOW)).toEqual({ status: 'offline' });
    expect(await claimInvite(server(() => new Response('{}', { status: 503 })).deps, 'ABCD-EFGH', NOW)).toEqual({ status: 'offline' });
    const odd = server(() => new Response('{"nope":1}', { status: 200 }));
    expect(await claimInvite(odd.deps, 'ABCD-EFGH', NOW)).toEqual({ status: 'offline' });
    expect(await loadInvite(odd.store.storage)).toBeNull();
  });

  it('sends nothing when the phone cannot note the footprint first', async () => {
    const s = server(() => new Response(JSON.stringify(INVITE), { status: 200 }));
    s.store.failures.write = true;
    expect(await claimInvite(s.deps, 'ABCD-EFGH', NOW)).toEqual({ status: 'not_saved' });
    expect(s.calls).toEqual([]);
  });

  it('says so when the server has the claim but the phone could not keep it, and the same code claimed again keeps it', async () => {
    const s = server(() => new Response(JSON.stringify(INVITE), { status: 200 }));
    const post = s.deps.fetch;
    s.deps.fetch = (async (url: string, init?: RequestInit) => {
      const answer = await (post as typeof fetch)(url, init);
      if (new URL(url).pathname === '/me/invites/claim') s.store.failures.write = true;
      return answer;
    }) as unknown as typeof fetch;
    expect(await claimInvite(s.deps, 'ABCD-EFGH', NOW)).toEqual({ status: 'claimed_not_kept' });
    s.store.failures.write = false;
    s.deps.fetch = post;
    expect(await claimInvite(s.deps, 'ABCD-EFGH', NOW)).toEqual({ status: 'claimed', invite: INVITE });
    expect(await loadInvite(s.store.storage)).toEqual(INVITE);
  });

  it('reads a damaged or missing stored invite as no invite, and clears it', async () => {
    const { storage, data } = memoryStorage();
    expect(await loadInvite(storage)).toBeNull();
    data.set(KEYS.invite, { inviteId: 'nope' });
    expect(await loadInvite(storage)).toBeNull();
    await saveInvite(storage, INVITE);
    expect(await loadInvite(storage)).toEqual(INVITE);
    await clearInvite(storage);
    expect(await loadInvite(storage)).toBeNull();
  });
});

describe('the invite and the ticket request', () => {
  const content: BundleContent = {};
  const pending = pendingFrom({ tier: 'gp', serviceId: 'svc-1', handoffWindowDays: 7 }, { now: NOW, newId: () => '22222222-2222-4222-8222-222222222222' }, null);
  const input = (overrides: Partial<SendInput> = {}): SendInput => ({ pending, elements: ['ticket'], content, approvedSummary: null, summaryRequestId: null, summaryBuiltFrom: [], language: 'en', now: NOW, ...overrides });
  const created = {
    created: true,
    ticket: {
      id: '33333333-3333-4333-8333-333333333333', shortCode: 'MW4K7Q', qrPayload: 'MAWSOOL:TICKET:MW4K7Q', tier: 'gp', state: 'issued', language: 'en', deadlineAt: '2026-11-09T23:59:59+04:00', source: 'tamm',
      serviceId: '55555555-5555-4555-8555-555555555555', serviceName: 'Sample PHC', clinicName: 'Sample', clinicContact: 'Call', parentTicketId: null, createdAt: '2026-11-02T08:00:00+04:00', events: [], consents: [],
    },
  };

  it('carries the claimed invite on a new ticket, and none when there is no invite', () => {
    expect(ticketRequest(input({ inviteId: INVITE.inviteId })).inviteId).toBe(INVITE.inviteId);
    expect(ticketRequest(input()).inviteId).toBeNull();
    expect(ticketRequest(input({ inviteId: null })).inviteId).toBeNull();
  });

  it('leaves the invite off a reroute, which is not a new screen', () => {
    const rerouted = { ...pending, reroute: { ticketId: '44444444-4444-4444-8444-444444444444', reason: 'cost' as const } };
    expect(ticketRequest(input({ pending: rerouted, inviteId: INVITE.inviteId })).inviteId).toBeNull();
  });

  it('forgets the invite once a ticket has used it, and keeps it when the send fails', async () => {
    const sent = server(() => new Response(JSON.stringify(created), { status: 201 }));
    await saveInvite(sent.store.storage, INVITE);
    await savePendingChoice(sent.store.storage, pending);
    expect(await sendReferral(sent.deps, input({ inviteId: INVITE.inviteId }))).toMatchObject({ status: 'sent' });
    expect((sent.calls[0]!.body as { inviteId: string }).inviteId).toBe(INVITE.inviteId);
    expect(await loadInvite(sent.store.storage)).toBeNull();

    const failed = server(() => Promise.reject(new TypeError('down')));
    await saveInvite(failed.store.storage, INVITE);
    expect(await sendReferral(failed.deps, input({ inviteId: INVITE.inviteId }))).toEqual({ status: 'offline' });
    expect(await loadInvite(failed.store.storage)).toEqual(INVITE);
  });

  it('does not touch a stored invite when the ticket did not use one', async () => {
    const s = server(() => new Response(JSON.stringify(created), { status: 201 }));
    await saveInvite(s.store.storage, INVITE);
    await sendReferral(s.deps, input());
    expect(await loadInvite(s.store.storage)).toEqual(INVITE);
  });

  it('still reports the ticket as sent when forgetting the invite fails', async () => {
    const s = server(() => new Response(JSON.stringify(created), { status: 201 }));
    await saveInvite(s.store.storage, INVITE);
    const post = s.deps.fetch;
    s.deps.fetch = (async (url: string, init?: RequestInit) => {
      const answer = await (post as typeof fetch)(url, init);
      if (new URL(url).pathname === '/tickets') s.store.failures.write = true;
      return answer;
    }) as unknown as typeof fetch;
    expect(await sendReferral(s.deps, input({ inviteId: INVITE.inviteId }))).toMatchObject({ status: 'sent', saved: false });
  });
});

describe('the clinic could not see you', () => {
  const event = (seq: number, from: string | null, to: string, actor: string) => ({ seq, fromState: from as never, toState: to as never, actor });
  const issued = event(1, null, 'issued', 'person');

  it('shows while the clinic’s latest event is a report that changed no state and the ticket is still waiting', () => {
    for (const state of ['issued', 'acknowledged', 'overdue'] as const) {
      expect(clinicCouldNotSee({ state, events: [issued, event(2, state, state, 'clinic')] }), state).toBe(true);
    }
  });

  it('does not show when nothing was reported, when something happened after the report, or when the ticket moved on', () => {
    expect(clinicCouldNotSee({ state: 'issued', events: [issued] })).toBe(false);
    expect(clinicCouldNotSee({ state: 'acknowledged', events: [issued, event(2, 'issued', 'issued', 'clinic'), event(3, 'issued', 'acknowledged', 'clinic')] })).toBe(false);
    expect(clinicCouldNotSee({ state: 'overdue', events: [issued, event(2, 'issued', 'issued', 'clinic'), event(3, 'issued', 'overdue', 'system')] })).toBe(false);
    for (const state of ['seen', 'rerouted', 'declined', 'withdrawn', 'closed', 'remeasured'] as const) {
      expect(clinicCouldNotSee({ state, events: [issued, event(2, state, state, 'clinic')] }), state).toBe(false);
    }
  });

  it('does not take a same-state event by the person or the system for the clinic’s report, and reads the newest event whatever the order', () => {
    expect(clinicCouldNotSee({ state: 'issued', events: [issued, event(2, 'issued', 'issued', 'person')] })).toBe(false);
    expect(clinicCouldNotSee({ state: 'issued', events: [event(2, 'issued', 'issued', 'clinic'), issued] })).toBe(true);
    expect(clinicCouldNotSee({ state: 'issued', events: [] })).toBe(false);
  });
});
