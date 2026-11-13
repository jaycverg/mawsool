// @vitest-environment jsdom
import type { Locale } from '@mawsool/types';
import type { StorageAdapter } from '@mawsool/ui';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CrisisHandoffPanel } from '../components/CrisisHandoffPanel';
import type { Device } from '../lib/use-device';
import ar from '../messages/ar.json';
import en from '../messages/en.json';
import { memoryStorage } from './helpers/memory';

const MESSAGES = { en, ar } as const;
const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const OPEN = { eventId: EVENT_ID, trigger: 'phq9_item9' as const };

/**
 * The crisis screen's hand-off panel, rendered with the component itself in a DOM, against a fake API whose hand-off POST loses its reply (the server
 * stores the note) and, unless told otherwise, breaks every later read of the phone's hand-off records at that moment. The panel never got to read the record it wrote.
 */
function harness(options: { breakStoreAtPost: boolean } = { breakStoreAtPost: true }) {
  const store = memoryStorage({ 'crisis:block': { blocked: true, trigger: 'phq9_item9' } });
  const calls: { method: string; path: string; body: Record<string, unknown> | null }[] = [];
  const server = { stored: false };
  const breakReads = () => {
    const get = store.storage.get.bind(store.storage);
    (store.storage as StorageAdapter).get = (async (key: string) => (key === 'crisis:handoff' ? Promise.reject(new Error('storage read failed')) : get(key))) as StorageAdapter['get'];
  };
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const method = init?.method ?? 'GET';
    calls.push({ method, path, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null });
    if (path === '/persons') return new Response('{}', { status: 201 });
    if (method === 'POST' && path === '/me/crisis-handoffs') {
      server.stored = true;
      if (options.breakStoreAtPost) breakReads();
      throw new TypeError('the reply never came');
    }
    if (method === 'DELETE') {
      server.stored = false;
      return new Response('{}', { status: 200 });
    }
    return new Response('{}', { status: 200 });
  });
  window.fetch = fetchFn as unknown as typeof fetch;
  const device = { storage: store.storage, anonymous: false } as unknown as Device;
  const handoffPosts = () => calls.filter((call) => call.method === 'POST' && call.path === '/me/crisis-handoffs');
  return { device, calls, server, handoffPosts };
}

function mount(locale: Locale, device: Device) {
  return render(
    <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]}>
      <CrisisHandoffPanel device={device} lang={locale} mode="crisis" open={OPEN} />
    </NextIntlClientProvider>,
  );
}

const setOnline = (online: boolean) => Object.defineProperty(window.navigator, 'onLine', { value: online, configurable: true });
const failure = () => document.querySelector('[data-handoff-failure]');

beforeEach(() => setOnline(true));
afterEach(() => {
  cleanup();
  setOnline(true);
});

describe.each(['en', 'ar'] as const)('the crisis screen’s hand-off panel (%s)', (locale) => {
  const words = MESSAGES[locale].crisis;

  /** Opens the form, ticks the consent and presses Send. */
  async function press() {
    if (!document.querySelector('[data-handoff-consent]')) fireEvent.click(await screen.findByText(words.handoffOffer));
    const consent = (await screen.findByRole('checkbox')) as HTMLInputElement;
    if (!consent.checked) fireEvent.click(consent);
    fireEvent.click(document.querySelector('[data-handoff-send]') as HTMLElement);
  }

  it('keeps Stop and never says nothing was sent after an attempt whose record the panel could not read back, whatever the phone’s store does next', async () => {
    const h = harness();
    mount(locale, h.device);

    await press();
    await waitFor(() => expect(failure()?.textContent).toBe(words.handoffNotConfirmed));
    expect(h.server.stored, 'the server did get the note').toBe(true);
    expect(document.querySelector('[data-handoff-stop]'), 'Stop is offered although the store can no longer be read').not.toBeNull();
    expect(document.querySelector('[data-handoff-state]')?.getAttribute('data-handoff-state')).toBe('sending');

    // No network: the press must still say unconfirmed, and send nothing.
    setOnline(false);
    await press();
    await waitFor(() => expect(failure()?.getAttribute('data-handoff-failure')).toBe('unconfirmed'));
    expect(failure()?.textContent).toBe(words.handoffNotConfirmed);
    expect(failure()?.textContent).not.toBe(words.handoffOffline);
    expect(h.handoffPosts(), 'the second press sent no request').toHaveLength(1);

    // Online again, the store still not answering: the record cannot be written for the retry, which still says unconfirmed, never failed.
    setOnline(true);
    await press();
    await waitFor(() => expect(h.calls.filter((call) => call.path === '/me/crisis-handoffs').length).toBeGreaterThanOrEqual(1));
    await waitFor(() => expect(failure()?.getAttribute('data-handoff-failure')).toBe('unconfirmed'));
    expect(failure()?.textContent).not.toBe(words.handoffFailed);

    // Stop works from the id the panel remembers: the server is asked to delete exactly the note it was sent.
    fireEvent.click(document.querySelector('[data-handoff-stop]') as HTMLElement);
    await waitFor(() => expect(h.server.stored).toBe(false));
    const sentId = h.handoffPosts()[0]!.body!.handoffId;
    expect(h.calls.filter((call) => call.method === 'DELETE').map((call) => call.path)).toEqual([`/me/crisis-handoffs/${sentId}`]);
  });

  it('unticks the consent box after a confirmed Stop, so a new send needs a fresh tick', async () => {
    const h = harness({ breakStoreAtPost: false });
    mount(locale, h.device);

    await press();
    await waitFor(() => expect(failure()?.getAttribute('data-handoff-failure')).toBe('unconfirmed'));
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked, 'ticked for the send that was made').toBe(true);

    fireEvent.click(document.querySelector('[data-handoff-stop]') as HTMLElement);
    await waitFor(() => expect(screen.getByText(words.handoffStopped)).toBeTruthy());
    expect(h.server.stored).toBe(false);
    expect(document.querySelector('[data-handoff-stop]'), 'the note is gone, so is Stop').toBeNull();
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    expect((document.querySelector('[data-handoff-send]') as HTMLButtonElement).disabled, 'Send waits for a new tick').toBe(true);
  });
});
