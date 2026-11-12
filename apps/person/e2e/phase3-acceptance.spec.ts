import { type BrowserContext, type Page, type Request, type Route } from '@playwright/test';
import { expect, test, type ConsoleGuard } from './fixtures';
import acceptance from './acceptance-phase3.json';
import {
  API,
  BASE,
  INSPECT,
  LOCALES,
  answerAll,
  ANONYMOUS_DB_PREFIX,
  anonymousDb,
  computed,
  crisisUrl,
  escapeRe,
  finishButton,
  goOffline,
  installFailingIndexedDb,
  msg,
  pageStorage,
  rawStoreKeys,
  setIdbMode,
  snapshot,
  takeCheckIn,
  tapOwners,
  triggerCrisis,
  visitOnline,
  waitForStored,
  watchNavigationRequests,
  type IdbMode,
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
  /** Where a test that makes a request fail on purpose names the failure; nothing else is excused. */
  consoleGuard: ConsoleGuard;
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

/** A message with its rich-text tags removed, as the person reads it. */
const plain = (text: string) => text.replace(/<\/?\w+>/g, '');

/** The reminder numbers the API holds, as the inspect listener shows them: the raw ciphertext and the number decrypted with the harness's key. */
async function storedReminderNumbers(): Promise<{ personId: string; intervalWeeks: number; ciphertext: string; phone: string }[]> {
  return (await (await fetch(`${INSPECT}/reminder-phones`)).json()) as { personId: string; intervalWeeks: number; ciphertext: string; phone: string }[];
}

const SEEN_TICKET_ID = '9a9d2f6e-0a0e-4a45-9d2c-3c7e1a4e9b11';
const SEEN_AT_MS = Date.parse('2026-10-01T10:00:00+04:00');
const SIX_WEEKS_MS = 42 * DAY_MS;
/** The moment the repeat check opens for the ticket the stub serves: the exact value every start link must carry as `since`. */
const OPENS_MS = SEEN_AT_MS + SIX_WEEKS_MS;

/**
 * Makes the real server hold the statistics choice for the person whose request this is, as the send would have if the ticket were
 * real (the ticket is a stub, so the real route would not know it). The server's own state, not a faked answer, is then what the
 * phone's later reads of its choices see.
 */
async function serverCountsTheChoice(route: Route): Promise<void> {
  const authorization = route.request().headers().authorization;
  const response = await fetch(`${API}/me/outcome-statistics`, { method: 'PUT', headers: { authorization: authorization!, 'content-type': 'application/json' }, body: JSON.stringify({ optIn: true }) });
  expect(response.ok).toBe(true);
}

/**
 * A ticket the clinic saw on 1 October, as the API serves it, for the screens that depend on a date six weeks on: the API's
 * own clock cannot be moved outside the demo gate, and the server's side of the six weeks has its own tests. `ticketConsentLive`
 * false stands for a share the person ended.
 */
async function stubSeenTicket(page: Page, locale: Locale, ticketConsentLive = true): Promise<string> {
  const id = SEEN_TICKET_ID;
  const ticket = {
    id, shortCode: 'MW4K7Q', qrPayload: 'MAWSOOL:TICKET:MW4K7Q', tier: 'gp', state: 'seen', language: locale, deadlineAt: '2026-10-08T23:59:59+04:00', source: 'app',
    serviceId: '6c6d2f6e-0a0e-4a45-9d2c-3c7e1a4e9a22', serviceName: 'Sample primary care centre 1', clinicName: 'Sample PHC, Khalifa City', clinicContact: 'Sample clinic.',
    parentTicketId: null, createdAt: '2026-09-28T08:00:00+04:00',
    events: [
      { seq: 1, fromState: null, toState: 'issued', actor: 'person', reason: null, selfConfirmed: false, at: '2026-09-28T08:00:00+04:00' },
      { seq: 2, fromState: 'issued', toState: 'seen', actor: 'clinic', reason: null, selfConfirmed: false, at: new Date(SEEN_AT_MS).toISOString() },
    ],
    consents: [{ id: '7d7d2f6e-0a0e-4a45-9d2c-3c7e1a4e9a33', element: 'ticket', recipient: 'x', grantedAt: '2026-09-28T08:00:00+04:00', revokedAt: ticketConsentLive ? null : '2026-10-02T08:00:00+04:00' }],
  };
  await page.route(`${API}/me/tickets/${id}?locale=${locale}`, (route) => route.fulfill({ json: ticket }));
  await page.route(`${API}/me/tickets/${id}/reads?locale=${locale}`, (route) => route.fulfill({ json: [] }));
  await page.route(`${API}/me/tickets?locale=${locale}`, (route) => route.fulfill({ json: [ticket] }));
  return id;
}

/** The repeat check taken through the screens: the PHQ-9 and the GAD-7, every answer "not at all", ending on the totals. */
async function takeRepeatCheck(page: Page, locale: Locale, id: string): Promise<void> {
  await page.getByRole('link', { name: msg(locale, 'ticket.remeasureStart'), exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/${locale}/check-in/\\?i=phq9&rm=${id}&since=${OPENS_MS}$`));
  await expect(page.locator('[data-repeat-step]')).toHaveText(msg(locale, 'checkIn.repeatStep').replace('{current}', '1').replace('{total}', '2'));
  await answerAll(page, locale, [0, 0, 0, 0, 0, 0, 0, 0, 0]);
  await page.getByRole('button', { name: msg(locale, 'flow.next'), exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/${locale}/check-in/\\?i=gad7&rm=${id}&p=[0-9a-f-]{36}&since=${OPENS_MS}$`));
  await answerAll(page, locale, [0, 0, 0, 0, 0, 0, 0]);
  await page.getByRole('button', { name: msg(locale, 'checkIn.finishRepeat'), exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/${locale}/remeasure/\\?id=${id}&p=[0-9a-f-]{36}&g=[0-9a-f-]{36}`));
  await expect(page.locator('[data-totals]')).toBeVisible();
}

const LATIN = /[A-Za-z]/;
const ARABIC = /[؀-ۿ]/;

/** The part of the decline words that says the clinic can still read what was shared, which must stay in the copy in each language. */
const STILL_READABLE: Record<Locale, string> = { en: 'can still read what you shared', ar: 'الاطلاع على ما شاركتَه' };

/** The ticket declined from the confirm box that Decline or "I don't want this any more" opens, and what the screen then says. */
async function expectDeclineWords(page: Page, locale: Locale, id: string): Promise<void> {
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText(plain(msg(locale, 'ticket.declineConfirm')));
  await expect(dialog).toContainText(STILL_READABLE[locale]);
  // The words name what is still true, and point at the control that ends it.
  const link = dialog.locator('[data-stop-sharing-link]');
  await expect(link).toHaveCount(1);
  await expect(link).toHaveAttribute('href', '#sharing');
  // Body text: 15 px on 22 in English and 24 in Arabic. The link is a 44 px target, as every control is.
  expect(await computed(page, '#decline-text', ['font-size', 'line-height'])).toMatchObject({ 'font-size': '15px', 'line-height': locale === 'ar' ? '24px' : '22px' });
  expect((await computed(page, '#decline-text [data-stop-sharing-link]', [])).height).toBeGreaterThanOrEqual(44);
  // The link's 44 px target is padding, so its box reaches under "Yes, decline" below it. Asked of the browser pixel by pixel: the
  // destructive button wins every pixel it shares with the link and loses none of its own, and the link answers everywhere
  // above it. What the link keeps is 40 px in English and 42 in Arabic, not the 44 its box measures: the button covers the rest.
  const taps = await tapOwners(page, '#decline-text [data-stop-sharing-link]', '[role="alertdialog"] button.bg-danger');
  expect(taps.ownerBox, 'the link box').toBeGreaterThanOrEqual(44);
  // The link answers from its top, then "Yes, decline" answers for every row they share: never the link on top of the button, never a gap.
  expect(taps.rows, 'who answers at each row of the link, from its top').toMatch(/^O+B+$/);
  expect(taps.otherLost, 'the button keeps every pixel of its own').toBe(0);
  expect(taps.rows.replaceAll('B', '').length, 'what a finger reaches of the link').toBeGreaterThanOrEqual(40);
  await page.getByRole('button', { name: msg(locale, 'ticket.declineYes'), exact: true }).click();

  await expect(page.locator('[data-step="declined"]')).toHaveAttribute('data-done', 'true');
  const row = await stored(id);
  expect(row.ticket.state).toBe('declined');
  expect(row.events.map((event) => [event.fromState, event.toState, event.actor])).toEqual([
    [null, 'issued', 'person'],
    ['issued', 'declined', 'person'],
  ]);
  const note = page.locator('[data-declined-note]');
  await expect(note).toContainText(plain(msg(locale, 'ticket.declinedNote')));
  await expect(note).toContainText(STILL_READABLE[locale]);
  // The board's tinted note is 14 px on 20, and its link is a 44 px target too.
  expect(await computed(page, '[data-declined-note]', ['font-size', 'line-height'])).toMatchObject({ 'font-size': '14px', 'line-height': '20px' });
  expect((await computed(page, '[data-declined-note] [data-stop-sharing-link]', [])).height).toBeGreaterThanOrEqual(44);
  // The copy is true: the clinic can still open what was shared.
  expect((await clinicRead(id)).bundle).toBe(200);

  // The link in the note goes to the sharing panel, which holds the real control; using it ends the share.
  await note.locator('[data-stop-sharing-link]').click();
  await expect(page).toHaveURL(/#sharing$/);
  await expect(page.locator('[data-panel="sharing"]')).toBeInViewport();
  await page.getByRole('button', { name: msg(locale, 'ticket.withdraw'), exact: true }).click();
  await page.getByRole('button', { name: msg(locale, 'ticket.withdrawYes'), exact: true }).click();
  await expect(page.locator('[data-share-ended]')).toBeVisible();
  await expect(page.locator('[data-declined-note]')).toHaveCount(0);
  expect((await clinicRead(id)).bundle).toBe(410);
  expect((await stored(id)).ticket.state).toBe('declined');
}

/** What the test saw of the API origin. Once `blocking` is set every request to it is refused as well as counted. */
interface ApiWatch {
  blocking: boolean;
  hits: string[];
}

async function watchApi(context: BrowserContext): Promise<ApiWatch> {
  const watch: ApiWatch = { blocking: false, hits: [] };
  context.on('request', (request) => {
    if (watch.blocking && request.url().startsWith(API)) watch.hits.push(`${request.method()} ${request.url()}`);
  });
  await context.route(
    (url) => url.href.startsWith(API),
    (route) => (watch.blocking ? route.abort() : route.continue()),
  );
  return watch;
}

/**
 * An ordinary first visit, then the explicit choice of an anonymous session from the home screen. The API is watched from the
 * moment the choice is made: the visit before it is an ordinary one, so the app's background reads belong to it and are let through.
 */
async function startAnonymous(page: Page, locale: Locale, watch: ApiWatch): Promise<void> {
  await visitOnline(page, locale);
  await page.waitForLoadState('networkidle');
  await page.locator('[data-anonymous-offer] a').click();
  await expect(page).toHaveURL(new RegExp(`^${escapeRe(BASE)}/${locale}/anonymous/$`));
  await expect(page.locator('[data-anonymous-state="off"]')).toBeVisible();
  await page.waitForLoadState('networkidle');
  watch.blocking = true;
  await page.locator('[data-anonymous-start]').click();
  await expect(page).toHaveURL(new RegExp(`^${escapeRe(BASE)}/${locale}/$`));
  await expect(page.locator('[data-anonymous-banner]')).toContainText(msg(locale, 'anonymous.banner'));
}

/** The rows an anonymous session's database holds: the check-ins as ciphertext, and the key that opens them. */
const ANONYMOUS_DB_ROWS = ['__device-key', 'screenings'];

/** The tab's note for the session: a random id and nothing else. */
const ANONYMOUS_NOTE = /^\{"session":"[0-9a-f-]{36}"\}$/;

const ANONYMOUS_CASES: Record<string, (ctx: Context) => Promise<void>> = {
  async 'anonymous-session-makes-no-request-to-the-api'({ page, context, locale }) {
    const api = await watchApi(context);
    await startAnonymous(page, locale, api);

    // A check-in, its result and a reload of it: all on the phone, in this tab only.
    await takeCheckIn(page, locale, 'phq9', PHQ9_ELEVEN);
    await expect(page.locator('[data-score]')).toHaveText('11');
    await expect(page.locator('[data-anonymous-result-note]')).toContainText(msg(locale, 'anonymous.resultNote'));
    await expect(page.getByRole('link', { name: msg(locale, 'result.options'), exact: true })).toHaveCount(0);
    const resultUrl = page.url();
    await page.reload();
    await expect(page.locator('[data-score]')).toHaveText('11');
    await expect(page.locator('[data-anonymous-banner]')).toBeVisible();
    expect(Object.keys((await anonymousDb(page)).rows).sort()).toEqual(ANONYMOUS_DB_ROWS);

    // The device store holds none of what a server relationship leaves behind.
    const keys = await rawStoreKeys(page);
    for (const key of ['screenings', 'identity', 'server:footprint', 'crisis:outbox', 'tickets']) expect(keys, key).not.toContain(key);

    // Home no longer offers the choice, and Settings offers the way out and none of the server's panels.
    await page.goto(`/${locale}/`);
    await expect(page.locator('[data-anonymous-offer]')).toHaveCount(0);
    await page.goto(`/${locale}/settings/`);
    await expect(page.locator('[data-panel="anonymous"]')).toContainText(msg(locale, 'anonymous.settingsBody'));
    await expect(page.locator('[data-panel="reminders"]')).toHaveCount(0);

    // Leaving is explicit, and erases the session's results from the tab.
    await page.goto(`/${locale}/anonymous/`);
    await expect(page.locator('[data-anonymous-state="on"]')).toBeVisible();
    await page.locator('[data-anonymous-leave]').click();
    await expect(page.locator('[data-anonymous-confirm]')).toContainText(msg(locale, 'anonymous.leaveConfirm'));
    expect(Object.keys((await anonymousDb(page)).rows).sort()).toEqual(ANONYMOUS_DB_ROWS);
    // Not one request to the API from the choice to here. Leaving ends the session, so what follows is an ordinary visit.
    expect(api.hits).toEqual([]);
    api.blocking = false;
    const directory = page.waitForResponse((response) => response.url() === `${API}/services?locale=${locale}` && response.ok());
    await page.locator('[data-anonymous-leave-yes]').click();
    await expect(page).toHaveURL(new RegExp(`^${escapeRe(BASE)}/${locale}/$`));
    await directory;
    await expect(page.locator('[data-anonymous-banner]')).toHaveCount(0);
    await expect(page.locator('[data-anonymous-offer]')).toBeVisible();
    expect((await anonymousDb(page)).exists).toBe(false);
    expect((await pageStorage(page)).session['mawsool.anonymous']).toBeUndefined();
    await page.goto(resultUrl);
    await expect(page.getByText(msg(locale, 'result.notFound'), { exact: true })).toBeVisible();
  },

  async 'anonymous-session-says-what-it-cannot-do-and-walls-the-screens-that-need-the-server'({ page, context, locale }) {
    const api = await watchApi(context);
    await startAnonymous(page, locale, api);
    await page.goto(`/${locale}/anonymous/`);
    for (const key of ['works1', 'works2', 'cannot1', 'cannot2', 'cannot3', 'keeps']) await expect(page.locator('main')).toContainText(msg(locale, `anonymous.${key}`));

    for (const screen of ['options', 'consent', 'ticket', 'claim', 'tamm', 'remeasure', 'next-day']) {
      await page.goto(`/${locale}/${screen}/`);
      const wall = page.locator('[data-anonymous-wall]');
      await expect(wall, screen).toBeVisible();
      await expect(wall.getByRole('heading', { level: 1 })).toHaveText(msg(locale, 'anonymous.wallTitle'));
      for (const key of ['cannot1', 'cannot2', 'cannot3']) await expect(wall).toContainText(msg(locale, `anonymous.${key}`));
      // Nothing of the screen itself rendered, so nothing on it could have started a request.
      await expect(page.locator('[data-tier], [data-screen="consent"], [data-screen="ticket"]'), screen).toHaveCount(0);
    }
    await page.reload();
    await expect(page.locator('[data-anonymous-wall]')).toBeVisible();
    expect(api.hits).toEqual([]);
  },

  async 'anonymous-banner-link-is-a-touch-target-and-adds-no-scroll-to-a-short-screen'({ page, context, locale }) {
    await page.setViewportSize({ width: 390, height: 844 });
    const api = await watchApi(context);
    await startAnonymous(page, locale, api);
    const link = page.locator('[data-anonymous-banner] a');
    await expect(link).toHaveAttribute('href', `/${locale}/anonymous/`);
    const box = (await link.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(44);
    // The banner takes its height out of the screen below it: a screen that fits the viewport still fits with the banner on.
    for (const screen of ['', 'options/', 'check-ins/']) {
      await page.goto(`/${locale}/${screen}`);
      await expect(page.locator('[data-anonymous-banner]')).toBeVisible();
      const extra = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
      expect(extra, `${screen || 'home'} scrolls by`).toBeLessThanOrEqual(0);
    }
    expect(api.hits).toEqual([]);
  },

  async 'anonymous-result-note-link-is-a-touch-target'({ page, context, locale }) {
    await page.setViewportSize({ width: 390, height: 844 });
    const api = await watchApi(context);
    await startAnonymous(page, locale, api);
    await takeCheckIn(page, locale, 'phq9', PHQ9_ELEVEN);
    const note = page.locator('[data-anonymous-result-note]');
    await expect(note).toContainText(msg(locale, 'anonymous.resultNote'));
    const link = note.locator('a');
    await expect(link).toHaveText(msg(locale, 'anonymous.bannerLink'));
    await expect(link).toHaveAttribute('href', `/${locale}/anonymous/`);
    const box = (await link.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scroll at 390 px').toBe(true);
    expect(api.hits).toEqual([]);
  },

  async 'anonymous-crisis-is-kept-on-the-phone-never-sent-and-removed-by-delete-everything'({ page, context, locale }) {
    const api = await watchApi(context);
    await startAnonymous(page, locale, api);
    const navigations = await watchNavigationRequests(page);
    await triggerCrisis(page, locale);
    const eventId = await page.evaluate(() => JSON.parse(sessionStorage.getItem('mawsool.crisis-mark')!).eventId as string);

    // The crisis screen is as ever: every number, the call, "did you reach someone", and no hand-off panel.
    for (const number of ['800725462', '998', '999']) await expect(page.locator(`a[href="tel:${number}"]`)).toBeVisible();
    await expect(page.locator('[data-anonymous-banner]')).toHaveCount(0);
    await expect(page.locator('[data-panel="crisis-handoff"]')).toHaveCount(0);
    await page.getByRole('button', { name: msg(locale, 'crisis.callNow'), exact: true }).click();
    expect(navigations.urls().some((url) => url.startsWith('tel:'))).toBe(true);
    await page.getByRole('button', { name: msg(locale, 'crisis.reachedYes'), exact: true }).click();
    await expect(page.getByText(msg(locale, 'crisis.reachedThanks'), { exact: true })).toBeVisible();

    // The block stays on the phone across a reload, and the event is neither sent nor queued.
    await waitForStored(page, 'crisis:block');
    await page.reload();
    await expect(page).toHaveURL(crisisUrl(locale));
    expect(await rawStoreKeys(page)).not.toContain('crisis:outbox');
    await page.getByRole('button', { name: msg(locale, 'crisis.safeNow'), exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`^${escapeRe(BASE)}/${locale}/result/\\?id=[0-9a-f-]{36}$`));
    await page.waitForTimeout(1500);
    expect(await (await fetch(`${INSPECT}/crisis-events/${eventId}`)).json()).toEqual([]);

    // Delete everything in the session wipes the check-ins and the crisis block, and asks nothing of the server.
    await page.goto(`/${locale}/settings/`);
    await expect(page.getByText(msg(locale, 'anonymous.deleteBody'), { exact: true })).toBeVisible();
    await page.getByRole('button', { name: msg(locale, 'settings.delete'), exact: true }).click();
    await confirmDelete(page, locale);
    await expect(page.getByText(msg(locale, 'settings.deleted'), { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => rawStoreKeys(page), { timeout: 10_000 }).not.toContain('crisis:block');
    expect((await anonymousDb(page)).exists).toBe(false);
    expect(await page.evaluate(() => sessionStorage.getItem('mawsool.crisis-mark'))).toBeNull();
    expect(api.hits).toEqual([]);
  },
};

/** The phone is in an anonymous session and the browser's storage fails when the trigger answer arrives. */
async function anonymousCrisisWithFailingStorage({ page, context, locale }: Context, mode: IdbMode): Promise<void> {
  const api = await watchApi(context);
  await installFailingIndexedDb(page);
  await startAnonymous(page, locale, api);
  await page.goto(`/${locale}/check-in/?i=phq9`);
  await answerAll(page, locale, [0, 0, 0, 0, 0, 0, 0, 0]);
  await page.getByRole('button', { name: msg(locale, 'flow.next'), exact: true }).click();
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '9');

  await setIdbMode(page, mode);
  await page.locator('input[type="radio"][value="1"]').click();
  await expect(page).toHaveURL(crisisUrl(locale), { timeout: 15_000 });
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(msg(locale, 'crisis.heading'));
  for (const number of ['800725462', '998', '999']) await expect(page.locator(`a[href="tel:${number}"]`)).toBeVisible();

  // The block holds for the rest of the tab, with the anonymous database failing: Back, a direct visit, a reload.
  await page.goBack();
  await expect(page).toHaveURL(crisisUrl(locale), { timeout: 15_000 });
  for (const screen of ['options', 'check-in', 'result']) {
    await page.goto(`/${locale}/${screen}/`);
    await expect(page).toHaveURL(crisisUrl(locale), { timeout: 15_000 });
  }
  await page.reload();
  await expect(page).toHaveURL(crisisUrl(locale));

  // The person is not trapped: "I'm safe right now" releases the block whatever the storage does.
  await page.getByRole('button', { name: msg(locale, 'crisis.safeNow'), exact: true }).click();
  await expect(page).not.toHaveURL(crisisUrl(locale), { timeout: 15_000 });
  expect(api.hits).toEqual([]);
}

const ANONYMOUS_STORAGE_CASES: Record<string, (ctx: Context) => Promise<void>> = {
  async 'anonymous-check-ins-and-results-stay-out-of-plain-text-storage'({ page, context, locale }) {
    const api = await watchApi(context);
    await startAnonymous(page, locale, api);

    /** Nothing the person answered or was told is in the tab's page storage; the only plain notes are the session id and, once a crisis is open, its mark. */
    const expectNoHealthDataInPlainText = async (stage: string, crisisOpen: boolean) => {
      const { session, local } = await pageStorage(page);
      expect(local, `${stage}: localStorage`).toEqual({});
      expect(Object.keys(session).sort(), `${stage}: sessionStorage`).toEqual(crisisOpen ? ['mawsool.anonymous', 'mawsool.crisis-mark'] : ['mawsool.anonymous']);
      expect(session['mawsool.anonymous'], stage).toMatch(ANONYMOUS_NOTE);
      if (crisisOpen) expect(Object.keys(JSON.parse(session['mawsool.crisis-mark']!) as object).sort(), stage).toEqual(['anonymous', 'eventId', 'shownAt', 'trigger']);
      if (crisisOpen) {
        const markNote = JSON.parse(session['mawsool.crisis-mark']!) as { trigger: string; eventId: string; shownAt: string; anonymous: boolean };
        expect(markNote.anonymous, stage).toBe(true);
        expect(['phq9_item9', 'cssrs'], stage).toContain(markNote.trigger);
        expect(markNote.eventId, stage).toMatch(/^[0-9a-f-]{36}$/);
        expect(new Date(markNote.shownAt).toISOString(), stage).toBe(markNote.shownAt);
      }
      const everything = JSON.stringify({ session: { 'mawsool.anonymous': session['mawsool.anonymous'] }, local }).toLowerCase();
      for (const word of ['score', 'total', 'band', 'answer', 'phq9', 'gad7', 'who5', 'moderate', 'severe', 'screening']) expect(everything, `${stage}: ${word}`).not.toContain(word);
    };

    // Part way through a check-in, with answers given.
    await page.goto(`/${locale}/check-in/?i=phq9`);
    await answerAll(page, locale, PHQ9_ELEVEN);
    await expectNoHealthDataInPlainText('check-in', false);

    // Finished, on the result and after a reload of it: the database holds them as ciphertext under a key no script can read.
    await finishButton(page, locale).click();
    await expect(page.locator('[data-score]')).toHaveText('11');
    await expectNoHealthDataInPlainText('result', false);
    await page.reload();
    await expect(page.locator('[data-score]')).toHaveText('11');
    await expectNoHealthDataInPlainText('result after reload', false);
    const db = await anonymousDb(page);
    expect(db.rows['screenings']).toEqual({ kind: 'sealed', fields: ['ct', 'iv', 'v'] });
    expect(db.rows['__device-key']).toEqual({ kind: 'key', extractable: false });
    // The database's name is the only other plain trace of the session: its prefix and the same random id as the tab's note.
    const sessionId = (JSON.parse((await pageStorage(page)).session['mawsool.anonymous']!) as { session: string }).session;
    expect(db.name).toBe(`${ANONYMOUS_DB_PREFIX}${sessionId}`);

    // A crisis in the session: the mark names the trigger, an event id and a time, and still no answer or score is in plain text.
    await triggerCrisis(page, locale);
    await expectNoHealthDataInPlainText('crisis screen', true);
    expect(api.hits).toEqual([]);
  },

  async 'anonymous-store-and-key-are-deleted-on-leaving-on-delete-everything-and-on-a-new-tab-session'({ page, context, locale }) {
    // Every deletion of a database is logged in the tab, with the address of the page that asked, so that a database found gone is
    // known to have been deleted by the path under test and not by a later start of the app.
    await context.addInitScript(() => {
      const original = IDBFactory.prototype.deleteDatabase;
      IDBFactory.prototype.deleteDatabase = function (this: IDBFactory, name: string) {
        const log = JSON.parse(sessionStorage.getItem('e2e.deletes') ?? '[]') as string[];
        sessionStorage.setItem('e2e.deletes', JSON.stringify([...log, `${location.pathname} ${name}`]));
        return original.call(this, name);
      };
    });
    const deletesBy = async (target: Page) => JSON.parse((await pageStorage(target)).session['e2e.deletes'] ?? '[]') as string[];
    const api = await watchApi(context);
    await startAnonymous(page, locale, api);
    const checkIn = async (target: Page) => {
      await takeCheckIn(target, locale, 'phq9', PHQ9_ELEVEN);
      await expect(target.locator('[data-score]')).toHaveText('11');
      expect(Object.keys((await anonymousDb(target)).rows).sort()).toEqual(ANONYMOUS_DB_ROWS);
    };

    // Delete everything: the database goes, ciphertext and key with it, and the session carries on with a new, empty one.
    await checkIn(page);
    await page.goto(`/${locale}/settings/`);
    await page.getByRole('button', { name: msg(locale, 'settings.delete'), exact: true }).click();
    await confirmDelete(page, locale);
    await expect(page.getByText(msg(locale, 'settings.deleted'), { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect.poll(async () => (await anonymousDb(page)).exists, { timeout: 10_000 }).toBe(false);
    expect((await deletesBy(page)).some((entry) => entry.startsWith(`/${locale}/settings/ ${ANONYMOUS_DB_PREFIX}`))).toBe(true);

    // A session that is still open is not deleted by another tab's start of the app: its page holds the session's lock. That start
    // is an ordinary visit, so the API may be asked.
    await checkIn(page);
    expect(api.hits).toEqual([]);
    api.blocking = false;
    const next = await context.newPage();
    await next.goto(`/${locale}/`);
    await next.waitForLoadState('networkidle');
    await next.waitForTimeout(3_000); // longer than the grace a start gives a reloading page before it deletes anything
    expect((await anonymousDb(next)).exists).toBe(true);
    expect(await deletesBy(next)).toEqual([]);
    api.blocking = true;
    await page.reload();
    await expect(page.locator('[data-score]')).toHaveText('11');
    expect(api.hits).toEqual([]);

    // A new tab session: the tab closed without a chance to wipe, its lock is gone, and the next start of the app in any tab deletes
    // what it left.
    await page.close();
    api.blocking = false;
    await next.goto(`/${locale}/`);
    await expect.poll(async () => (await anonymousDb(next)).exists, { timeout: 15_000 }).toBe(false);
    expect((await deletesBy(next)).some((entry) => entry.startsWith(`/${locale}/ ${ANONYMOUS_DB_PREFIX}`))).toBe(true);

    // Leaving the session: the page that asked to leave is the one that deleted the database, before the next page's start.
    await startAnonymous(next, locale, api);
    await checkIn(next);
    await next.goto(`/${locale}/anonymous/`);
    await next.locator('[data-anonymous-leave]').click();
    await expect(next.locator('[data-anonymous-confirm]')).toBeVisible();
    expect(api.hits).toEqual([]);
    api.blocking = false;
    const directory = next.waitForResponse((response) => response.url() === `${API}/services?locale=${locale}` && response.ok());
    const deletesBefore = (await deletesBy(next)).length;
    await next.locator('[data-anonymous-leave-yes]').click();
    await expect(next).toHaveURL(new RegExp(`^${escapeRe(BASE)}/${locale}/$`));
    await directory;
    // The first deletion after the press was asked for by the leave screen itself, not by the start of the page that follows it.
    expect((await deletesBy(next)).slice(deletesBefore)[0]).toMatch(new RegExp(`^/${locale}/anonymous/ ${ANONYMOUS_DB_PREFIX}`));
    expect((await anonymousDb(next)).exists).toBe(false);
    expect((await pageStorage(next)).session['mawsool.anonymous']).toBeUndefined();
  },

  async 'anonymous-screen-is-shut-while-a-crisis-is-open-and-leaving-is-refused'({ page, context, locale }) {
    const api = await watchApi(context);
    await startAnonymous(page, locale, api);
    await triggerCrisis(page, locale);
    // Neither starting nor leaving a session is reachable during a crisis: the address lands on the crisis screen, and the
    // session, its note and its database stay as they were.
    await page.goto(`/${locale}/anonymous/`);
    await expect(page).toHaveURL(crisisUrl(locale), { timeout: 15_000 });
    await expect(page.locator('[data-screen="anonymous"]')).toHaveCount(0);
    expect((await pageStorage(page)).session['mawsool.anonymous']).toMatch(ANONYMOUS_NOTE);
    expect(JSON.parse((await pageStorage(page)).session['mawsool.crisis-mark']!)).toMatchObject({ anonymous: true });
    // Once the person releases the screen the session can be left again.
    await page.getByRole('button', { name: msg(locale, 'crisis.safeNow'), exact: true }).click();
    await expect(page).not.toHaveURL(crisisUrl(locale), { timeout: 15_000 });
    await page.goto(`/${locale}/anonymous/`);
    await expect(page.locator('[data-anonymous-state="on"]')).toBeVisible();
    await expect(page.locator('[data-anonymous-leave]')).toBeVisible();
    expect(api.hits).toEqual([]);
  },

  async 'anonymous-crisis-screen-opens-when-the-store-refuses'(ctx) {
    await anonymousCrisisWithFailingStorage(ctx, 'refuse');
  },

  async 'anonymous-crisis-screen-opens-when-the-store-hangs'(ctx) {
    await anonymousCrisisWithFailingStorage(ctx, 'hang');
  },
};

const CASES: Record<string, (ctx: Context) => Promise<void>> = {
  ...ANONYMOUS_CASES,
  ...ANONYMOUS_STORAGE_CASES,
  async 'directory-names-follow-the-language'({ page, locale }) {
    // Every service name the person is shown (the option cards, the consent screen, the ticket) and the clinic's name and
    // contact are in the page's language. In Arabic none of them has a Latin letter; in English they are the sample names.
    const inLanguage = (texts: string[], what: string) => {
      expect(texts.length, `${what} has text`).toBeGreaterThan(0);
      for (const text of texts) {
        if (locale === 'ar') {
          expect(text, `${what}: ${text}`).toMatch(ARABIC);
          expect(text, `${what}: ${text}`).not.toMatch(LATIN);
        } else {
          expect(text, `${what}: ${text}`).toMatch(/^Sample /);
        }
      }
    };
    await toOptions(page, locale);
    await page.getByRole('button', { name: msg(locale, 'options.showOther'), exact: true }).click();
    const cards = page.locator('[data-tier] [data-service-name]');
    expect(await cards.count(), 'the lead cards and the other tiers').toBeGreaterThanOrEqual(4);
    inLanguage(await cards.allInnerTexts(), 'option cards');

    await page.locator('[data-tier][data-lead]').getByRole('button', { name: msg(locale, 'options.choose'), exact: true }).click();
    await expect(page.locator('[data-screen="consent"]')).toBeVisible();
    inLanguage(await page.locator('[data-screen="consent"] [data-service-name]').allInnerTexts(), 'consent screen');

    await tick(page, 'scores');
    await send(page, locale);
    await expect(page).toHaveURL(ticketUrl(locale));
    await expect(page.locator('[data-ticket]')).toBeVisible();
    const id = ticketIdOf(page);
    inLanguage(await page.locator('[data-ticket] [data-service-name]').allInnerTexts(), 'ticket service');
    inLanguage(await page.locator('[data-ticket] [data-clinic-name]').allInnerTexts(), 'ticket clinic');
    const contact = await page.locator('[data-clinic-contact]').innerText();
    if (locale === 'ar') {
      expect(contact).toMatch(ARABIC);
      expect(contact).not.toMatch(LATIN);
    } else {
      expect(contact).toMatch(/^Sample /);
    }

    // The list of who opened it names the clinic in the same language once the clinic has.
    expect((await clinicRead(id)).bundle).toBe(200);
    await page.reload();
    const reads = page.locator('[data-reads] li');
    await expect(reads).toHaveCount(1);
    if (locale === 'ar') expect(await reads.innerText()).not.toMatch(LATIN);
    else expect(await reads.innerText()).toMatch(/^Sample /);

    // Switching the language and coming back shows the other language's names, not the saved ones.
    const other = locale === 'ar' ? 'en' : 'ar';
    await page.goto(`/${other}/ticket/?id=${id}`);
    await expect(page.locator('[data-ticket]')).toBeVisible();
    const otherName = await page.locator('[data-ticket] [data-service-name]').innerText();
    if (other === 'ar') expect(otherName).not.toMatch(LATIN);
    else expect(otherName).toMatch(/^Sample /);
  },

  async 'decline-keeps-the-share-until-stopped'({ page, locale }) {
    const id = await issueTicket(page, locale, ['scores']);
    await expect(page.locator('[data-declined-note]')).toHaveCount(0);
    await page.getByRole('button', { name: msg(locale, 'ticket.decline'), exact: true }).click();
    await expectDeclineWords(page, locale, id);
  },

  async 'no-longer-wanted-says-the-same-as-decline'({ page, context, locale }) {
    const id = await issueTicket(page, locale, ['scores']);
    await context.clock.setFixedTime(new Date(Date.now() + 8 * DAY_MS));
    await page.reload();
    await expect(page.locator('[data-prompt="follow-up"]')).toBeVisible();
    await page.getByRole('button', { name: msg(locale, 'ticket.followUpNo'), exact: true }).click();
    await expectDeclineWords(page, locale, id);
  },

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
    // Nothing has left the phone but the unfiltered directory read and the demo clock's offset read, both plain GETs.
    expect(toApi.every((entry) => entry === 'GET /services' || entry === 'GET /clock')).toBe(true);

    await tick(page, 'scores');
    await expect(page.locator('[data-preview]')).toContainText('PHQ-9 11');
    await page.locator('input[data-element="scores"]').uncheck();
    await expect(page.locator('[data-preview]')).not.toContainText('PHQ-9');
    expect(toApi.every((entry) => entry === 'GET /services' || entry === 'GET /clock')).toBe(true);
  },

  async 'consent-send-needs-a-chosen-service'({ page, locale }) {
    await toOptions(page, locale);
    // The directory the consent screen reads no longer holds the service the person chose (a copy that moved on).
    let holdsService = false;
    await page.route(`${API}/services*`, async (route) => {
      const real = await route.fetch();
      await route.fulfill({ response: real, json: holdsService ? await real.json() : [] });
    });
    const sent: string[] = [];
    page.on('request', (request) => void (request.url() === `${API}/tickets` && sent.push(request.method())));
    await page.locator('[data-tier][data-lead]').getByRole('button', { name: msg(locale, 'options.choose'), exact: true }).click();
    await expect(page).toHaveURL(consentUrl(locale));
    const sendButton = page.getByRole('button', { name: msg(locale, 'consent.send'), exact: true });
    await expect(page.locator('[data-service-missing]')).toHaveText(msg(locale, 'consent.serviceMissing'));
    await expect(sendButton).toBeDisabled();
    // A click that gets through anyway (the page is scripted, not tapped) sends nothing.
    await sendButton.dispatchEvent('click');
    await expect(page.locator('[data-service-missing]')).toBeVisible();
    expect(sent).toEqual([]);

    // With the service back in the directory the same screen can send.
    holdsService = true;
    await page.reload();
    await expect(page.locator('[data-service-name]')).not.toHaveText('');
    await expect(page.locator('[data-service-missing]')).toHaveCount(0);
    await expect(sendButton).toBeEnabled();
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
    // Let the page's own background reads (the directory and the clock) finish first: they start after the load event, and
    // on a slow machine they would land after the listener below and be counted as requests Delete everything made.
    await page.waitForLoadState('networkidle');
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

  async 'delete-during-crisis-sends-the-record'({ page, context, locale, consoleGuard }) {
    await visitOnline(page, locale);
    await context.setOffline(true);
    await triggerCrisis(page, locale);
    const eventId = await page.evaluate(() => JSON.parse(sessionStorage.getItem('mawsool.crisis-mark')!).eventId as string);
    await page.goto(`/${locale}/settings/`);
    // Holding the send back while the network returns, so the record is still unsent when the person confirms.
    consoleGuard.allow({ url: `${API}/crisis-events`, expect: 'net::ERR_FAILED', reason: 'the test aborts the send on purpose to hold the record back while the person confirms' });
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
    await expect(page.locator('[data-panel="equity"] [data-idle-note]')).toHaveText(msg(locale, 'settings.optInIdleNote'));
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

  async 'opted-in-phone-reaches-the-server-once-a-day-so-the-idle-limit-does-not-clear-its-choices'({ page, locale }) {
    const reads: string[] = [];
    /** Calls to the API this page has started and not yet seen finish or fail. */
    const inFlight = new Set<Request>();
    const toApi = (request: Request) => request.url().startsWith(API);
    page.on('request', (request) => {
      if (!toApi(request)) return;
      inFlight.add(request);
      if (request.method() === 'GET' && request.url() === `${API}/me/opt-ins`) reads.push(request.url());
    });
    // The answer's headers, not the request's end: the phone never reads the body of its registration call, so that call never "finishes".
    // The API has done its work (dated the person) before it answers.
    page.on('response', (response) => {
      const request = response.request();
      if (!toApi(request)) return;
      inFlight.delete(request);
    });
    page.on('requestfailed', (request) => {
      inFlight.delete(request);
    });
    await toConsent(page, locale);
    await page.locator('#equity-on').check();
    await page.locator('#equity-ageBand').selectOption('25_34');
    await send(page, locale);
    await expect(page).toHaveURL(ticketUrl(locale));
    const { ticket } = await stored(ticketIdOf(page));
    // `serverToday` is the API's own day, read in the same answer, so a run across midnight UTC compares like with like.
    const person = async () => (await (await fetch(`${INSPECT}/persons/${ticket.personId}`)).json()) as { equityOptIn: boolean; lastSeenOn: string; serverToday: string };
    /** Where the server's note of the phone is: the string `today` when it holds the server's own day, else the day it holds. */
    const noteOnServer = async () => {
      const { lastSeenOn, serverToday } = await person();
      return lastSeenOn === serverToday ? 'today' : lastSeenOn;
    };
    /** Puts the server's note back by N days and returns the day it now holds. */
    const backdate = async (daysAgo: number) => {
      const response = await fetch(`${INSPECT}/e2e/last-seen/${ticket.personId}?daysAgo=${daysAgo}`, { method: 'POST' });
      expect(response.ok).toBe(true);
      return ((await response.json()) as { lastSeenOn: string }).lastSeenOn;
    };

    // The ticket screen was opened by a full page load, so it asks the server for the ticket, and, the choice being on, the phone's
    // first start with it tells the server once. Both arrive some time after the address changes, and each of them is use: let
    // them finish, and leave the screen, before the server's note is put back, or one lands after it and moves it.
    await expect(page.locator('[data-screen="ticket"] [data-ticket]')).toBeVisible();
    await waitForStored(page, 'server:last-seen-sent'); // the phone has told the server and noted the day, on its clock of that moment
    await expect.poll(() => [...inFlight].map((request) => `${request.method()} ${request.url()}`)).toEqual([]);
    await page.goto('about:blank');
    await expect.poll(() => [...inFlight].map((request) => `${request.method()} ${request.url()}`)).toEqual([]);
    expect(await noteOnServer()).toBe('today');
    expect((await person()).equityOptIn).toBe(true);

    // A day later by the phone's own clock, with the server's last note of the phone ten days old: opening the app is use, so the
    // phone reads the person's own two choices once (the home screen asks the server for nothing itself) and the server's note is its
    // own day again.
    await page.clock.setFixedTime(new Date(Date.now() + 86_400_000));
    const tenDaysAgo = await backdate(10);
    expect((await person()).lastSeenOn).toBe(tenDaysAgo);
    reads.length = 0;
    await page.goto(`/${locale}/`);
    await expect.poll(noteOnServer).toBe('today');
    expect(reads).toHaveLength(1);

    // Another start the same day asks nothing more: the day the server holds stays where the test put it.
    const clockRead = page.waitForResponse(`${API}/clock`);
    const backdated = await backdate(10);
    await page.goto(`/${locale}/`);
    await clockRead;
    await page.waitForLoadState('networkidle');
    expect((await person()).lastSeenOn).toBe(backdated);
    expect(reads).toHaveLength(1);
  },

  async 'settings-says-once-that-the-idle-limit-switched-the-equity-choice-off-and-the-phone-then-sends-nothing-under-it'({ page, locale }) {
    const equityPuts: string[] = [];
    /** Calls to the API this page has started and not yet seen answered or fail (the registration's body is never read, so its answer's headers count). */
    const inFlight = new Set<Request>();
    page.on('request', (request) => {
      if (request.url().startsWith(API)) inFlight.add(request);
      if (request.url() === `${API}/me/equity` && request.method() === 'PUT') equityPuts.push(request.postData() ?? '');
    });
    page.on('response', (response) => inFlight.delete(response.request()));
    page.on('requestfailed', (request) => inFlight.delete(request));
    await toConsent(page, locale);
    await page.locator('#equity-on').check();
    await page.locator('#equity-ageBand').selectOption('25_34');
    await send(page, locale);
    await expect(page).toHaveURL(ticketUrl(locale));
    const { ticket } = await stored(ticketIdOf(page));
    const person = async () => (await (await fetch(`${INSPECT}/persons/${ticket.personId}`)).json()) as { equityOptIn: boolean; ageBand: string | null };
    expect(await person()).toMatchObject({ equityOptIn: true, ageBand: '25_34' });

    // Let the calls the ticket screen starts finish and leave it, or one lands after the server's note is put back and moves it.
    await expect(page.locator('[data-screen="ticket"] [data-ticket]')).toBeVisible();
    await waitForStored(page, 'server:last-seen-sent');
    await expect.poll(() => [...inFlight].map((request) => `${request.method()} ${request.url()}`)).toEqual([]);
    await page.goto('about:blank');
    await expect.poll(() => [...inFlight].map((request) => `${request.method()} ${request.url()}`)).toEqual([]);

    // The phone is then silent for the idle limit: the server's note of it goes back 180 days and the real sweep runs, which turns the choice off there.
    expect((await fetch(`${INSPECT}/e2e/last-seen/${ticket.personId}?daysAgo=180`, { method: 'POST' })).ok).toBe(true);
    const swept = (await (await fetch(`${INSPECT}/e2e/sweep`, { method: 'POST' })).json()) as { optInsCleared: number };
    expect(swept.optInsCleared).toBeGreaterThanOrEqual(1);
    expect(await person()).toMatchObject({ equityOptIn: false, ageBand: null });

    // Opened again 180 days later by the phone's own clock: Settings reads the server's two choices, shows the group-totals choice off, and says why, in its own words.
    await page.clock.setFixedTime(new Date(Date.now() + 180 * 86_400_000));
    equityPuts.length = 0;
    await page.goto(`/${locale}/settings/`);
    await expect(page.locator('[data-opt-ins-cleared="equity"]')).toHaveText(msg(locale, 'settings.optInsClearedEquity'));
    await expect(page.locator('[data-panel="equity"]')).toHaveCount(0);

    // It is said once: the next visit shows nothing about it, and the choice is still off.
    await page.goto(`/${locale}/settings/`);
    await expect(page.locator('[data-panel="reminders"]')).toBeVisible();
    await expect(page.locator('[data-opt-ins-cleared]')).toHaveCount(0);
    await expect(page.locator('[data-panel="equity"]')).toHaveCount(0);

    // Nothing is sent under the cleared choice: the consent screen starts with it off, and no equity request was made on the way.
    await page.goto(`/${locale}/options/`);
    await page.locator('[data-tier][data-lead] button').click();
    await expect(page.locator('#equity-on')).not.toBeChecked();
    expect(equityPuts).toEqual([]);
    expect(await person()).toMatchObject({ equityOptIn: false, ageBand: null });
  },

  async 'a-background-read-that-gets-401-registers-nothing-and-records-no-day'({ page, locale, consoleGuard }) {
    /** Every request for the phone's two choices. A read that registered the phone again after the 401 would ask a second time. */
    const reads: string[] = [];
    const inFlight = new Set<Request>();
    page.on('request', (request) => {
      if (request.url().startsWith(API)) inFlight.add(request);
      if (request.url() === `${API}/me/opt-ins`) reads.push(request.method());
    });
    page.on('response', (response) => inFlight.delete(response.request()));
    page.on('requestfailed', (request) => inFlight.delete(request));
    consoleGuard.allow({ url: `${API}/me/opt-ins`, expect: 401, reason: 'the test answers the phone background read of its own choices with 401, as a server that forgot the phone would' });
    await page.route(`${API}/me/opt-ins`, (route) => route.fulfill({ status: 401, json: { error: 'unauthorized', message: 'Unknown device' } }));
    const refused = page.waitForResponse((response) => response.url() === `${API}/me/opt-ins`);
    await toConsent(page, locale);
    await page.locator('#equity-on').check();
    await page.locator('#equity-ageBand').selectOption('25_34');
    await send(page, locale);
    await expect(page).toHaveURL(ticketUrl(locale));
    await expect(page.locator('[data-screen="ticket"] [data-ticket]')).toBeVisible();

    // The background read on the ticket screen's start was refused: it was not made again after registering the phone (the way a call the
    // person makes would be), and the day it keeps for the read was not written.
    expect((await refused).status()).toBe(401);
    // A second registration, if the read made one, starts at once and is answered quickly: give it the time, then wait for everything to settle.
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 1000)));
    await expect.poll(() => [...inFlight].map((request) => `${request.method()} ${request.url()}`)).toEqual([]);
    expect(reads, 'the read was made once and not repeated after the 401').toEqual(['GET']);
    expect(await rawStoreKeys(page)).not.toContain('server:last-seen-sent');
    expect(await rawStoreKeys(page)).toContain('equity');
  },

  async 'reads-list-and-its-failure'({ page, locale, consoleGuard }) {
    const id = await issueTicket(page, locale);
    expect((await clinicRead(id)).bundle).toBe(200);
    await page.reload();
    await expect(page.locator('[data-reads] li')).toHaveCount(1);
    // The clinic is named in the page's language: the sample name in English, its Arabic name in Arabic.
    await expect(page.locator('[data-reads]')).toContainText(locale === 'ar' ? 'نموذج' : 'Sample');
    await expect(page.locator('[data-reads-failed]')).toHaveCount(0);

    consoleGuard.allow({ url: `${API}/me/tickets/${id}/reads?locale=${locale}`, expect: 'net::ERR_FAILED', reason: 'the test aborts the reads call on purpose to show it is reported as failed, not as nobody opening the ticket' });
    await page.route('**/me/tickets/*/reads?locale=*', (route) => route.abort());
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
    // What the API serves for the page's language: the Arabic run is given Arabic text, as a real Arabic ticket carries.
    const names =
      locale === 'ar'
        ? { serviceName: 'نموذج: مركز الرعاية الأولية 1', clinicName: 'نموذج: مركز الرعاية الأولية · مدينة خليفة', clinicContact: 'مكتب استقبال نموذجي. الاستقبال مفتوح من 8:00 إلى 16:00؛ اسأل عن مكتب الإحالات.' }
        : { serviceName: 'Sample primary care centre 1', clinicName: 'Sample PHC, Khalifa City', clinicContact: 'Sample clinic. Reception is open 8:00 to 16:00; ask for the referral desk.' };
    const ticket = {
      id, shortCode: 'MW4K7Q', qrPayload: 'MAWSOOL:TICKET:MW4K7Q', tier: 'gp', state: 'acknowledged', language: locale, deadlineAt: '2026-11-05T23:59:59+04:00', source: 'app',
      serviceId: '6c6d2f6e-0a0e-4a45-9d2c-3c7e1a4e9a22', ...names,
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
    // The screen asks for the page's language with every read, so each address carries it.
    await page.route(`${API}/me/tickets/${id}?locale=${locale}`, (route) => route.fulfill({ json: ticket }));
    await page.route(`${API}/me/tickets/${id}/reads?locale=${locale}`, (route) => route.fulfill({ json: [{ at: '2026-10-31T10:00:00+04:00', role: 'clinician', facilityName: names.clinicName }] }));
    await page.route(`${API}/me/tickets?locale=${locale}`, (route) => route.fulfill({ json: [ticket] }));
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

  async 'ticket-tab-finds-a-ticket-after-a-failed-local-save'({ page, locale, consoleGuard }) {
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
    consoleGuard.allow({ url: `${API}/me/tickets?locale=${locale}`, expect: 'net::ERR_FAILED', reason: 'the test aborts the ticket list on purpose to show a failed list is not reported as no referral' });
    await page.route(`${API}/me/tickets?locale=${locale}`, (route) => route.abort());
    await page.goto(`/${locale}/ticket/`);
    await expect(page.getByRole('alert').filter({ hasText: msg(locale, 'ticket.loadFailed') })).toBeVisible();
    await expect(page.getByText(msg(locale, 'ticket.noTicket'))).toHaveCount(0);

    // A phone that never shared anything makes no request for it.
    const fresh = await (await page.context().browser()!.newContext({ viewport: { width: 390, height: 844 } })).newPage();
    const asked: string[] = [];
    fresh.on('request', (request: Request) => {
      // The directory read and the demo clock's offset read are the two plain GETs every page load makes; neither asks for a ticket or a person.
      if (request.url().startsWith(API) && !(request.method() === 'GET' && ['/services', '/clock'].includes(new URL(request.url()).pathname))) asked.push(`${request.method()} ${new URL(request.url()).pathname}`);
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

  async 'reminders-are-off-until-turned-on-and-the-card-shows-neutral-words-when-due'({ page, context, locale }) {
    await visitOnline(page, locale);
    await page.goto(`/${locale}/`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.locator('[data-prompt="reminder"]')).toHaveCount(0);

    await page.goto(`/${locale}/settings/`);
    const toggle = page.locator('[data-reminders-switch]');
    await expect(toggle).not.toBeChecked();
    await expect(page.locator('input[name="reminder-interval"]')).toHaveCount(0);
    await toggle.click();
    await expect(toggle).toBeChecked();
    await expect(page.locator('input[name="reminder-interval"][value="4"]')).toBeChecked();
    await expect(page.locator('input[name="reminder-interval"]')).toHaveCount(2);
    await expect(page.locator('[data-reminders-limit]')).toHaveText(msg(locale, 'settings.remindersLimit'));

    // Every 4 weeks to start: not yet due at 15 days; every 2 weeks: due at 15 days.
    const turnedOn = Date.now();
    await context.clock.setFixedTime(new Date(turnedOn + 15 * DAY_MS));
    await page.goto(`/${locale}/`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.locator('[data-prompt="reminder"]')).toHaveCount(0);
    await page.goto(`/${locale}/settings/`);
    await page.locator('input[name="reminder-interval"][value="2"]').click();
    await expect(page.locator('input[name="reminder-interval"][value="2"]')).toBeChecked();
    await page.goto(`/${locale}/`);
    const card = page.locator('[data-prompt="reminder"]');
    await expect(card).toBeVisible();
    await expect(card.locator('h2')).toHaveText(msg(locale, 'reminder.title'));
    await expect(card.locator('p')).toHaveText(msg(locale, 'reminder.body'));
    expect((await card.innerText()).replace(msg(locale, 'reminder.title'), '').replace(msg(locale, 'reminder.body'), '').trim()).toBe(msg(locale, 'reminder.action'));

    // Finishing a check-in pushes the next reminder a whole interval out.
    await takeCheckIn(page, locale, 'who5', [3, 3, 3, 3, 3]);
    await page.goto(`/${locale}/`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.locator('[data-prompt="reminder"]')).toHaveCount(0);
  },

  async 'reminder-notifier-shows-a-due-reminder-as-a-notification-when-the-app-opens'({ page, context, locale }) {
    // The test browser cannot be relied on to hold the notification permission, and a notification cannot be read back from it. So the
    // page is told that permission is granted, and every notification it is asked to show, by either way the adapter has (the
    // service worker's registration, or the constructor when none is registered), is recorded instead of shown.
    await page.addInitScript(() => {
      const record = (title: string, options?: NotificationOptions) =>
        sessionStorage.setItem('e2e.shown', JSON.stringify([...JSON.parse(sessionStorage.getItem('e2e.shown') ?? '[]'), { title, body: options?.body, tag: options?.tag }]));
      ServiceWorkerRegistration.prototype.showNotification = async function (title: string, options?: NotificationOptions) {
        record(title, options);
      };
      class Recording {
        static permission: NotificationPermission = 'granted';
        static requestPermission = async (): Promise<NotificationPermission> => 'granted';
        constructor(title: string, options?: NotificationOptions) {
          record(title, options);
        }
      }
      window.Notification = Recording as unknown as typeof Notification;
    });
    const shown = async (): Promise<{ title: string; body: string; tag: string }[]> => JSON.parse((await page.evaluate(() => sessionStorage.getItem('e2e.shown'))) ?? '[]');
    await visitOnline(page, locale);
    await page.goto(`/${locale}/settings/`);
    await page.locator('[data-reminders-switch]').click();
    await expect(page.locator('[data-reminders-switch]')).toBeChecked();
    await page.locator('input[name="reminder-interval"][value="2"]').click();
    await expect(page.locator('input[name="reminder-interval"][value="2"]')).toBeChecked();

    // Not yet due: opening the app shows nothing.
    await page.goto(`/${locale}/`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.locator('[data-prompt="reminder"]')).toHaveCount(0);
    expect(await shown()).toEqual([]);

    // Due, on the care clock: the notifier mounted by the layout shows it when the page opens, in the reminder words alone.
    await context.clock.setFixedTime(new Date(Date.now() + 15 * DAY_MS));
    await page.goto(`/${locale}/`);
    await expect(page.locator('[data-prompt="reminder"]')).toBeVisible();
    await expect.poll(shown, { timeout: 15_000 }).toHaveLength(1);
    const [notification] = await shown();
    expect(notification).toMatchObject({ title: msg(locale, 'reminder.title'), body: msg(locale, 'reminder.body') });
    expect(notification!.tag).toBe('check-in-reminder');
  },

  async 'reminder-number-is-optional-stored-apart-and-deleted-with-the-reminders'({ page, locale }) {
    await visitOnline(page, locale);
    await page.goto(`/${locale}/settings/`);
    const before = (await storedReminderNumbers()).length;
    await page.locator('[data-reminders-switch]').click();
    await expect(page.locator('[data-reminders-switch]')).toBeChecked();
    await expect(page.locator('[data-panel="reminder-number"] [data-sample]')).toHaveText(msg(locale, 'settings.remindersSample'));
    await expect(page.locator('[data-panel="reminder-number"]')).toContainText(msg(locale, 'settings.remindersTextBody'));

    // Reminders on without a number put no row on the server.
    expect(await storedReminderNumbers()).toHaveLength(before);
    const sent: string[] = [];
    page.on('request', (request) => void (request.url().startsWith(`${API}/me/reminder-phone`) && sent.push(request.method())));

    // A number that is not international is refused on the phone, and nothing is sent.
    await page.locator('#reminder-phone').fill('0501234567');
    await page.getByRole('button', { name: msg(locale, 'settings.remindersSaveNumber'), exact: true }).click();
    await expect(page.locator('[data-reminder-note="invalid"]')).toHaveText(msg(locale, 'settings.remindersInvalid'));
    expect(sent).toEqual([]);

    const number = `+9715${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
    await page.locator('#reminder-phone').fill(number.replace('+971', '+971 ').replace(/(\d{3})(\d{4})$/, '$1 $2'));
    await page.getByRole('button', { name: msg(locale, 'settings.remindersSaveNumber'), exact: true }).click();
    await expect(page.locator('[data-reminder-number]')).toHaveText(number);
    const held = (await storedReminderNumbers()).filter((row) => row.phone === number);
    expect(held).toHaveLength(1);
    expect(held[0]!.intervalWeeks).toBe(4);
    expect(held[0]!.ciphertext).not.toContain(number.slice(4));
    expect(await rawStoreKeys(page)).toContain('reminders');

    // A sample text goes to the API's mock notifier: it answers that nothing was sent, and the phone says so.
    const sampleStatus = page.waitForResponse((response) => response.url() === `${API}/me/reminder-phone/sample` && response.request().method() === 'POST');
    await page.locator('[data-reminder-sample]').click();
    expect((await sampleStatus).status()).toBe(200);
    await expect(page.locator('[data-reminder-note="sample"]')).toHaveText(msg(locale, 'settings.remindersSampleDone'));

    // Removing the number deletes the row and keeps reminders on.
    await page.getByRole('button', { name: msg(locale, 'settings.remindersRemoveNumber'), exact: true }).click();
    await expect(page.locator('#reminder-phone')).toBeVisible();
    expect((await storedReminderNumbers()).filter((row) => row.phone === number)).toEqual([]);
    await expect(page.locator('[data-reminders-switch]')).toBeChecked();

    // Turning reminders off deletes the row too.
    await page.locator('#reminder-phone').fill(number);
    await page.getByRole('button', { name: msg(locale, 'settings.remindersSaveNumber'), exact: true }).click();
    await expect(page.locator('[data-reminder-number]')).toHaveText(number);
    expect((await storedReminderNumbers()).filter((row) => row.phone === number)).toHaveLength(1);
    await page.locator('[data-reminders-switch]').click();
    await expect(page.locator('[data-reminders-switch]')).not.toBeChecked();
    expect((await storedReminderNumbers()).filter((row) => row.phone === number)).toEqual([]);
    expect(await rawStoreKeys(page)).not.toContain('reminders');

    // Delete everything removes it as well.
    await page.locator('[data-reminders-switch]').click();
    await expect(page.locator('[data-reminders-switch]')).toBeChecked();
    await page.locator('#reminder-phone').fill(number);
    await page.getByRole('button', { name: msg(locale, 'settings.remindersSaveNumber'), exact: true }).click();
    await expect(page.locator('[data-reminder-number]')).toHaveText(number);
    expect((await storedReminderNumbers()).filter((row) => row.phone === number)).toHaveLength(1);
    await openSettingsAndConfirmDelete(page, locale);
    await confirmDelete(page, locale);
    await expect(page.locator('[data-erased]')).toBeVisible();
    expect((await storedReminderNumbers()).filter((row) => row.phone === number)).toEqual([]);
    await expect.poll(() => rawStoreKeys(page), { timeout: 10_000 }).toEqual([]);
  },

  async 'repeat-check-opens-six-weeks-after-the-clinic-saw-the-person'({ page, context, locale }) {
    await visitOnline(page, locale);
    const id = await stubSeenTicket(page, locale);
    await context.clock.setFixedTime(new Date(SEEN_AT_MS + SIX_WEEKS_MS - 60_000));
    await page.goto(`/${locale}/ticket/?id=${id}`);
    await expect(page.locator('[data-ticket]')).toBeVisible();
    await expect(page.locator('[data-prompt="remeasure"]')).toHaveCount(0);
    await expect(page.locator('[data-remeasure-wait]')).toBeVisible();
    await expect(page.locator('[data-control="end-ticket"]')).toBeVisible();

    await context.clock.setFixedTime(new Date(SEEN_AT_MS + SIX_WEEKS_MS));
    await page.reload();
    await expect(page.locator('[data-prompt="remeasure"]')).toBeVisible();
    await expect(page.locator('[data-remeasure-wait]')).toHaveCount(0);
    const start = page.getByRole('link', { name: msg(locale, 'ticket.remeasureStart'), exact: true });
    // The link carries the exact moment the check opened, which the questionnaire uses to leave any older unfinished check-in alone.
    await expect(start).toHaveAttribute('href', `/${locale}/check-in/?i=phq9&rm=${id}&since=${OPENS_MS}`);
    await start.click();
    await expect(page).toHaveURL(new RegExp(`/${locale}/check-in/\\?i=phq9&rm=${id}&since=${OPENS_MS}$`));

    // The repeat check screen offers the same start, with the same moment, once it is open.
    await page.goto(`/${locale}/remeasure/?id=${id}`);
    await expect(page.locator('[data-remeasure-start]')).toHaveAttribute('href', `/${locale}/check-in/?i=phq9&rm=${id}&since=${OPENS_MS}`);

    // The repeat check screen itself says the same before the date.
    await context.clock.setFixedTime(new Date(SEEN_AT_MS + 10 * DAY_MS));
    await page.goto(`/${locale}/remeasure/?id=${id}`);
    await expect(page.locator('[data-remeasure-state="not-open"]')).toBeVisible();
    await expect(page.locator('[data-remeasure-start]')).toHaveCount(0);
  },

  async 'repeat-check-sends-the-totals-only-when-ticked'({ page, context, locale }) {
    await visitOnline(page, locale);
    const id = await stubSeenTicket(page, locale);
    const bodies: { scores: { instrument: string; total: number }[] }[] = [];
    await page.route(`${API}/me/tickets/${id}/remeasure`, async (route) => {
      bodies.push(route.request().postDataJSON());
      await route.fulfill({ json: { state: 'closed', scoresShared: bodies.at(-1)!.scores.length > 0, events: [] } });
    });
    await context.clock.setFixedTime(new Date(SEEN_AT_MS + SIX_WEEKS_MS));
    await page.goto(`/${locale}/ticket/?id=${id}`);
    await takeRepeatCheck(page, locale, id);
    await expect(page.locator('[data-total="phq9"]')).toContainText('PHQ-9');
    await expect(page.locator('[data-total="gad7"]')).toContainText('GAD-7');
    const summary = page.url();

    // Default off: finishing without the tick sends the move and no totals.
    const share = page.locator('[data-control="share-totals"]');
    await expect(share).not.toBeChecked();
    await page.getByRole('button', { name: msg(locale, 'remeasure.finish'), exact: true }).click();
    await expect(page).toHaveURL(ticketUrl(locale));
    expect(bodies).toEqual([{ scores: [] }]);

    // Ticked: exactly the two totals, with no answers.
    await page.goto(summary);
    await share.check();
    await page.getByRole('button', { name: msg(locale, 'remeasure.finish'), exact: true }).click();
    await expect(page).toHaveURL(ticketUrl(locale));
    expect(bodies).toHaveLength(2);
    expect(bodies[1]!.scores.map((score) => [score.instrument, score.total])).toEqual([['phq9', 0], ['gad7', 0]]);
    expect(JSON.stringify(bodies[1])).not.toContain('answers');

    // A share the person ended offers nothing to tick.
    await stubSeenTicket(page, locale, false);
    await page.goto(summary);
    await expect(page.locator('[data-share-unavailable]')).toBeVisible();
    await expect(share).toHaveCount(0);
  },

  async 'repeat-check-counts-in-anonymous-statistics-only-when-ticked-and-only-with-the-totals'({ page, context, locale }) {
    await visitOnline(page, locale);
    const id = await stubSeenTicket(page, locale);
    const bodies: Record<string, unknown>[] = [];
    await page.route(`${API}/me/tickets/${id}/remeasure`, async (route) => {
      bodies.push(route.request().postDataJSON());
      await route.fulfill({ json: { state: 'closed', scoresShared: ((bodies.at(-1)!.scores as unknown[]) ?? []).length > 0, events: [] } });
    });
    await context.clock.setFixedTime(new Date(SEEN_AT_MS + SIX_WEEKS_MS));
    await page.goto(`/${locale}/ticket/?id=${id}`);
    await takeRepeatCheck(page, locale, id);
    const summary = page.url();
    const finish = () => page.getByRole('button', { name: msg(locale, 'remeasure.finish'), exact: true }).click();
    const share = page.locator('[data-control="share-totals"]');
    const statistics = page.locator('[data-control="count-in-statistics"]');
    const choice = page.locator('label', { has: statistics });

    // Default off, in its own box with its own words, and unavailable while the totals are not being sent.
    await expect(statistics).not.toBeChecked();
    await expect(statistics).toBeDisabled();
    await expect(choice).toContainText(msg(locale, 'remeasure.statisticsLabel'));
    await expect(choice).toContainText(msg(locale, 'remeasure.statisticsHelp'));
    expect(msg(locale, 'remeasure.statisticsHelp'), 'says the totals count only in groups of 10 or more').toContain('10');
    expect(msg(locale, 'remeasure.statisticsHelp'), 'says a clinic never sees the choice').toContain(locale === 'en' ? 'ever sees this choice' : 'أبدًا');
    // Ticking the send box makes it available, still unticked; unticking the send box again disables it and unticks it even when it was ticked.
    await share.check();
    await expect(statistics).toBeEnabled();
    await expect(statistics).not.toBeChecked();
    await statistics.check();
    await expect(statistics).toBeChecked();
    await share.uncheck();
    await expect(statistics).toBeDisabled();
    await expect(statistics).not.toBeChecked();

    // Totals not sent: the move alone, and no word about the choice.
    await finish();
    await expect(page).toHaveURL(ticketUrl(locale));
    expect(bodies).toEqual([{ scores: [] }]);

    // Totals sent, the choice left off: the request says so, so a choice made earlier cannot linger.
    await page.goto(summary);
    await share.check();
    await finish();
    await expect(page).toHaveURL(ticketUrl(locale));
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toMatchObject({ statisticsOptIn: false });
    expect((bodies[1]!.scores as unknown[]).length).toBe(2);

    // Both ticked: the choice travels with the totals in the same request.
    await page.goto(summary);
    await share.check();
    await statistics.check();
    await finish();
    await expect(page).toHaveURL(ticketUrl(locale));
    expect(bodies).toHaveLength(3);
    expect(bodies[2]).toMatchObject({ statisticsOptIn: true });
    expect(JSON.stringify(bodies[2])).not.toContain('answers');
    expect(await rawStoreKeys(page)).toContain('outcome-statistics');

    // The phone remembers it: the box is ticked next time the totals are sent, and still unticked and disabled while they are not.
    await page.goto(summary);
    await expect(statistics).toBeDisabled();
    await expect(statistics).not.toBeChecked();
    await share.check();
    await expect(statistics).toBeChecked();
  },

  async 'settings-turns-off-anonymous-statistics-and-shows-nothing-while-it-is-off'({ page, context, locale, consoleGuard }) {
    await visitOnline(page, locale);
    await page.goto(`/${locale}/settings/`);
    await expect(page.locator('[data-panel="reminders"]')).toBeVisible();
    // Off by default: Settings has no panel for it.
    await expect(page.locator('[data-panel="statistics"]')).toHaveCount(0);

    // Turn it on where the totals are sent.
    const id = await stubSeenTicket(page, locale);
    // The ticket is a stub, so the send is answered here; the real server is told the choice the way a send it received would have told it.
    await page.route(`${API}/me/tickets/${id}/remeasure`, async (route) => {
      await serverCountsTheChoice(route);
      await route.fulfill({ json: { state: 'closed', scoresShared: true, events: [] } });
    });
    await context.clock.setFixedTime(new Date(SEEN_AT_MS + SIX_WEEKS_MS));
    await page.goto(`/${locale}/ticket/?id=${id}`);
    await takeRepeatCheck(page, locale, id);
    await page.locator('[data-control="share-totals"]').check();
    await page.locator('[data-control="count-in-statistics"]').check();
    await page.getByRole('button', { name: msg(locale, 'remeasure.finish'), exact: true }).click();
    await expect(page).toHaveURL(ticketUrl(locale));

    // Settings now says so, in words, with one control that turns it off.
    const turnedOff: { method: string; body: unknown }[] = [];
    let refuse = true;
    consoleGuard.allow({ url: `${API}/me/outcome-statistics`, expect: 503, reason: 'the test makes the server refuse the first turn-off to show the choice stays on when the server could not be told' });
    await page.route(`${API}/me/outcome-statistics`, async (route) => {
      turnedOff.push({ method: route.request().method(), body: route.request().postDataJSON() });
      if (refuse) return route.fulfill({ status: 503, json: { error: 'unavailable', message: 'down' } });
      return route.fulfill({ json: { optIn: false } });
    });
    await page.goto(`/${locale}/settings/`);
    const panel = page.locator('[data-panel="statistics"]');
    await expect(panel).toContainText(msg(locale, 'settings.statisticsTitle'));
    await expect(panel).toContainText(msg(locale, 'settings.statisticsOnBody'));
    await expect(panel.locator('[data-idle-note]')).toHaveText(msg(locale, 'settings.optInIdleNote'));
    const off = panel.getByRole('button', { name: msg(locale, 'settings.statisticsOptOut'), exact: true });
    await off.click();
    await expect(panel.getByRole('alert')).toHaveText(msg(locale, 'settings.statisticsFailed'));
    await expect(off).toBeVisible();
    refuse = false;
    await off.click();
    await expect(panel.getByRole('status')).toHaveText(msg(locale, 'settings.statisticsRemoved'));
    await expect(off).toHaveCount(0);
    expect(turnedOff).toEqual([{ method: 'PUT', body: { optIn: false } }, { method: 'PUT', body: { optIn: false } }]);

    // Gone for good on the phone: the next visit has no panel.
    await page.goto(`/${locale}/settings/`);
    await expect(page.locator('[data-panel="reminders"]')).toBeVisible();
    await expect(page.locator('[data-panel="statistics"]')).toHaveCount(0);
  },

  async 'statistics-note-refused-write-sends-nothing-shows-the-message-and-keeps-finish-in-view'({ page, context, locale }) {
    await installFailingIndexedDb(page);
    await visitOnline(page, locale);
    const id = await stubSeenTicket(page, locale);
    const bodies: Record<string, unknown>[] = [];
    await page.route(`${API}/me/tickets/${id}/remeasure`, async (route) => {
      bodies.push(route.request().postDataJSON());
      await route.fulfill({ json: { state: 'closed', scoresShared: true, events: [] } });
    });
    await context.clock.setFixedTime(new Date(SEEN_AT_MS + SIX_WEEKS_MS));
    await page.goto(`/${locale}/ticket/?id=${id}`);
    await takeRepeatCheck(page, locale, id);
    const totalsUrl = page.url();
    await page.locator('[data-control="share-totals"]').check();
    await page.locator('[data-control="count-in-statistics"]').check();
    const finish = page.locator('[data-control="finish-remeasure"]');
    const inView = async (what: string) => {
      const box = (await finish.boundingBox())!;
      expect(box.y, `${what}: Finish starts inside the viewport`).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height, `${what}: Finish ends inside the viewport`).toBeLessThanOrEqual(page.viewportSize()!.height);
    };
    await inView('with the box ticked');

    // The phone cannot write its note that the choice may be on: nothing is sent, the message says so, and the choice is still not recorded.
    await setIdbMode(page, 'refuse-writes');
    await finish.click();
    await expect(page.locator('[data-note-failed]')).toHaveText(msg(locale, 'remeasure.statisticsNoteFailed'));
    await expect(page).toHaveURL(totalsUrl);
    expect(bodies, 'nothing was sent').toEqual([]);
    expect(await rawStoreKeys(page)).not.toContain('outcome-statistics');
    // The message is on the screen and Finish is still in view, in both languages, without scrolling to it.
    await inView('with the message shown');

    // With the phone able to write again, the same Finish sends the choice and the note is kept.
    await setIdbMode(page, null);
    await finish.click();
    await expect(page).toHaveURL(`${BASE}/${locale}/ticket/?id=${id}`);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ statisticsOptIn: true });
    expect(await rawStoreKeys(page)).toContain('outcome-statistics');
  },

  async 'repeat-check-note-failed-message-is-not-covered-by-the-finish-bar'({ page, context, locale }) {
    await installFailingIndexedDb(page);
    await visitOnline(page, locale);
    const id = await stubSeenTicket(page, locale);
    await context.clock.setFixedTime(new Date(SEEN_AT_MS + SIX_WEEKS_MS));
    await page.goto(`/${locale}/ticket/?id=${id}`);
    await takeRepeatCheck(page, locale, id);
    await page.locator('[data-control="share-totals"]').check();
    await page.locator('[data-control="count-in-statistics"]').check();
    const finish = page.locator('[data-control="finish-remeasure"]');
    const scrolledBefore = await page.evaluate(() => window.scrollY);

    await setIdbMode(page, 'refuse-writes');
    await finish.click();
    const message = page.locator('[data-note-failed]');
    await expect(message).toHaveText(msg(locale, 'remeasure.statisticsNoteFailed'));

    // At first render, with no scrolling: the whole message is on the screen, nothing sits over any part of it, and the button is below it.
    const seen = await message.evaluate((node) => {
      const box = node.getBoundingClientRect();
      const top = (x: number, y: number) => {
        const hit = document.elementFromPoint(x, y);
        return hit !== null && node.contains(hit);
      };
      return {
        top: box.top,
        bottom: box.bottom,
        scrolled: window.scrollY,
        height: window.innerHeight,
        fontSize: parseFloat(getComputedStyle(node).fontSize),
        reachable: [top(box.left + 2, box.top + 2), top(box.right - 2, box.top + 2), top((box.left + box.right) / 2, (box.top + box.bottom) / 2), top(box.left + 2, box.bottom - 2), top(box.right - 2, box.bottom - 2)],
      };
    });
    expect(seen.scrolled, 'the page did not have to scroll for the message to show').toBe(scrolledBefore);
    expect(seen.top, 'the message starts inside the viewport').toBeGreaterThanOrEqual(0);
    expect(seen.bottom, 'the message ends inside the viewport').toBeLessThanOrEqual(seen.height);
    expect(seen.reachable, 'no part of the message has anything over it').toEqual([true, true, true, true, true]);
    expect(seen.fontSize, 'the message keeps the size of body text').toBeGreaterThanOrEqual(15);
    const button = (await finish.boundingBox())!;
    expect(button.y, 'the button starts below the message, with no overlap').toBeGreaterThanOrEqual(seen.bottom);
    expect(button.y + button.height, 'the button ends inside the viewport').toBeLessThanOrEqual(seen.height);
    expect(button.height, 'the button keeps its 44 px target').toBeGreaterThanOrEqual(44);
  },

  async 'statistics-note-lost-reply-keeps-the-settings-turn-off-visible'({ page, context, locale, consoleGuard }) {
    await visitOnline(page, locale);
    const id = await stubSeenTicket(page, locale);
    consoleGuard.allow({ url: `${API}/me/tickets/${id}/remeasure`, expect: 'net::ERR_FAILED', reason: 'the test drops the reply of the send on purpose: the server may have counted the totals, so the phone must keep the choice it can turn off' });
    // The request arrives and the reply is lost: the real server holds the choice, and the phone cannot know.
    await page.route(`${API}/me/tickets/${id}/remeasure`, async (route) => {
      await serverCountsTheChoice(route);
      await route.abort();
    });
    await context.clock.setFixedTime(new Date(SEEN_AT_MS + SIX_WEEKS_MS));
    await page.goto(`/${locale}/ticket/?id=${id}`);
    await takeRepeatCheck(page, locale, id);
    const totalsUrl = page.url();
    await page.locator('[data-control="share-totals"]').check();
    await page.locator('[data-control="count-in-statistics"]').check();
    await page.locator('[data-control="finish-remeasure"]').click();
    // The send did not get an answer: the screen says so and stays, and the phone has already noted that the choice may be on.
    await expect(page.getByRole('alert').filter({ hasText: msg(locale, 'remeasure.failed') })).toBeVisible();
    await expect(page).toHaveURL(totalsUrl);
    expect(await rawStoreKeys(page)).toContain('outcome-statistics');
    // Settings still offers the turn-off, with the wording that covers every total.
    await page.goto(`/${locale}/settings/`);
    const panel = page.locator('[data-panel="statistics"]');
    await expect(panel).toContainText(msg(locale, 'settings.statisticsOnBody'));
    await expect(panel.locator('[data-control="turn-off-statistics"]')).toBeVisible();
    await expect(panel.locator('[data-control="turn-off-statistics"]')).toHaveText(msg(locale, 'settings.statisticsOptOut'));
  },

  async 'repeat-check-statistics-help-stays-readable-while-the-box-is-disabled'({ page, context, locale }) {
    await visitOnline(page, locale);
    const id = await stubSeenTicket(page, locale);
    await context.clock.setFixedTime(new Date(SEEN_AT_MS + SIX_WEEKS_MS));
    await page.goto(`/${locale}/ticket/?id=${id}`);
    await takeRepeatCheck(page, locale, id);
    const box = page.locator('[data-control="count-in-statistics"]');
    const choice = page.locator('label', { has: box });
    // Disabled while the totals are not sent: the box cannot be ticked and the label looks and acts unavailable.
    await expect(box).toBeDisabled();
    await expect(choice).toHaveCSS('cursor', 'not-allowed');
    await expect(choice).toHaveAttribute('data-disabled', '');
    /** WCAG contrast of an element's text against the background it is drawn on, with any fading by opacity of it or an ancestor counted. */
    const contrast = (selector: string) =>
      page.evaluate((text) => {
        const channels = (value: string) => value.match(/[\d.]+/g)!.map(Number) as [number, number, number];
        const linear = (value: number) => (value / 255 <= 0.03928 ? value / 255 / 12.92 : ((value / 255 + 0.055) / 1.055) ** 2.4);
        const luminance = ([r, g, b]: [number, number, number]) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
        const element = document.querySelector(text)!;
        let opacity = 1;
        for (let node: Element | null = element; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
        let backdrop: Element | null = element;
        while (backdrop && getComputedStyle(backdrop).backgroundColor === 'rgba(0, 0, 0, 0)') backdrop = backdrop.parentElement;
        const back = channels(getComputedStyle(backdrop!).backgroundColor);
        const fore = channels(getComputedStyle(element).color);
        const shown = fore.map((value, i) => value * opacity + back[i]! * (1 - opacity)) as [number, number, number];
        const [light, dark] = [luminance(shown), luminance(back)].sort((a, b) => b - a);
        return { ratio: (light! + 0.05) / (dark! + 0.05), opacity };
      }, selector);
    const help = await contrast('label:has([data-control="count-in-statistics"]) .t-small');
    const title = await contrast('label:has([data-control="count-in-statistics"]) .font-semibold');
    expect(help.opacity, 'the help is not faded').toBe(1);
    expect(help.ratio, 'the disabled help text reads at 4.5:1 or better').toBeGreaterThanOrEqual(4.5);
    expect(title.ratio, 'the disabled title reads at 4.5:1 or better').toBeGreaterThanOrEqual(4.5);
    // Enabled, it is the ordinary white card.
    await page.locator('[data-control="share-totals"]').check();
    await expect(box).toBeEnabled();
    await expect(choice).not.toHaveAttribute('data-disabled', '');
    expect((await contrast('label:has([data-control="count-in-statistics"]) .t-small')).ratio).toBeGreaterThanOrEqual(4.5);
  },

  async 'repeat-check-starts-a-fresh-check-in-and-never-finishes-an-old-one'({ page, context, locale }) {
    await visitOnline(page, locale);
    const id = await stubSeenTicket(page, locale);
    // An unfinished PHQ-9 from three weeks before the clinic saw the person: three answers given.
    await context.clock.setFixedTime(new Date(SEEN_AT_MS - 21 * DAY_MS));
    await page.goto(`/${locale}/check-in/?i=phq9`);
    await answerAll(page, locale, [1, 1, 1]);
    const progress = page.getByRole('progressbar');
    // An ordinary check-in picks it up at question 4 (so the old draft is really there to be resumed).
    await page.goto(`/${locale}/check-in/?i=phq9`);
    await expect(progress).toHaveAttribute('aria-valuenow', '4');

    // The repeat check, from the ticket, starts at question 1 with nothing chosen.
    await context.clock.setFixedTime(new Date(OPENS_MS));
    await page.goto(`/${locale}/ticket/?id=${id}`);
    await page.getByRole('link', { name: msg(locale, 'ticket.remeasureStart'), exact: true }).click();
    await expect(progress).toHaveAttribute('aria-valuenow', '1');
    await expect(page.locator('input[type="radio"]:checked')).toHaveCount(0);
    // Its own first answer is a new check-in, not the old one continued: reloading resumes it at question 2.
    await answerAll(page, locale, [2]);
    await page.reload();
    await expect(progress).toHaveAttribute('aria-valuenow', '2');
  },

  async 'repeat-check-item-9-opens-the-crisis-screen'({ page, context, locale }) {
    await visitOnline(page, locale);
    const id = await stubSeenTicket(page, locale);
    await context.clock.setFixedTime(new Date(SEEN_AT_MS + SIX_WEEKS_MS));
    await page.goto(`/${locale}/check-in/?i=phq9&rm=${id}`);
    await answerAll(page, locale, [0, 0, 0, 0, 0, 0, 0, 0, 2], { lastLeavesPage: true });
    await expect(page).toHaveURL(crisisUrl(locale));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(msg(locale, 'crisis.heading'));
    // While the block stands the repeat check screen sends the person back to the crisis screen.
    await page.goto(`/${locale}/remeasure/?id=${id}`);
    await expect(page).toHaveURL(crisisUrl(locale), { timeout: 15_000 });
    await expect(page.locator('[data-screen="remeasure"]')).toHaveCount(0);
  },

  async 'person-ending-a-seen-ticket-closes-it'({ page, context, locale }) {
    const id = await issueTicket(page, locale);
    await expect(page.locator('[data-control="end-ticket"]')).toHaveCount(0); // nothing to end before the ticket is seen
    await context.clock.setFixedTime(new Date(Date.now() + 8 * DAY_MS));
    await page.reload();
    await page.getByRole('button', { name: msg(locale, 'ticket.followUpYes'), exact: true }).click();
    await expect(page.locator('[data-step="seen"]')).toHaveAttribute('data-done', 'true');
    await expect(page.locator('[data-prompt="remeasure"]')).toHaveCount(0); // six weeks have not passed
    await page.locator('[data-control="end-ticket"]').click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.locator('[data-control="end-ticket-yes"]').click();
    await expect(page.locator('[data-step="closed"]')).toHaveAttribute('data-done', 'true');
    await expect(page.locator('[data-control="end-ticket"]')).toHaveCount(0);
    await expect(page.locator('[data-closed-note]')).toBeVisible();
    const row = await stored(id);
    expect(row.ticket.state).toBe('closed');
    expect(row.events.map((event) => [event.fromState, event.toState, event.actor])).toEqual([
      [null, 'issued', 'person'],
      ['issued', 'seen', 'person'],
      ['seen', 'closed', 'person'],
    ]);
  },

  async 'next-day-check-follows-the-clock-opens-offline-and-keeps-the-answer-on-the-phone'({ page, context, locale }) {
    const nextDayUrl = new RegExp(`/${locale}/next-day/$`);
    await visitOnline(page, locale);
    await triggerCrisis(page, locale);
    await page.getByRole('button', { name: msg(locale, 'crisis.safeNow'), exact: true }).click();
    await expect(page).not.toHaveURL(crisisUrl(locale));
    await page.waitForLoadState('load');
    await waitForStored(page, 'crisis:follow-up');
    expect(await rawStoreKeys(page)).toContain('crisis:follow-up');

    // Neither the card on home nor the screen says anything is due a minute short of a day on.
    const now = Date.now();
    await context.clock.setFixedTime(new Date(now + DAY_MS - 60_000));
    await page.goto(`/${locale}/`);
    await expect(page.locator('[data-trend], [data-prompt="reminder"], h1').first()).toBeVisible();
    await expect(page.locator('[data-prompt="next-day"]')).toHaveCount(0);
    await page.goto(`/${locale}/next-day/`);
    await expect(page.locator('[data-state="not-due"]')).toBeVisible();
    await expect(page.locator('[data-state="question"]')).toHaveCount(0);

    // A day and a minute on, with the network cut, the card is on home and the screen asks how the person is.
    await context.clock.setFixedTime(new Date(now + DAY_MS + 60_000));
    const sent: string[] = [];
    page.on('request', (request) => {
      if (request.url().startsWith(API) && request.method() !== 'GET') sent.push(`${request.method()} ${new URL(request.url()).pathname}`);
    });
    await goOffline(context);
    await page.goto(`/${locale}/`);
    const card = page.locator('[data-prompt="next-day"]');
    await expect(card).toBeVisible();
    await expect(card).toContainText(msg(locale, 'nextDay.cardBody'));
    await card.getByRole('link', { name: msg(locale, 'nextDay.cardAction'), exact: true }).click();
    await expect(page).toHaveURL(nextDayUrl);
    await expect(page.locator('[data-state="question"] h1')).toHaveText(msg(locale, 'nextDay.title'));
    await page.locator('[data-answer="worse"]').click();
    await expect(page.locator('[data-answer-given="worse"]')).toBeVisible();
    await expect(page.locator('[data-answer-given="worse"] [role="status"]')).toHaveText(msg(locale, 'nextDay.afterWorse'));
    // A worse answer puts "Help now" first, and the offer of a GP or a specialist follows.
    await expect(page.locator('[data-help-now]')).toHaveAttribute('href', `/${locale}/crisis/`);
    await expect(page.locator('[data-offer]')).toContainText(msg(locale, 'nextDay.offerTitle'));

    // The answer is kept on the phone: it survives a reload, the home card is gone, and nothing was written to the server.
    await page.reload();
    await expect(page.locator('[data-answer-given="worse"]')).toBeVisible();
    await page.goto(`/${locale}/`);
    await expect(page.locator('[data-trend], [data-prompt="reminder"], h1').first()).toBeVisible();
    await expect(page.locator('[data-prompt="next-day"]')).toHaveCount(0);
    expect(sent).toEqual([]);
  },

  async 'next-day-check-offers-a-ticket-through-matching-consent-and-the-crisis-guard'({ page, context, locale }) {
    await visitOnline(page, locale);
    await triggerCrisis(page, locale);
    await page.getByRole('button', { name: msg(locale, 'crisis.safeNow'), exact: true }).click();
    await expect(page).not.toHaveURL(crisisUrl(locale));
    await page.waitForLoadState('load');
    await waitForStored(page, 'crisis:follow-up');
    await context.clock.setFixedTime(new Date(Date.now() + DAY_MS + 60_000));

    // The offer leads into the ordinary flow: the options screen is matching on the phone ...
    await page.goto(`/${locale}/next-day/`);
    await page.locator('[data-answer="same"]').click();
    await page.locator('[data-offer-options]').click();
    // After a crisis from item 9 alone the only finished PHQ-9 totals 1, which ranks guided self-help first; the offer is for a
    // GP or a specialist, so those lead here and self-help waits behind "Show other options".
    await expect(page).toHaveURL(new RegExp(`^${escapeRe(BASE)}/${locale}/options/\\?focus=clinic$`));
    await expect(page.locator('[data-tier="gp"]')).toBeVisible();
    await expect(page.locator('[data-tier="specialist"]')).toBeVisible();
    await expect(page.locator('[data-tier="self_help"]')).toHaveCount(0);
    // Choosing the GP goes on to the consent screen: nothing is sent from here.
    await page.locator('[data-tier="gp"]').getByRole('button', { name: msg(locale, 'options.choose'), exact: true }).click();
    await expect(page).toHaveURL(consentUrl(locale));
    // ... and a fresh check-in then reaches the consent screen like any other referral.
    await page.goto(`/${locale}/next-day/`);
    await page.getByRole('link', { name: msg(locale, 'nextDay.checkInAction'), exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/${locale}/check-in/$`));
    await toConsent(page, locale);
    await expect(page).toHaveURL(consentUrl(locale));

    // A new crisis shuts the next-day screen like every other: it lands on the crisis screen, whatever the address.
    await triggerCrisis(page, locale);
    await page.goto(`/${locale}/next-day/`);
    await expect(page).toHaveURL(crisisUrl(locale), { timeout: 15_000 });
    await expect(page.locator('[data-screen="next-day"]')).toHaveCount(0);
  },
};

const ids = acceptance.map((entry) => entry.id);
if (JSON.stringify([...ids].sort()) !== JSON.stringify(Object.keys(CASES).sort())) {
  throw new Error(`e2e/acceptance-phase3.json and the cases in this file differ: ${ids.join(', ')} vs ${Object.keys(CASES).join(', ')}`);
}

test.describe('Phase 3 exit acceptance', () => {
  for (const entry of acceptance) {
    for (const locale of LOCALES) {
      test(`${entry.id} [${locale}]: ${entry.sentence}`, async ({ page, context, consoleGuard }) => {
        await CASES[entry.id]!({ page, context, locale, consoleGuard });
      });
    }
  }
});
