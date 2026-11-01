import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import acceptance from './acceptance-phase3.json';
import {
  API,
  INSPECT,
  LOCALES,
  computed,
  crisisUrl,
  installFailingIndexedDb,
  msg,
  rawStoreKeys,
  setIdbMode,
  takeCheckIn,
  triggerCrisis,
  visitOnline,
  type Locale,
} from './helpers';

/**
 * Every browser sentence of Phase 3's exit acceptance, as its own named test, in both languages. `acceptance-phase3.json`
 * is the registry: the gate fails unless the report holds exactly one passing test per entry and locale. The API behind
 * it is the real one on an in-process database; the inspect listener shows what it stored.
 */
interface Context {
  page: Page;
  context: BrowserContext;
  locale: Locale;
}

const DAY_MS = 86_400_000;
/** PHQ-9 = 11: the "trained GP or tele" row, so a GP is the lead card. Item 9 is 0, so no crisis. */
const PHQ9_ELEVEN = [2, 2, 2, 1, 1, 1, 1, 1, 0] as const;

interface Stored {
  ticket: { id: string; personId: string; state: string; parentTicketId: string | null };
  events: { seq: number; fromState: string | null; toState: string; actor: string; reason: string | null; selfConfirmed: boolean }[];
  consents: { element: string; revokedAt: string | null }[];
  summaryLogs: number;
  children: string[];
  bundle: { contentCiphertext: string | null; approvedSummaryCiphertext: string | null; deletedAt: string | null; content: Record<string, unknown> | null } | null;
}

async function stored(ticketId: string): Promise<Stored> {
  return (await (await fetch(`${INSPECT}/tickets/${ticketId}`)).json()) as Stored;
}

const ticketIdOf = (page: Page) => new URL(page.url()).searchParams.get('id')!;
const consentUrl = (locale: Locale) => new RegExp(`/${locale}/consent/$`);
const ticketUrl = (locale: Locale) => new RegExp(`/${locale}/ticket/\\?id=`);

/** A check-in worth a GP referral, then the options screen. */
async function toOptions(page: Page, locale: Locale): Promise<void> {
  await visitOnline(page, locale);
  await takeCheckIn(page, locale, 'phq9', PHQ9_ELEVEN);
  await expect(page.locator('[data-score]')).toHaveText('11');
  await page.getByRole('link', { name: msg(locale, 'result.options'), exact: true }).click();
  await expect(page.locator('[data-tier][data-lead]')).toHaveAttribute('data-tier', 'gp');
}

/** The lead option chosen, which lands on the consent screen. */
async function toConsent(page: Page, locale: Locale): Promise<void> {
  await toOptions(page, locale);
  await page.locator('[data-tier][data-lead]').getByRole('button', { name: msg(locale, 'options.choose'), exact: true }).click();
  await expect(page).toHaveURL(consentUrl(locale));
  await expect(page.locator('[data-screen="consent"]')).toBeVisible();
}

const tick = (page: Page, element: string) => page.locator(`input[data-element="${element}"]`).check();
const send = (page: Page, locale: Locale) => page.getByRole('button', { name: msg(locale, 'consent.send'), exact: true }).click();

/** Takes a GP referral all the way to a ticket with the given elements ticked. */
async function issueTicket(page: Page, locale: Locale, elements: string[] = ['scores']): Promise<string> {
  await toConsent(page, locale);
  // An element can only be ticked once there is something to share: a note has to be written first.
  if (elements.includes('free_text')) await page.locator('#note').fill('A short note for the clinic');
  for (const element of elements) await tick(page, element);
  await send(page, locale);
  await expect(page).toHaveURL(ticketUrl(locale));
  await expect(page.locator('[data-ticket]')).toBeVisible();
  return ticketIdOf(page);
}

