// @vitest-environment jsdom
import type { Locale } from '@mawsool/types';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsentScreen } from '../components/ConsentScreen';
import { CrisisHandoffPanel } from '../components/CrisisHandoffPanel';
import { CrisisScreen } from '../components/CrisisScreen';
import { createCrisisStore, type CrisisMark } from '../lib/crisis';
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
const CODE = 'Sand-River-Lamp ';

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

  async function open(reply: { source: 'ai' | 'template'; text: string; demoCode?: 'accepted' | 'refused' }) {
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
  const codeField = () => document.querySelector('#demo-code') as HTMLInputElement | null;

  it('without the flag has no public-demo note and no demo-code field, and a draft carries no demoCode', async () => {
    const { drafts } = await open({ source: 'template', text: 'TEMPLATE TEXT' });
    expect(document.querySelector('[data-public-demo-note]')).toBeNull();
    expect(codeField()).toBeNull();
    fireEvent.click(aiTick());
    fireEvent.click(screen.getByRole('button', { name: words.draft }));
    await screen.findByDisplayValue('TEMPLATE TEXT');
    expect(drafts).toHaveLength(1);
    expect('demoCode' in drafts[0]!).toBe(false);
  });

  it('with the flag shows the note and the field, and the field is disabled until the AI tick is on', async () => {
    vi.stubEnv('NEXT_PUBLIC_PUBLIC_DEMO', 'true');
    await open({ source: 'template', text: 'TEMPLATE TEXT' });
    expect(document.querySelector('[data-public-demo-note]')!.textContent).toBe(words.publicDemoNote);
    const field = codeField()!;
    expect(field).not.toBeNull();
    expect(field.disabled).toBe(true);
    expect(field.getAttribute('autocapitalize')).toBe('none');
    expect(field.getAttribute('autocorrect')).toBe('off');
    expect(field.getAttribute('spellcheck')).toBe('false');
    fireEvent.click(aiTick());
    await waitFor(() => expect(codeField()!.disabled).toBe(false));
  });

  it('sends the typed code as demoCode, shows the “not accepted” message beside a template draft when the reply says refused, and keeps the code out of every store', async () => {
    vi.stubEnv('NEXT_PUBLIC_PUBLIC_DEMO', 'true');
    const { memory, drafts } = await open({ source: 'template', text: 'TEMPLATE TEXT', demoCode: 'refused' });
    fireEvent.click(aiTick());
    await waitFor(() => expect(codeField()!.disabled).toBe(false));
    fireEvent.change(codeField()!, { target: { value: CODE } });
    fireEvent.click(screen.getByRole('button', { name: words.draft }));
    await screen.findByText(words.demoCodeRefused);
    expect(screen.getByDisplayValue('TEMPLATE TEXT')).toBeTruthy();
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.demoCode).toBe(CODE);
    expect(drafts[0]!.useAi).toBe(true);

    const device = [...memory.data.entries()].map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n');
    expect(device).not.toContain('Sand-River-Lamp');
    expect(device.toLowerCase()).not.toContain('sand-river');
    const session = Object.keys(window.sessionStorage).map((key) => `${key}=${window.sessionStorage.getItem(key)}`).join('\n');
    const local = Object.keys(window.localStorage).map((key) => `${key}=${window.localStorage.getItem(key)}`).join('\n');
    expect(session.toLowerCase()).not.toContain('sand-river');
    expect(local.toLowerCase()).not.toContain('sand-river');
  });

  it('shows no message when the reply says accepted, and clears an earlier message on the next draft', async () => {
    vi.stubEnv('NEXT_PUBLIC_PUBLIC_DEMO', 'true');
    const { drafts } = await open({ source: 'ai', text: 'AI TEXT', demoCode: 'accepted' });
    fireEvent.click(aiTick());
    await waitFor(() => expect(codeField()!.disabled).toBe(false));
    fireEvent.change(codeField()!, { target: { value: CODE } });
    fireEvent.click(screen.getByRole('button', { name: words.draft }));
    await screen.findByDisplayValue('AI TEXT');
    expect(screen.queryByText(words.demoCodeRefused)).toBeNull();
    expect(drafts[0]!.demoCode).toBe(CODE);
  });

  it('sends no demoCode when the AI box is not ticked, whatever is in the field', async () => {
    vi.stubEnv('NEXT_PUBLIC_PUBLIC_DEMO', 'true');
    const { drafts } = await open({ source: 'template', text: 'TEMPLATE TEXT' });
    fireEvent.click(aiTick());
    await waitFor(() => expect(codeField()!.disabled).toBe(false));
    fireEvent.change(codeField()!, { target: { value: CODE } });
    fireEvent.click(aiTick());
    await waitFor(() => expect(aiTick().checked).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: words.draft }));
    await screen.findByDisplayValue('TEMPLATE TEXT');
    expect(drafts[0]!.useAi).toBe(false);
    expect('demoCode' in drafts[0]!).toBe(false);
  });
});
