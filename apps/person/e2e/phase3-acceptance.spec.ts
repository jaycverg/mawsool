import { expect, test, type BrowserContext, type Page, type Request } from '@playwright/test';
import acceptance from './acceptance-phase3.json';
import {
  API,
  BASE,
  INSPECT,
  LOCALES,
  computed,
  crisisUrl,
  installFailingIndexedDb,
  msg,
  rawStoreKeys,
  setIdbMode,
  snapshot,
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
  ticket: { id: string; personId: string; shortCode: string; state: string; parentTicketId: string | null };
  events: { seq: number; fromState: string | null; toState: string; actor: string; reason: string | null; selfConfirmed: boolean }[];
  consents: { element: string; revokedAt: string | null }[];
  summaryLogs: number;
  children: string[];
  bundle: { contentCiphertext: string | null; approvedSummaryCiphertext: string | null; summaryBuiltFrom: string[]; deletedAt: string | null; content: Record<string, unknown> | null } | null;
}

async function stored(ticketId: string): Promise<Stored> {
  return (await (await fetch(`${INSPECT}/tickets/${ticketId}`)).json()) as Stored;
}

/** What the clinic at the ticket's facility is told by the bundle route and the ticket route. */
async function clinicRead(ticketId: string): Promise<{ bundle: number; ticket: number; body: string }> {
  return (await (await fetch(`${INSPECT}/clinic-read/${ticketId}`)).json()) as { bundle: number; ticket: number; body: string };
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

/**
 * Stands in for a working AI provider (the e2e API runs with the summary flag off, so it only ever returns the template):
 * a draft whose request asked for the AI comes back marked `source: 'ai'`. The request still reaches the real API, so the
 * draft is logged as it would be. No key and no provider are involved.
 */
async function answerAiDrafts(page: Page): Promise<void> {
  await page.route(`${API}/summary/draft`, async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { source: string; text: string };
    const asked = JSON.parse(route.request().postData() ?? '{}') as { useAi?: boolean };
    await route.fulfill({ response, json: asked.useAi ? { ...body, source: 'ai' } : body });
  });
}
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

  async 'summary-is-shared-only-when-approved'({ page, locale }) {
    const bodies: Record<string, unknown>[] = [];
    page.on('request', (request) => {
      if (request.url() === `${API}/tickets` && request.method() === 'POST') bodies.push(JSON.parse(request.postData() ?? '{}'));
    });
    await toConsent(page, locale);
    await page.getByRole('button', { name: msg(locale, 'consent.draft'), exact: true }).click();
    // The flag is off here, so the draft is the fill-in template, and says so.
    await expect(page.locator('[data-summary="template"]')).toBeVisible();
    await expect(page.getByText(msg(locale, 'consent.sourceTemplate'))).toBeVisible();
    await page.locator('#summary').fill('APPROVED-SUMMARY-MARKER I would like a first appointment.');
    await expect(page.getByRole('button', { name: msg(locale, 'consent.approve'), exact: true })).toBeVisible();
    await expect(page.locator('[data-preview]')).not.toContainText(msg(locale, 'consent.previewSummary'));
    await page.getByRole('button', { name: msg(locale, 'consent.approve'), exact: true }).click();
    await expect(page.getByText(msg(locale, 'consent.approved'))).toBeVisible();
    await expect(page.locator('[data-preview]')).toContainText(msg(locale, 'consent.previewSummary'));
    // Editing again withdraws the approval.
    await page.locator('#summary').fill('APPROVED-SUMMARY-MARKER I would like a first appointment soon.');
    await expect(page.getByRole('button', { name: msg(locale, 'consent.approve'), exact: true })).toBeVisible();
    await page.getByRole('button', { name: msg(locale, 'consent.approve'), exact: true }).click();
    await send(page, locale);
    await expect(page).toHaveURL(ticketUrl(locale));
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!['approvedSummary']).toBe('APPROVED-SUMMARY-MARKER I would like a first appointment soon.');
    const row = await stored(ticketIdOf(page));
    expect(row.bundle!.approvedSummaryCiphertext).toMatch(/^v1\./);
    expect(row.bundle!.approvedSummaryCiphertext).not.toContain('APPROVED-SUMMARY-MARKER');
    expect(row.summaryLogs).toBe(2); // the draft and the approved text, both linked to the ticket

    // A summary that was written but never approved is not shared.
    await page.evaluate(() => localStorage.clear());
    await page.goto(`/${locale}/options/`);
    await page.locator('[data-tier][data-lead] button').click();
    await expect(page).toHaveURL(consentUrl(locale));
    await page.getByRole('button', { name: msg(locale, 'consent.draft'), exact: true }).click();
    await page.locator('#summary').fill('NEVER-APPROVED-MARKER text');
    await send(page, locale);
    await expect(page).toHaveURL(ticketUrl(locale));
    expect(bodies).toHaveLength(2);
    expect(bodies[1]!['approvedSummary']).toBeNull();
    expect(JSON.stringify(bodies[1])).not.toContain('NEVER-APPROVED-MARKER');
    expect((await stored(ticketIdOf(page))).bundle!.approvedSummaryCiphertext).toBeNull();
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


  async 'every-earlier-ticket-is-reachable-and-withdrawable'({ page, context, locale }) {
    const parent = await issueTicket(page, locale, ['scores']);
    expect((await clinicRead(parent)).bundle).toBe(200);
    await context.clock.setFixedTime(new Date(Date.now() + 8 * DAY_MS));
    await page.reload();
    await page.getByRole('button', { name: msg(locale, 'ticket.followUpNotYet'), exact: true }).click();
    await page.locator('[data-reason="cost"]').click();
    await page.locator('[data-tier][data-lead] button').click();
    await send(page, locale);
    await expect(page).toHaveURL(ticketUrl(locale));
    const child = ticketIdOf(page);

    // The new ticket links back, and the list reaches both.
    await expect(page.locator('[data-panel="referrals"] [data-ticket-link]')).toHaveCount(2);
    expect((await page.locator('[data-earlier] a').boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.locator('[data-earlier] a').click();
    await expect(page).toHaveURL(new RegExp(`id=${parent}`));
    await expect(page.locator('[data-ticket]')).toBeVisible();
    await expect(page.locator('[data-share-ended]')).toHaveCount(0);

    // Withdrawing the earlier ticket ends its share, though the ticket itself is already terminal.
    await page.getByRole('button', { name: msg(locale, 'ticket.withdraw'), exact: true }).click();
    await page.getByRole('button', { name: msg(locale, 'ticket.withdrawYes'), exact: true }).click();
    await expect(page.locator('[data-share-ended]')).toHaveText(msg(locale, 'ticket.withdrawnNote'));
    const row = await stored(parent);
    expect(row.ticket.state).toBe('rerouted');
    expect(row.bundle).toMatchObject({ contentCiphertext: null, content: null });
    expect(await clinicRead(parent)).toMatchObject({ bundle: 410, ticket: 410 });
    // The new ticket is untouched, and its own clinic still reads it.
    expect((await clinicRead(child)).bundle).toBe(200);
    // Opening it from the list works from either ticket.
    await page.locator(`[data-ticket-link]:not([aria-current])`).click();
    await expect(page).toHaveURL(new RegExp(`id=${child}`));
  },

  async 'stopping-removes-the-summary-and-unticking-unapproves'({ page, locale }) {
    await answerAiDrafts(page);
    await toConsent(page, locale);
    await tick(page, 'scores');
    await page.locator('#use-ai').check(); // a draft the AI writes is built from what is ticked
    await page.getByRole('button', { name: msg(locale, 'consent.draft'), exact: true }).click();
    await expect(page.locator('[data-summary="ai"]')).toBeVisible();
    await page.locator('#summary').fill('SUMMARY-WORDS written with the scores in view');
    await page.getByRole('button', { name: msg(locale, 'consent.approve'), exact: true }).click();
    await expect(page.getByText(msg(locale, 'consent.approved'))).toBeVisible();
    // An element the draft used leaves: the approval goes, and coming back does not restore it.
    await page.locator('input[data-element="scores"]').uncheck();
    await expect(page.getByText(msg(locale, 'consent.approved'))).toHaveCount(0);
    await expect(page.locator('[data-stale]')).toBeVisible();
    await expect(page.locator('[data-preview]')).not.toContainText(msg(locale, 'consent.previewSummary'));
    await tick(page, 'scores');
    await expect(page.getByText(msg(locale, 'consent.approved'))).toHaveCount(0);
    await page.getByRole('button', { name: msg(locale, 'consent.approve'), exact: true }).click();
    await send(page, locale);
    await expect(page).toHaveURL(ticketUrl(locale));
    const id = ticketIdOf(page);
    expect((await stored(id)).bundle!.approvedSummaryCiphertext).toMatch(/^v1\./);
    expect((await stored(id)).summaryLogs).toBe(2);

    await page.locator('[data-consent="scores"] button').click();
    await expect(page.locator('[data-notice="summary-removed"]')).toHaveText(msg(locale, 'ticket.summaryRemoved'));
    // The notice is about sharing: it sits at the top of the sharing panel, above the list of what is shared.
    await expect(page.locator('[data-panel="sharing"] [data-notice="summary-removed"]')).toHaveCount(1);
    const noticeBox = (await page.locator('[data-notice="summary-removed"]').boundingBox())!;
    expect(noticeBox.y).toBeLessThan((await page.locator('[data-consent]').first().boundingBox())!.y);
    const after = await stored(id);
    expect(after.bundle!.approvedSummaryCiphertext).toBeNull();
    expect(after.summaryLogs).toBe(0);
    expect(Object.keys(after.bundle!.content!)).toEqual([]);
  },

  async 'stopping-an-element-keeps-a-template-summary'({ page, locale }) {
    const sent: { approvedSummary: string | null; summaryBuiltFrom: string[]; consents: string[] }[] = [];
    page.on('request', (request) => {
      if (request.url() === `${API}/tickets` && request.method() === 'POST') sent.push(JSON.parse(request.postData() ?? '{}'));
    });
    await toConsent(page, locale);
    await tick(page, 'scores');
    await page.locator('#use-ai').check(); // the box is ticked, but the flag is off here, so the draft is the fill-in template
    await page.getByRole('button', { name: msg(locale, 'consent.draft'), exact: true }).click();
    await expect(page.locator('[data-summary="template"]')).toBeVisible();
    await page.locator('#summary').fill('TYPED-BY-THE-PERSON text that no tick made');
    await page.getByRole('button', { name: msg(locale, 'consent.approve'), exact: true }).click();
    await expect(page.getByText(msg(locale, 'consent.approved'))).toBeVisible();
    // A template is built from nothing: unticking what was ticked does not unapprove it.
    await page.locator('input[data-element="scores"]').uncheck();
    await tick(page, 'scores');
    await expect(page.getByText(msg(locale, 'consent.approved'))).toBeVisible();
    await expect(page.locator('[data-stale]')).toHaveCount(0);
    await send(page, locale);
    await expect(page).toHaveURL(ticketUrl(locale));
    expect(sent[0]).toMatchObject({ approvedSummary: 'TYPED-BY-THE-PERSON text that no tick made', consents: ['ticket', 'scores'], summaryBuiltFrom: [] });
    const id = ticketIdOf(page);
    expect((await stored(id)).summaryLogs).toBe(2);

    await page.locator('[data-consent="scores"] button').click();
    await expect(page.locator('[data-consent="scores"]')).toHaveAttribute('data-revoked', 'true');
    await expect(page.locator('[data-notice="summary-removed"]')).toHaveCount(0);
    const after = await stored(id);
    expect(after.bundle!.approvedSummaryCiphertext).toMatch(/^v1\./);
    expect(after.summaryLogs).toBe(1); // the draft was logged as made from the ticked scores, so it goes with them; the typed text's own record stays
    expect(Object.keys(after.bundle!.content!)).toEqual([]);
  },

  async 'a-re-ticked-element-stays-in-what-the-summary-was-built-from'({ page, locale }) {
    const sent: { approvedSummary: string | null; summaryBuiltFrom: string[]; consents: string[] }[] = [];
    page.on('request', (request) => {
      if (request.url() === `${API}/tickets` && request.method() === 'POST') sent.push(JSON.parse(request.postData() ?? '{}'));
    });
    await answerAiDrafts(page);
    await toConsent(page, locale);
    await page.locator('#note').fill('NOTE-THE-DRAFT-USED');
    await tick(page, 'free_text');
    await page.locator('#use-ai').check();
    await page.getByRole('button', { name: msg(locale, 'consent.draft'), exact: true }).click();
    await expect(page.locator('[data-summary="ai"]')).toBeVisible();
    // The person leaves the note out, approves the summary like that, then puts the note back and sends.
    await page.locator('input[data-element="free_text"]').uncheck();
    await expect(page.locator('[data-stale]')).toBeVisible();
    await page.getByRole('button', { name: msg(locale, 'consent.approve'), exact: true }).click();
    await expect(page.getByText(msg(locale, 'consent.approved'))).toBeVisible();
    await expect(page.locator('[data-stale]')).toHaveCount(0);
    await tick(page, 'free_text');
    await expect(page.getByText(msg(locale, 'consent.approved'))).toBeVisible();
    await send(page, locale);
    await expect(page).toHaveURL(ticketUrl(locale));
    // The list keeps the note: the words in the summary may still come from it.
    expect(sent[0]).toMatchObject({ consents: ['ticket', 'free_text'], summaryBuiltFrom: ['ticket', 'free_text'] });
    const id = ticketIdOf(page);
    const before = await stored(id);
    expect([...before.bundle!.summaryBuiltFrom].sort()).toEqual(['free_text', 'ticket']);
    expect(before.bundle!.approvedSummaryCiphertext).toMatch(/^v1\./);

    await page.locator('[data-consent="free_text"] button').click();
    await expect(page.locator('[data-notice="summary-removed"]')).toHaveText(msg(locale, 'ticket.summaryRemoved'));
    const after = await stored(id);
    expect(after.bundle!.approvedSummaryCiphertext).toBeNull();
    expect(after.bundle!.summaryBuiltFrom).toEqual([]);
    expect(after.summaryLogs).toBe(0);
  },

  async 'draft-request-carries-only-what-is-allowed'({ page, locale }) {
    const drafts: { useAi: boolean; consented: string[]; content: Record<string, unknown> }[] = [];
    page.on('request', (request) => {
      if (request.url() === `${API}/summary/draft`) drafts.push(JSON.parse(request.postData() ?? '{}'));
    });
    await toConsent(page, locale);
    await page.locator('#note').fill('NOTE-MARKER-1');
    await page.locator('#conditions').fill('CONDITION-MARKER-1');
    await tick(page, 'scores');
    await tick(page, 'free_text');
    await page.getByRole('button', { name: msg(locale, 'consent.draft'), exact: true }).click();
    await expect(page.locator('#summary')).toBeVisible();
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ useAi: false, consented: ['ticket'], content: {} });
    expect(JSON.stringify(drafts[0])).not.toMatch(/NOTE-MARKER|CONDITION-MARKER|phq9/);

    await page.locator('#use-ai').check();
    await page.getByRole('button', { name: msg(locale, 'consent.draft'), exact: true }).click();
    await expect.poll(() => drafts.length).toBe(2);
    expect(drafts[1]!.useAi).toBe(true);
    expect(drafts[1]!.consented).toEqual(['ticket', 'scores', 'free_text']);
    expect(Object.keys(drafts[1]!.content).sort()).toEqual(['free_text', 'scores']);
    expect(JSON.stringify(drafts[1])).toContain('NOTE-MARKER-1');
    expect(JSON.stringify(drafts[1])).not.toContain('CONDITION-MARKER'); // typed, not ticked
  },

  async 'equity-opt-in-can-be-left'({ page, locale }) {
    const puts: Record<string, unknown>[] = [];
    page.on('request', (request) => {
      if (request.url() === `${API}/me/equity` && request.method() === 'PUT') puts.push(JSON.parse(request.postData() ?? '{}'));
    });
    await toConsent(page, locale);
    await page.locator('#equity-on').check();
    await page.locator('#equity-ageBand').selectOption('25_34');
    await send(page, locale);
    await expect(page).toHaveURL(ticketUrl(locale));
    const { ticket } = await stored(ticketIdOf(page));
    const person = async () => (await (await fetch(`${INSPECT}/persons/${ticket.personId}`)).json()) as { equityOptIn: boolean; ageBand: string | null };
    expect(await person()).toMatchObject({ equityOptIn: true, ageBand: '25_34' });
    expect(puts).toEqual([{ optIn: true, buckets: { ageBand: '25_34', gender: null, language: null, region: null } }]);

    // A later pick starts from what was chosen.
    await page.goto(`/${locale}/options/`);
    await page.locator('[data-tier][data-lead] button').click();
    await expect(page.locator('#equity-on')).toBeChecked();
    await expect(page.locator('#equity-ageBand')).toHaveValue('25_34');

    // Settings can turn it off.
    await page.goto(`/${locale}/settings/`);
    await expect(page.locator('[data-panel="equity"]')).toContainText(msg(locale, 'settings.equityOnBody'));
    await page.getByRole('button', { name: msg(locale, 'settings.equityOptOut'), exact: true }).click();
    await expect(page.getByText(msg(locale, 'settings.equityRemoved'))).toBeVisible();
    expect(puts.at(-1)).toEqual({ optIn: false });
    expect(await person()).toMatchObject({ equityOptIn: false, ageBand: null });
    await page.goto(`/${locale}/options/`);
    await page.locator('[data-tier][data-lead] button').click();
    await expect(page.locator('#equity-on')).not.toBeChecked();
    await page.goto(`/${locale}/settings/`);
    await expect(page.locator('[data-panel="equity"]')).toHaveCount(0);
  },

  async 'reads-list-and-its-failure'({ page, locale }) {
    const id = await issueTicket(page, locale);
    expect((await clinicRead(id)).bundle).toBe(200);
    await page.reload();
    await expect(page.locator('[data-reads] li')).toHaveCount(1);
    await expect(page.locator('[data-reads]')).toContainText('Sample');
    await expect(page.locator('[data-reads-failed]')).toHaveCount(0);

    await page.route('**/me/tickets/*/reads', (route) => route.abort());
    await page.reload();
    await expect(page.locator('[data-reads-failed]')).toHaveText(msg(locale, 'ticket.readsFailed'));
    await expect(page.getByText(msg(locale, 'ticket.readsNone'))).toHaveCount(0);
    await expect(page.locator('[data-reads]')).toHaveCount(0);
  },

  async 'local-failures-are-reported'({ page, context, locale }) {
    await installFailingIndexedDb(page);
    await toOptions(page, locale);
    // Choosing: both kinds of pick report a refused save and stay on the screen.
    await setIdbMode(page, 'refuse');
    await page.locator('[data-tier][data-lead] button').click();
    await expect(page.getByRole('alert').filter({ hasText: msg(locale, 'options.saveFailed') })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/${locale}/options/`));
    await setIdbMode(page, null);

    // Sending: a refused save before anything is sent is shown, and the button is usable again.
    await page.locator('[data-tier][data-lead] button').click();
    await expect(page).toHaveURL(consentUrl(locale));
    // The screen reads the phone before it shows Send; storage is refused only once it has finished, or a refused read
    // trips the crisis guard or the unreadable screen instead of the send this step is about.
    await expect(page.getByRole('button', { name: msg(locale, 'consent.send'), exact: true })).toBeEnabled();
    await setIdbMode(page, 'refuse');
    await send(page, locale);
    await expect(page.getByRole('alert').filter({ hasText: msg(locale, 'consent.localFailed') })).toBeVisible();
    await expect(page.getByRole('button', { name: msg(locale, 'consent.send'), exact: true })).toBeEnabled();
    await setIdbMode(page, null);

    // A write that fails after the server has the ticket never hides the referral.
    await page.route(`${API}/tickets`, async (route) => {
      const real = await route.fetch();
      await setIdbMode(page, 'refuse-writes');
      await route.fulfill({ response: real });
    });
    await send(page, locale);
    await expect(page).toHaveURL(/\/ticket\/\?id=.*saved=0/);
    const id = ticketIdOf(page);
    expect((await stored(id)).ticket.state).toBe('issued');
    await setIdbMode(page, null);
    await page.unroute(`${API}/tickets`);
    await page.reload();
    await expect(page.locator('[data-ticket]')).toBeVisible();
    await expect(page.getByText(msg(locale, 'ticket.savedWarning'))).toBeVisible();
    void context;
  },

  async 'withdrawn-ticket-layout-and-day-count'({ page, locale }) {
    await issueTicket(page, locale, ['scores']);
    // A 7-day promise issued today reads 7, counted in Dubai calendar days.
    const daysLeft = (await page.locator('[data-deadline]').innerText()).split('·').at(-1)!;
    expect(daysLeft).toMatch(/7/);
    expect(daysLeft).not.toMatch(/8/);
    await page.getByRole('button', { name: msg(locale, 'ticket.withdraw'), exact: true }).click();
    await page.getByRole('button', { name: msg(locale, 'ticket.withdrawYes'), exact: true }).click();
    await expect(page.locator('[data-share-ended]')).toBeVisible();
    // Nothing ahead is shown as still to come, and the deadline line has no separator left hanging.
    await expect(page.locator('[data-step][data-done="false"]')).toHaveCount(0);
    await expect(page.locator('[data-step]').last()).toHaveAttribute('data-step', 'withdrawn');
    expect((await page.locator('[data-deadline]').innerText()).trim()).not.toMatch(/·\s*$/);
    const heights = await page.locator('[data-step]').evaluateAll((nodes) => nodes.slice(0, -1).map((node) => Math.round(node.getBoundingClientRect().height)));
    expect(new Set(heights).size).toBe(1);
  },

  async 'labels-are-translated'({ page, locale }) {
    await toOptions(page, locale);
    await page.locator('details[data-panel="preferences"] summary').click();
    await page.locator('#pref-language').selectOption('ur');
    await page.locator('#pref-region').selectOption('al_ain');
    await page.locator('[data-tier][data-lead] button').click();
    await expect(page).toHaveURL(consentUrl(locale));
    await tick(page, 'preferences');
    const row = page.locator('label:has(input[data-element="preferences"])');
    await expect(row).toContainText(msg(locale, 'options.languageName.ur'));
    await expect(row).toContainText(msg(locale, 'options.regionName.al_ain'));
    await expect(row).not.toContainText(/\b(ur|al_ain)\b/);
    await page.locator('#equity-on').check();
    const labels = await page.locator('#equity-language option, #equity-region option').allInnerTexts();
    expect(labels).toContain(msg(locale, 'options.languageName.tl'));
    expect(labels).toContain(msg(locale, 'options.regionName.al_dhafra'));
    expect(labels.filter((label) => /^[a-z_]+$/.test(label))).toEqual([]);
    await expect(page.locator('main p b[dir="auto"]').first()).toBeVisible();
    await page.locator('input[data-element="preferences"]').uncheck();
    await send(page, locale);
    await expect(page).toHaveURL(ticketUrl(locale));
    await expect(page.locator('[data-clinic-contact]')).toHaveAttribute('dir', 'auto');
  },

  async 'snapshot-consent'({ page, context, locale }) {
    await context.clock.setFixedTime(new Date('2026-11-02T08:00:00+04:00'));
    await toConsent(page, locale);
    await snapshot(page, `consent-${locale}`);
  },

  async 'snapshot-ticket'({ page, context, locale }) {
    // A fixed ticket, so every date is the same in every run; the code and the QR are masked as well.
    const id = '5b5d2f6e-0a0e-4a45-9d2c-3c7e1a4e9a11';
    const ticket = {
      id, shortCode: 'MW4K7Q', qrPayload: 'MAWSOOL:TICKET:MW4K7Q', tier: 'gp', state: 'acknowledged', language: locale, deadlineAt: '2026-11-05T23:59:59+04:00', source: 'app',
      serviceId: '6c6d2f6e-0a0e-4a45-9d2c-3c7e1a4e9a22', serviceName: 'Sample primary care centre 1', clinicName: 'Sample PHC, Khalifa City', clinicContact: 'Sample clinic. Reception is open 8:00 to 16:00; ask for the referral desk.',
      parentTicketId: null, createdAt: '2026-10-29T08:00:00+04:00',
      events: [
        { seq: 1, fromState: null, toState: 'issued', actor: 'person', reason: null, selfConfirmed: false, at: '2026-10-29T08:00:00+04:00' },
        { seq: 2, fromState: 'issued', toState: 'acknowledged', actor: 'clinic', reason: null, selfConfirmed: false, at: '2026-10-30T09:00:00+04:00' },
      ],
      consents: [
        { id: '7d7d2f6e-0a0e-4a45-9d2c-3c7e1a4e9a33', element: 'ticket', recipient: 'x', grantedAt: '2026-10-29T08:00:00+04:00', revokedAt: null },
        { id: '8e8d2f6e-0a0e-4a45-9d2c-3c7e1a4e9a44', element: 'scores', recipient: 'x', grantedAt: '2026-10-29T08:00:00+04:00', revokedAt: null },
      ],
    };
    await context.clock.setFixedTime(new Date('2026-11-02T08:00:00+04:00'));
    await page.route(`${API}/me/tickets/${id}`, (route) => route.fulfill({ json: ticket }));
    await page.route(`${API}/me/tickets/${id}/reads`, (route) => route.fulfill({ json: [{ at: '2026-10-31T10:00:00+04:00', role: 'clinician', facilityName: 'Sample PHC, Khalifa City' }] }));
    await page.route(`${API}/me/tickets`, (route) => route.fulfill({ json: [ticket] }));
    await visitOnline(page, locale);
    await page.goto(`/${locale}/ticket/?id=${id}`);
    await expect(page.locator('[data-ticket]')).toBeVisible();
    await expect(page.locator('[data-reads] li')).toHaveCount(1);
    await page.evaluate(async () => document.fonts.ready);
    await expect(page).toHaveScreenshot(`ticket-${locale}.png`, { fullPage: true, mask: [page.locator('[data-code]'), page.locator('svg[data-qr]')] });
  },


  async 'approving-with-an-element-unticked-keeps-the-approval'({ page, locale }) {
    const sent: { approvedSummary: string | null; summaryBuiltFrom: string[]; consents: string[] }[] = [];
    page.on('request', (request) => {
      if (request.url() === `${API}/tickets` && request.method() === 'POST') sent.push(JSON.parse(request.postData() ?? '{}'));
    });
    const approve = (page: Page) => page.getByRole('button', { name: msg(locale, 'consent.approve'), exact: true });

    // A draft the AI wrote, the element then unticked: Approve works from that state, and the element stays out.
    await answerAiDrafts(page);
    await toConsent(page, locale);
    await tick(page, 'scores');
    await page.locator('#use-ai').check();
    await page.getByRole('button', { name: msg(locale, 'consent.draft'), exact: true }).click();
    await expect(page.locator('[data-summary="ai"]')).toBeVisible();
    await page.locator('#summary').fill('WRITTEN-WITHOUT-THE-SCORES-NOW');
    await page.locator('input[data-element="scores"]').uncheck();
    await expect(page.locator('[data-stale]')).toBeVisible();
    await approve(page).click();
    await expect(page.getByText(msg(locale, 'consent.approved'))).toBeVisible();
    await expect(page.locator('[data-stale]')).toHaveCount(0);
    await page.waitForTimeout(300); // the approval must survive the effect that watches the ticks
    await expect(page.getByText(msg(locale, 'consent.approved'))).toBeVisible();
    await send(page, locale);
    await expect(page).toHaveURL(ticketUrl(locale));
    expect(sent[0]).toMatchObject({ approvedSummary: 'WRITTEN-WITHOUT-THE-SCORES-NOW', consents: ['ticket'], summaryBuiltFrom: ['ticket'] });
    const first = await stored(ticketIdOf(page));
    expect(first.bundle!.approvedSummaryCiphertext).toMatch(/^v1\./);
    expect(first.bundle!.content).toEqual({});

    // A summary written by hand (AI box unticked) is never unapproved by a tick.
    await page.goto(`/${locale}/options/`);
    await page.locator('[data-tier][data-lead] button').click();
    await expect(page).toHaveURL(consentUrl(locale));
    await tick(page, 'scores');
    await page.locator('#use-ai').uncheck(); // the tick was kept from the last visit; this summary is written by hand
    await page.getByRole('button', { name: msg(locale, 'consent.draft'), exact: true }).click();
    await page.locator('#summary').fill('WRITTEN-BY-HAND');
    await approve(page).click();
    await page.locator('input[data-element="scores"]').uncheck();
    await page.locator('input[data-element="scores"]').check();
    await page.locator('input[data-element="scores"]').uncheck();
    await expect(page.getByText(msg(locale, 'consent.approved'))).toBeVisible();
    await expect(page.locator('[data-stale]')).toHaveCount(0);
    await send(page, locale);
    await expect(page).toHaveURL(ticketUrl(locale));
    expect(sent[1]).toMatchObject({ approvedSummary: 'WRITTEN-BY-HAND', summaryBuiltFrom: [] });
    expect((await stored(ticketIdOf(page))).bundle!.approvedSummaryCiphertext).toMatch(/^v1\./);
  },

  async 'ticket-tab-finds-a-ticket-after-a-failed-local-save'({ page, locale }) {
    await installFailingIndexedDb(page);
    await toConsent(page, locale);
    await page.route(`${API}/tickets`, async (route) => {
      const real = await route.fetch();
      await setIdbMode(page, 'refuse-writes');
      await route.fulfill({ response: real });
    });
    await send(page, locale);
    await expect(page).toHaveURL(/\/ticket\/\?id=.*saved=0/);
    const { shortCode } = (await stored(ticketIdOf(page))).ticket;
    await setIdbMode(page, null);
    await page.unroute(`${API}/tickets`);

    // The phone kept no note of the ticket, but it did give the server something: the tab asks for the list and opens the newest.
    await page.goto(`/${locale}/ticket/`);
    await expect(page.locator('[data-ticket]')).toBeVisible();
    // It is the ticket just sent, not any ticket: the code on screen is the stored ticket's short code.
    await expect(page.locator('[data-code]')).toHaveText(`${shortCode.slice(0, 2)}-${shortCode.slice(2)}`);
    await expect(page.getByText(msg(locale, 'ticket.noTicket'))).toHaveCount(0);

    // If that list cannot be had, the person is told so, never that they have no referral.
    await page.route(`${API}/me/tickets`, (route) => route.abort());
    await page.goto(`/${locale}/ticket/`);
    await expect(page.getByRole('alert').filter({ hasText: msg(locale, 'ticket.loadFailed') })).toBeVisible();
    await expect(page.getByText(msg(locale, 'ticket.noTicket'))).toHaveCount(0);

    // A phone that never shared anything makes no request for it.
    const fresh = await (await page.context().browser()!.newContext({ viewport: { width: 390, height: 844 } })).newPage();
    const asked: string[] = [];
    fresh.on('request', (request: Request) => {
      if (request.url().startsWith(API) && !(request.method() === 'GET' && new URL(request.url()).pathname === '/services')) asked.push(`${request.method()} ${new URL(request.url()).pathname}`);
    });
    await fresh.goto(`${BASE}/${locale}/ticket/`);
    await expect(fresh.getByText(msg(locale, 'ticket.noTicket'))).toBeVisible();
    await fresh.waitForTimeout(500);
    expect(asked).toEqual([]);
  },

  async 'consent-and-ticket-measure-at-390'({ page, locale }) {
    const ar = locale === 'ar';
    const h1 = { 'font-size': '24px', 'font-weight': '600', 'line-height': ar ? '34px' : '30px', color: 'rgb(16, 48, 45)' };
    const rgb = { ink: 'rgb(16, 48, 45)', muted: 'rgb(74, 95, 92)', accent: 'rgb(14, 107, 99)', white: 'rgb(255, 255, 255)', border: 'rgb(213, 223, 220)', grey: 'rgb(154, 170, 167)', tint: 'rgb(224, 240, 236)', ground: 'rgb(243, 246, 245)' };
    await toConsent(page, locale);
    expect(await computed(page, 'main h1', ['font-size', 'font-weight', 'line-height', 'color'])).toMatchObject(h1);
    expect(await computed(page, '.btn-primary', ['border-top-left-radius', 'background-color', 'color'])).toMatchObject({ height: 52, 'border-top-left-radius': '26px', 'background-color': rgb.accent, color: rgb.white });
    for (const row of await page.locator('label:has(input[data-element])').all()) expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await computed(page, 'main section:has(> div > span[data-element="ticket"])', ['background-color', 'border-top-left-radius', 'border-top-color'])).toMatchObject({ 'background-color': rgb.white, 'border-top-left-radius': '16px', 'border-top-color': rgb.border });
    expect(await computed(page, '[data-preview]', ['background-color', 'border-top-left-radius'])).toMatchObject({ 'background-color': rgb.tint, 'border-top-left-radius': '14px' });
    expect(await computed(page, 'body', ['background-color'])).toMatchObject({ 'background-color': rgb.ground });
    // The AI box: the button sits beside its text, 44 high, white, 14 px of padding, as on the board.
    const draft = page.getByRole('button', { name: msg(locale, 'consent.draft'), exact: true });
    expect(await computed(page, 'button:text-is("' + msg(locale, 'consent.draft') + '")', ['padding-left', 'padding-right', 'background-color', 'border-top-left-radius', 'color'])).toMatchObject({ height: 44, 'padding-left': '14px', 'padding-right': '14px', 'background-color': rgb.white, 'border-top-left-radius': '22px', color: rgb.accent });
    const text = (await page.getByText(msg(locale, 'consent.aiText')).boundingBox())!;
    const button = (await draft.boundingBox())!;
    expect(Math.abs(text.y + text.height / 2 - (button.y + button.height / 2))).toBeLessThan(button.height); // on one row
    expect(button.x === text.x ? 0 : 1).toBe(1);
    // The "Sample service" chip never breaks across lines.
    expect(await computed(page, '[data-sample]', ['white-space', 'display', 'background-color', 'color'])).toMatchObject({ 'white-space': 'nowrap', display: 'inline-flex', 'background-color': 'rgb(231, 228, 242)', color: 'rgb(62, 52, 112)' });
    expect((await page.locator('[data-sample]').boundingBox())!.height).toBeLessThan(40); // one line; two would be over 50
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

    await tick(page, 'scores');
    await send(page, locale);
    await expect(page).toHaveURL(ticketUrl(locale));
    await expect(page.locator('[data-ticket]')).toBeVisible();
    expect(await computed(page, 'main h1', ['font-size', 'font-weight', 'line-height', 'color'])).toMatchObject(h1);
    expect(await computed(page, '[data-code]', ['font-size', 'font-family', 'letter-spacing', 'font-weight', 'color'])).toMatchObject({ 'font-size': '28px', 'letter-spacing': '2px', 'font-weight': '600', color: rgb.white });
    expect(await computed(page, '[data-code]', ['font-family'])).toMatchObject({ 'font-family': expect.stringMatching(/IBM Plex Mono/) });
    expect(await computed(page, '[data-ticket]', ['border-top-left-radius', 'background-color', 'border-top-color'])).toMatchObject({ 'border-top-left-radius': '18px', 'background-color': rgb.white, 'border-top-color': rgb.border });
    expect(await computed(page, '[data-ticket] > div:first-child', ['background-color'])).toMatchObject({ 'background-color': rgb.accent });
    // The mock directory is labelled on the ticket too, in the same chip.
    await expect(page.locator('[data-ticket] [data-sample]')).toHaveText(msg(locale, 'ticket.sample'));
    expect(await computed(page, '[data-ticket] [data-sample]', ['background-color', 'color', 'white-space'])).toMatchObject({ 'background-color': 'rgb(231, 228, 242)', color: 'rgb(62, 52, 112)', 'white-space': 'nowrap' });
    // The QR box is 84 of code and 4 of white on each side: 92 square.
    expect(await computed(page, 'svg[data-qr]', ['padding-top', 'background-color', 'border-top-left-radius'])).toMatchObject({ width: 92, height: 92, 'padding-top': '4px', 'background-color': rgb.white, 'border-top-left-radius': '8px' });
    expect((await page.locator('svg[data-qr]').getAttribute('width'))).toBe('84');
    // The deadline line has a 6 px gap and the clock icon.
    expect(await computed(page, '[data-deadline]', ['column-gap'])).toMatchObject({ 'column-gap': '6px' });
    await expect(page.locator('[data-deadline] svg circle')).toHaveCount(1);
    // Timeline: done badges 24, the next step a 20 px ring in the brand colour, the rest grey with muted titles.
    expect(await computed(page, '[data-step][data-done="true"] > div:first-child > span:first-child', [])).toMatchObject({ width: 24, height: 24 });
    const next = page.locator('[data-step][data-pending="next"]');
    expect(await computed(page, '[data-step][data-pending="next"] > div:first-child > span:first-child', ['border-top-width', 'border-top-color'])).toMatchObject({ width: 24, height: 24, 'border-top-width': '2px', 'border-top-color': rgb.accent });
    expect(await computed(page, '[data-step][data-pending="later"] > div:first-child > span:first-child', ['border-top-color'])).toMatchObject({ width: 24, height: 24, 'border-top-color': rgb.grey });
    expect(await computed(page, '[data-step][data-pending="later"] > div:last-child > div:first-child', ['color'])).toMatchObject({ color: rgb.muted });
    expect(await computed(page, '[data-step][data-pending="next"] > div:last-child > div:first-child', ['color'])).toMatchObject({ color: rgb.ink });
    await expect(next).toHaveCount(1);
    // Change option and Decline: 48 high, 24 radius, 15 px.
    for (const name of [msg(locale, 'ticket.changeOption'), msg(locale, 'ticket.decline')]) {
      expect(await computed(page, `button:text-is("${name}")`, ['border-top-left-radius', 'font-size'])).toMatchObject({ height: 48, 'border-top-left-radius': '24px', 'font-size': '15px' });
    }
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