async function openSettingsAndConfirmDelete(page: Page, locale: Locale): Promise<void> {
  await page.goto(`/${locale}/settings/`);
  await page.getByRole('button', { name: msg(locale, 'settings.delete'), exact: true }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
}

const confirmDelete = (page: Page, locale: Locale) => page.getByRole('button', { name: msg(locale, 'settings.deleteYes'), exact: true }).click();

const CASES: Record<string, (ctx: Context) => Promise<void>> = {
  async 'consent-and-ticket-redirect-while-blocked'({ page, locale }) {
    await visitOnline(page, locale);
    await triggerCrisis(page, locale);
    for (const screen of ['consent/', 'ticket/', 'consent', 'ticket', 'ticket/?id=00000000-0000-4000-8000-000000000000']) {
      await page.goto(`/${locale}/${screen}`);
      await expect(page, screen).toHaveURL(crisisUrl(locale), { timeout: 15_000 });
      await expect(page.locator('[data-screen="consent"], [data-screen="ticket"]')).toHaveCount(0);
    }
  },

  async 'consent-defaults-off-and-previews'({ page, locale }) {
    const toApi: string[] = [];
    page.on('request', (request) => {
      if (request.url().startsWith(API)) toApi.push(`${request.method()} ${new URL(request.url()).pathname}`);
    });
    await toConsent(page, locale);

    for (const element of ['scores', 'trajectory', 'conditions', 'preferences', 'free_text']) {
      await expect(page.locator(`input[data-element="${element}"]`), element).not.toBeChecked();
    }
    await expect(page.locator('[data-element="ticket"]')).toContainText(msg(locale, 'consent.needed'));
    await expect(page.locator('#use-ai')).not.toBeChecked();
    await expect(page.locator('#equity-on')).not.toBeChecked();
    await expect(page.locator('[data-panel="equity"] select')).toHaveCount(0);
    await expect(page.locator('[data-preview]')).toContainText(msg(locale, 'consent.previewTicket'));
    await expect(page.locator('[data-preview]')).not.toContainText('PHQ-9');
    // Nothing has left the phone but the unfiltered directory read.
    expect(toApi.every((entry) => entry === 'GET /services')).toBe(true);

    await tick(page, 'scores');
    await expect(page.locator('[data-preview]')).toContainText('PHQ-9 11');
    await page.locator('input[data-element="scores"]').uncheck();
    await expect(page.locator('[data-preview]')).not.toContainText('PHQ-9');
    expect(toApi.every((entry) => entry === 'GET /services')).toBe(true);
  },

  async 'ticket-sends-only-ticked-and-stores-ciphertext'({ page, locale }) {
    let body: Record<string, unknown> | null = null;
    page.on('request', (request) => {
      if (request.url() === `${API}/tickets` && request.method() === 'POST') body = JSON.parse(request.postData() ?? '{}');
    });
    await toConsent(page, locale);
    await page.locator('#note').fill('NOTE-MARKER-4471');
    await page.locator('#conditions').fill('CONDITION-MARKER-9023');
    await tick(page, 'scores');
    await send(page, locale);
    await expect(page).toHaveURL(ticketUrl(locale));

    expect(body).not.toBeNull();
    const request = body as unknown as { consents: string[]; content: Record<string, unknown>; clientRequestId: string };
    expect(request.consents).toEqual(['ticket', 'scores']);
    expect(Object.keys(request.content)).toEqual(['scores']);
    expect(JSON.stringify(request)).not.toMatch(/NOTE-MARKER|CONDITION-MARKER|answers/);

    const row = await stored(ticketIdOf(page));
    expect(row.ticket.state).toBe('issued');
    expect(row.events).toHaveLength(1);
    expect(row.bundle!.contentCiphertext).toMatch(/^v1\./);
    expect(row.bundle!.contentCiphertext).not.toMatch(/scores|phq9|NOTE-MARKER/);
    expect(Object.keys(row.bundle!.content!)).toEqual(['scores']);
    expect(row.consents.map((consent) => consent.element).sort()).toEqual(['scores', 'ticket']);

    // The ticket screen: code, QR, clinic, deadline, first step done.
    await expect(page.locator('[data-code]')).toHaveText(/^MW-[23456789A-HJKMNP-Z]{4}$/);
    await expect(page.locator('svg[data-qr]')).toBeVisible();
    await expect(page.locator('[data-clinic-contact]')).not.toBeEmpty();
    await expect(page.locator('[data-step="issued"]')).toHaveAttribute('data-done', 'true');
    await expect(page.locator('[data-step="seen"]')).toHaveAttribute('data-done', 'false');
    await expect(page.getByText(msg(locale, 'ticket.beSeenBy'))).toBeVisible();
    // And the typed note is still on the phone, not on the server.
    await page.goBack();
    await page.goto(`/${locale}/settings/`);
    await page.getByRole('button', { name: msg(locale, 'settings.download'), exact: true }).click();
    expect(await page.getByLabel(msg(locale, 'settings.dataLabel')).inputValue()).toContain('NOTE-MARKER-4471');
  },

  async 'revoke-one-then-withdraw'({ page, locale }) {
    const id = await issueTicket(page, locale, ['scores', 'free_text']);
    await expect(page.locator('[data-consent]')).toHaveCount(3);
    await page.locator('[data-consent="scores"] button').click();
    await expect(page.locator('[data-consent="scores"]')).toHaveAttribute('data-revoked', 'true');

    const afterOne = await stored(id);
    expect(Object.keys(afterOne.bundle!.content!)).toEqual(['free_text']);
    expect(afterOne.ticket.state).toBe('issued');
    expect(afterOne.consents.filter((consent) => consent.revokedAt !== null).map((consent) => consent.element)).toEqual(['scores']);

    await page.getByRole('button', { name: msg(locale, 'ticket.withdraw'), exact: true }).click();
    await page.getByRole('button', { name: msg(locale, 'ticket.withdrawYes'), exact: true }).click();
    await expect(page.getByText(msg(locale, 'ticket.withdrawnNote'))).toBeVisible();
    const afterAll = await stored(id);
    expect(afterAll.bundle).toMatchObject({ contentCiphertext: null, approvedSummaryCiphertext: null, content: null });
    expect(afterAll.bundle!.deletedAt).not.toBeNull();
    expect(afterAll.ticket.state).toBe('withdrawn');
    expect(afterAll.events.at(-1)).toMatchObject({ toState: 'withdrawn', actor: 'person' });
    expect(afterAll.consents.every((consent) => consent.revokedAt !== null)).toBe(true);
  },

  async 'day-7-yes-reaches-seen'({ page, context, locale }) {
    const id = await issueTicket(page, locale);
    await expect(page.locator('[data-prompt="follow-up"]')).toHaveCount(0);
    await context.clock.setFixedTime(new Date(Date.now() + 8 * DAY_MS));
    await page.reload();
    await expect(page.locator('[data-prompt="follow-up"]')).toBeVisible();
    await page.getByRole('button', { name: msg(locale, 'ticket.followUpYes'), exact: true }).click();
    await expect(page.locator('[data-step="seen"]')).toHaveAttribute('data-done', 'true');
    await expect(page.locator('[data-prompt="follow-up"]')).toHaveCount(0);
    const row = await stored(id);
    expect(row.ticket.state).toBe('seen');
    expect(row.events.map((event) => [event.fromState, event.toState, event.actor, event.selfConfirmed])).toEqual([
      [null, 'issued', 'person', false],
      ['issued', 'seen', 'person', true],
    ]);
  },

  async 'not-yet-reroutes-with-new-consent'({ page, context, locale }) {
    const parent = await issueTicket(page, locale, ['scores']);
    await context.clock.setFixedTime(new Date(Date.now() + 8 * DAY_MS));
    await page.reload();
    await page.getByRole('button', { name: msg(locale, 'ticket.followUpNotYet'), exact: true }).click();
    await page.locator('[data-reason="cost"]').click();
    await expect(page).toHaveURL(new RegExp(`/${locale}/options/\\?reroute=${parent}&reason=cost`));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(msg(locale, 'options.rerouteHeading'));
    await expect(page.locator('[data-tier]').first()).toBeVisible();
    await expect(page.locator('[data-tier="self_help"]')).toHaveCount(0);

    await page.locator('[data-tier][data-lead] button').click();
    await expect(page).toHaveURL(consentUrl(locale));
    await expect(page.getByText(msg(locale, 'consent.reroutingNote'))).toBeVisible();
    await send(page, locale); // nothing ticked: only the ticket element
    await expect(page).toHaveURL(ticketUrl(locale));
    const child = ticketIdOf(page);
    expect(child).not.toBe(parent);

    const childRow = await stored(child);
    expect(childRow.ticket.parentTicketId).toBe(parent);
    expect(childRow.bundle!.content).toEqual({});
    const parentRow = await stored(parent);
    expect(parentRow.ticket.state).toBe('rerouted');
    expect(parentRow.events.at(-1)).toMatchObject({ fromState: 'issued', toState: 'rerouted', actor: 'person', reason: 'cost' });
    expect(Object.keys(parentRow.bundle!.content!)).toEqual(['scores']); // the parent keeps what it had; nothing was copied
    expect(parentRow.children).toEqual([child]);
  },

  async 'delete-everything-revokes-first'({ page, context, locale }) {
    await toConsent(page, locale);
    await tick(page, 'scores');
    await page.locator('#equity-on').check();
    await page.locator('#equity-ageBand').selectOption('25_34');
    await page.locator('#equity-region').selectOption('al_ain');
    await send(page, locale);
    await expect(page).toHaveURL(ticketUrl(locale));
    const id = ticketIdOf(page);
    const { ticket } = await stored(id);
    const person = async () => (await (await fetch(`${INSPECT}/persons/${ticket.personId}`)).json()) as { equityOptIn: boolean; ageBand: string | null; region: string | null };
    expect(await person()).toMatchObject({ equityOptIn: true, ageBand: '25_34', region: 'al_ain' });

    // Offline, with data on the server: nothing is deleted, and the person is told.
    await openSettingsAndConfirmDelete(page, locale);
    await context.setOffline(true);
    await confirmDelete(page, locale);
    await expect(page.getByText(msg(locale, 'settings.blocked'))).toBeVisible({ timeout: 20_000 });
    expect((await rawStoreKeys(page)).length).toBeGreaterThan(0);
    await context.setOffline(false);
    expect((await stored(id)).ticket.state).toBe('issued');

    // Back online: the server is asked first, then the phone is wiped.
    await page.getByRole('button', { name: msg(locale, 'settings.delete'), exact: true }).click();
    await confirmDelete(page, locale);
    await expect(page.getByText(msg(locale, 'settings.deleted'), { exact: true })).toBeVisible({ timeout: 20_000 });
    const row = await stored(id);
    expect(row.ticket.state).toBe('withdrawn');
    expect(row.bundle).toMatchObject({ contentCiphertext: null, content: null });
    expect(row.consents.every((consent) => consent.revokedAt !== null)).toBe(true);
    expect(await person()).toMatchObject({ equityOptIn: false, ageBand: null, region: null });
    await expect.poll(() => rawStoreKeys(page), { timeout: 10_000 }).toEqual([]);
  },

  async 'delete-everything-offline-without-server-data'({ page, context, locale }) {
    const toApi: string[] = [];
    await visitOnline(page, locale);
    await takeCheckIn(page, locale, 'phq9', PHQ9_ELEVEN);
    await page.goto(`/${locale}/settings/`);
    await context.setOffline(true);
    page.on('request', (request) => {
      if (request.url().startsWith(API)) toApi.push(`${request.method()} ${request.url()}`);
    });
    await page.getByRole('button', { name: msg(locale, 'settings.delete'), exact: true }).click();
    await confirmDelete(page, locale);
    await expect(page.getByText(msg(locale, 'settings.deleted'), { exact: true })).toBeVisible();
    await expect.poll(() => rawStoreKeys(page), { timeout: 10_000 }).toEqual([]);
    expect(toApi).toEqual([]);
  },

  async 'delete-during-crisis-sends-the-record'({ page, context, locale }) {
    await visitOnline(page, locale);
    await context.setOffline(true);
    await triggerCrisis(page, locale);
    const eventId = await page.evaluate(() => JSON.parse(sessionStorage.getItem('mawsool.crisis-mark')!).eventId as string);
    await page.goto(`/${locale}/settings/`);
    // Holding the send back while the network returns, so the record is still unsent when the person confirms.
    await page.route(`${API}/crisis-events`, (route) => route.abort());
    await context.setOffline(false);
    await page.getByRole('button', { name: msg(locale, 'settings.delete'), exact: true }).click();
    await page.unroute(`${API}/crisis-events`);
    await confirmDelete(page, locale);
    await expect(page.getByText(msg(locale, 'settings.deleted'), { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(msg(locale, 'settings.deletedCrisisSent'))).toBeVisible();
    await expect(page.getByText(msg(locale, 'settings.deletedCrisisOpen'))).toBeVisible();
    const rows = (await (await fetch(`${INSPECT}/crisis-events/${eventId}`)).json()) as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!).filter((key) => /person|answer|score/i.test(key))).toEqual([]);
    await expect.poll(() => rawStoreKeys(page), { timeout: 10_000 }).toEqual([]);
    expect(await page.evaluate(() => sessionStorage.getItem('mawsool.crisis-mark'))).toBeNull();
  },

  async 'delete-during-crisis-offline-loses-the-record'({ page, context, locale }) {
    await visitOnline(page, locale);
    await context.setOffline(true);
    await triggerCrisis(page, locale);
    const eventId = await page.evaluate(() => JSON.parse(sessionStorage.getItem('mawsool.crisis-mark')!).eventId as string);
    await page.goto(`/${locale}/settings/`);
    await page.getByRole('button', { name: msg(locale, 'settings.delete'), exact: true }).click();
    await confirmDelete(page, locale);
    await expect(page.getByText(msg(locale, 'settings.deleted'), { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(msg(locale, 'settings.deletedCrisisLost'))).toBeVisible();
    await expect(page.getByText(msg(locale, 'settings.deletedCrisisOpen'))).toBeVisible();
    await expect.poll(() => rawStoreKeys(page), { timeout: 10_000 }).toEqual([]);
    expect(await page.evaluate(() => sessionStorage.getItem('mawsool.crisis-mark'))).toBeNull();
    await context.setOffline(false);
    await page.waitForTimeout(2000);
    expect(await (await fetch(`${INSPECT}/crisis-events/${eventId}`)).json()).toEqual([]);
  },

  async 'pending-choice-keeps-current-support'({ page, locale }) {
    await toOptions(page, locale);
    await page.getByRole('button', { name: msg(locale, 'options.showOther'), exact: true }).click();
    await page.locator('[data-tier="self_help"] button').click();
    await expect(page.getByRole('status').filter({ hasText: msg(locale, 'options.savedTitle') })).toBeVisible();
    await page.locator('[data-tier][data-lead] button').click();
    await expect(page).toHaveURL(consentUrl(locale));
    // The person leaves without sending.
    await page.goto(`/${locale}/options/`);
    await expect(page.locator('[data-tier="self_help"]')).toContainText(msg(locale, 'options.currentSupport'));
    await expect(page.locator('[data-tier="gp"]')).not.toContainText(msg(locale, 'options.currentSupport'));
  },

  async 'options-save-failure-is-shown'({ page, locale }) {
    await installFailingIndexedDb(page);
    await toOptions(page, locale);
    await setIdbMode(page, 'refuse');
    await page.locator('#plan').selectOption('thiqa');
    await expect(page.getByRole('alert').filter({ hasText: msg(locale, 'options.saveFailed') })).toBeVisible();
    await setIdbMode(page, null);
    await page.locator('#plan').selectOption('daman_basic');
    await expect(page.getByRole('alert').filter({ hasText: msg(locale, 'options.saveFailed') })).toHaveCount(0);
  },

  async 'tab-mark-exception-is-named'({ page, locale }) {
    await visitOnline(page, locale);
    await triggerCrisis(page, locale);
    const raw = await page.evaluate(() => sessionStorage.getItem('mawsool.crisis-mark'));
    const mark = JSON.parse(raw!) as Record<string, string>;
    expect(Object.keys(mark).sort()).toEqual(['eventId', 'shownAt', 'trigger']);
    expect(mark['trigger']).toBe('phq9_item9');
    expect(raw).not.toMatch(/answers|score|total|\[/);
    await page.goto(`/${locale}/settings/`);
    await expect(page.locator('[data-exception]')).toHaveText(msg(locale, 'settings.exception'));
    await expect(page.getByText(msg(locale, 'settings.intro'))).toBeVisible();
    // The note goes when the person says they are safe.
    await page.goto(`/${locale}/crisis/`);
    await page.getByRole('button', { name: msg(locale, 'crisis.safeNow'), exact: true }).click();
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem('mawsool.crisis-mark'))).toBeNull();
  },

  async 'consent-and-ticket-measure-at-390'({ page, locale }) {
    const ar = locale === 'ar';
    const h1 = { 'font-size': '24px', 'font-weight': '600', 'line-height': ar ? '34px' : '30px' };
    await toConsent(page, locale);
    expect(await computed(page, 'main h1', ['font-size', 'font-weight', 'line-height'])).toMatchObject(h1);
    expect(await computed(page, '.btn-primary', ['border-top-left-radius'])).toMatchObject({ height: 52, 'border-top-left-radius': '26px' });
    for (const row of await page.locator('label:has(input[data-element])').all()) expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await tick(page, 'scores');
    await send(page, locale);
    await expect(page).toHaveURL(ticketUrl(locale));
    await expect(page.locator('[data-ticket]')).toBeVisible();
    expect(await computed(page, 'main h1', ['font-size', 'font-weight', 'line-height'])).toMatchObject(h1);
    expect(await computed(page, '[data-code]', ['font-size', 'font-family', 'letter-spacing', 'font-weight'])).toMatchObject({ 'font-size': '28px', 'letter-spacing': '2px' });
    expect(await computed(page, '[data-code]', ['font-family'])).toMatchObject({ 'font-family': expect.stringMatching(/IBM Plex Mono/) });
    expect(await computed(page, '[data-ticket]', ['border-top-left-radius'])).toMatchObject({ 'border-top-left-radius': '18px' });
    for (const button of await page.locator('main button').all()) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  },
};

const ids = acceptance.map((entry) => entry.id);
if (JSON.stringify([...ids].sort()) !== JSON.stringify(Object.keys(CASES).sort())) {
  throw new Error(`e2e/acceptance-phase3.json and the cases in this file differ: ${ids.join(', ')} vs ${Object.keys(CASES).join(', ')}`);
}

test.describe('Phase 3 exit acceptance', () => {
  for (const entry of acceptance) {
    for (const locale of LOCALES) {
      test(`${entry.id} [${locale}]: ${entry.sentence}`, async ({ page, context }) => {
        await CASES[entry.id]!({ page, context, locale });
      });
    }
  }
});
