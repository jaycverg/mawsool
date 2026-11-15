// @vitest-environment jsdom
import type { Locale } from '@mawsool/types';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsentScreen } from '../components/ConsentScreen';
import { CrisisHandoffPanel } from '../components/CrisisHandoffPanel';
import { CrisisScreen } from '../components/CrisisScreen';
import { createCrisisStore, type CrisisMark } from '../lib/crisis';
import { KEYS } from '../lib/keys';
import { refusedRequests } from '../lib/net';
import { savePendingChoice } from '../lib/prefs';
import { readPublicDemoFlag } from '../lib/public-demo';
import ar from '../messages/ar.json';
import en from '../messages/en.json';
import { memoryStorage } from './helpers/memory';

const hoisted = vi.hoisted(() => ({ device: { current: null as unknown }, dial: vi.fn() }));
vi.mock('../lib/use-device', () => ({ useDevice: () => hoisted.device.current }));
vi.mock('../lib/sync', () => ({ repairNow: async () => undefined, syncNow: () => undefined, refreshDirectory: () => undefined }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => '/en/crisis/' }));
vi.mock('@mawsool/ui', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), createWebDialler: () => ({ dial: hoisted.dial }) }));

const MESSAGES = { en, ar } as const;
const SAKINA = '800725462';

/** A device over an in-memory store, with a real crisis store (and the tab's mark held in memory), as the screens use it. */
function makeDevice(initial: Record<string, unknown> = {}) {
  const memory = memoryStorage(initial);
  let mark: CrisisMark | null = null;
  const tabMark = { get: () => mark, set: (value: CrisisMark | null) => void (mark = value) };
  const crisis = createCrisisStore(memory.storage, { now: () => new Date('2026-11-01T08:00:00+04:00'), newId: () => crypto.randomUUID(), fallback: tabMark, readPatienceMs: 20 });
  const device = { storage: memory.storage, crisis, tabMark, anonymous: false };
  hoisted.device.current = device;
  return { device, memory };
}

const providers = (locale: Locale, children: React.ReactNode) => (
  <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]}>
    {children}
  </NextIntlClientProvider>
);

beforeEach(() => {
  hoisted.dial.mockClear();
  window.sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe('the strict flag', () => {
  it('is on for true, off for unset and empty, and refuses anything else so the build fails', () => {
    expect(readPublicDemoFlag('true')).toBe(true);
    expect(readPublicDemoFlag(undefined)).toBe(false);
    expect(readPublicDemoFlag('')).toBe(false);
    for (const value of ['1', 'TRUE', 'yes', 'false', 'ture', ' true']) expect(() => readPublicDemoFlag(value), value).toThrow(/NEXT_PUBLIC_PUBLIC_DEMO/);
  });
});

describe.each(['en', 'ar'] as const)('the crisis screen (%s)', (locale) => {
  const words = MESSAGES[locale].crisis;

  async function open() {
    const { device } = makeDevice();
    await device.crisis.raise({ trigger: 'phq9_item9', screeningId: null, locale });
    render(providers(locale, <CrisisScreen />));
    await screen.findByText(words.heading);
    return device;
  }

  it('in the public-demo build shows the numbers as text with no tel: link and says nothing here dials', async () => {
    vi.stubEnv('NEXT_PUBLIC_PUBLIC_DEMO', 'true');
    await open();
    expect(document.querySelectorAll('a[href^="tel:"]')).toHaveLength(0);
    expect(document.body.innerHTML).not.toContain('tel:');
    expect(screen.getByText(words.demoNoCall)).toBeTruthy();
    const text = document.querySelector('main')!.textContent ?? '';
    for (const number of ['800-SAKINA', '800 725462', '999', '998']) expect(text, number).toContain(number);
    expect(document.querySelector('[data-number="800725462"]')).not.toBeNull();
    expect(document.querySelector('[data-number="999"]')).not.toBeNull();
    expect(document.querySelector('[data-number="998"]')).not.toBeNull();
  });

  it('in the public-demo build “Call now” records the tap and asks whether the person reached someone, and never calls the dialler', async () => {
    vi.stubEnv('NEXT_PUBLIC_PUBLIC_DEMO', 'true');
    const device = await open();
    fireEvent.click(screen.getByRole('button', { name: words.callNow }));
    await screen.findByText(words.reachedTitle);
    await waitFor(async () => expect((await device.crisis.read()).record?.event?.callTapped).toBe(SAKINA));
    expect(hoisted.dial).not.toHaveBeenCalled();
  });

  it('without the flag keeps every number a tap-to-call link and dials through the adapter, as it always did', async () => {
    await open();
    for (const number of [SAKINA, '998', '999']) expect(document.querySelector(`a[href="tel:${number}"]`), number).not.toBeNull();
    expect(screen.queryByText(words.demoNoCall)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: words.callNow }));
    expect(hoisted.dial).toHaveBeenCalledWith(SAKINA);
    fireEvent.click(document.querySelector('a[href="tel:999"]')!);
    expect(hoisted.dial).toHaveBeenLastCalledWith('999');
  });

  it('with the flag set to anything but true dials as ever: only the exact value switches dialling off', async () => {
    vi.stubEnv('NEXT_PUBLIC_PUBLIC_DEMO', '1');
    await open();
    expect(document.querySelector(`a[href="tel:${SAKINA}"]`)).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: words.callNow }));
    expect(hoisted.dial).toHaveBeenCalledWith(SAKINA);
  });
});

describe.each(['en', 'ar'] as const)('the hand-off panel’s note (%s)', (locale) => {
  const words = MESSAGES[locale].crisis;
  const mount = async () => {
    const { device } = makeDevice({ 'crisis:block': { blocked: true, trigger: 'phq9_item9' } });
    render(providers(locale, <CrisisHandoffPanel device={device as never} lang={locale} mode="crisis" open={{ eventId: '11111111-1111-4111-8111-111111111111', trigger: 'phq9_item9' }} />));
    fireEvent.click(await screen.findByText(words.handoffOffer));
    await screen.findByText(words.handoffCallbackLabel);
  };

  it('sits next to the callback-number field in the public-demo build', async () => {
    vi.stubEnv('NEXT_PUBLIC_PUBLIC_DEMO', 'true');
    await mount();
    const note = document.querySelector('[data-public-demo-note]')!;
    expect(note.textContent).toBe(words.publicDemoNote);
    expect(note.closest('label')).toBe(document.querySelector('[data-handoff-number]')!.closest('label'));
  });

  it('is not there without the flag', async () => {
    await mount();
    expect(document.querySelector('[data-public-demo-note]')).toBeNull();
  });
});

describe.each(['en', 'ar'] as const)('the consent screen (%s)', (locale) => {
  const words = MESSAGES[locale].consent;
  type Body = Record<string, unknown>;

  async function open(reply: { source: 'ai' | 'template'; text: string }) {
    const { memory } = makeDevice();
    await savePendingChoice(memory.storage, { tier: 'gp', serviceId: crypto.randomUUID(), chosenAt: '2026-11-01T08:00:00+04:00', windowDays: 7, requestId: crypto.randomUUID(), reroute: null });
    const drafts: Body[] = [];
    window.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === '/persons') return new Response('{}', { status: 201 });
      if (path === '/services') return new Response('[]', { status: 200 });
      if (path === '/summary/draft') {
        drafts.push(JSON.parse(String(init?.body)) as Body);
        return new Response(JSON.stringify(reply), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    render(providers(locale, <ConsentScreen />));
    await screen.findByText(words.writeTitle);
    return { memory, drafts };
  }

  const aiTick = () => document.querySelector('#use-ai') as HTMLInputElement;

  it('without the flag has no public-demo note', async () => {
    await open({ source: 'template', text: 'TEMPLATE TEXT' });
    expect(document.querySelector('[data-public-demo-note]')).toBeNull();
  });

  it('with the flag shows the note beside what the person types, and no field for a code', async () => {
    vi.stubEnv('NEXT_PUBLIC_PUBLIC_DEMO', 'true');
    await open({ source: 'template', text: 'TEMPLATE TEXT' });
    expect(document.querySelector('[data-public-demo-note]')!.textContent).toBe(words.publicDemoNote);
    expect(document.querySelectorAll('input[type="text"]')).toHaveLength(0);
  });

  it('asks the server for a draft the same way with and without the flag: no field of the request is added', async () => {
    const bodies: string[][] = [];
    for (const flag of [undefined, 'true']) {
      cleanup();
      vi.unstubAllEnvs();
      if (flag) vi.stubEnv('NEXT_PUBLIC_PUBLIC_DEMO', flag);
      const { drafts } = await open({ source: 'template', text: 'TEMPLATE TEXT' });
      fireEvent.click(aiTick());
      fireEvent.click(screen.getByRole('button', { name: words.draft }));
      await screen.findByDisplayValue('TEMPLATE TEXT');
      expect(drafts).toHaveLength(1);
      bodies.push(Object.keys(drafts[0]!).sort());
    }
    expect(bodies[0]).toEqual(['consented', 'content', 'locale', 'requestId', 'useAi']);
    expect(bodies[1]).toEqual(bodies[0]);
  });
});

describe.each(['en', 'ar'] as const)('the AI banner on the consent screen (%s)', (locale) => {
  const words = MESSAGES[locale].consent;
  type Availability = 'available' | 'off' | 'daily_cap' | 'fail' | 'bad_status' | 'bad_body';

  async function open(options: { availability: Availability; draftReply?: Record<string, unknown>; anonymous?: boolean }) {
    const { device, memory } = makeDevice();
    if (options.anonymous) (device as { anonymous: boolean }).anonymous = true;
    await savePendingChoice(memory.storage, { tier: 'gp', serviceId: crypto.randomUUID(), chosenAt: '2026-11-01T08:00:00+04:00', windowDays: 7, requestId: crypto.randomUUID(), reroute: null });
    const requests: { path: string; headers: Headers }[] = [];
    window.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      requests.push({ path, headers: new Headers(init?.headers) });
      if (path === '/summary/availability') {
        if (options.availability === 'fail') throw new TypeError('network down');
        if (options.availability === 'bad_status') return new Response('{}', { status: 500 });
        if (options.availability === 'bad_body') return new Response(JSON.stringify({ ai: 'maybe' }), { status: 200 });
        return new Response(JSON.stringify({ ai: options.availability }), { status: 200 });
      }
      if (path === '/services') return new Response('[]', { status: 200 });
      if (path === '/summary/draft') return new Response(JSON.stringify(options.draftReply ?? { source: 'template', text: 'TEMPLATE TEXT' }), { status: 200 });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    render(providers(locale, <ConsentScreen />));
    await screen.findByText(words.writeTitle);
    return { memory, requests };
  }

  const banner = () => document.querySelector('[data-ai-unavailable]');
  const availabilityRequests = (requests: { path: string }[]) => requests.filter((request) => request.path === '/summary/availability');

  it('with the flag and the AI switched off shows the off note above the AI tick', async () => {
    vi.stubEnv('NEXT_PUBLIC_PUBLIC_DEMO', 'true');
    await open({ availability: 'off' });
    await waitFor(() => expect(banner()).not.toBeNull());
    expect(banner()!.textContent).toBe(words.aiOff);
    expect(banner()!.getAttribute('data-ai-unavailable')).toBe('off');
    const tick = document.querySelector('#use-ai')!;
    expect(banner()!.compareDocumentPosition(tick) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(banner()!.parentElement).toBe(tick.closest('section'));
  });

  it('with the flag and the day’s drafts used up shows the daily-cap note', async () => {
    vi.stubEnv('NEXT_PUBLIC_PUBLIC_DEMO', 'true');
    await open({ availability: 'daily_cap' });
    await waitFor(() => expect(banner()).not.toBeNull());
    expect(banner()!.textContent).toBe(words.aiDailyCap);
    expect(banner()!.getAttribute('data-ai-unavailable')).toBe('daily_cap');
  });

  it('has the two notes in both languages, different from each other and not left as a key name', () => {
    expect(words.aiOff).not.toBe(words.aiDailyCap);
    for (const text of [words.aiOff, words.aiDailyCap]) expect(text).not.toMatch(/^ai(Off|DailyCap)$/);
    expect(MESSAGES.en.consent.aiOff).toBe('AI drafting is switched off in this demo, so drafts are written from the template.');
    expect(MESSAGES.en.consent.aiDailyCap).toBe("Today's AI drafts for this demo are used up, so drafts are written from the template until tomorrow.");
  });

  it('shows nothing when the AI is available, and nothing when the answer cannot be read', async () => {
    vi.stubEnv('NEXT_PUBLIC_PUBLIC_DEMO', 'true');
    for (const availability of ['available', 'fail', 'bad_status', 'bad_body'] as const) {
      cleanup();
      const { requests } = await open({ availability });
      await waitFor(() => expect(availabilityRequests(requests)).toHaveLength(1));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(banner(), availability).toBeNull();
    }
  });

  it('without the flag makes no availability request and shows no banner, whatever the server would say', async () => {
    const { requests } = await open({ availability: 'off' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(availabilityRequests(requests)).toHaveLength(0);
    expect(banner()).toBeNull();
  });

  it('in an anonymous session makes no request for it, even with the flag', async () => {
    vi.stubEnv('NEXT_PUBLIC_PUBLIC_DEMO', 'true');
    const refusedBefore = refusedRequests.count;
    const { requests } = await open({ availability: 'off', anonymous: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(availabilityRequests(requests)).toHaveLength(0);
    expect(refusedRequests.count).toBe(refusedBefore);
    expect(banner()).toBeNull();
  });

  it('reads it without registering the phone and without leaving a footprint', async () => {
    vi.stubEnv('NEXT_PUBLIC_PUBLIC_DEMO', 'true');
    const { memory, requests } = await open({ availability: 'off' });
    await waitFor(() => expect(banner()).not.toBeNull());
    expect(requests.map((request) => request.path)).not.toContain('/persons');
    expect(availabilityRequests(requests)[0]!.headers.get('authorization')).toBeNull();
    expect(memory.data.has(KEYS.footprint)).toBe(false);
  });

  it('shows the note again after a draft reply that says the AI was unavailable, in the public-demo build only', async () => {
    vi.stubEnv('NEXT_PUBLIC_PUBLIC_DEMO', 'true');
    await open({ availability: 'available', draftReply: { source: 'template', text: 'TEMPLATE TEXT', aiUnavailable: 'daily_cap' } });
    expect(banner()).toBeNull();
    fireEvent.click(document.querySelector('#use-ai')!);
    fireEvent.click(screen.getByRole('button', { name: words.draft }));
    await screen.findByDisplayValue('TEMPLATE TEXT');
    await waitFor(() => expect(banner()).not.toBeNull());
    expect(banner()!.textContent).toBe(words.aiDailyCap);

    cleanup();
    vi.unstubAllEnvs();
    await open({ availability: 'available', draftReply: { source: 'template', text: 'TEMPLATE TEXT', aiUnavailable: 'off' } });
    fireEvent.click(document.querySelector('#use-ai')!);
    fireEvent.click(screen.getByRole('button', { name: words.draft }));
    await screen.findByDisplayValue('TEMPLATE TEXT');
    expect(banner()).toBeNull();
  });

  it('shows no note after a draft reply that carries no reason', async () => {
    vi.stubEnv('NEXT_PUBLIC_PUBLIC_DEMO', 'true');
    await open({ availability: 'available' });
    fireEvent.click(document.querySelector('#use-ai')!);
    fireEvent.click(screen.getByRole('button', { name: words.draft }));
    await screen.findByDisplayValue('TEMPLATE TEXT');
    expect(banner()).toBeNull();
  });
});
