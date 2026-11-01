import { type Browser, type BrowserContext, type Page } from '@playwright/test';
import { expect, test } from './fixtures';
import acceptance from './acceptance-c.json';
import {
  API,
  BASE,
  INSPECT,
  LOCALES,
  answerAll,
  computed,
  finishButton,
  msg,
  snapshot,
  takeCheckIn,
  type Locale,
} from './helpers';
import { CLINIC, CLINICIAN_A, FACILITY_A, OPS, bearer, call, cmsg, keepSession, makeTicket, newPerson, serviceAt, staffSession } from './staff-helpers';
import commonAr from '../../../packages/ui/messages/ar.json';
import commonEn from '../../../packages/ui/messages/en.json';
import opsAr from '../../ops/messages/ar.json';
import opsEn from '../../ops/messages/en.json';

/**
 * Gate C: the whole demo script, steps 1 to 12, in Arabic and in English, against the real API with `DEMO_MODE` on, the
 * real person export and the real clinician and ops production builds, in a real Chromium. The browser fails on any
 * console error and this gate allows none: no URL, no status, no test is excused.
 *
 * `acceptance-c.json` is the registry. The sentences of the exit acceptance that a server test can prove are in
 * `scripts/gate-c.json`, which `pnpm gate:c` checks first.
 */
const OPS_MESSAGES = { ar: { ...commonAr, ...opsAr }, en: { ...commonEn, ...opsEn } } as unknown as Record<Locale, Record<string, unknown>>;
function omsg(locale: Locale, path: string, values: Record<string, string | number> = {}): string {
  const found = path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], OPS_MESSAGES[locale]);
  if (typeof found !== 'string') throw new Error(`no ops message ${path} in ${locale}`);
  return Object.entries(values).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, String(value)), found);
}

interface Context {
  page: Page;
  context: BrowserContext;
  browser: Browser;
  locale: Locale;
}

const DAY = 86_400_000;
const opsUrl = (locale: Locale, path = '') => `${OPS}/${locale}/${path}`;
const clinicUrl = (locale: Locale, query = '') => `${CLINIC}/${locale}/${query}`;
const ADMIN = 'admin@demo.mawsool.test';
const OPS_USER = 'ops@demo.mawsool.test';

async function signedInPage(context: BrowserContext, origin: string, email: string): Promise<Page> {
  await keepSession(context, origin, await staffSession(email));
  return context.newPage();
}

/** The demo clock's offset in milliseconds, as the API reports it to anyone. */
async function offsetMs(): Promise<number> {
  return ((await call('GET', '/clock')).json() as { offsetMs: number }).offsetMs;
}

/** Presses Reset on the admin panel (twice: it asks first) and returns Noura's invite code as the panel shows it. */
async function resetFromPanel(admin: Page, locale: Locale): Promise<string> {
  await admin.goto(opsUrl(locale));
  await expect(admin.locator('[data-clock-state="on"]')).toBeVisible();
  const button = admin.locator('[data-reset]');
  await button.click();
  await expect(button).toHaveText(omsg(locale, 'admin.reset.confirm'));
  await button.click();
  await expect(admin.locator('[data-reset-message]')).toHaveText(omsg(locale, 'admin.reset.done'));
  const code = (await admin.locator('[data-noura-code]').innerText()).trim();
  expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  return code;
}

/** Presses a clock step on the admin panel and waits for the panel to report the new offset. */
async function advanceFromPanel(admin: Page, by: '7d' | '3w' | '6w', expectedDays: number): Promise<void> {
  await admin.locator(`[data-advance="${by}"]`).click();
  await expect(admin.locator('[data-offset-days]')).toHaveAttribute('data-offset-days', String(expectedDays));
  await expect(admin.locator('[data-clock-message]')).toBeVisible();
  expect(await offsetMs()).toBe(expectedDays * DAY);
}

/** The Dubai calendar day a time falls on, as a day number (UTC+4, no daylight saving). */
const dubaiDay = (ms: number) => Math.floor((ms + 4 * 3_600_000) / DAY);
/** Where "the last 90 days" begins, the way the API counts it: the start of the Dubai day 90 days back. */
const since90 = (now: number) => new Date((dubaiDay(now - 90 * DAY)) * DAY - 4 * 3_600_000);

async function funnelParts(now: number, since: Date | null): Promise<{ openInvites: number; journeys: number; crisisEvents: number; total: number }> {
  const query = new URLSearchParams({ now: new Date(now).toISOString(), ...(since ? { since: since.toISOString() } : {}) });
  return (await (await fetch(`${INSPECT}/funnel-parts?${query}`)).json()) as { openInvites: number; journeys: number; crisisEvents: number; total: number };
}

interface Stored {
  ticket: { id: string; shortCode: string; state: string; source: string; deadlineAt: string; createdAt: string };
  events: { seq: number; fromState: string | null; toState: string; actor: string }[];
  consents: { element: string }[];
}
const stored = async (id: string): Promise<Stored> => (await (await fetch(`${INSPECT}/tickets/${id}`)).json()) as Stored;

const stageCount = (page: Page, stage: string) => page.locator(`[data-funnel-stage="${stage}"]`);
const numberOf = async (text: Promise<string>) => Number((await text).replace(/[^0-9.]/g, ''));

/** Opens the ops dashboard as the ops user and waits for the figures. */
async function dashboard(browser: Browser, locale: Locale): Promise<Page> {
  // Its own browser context: the admin panel's tab keeps the admin session, and this one is the ops user's.
  const page = await signedInPage(await browser.newContext(), OPS, OPS_USER);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(opsUrl(locale));
  await expect(page.locator('[data-funnel-stage="positive_screen"]')).toBeVisible();
  return page;
}

/**
 * The unfiltered dashboard stays readable: the funnel from the positive screen to seen, the four tier rows, the crisis
 * figures and the Urdu row are numbers, not "Suppressed" (a suppressed cell fails here, where a mere non-empty check would
 * accept the word), and the Urdu row is flagged.
 */
async function expectReadable(dash: Page, when: string): Promise<void> {
  for (const stage of ['positive_screen', 'ticket_issued', 'acknowledged', 'seen']) {
    const cell = stageCount(dash, stage);
    await expect(cell.locator('[data-count]'), `${stage} ${when}`).toHaveText(/\d/);
    await expect(cell.locator('[data-suppressed]'), `${stage} ${when}`).toHaveCount(0);
  }
  for (const tier of ['community', 'tele', 'gp', 'specialist']) {
    const row = dash.locator(`[data-tier-row="${tier}"]`);
    await expect(row, `${tier} row ${when}`).not.toHaveAttribute('data-suppressed', /.*/);
    await expect(row, `${tier} row ${when}`).toContainText(/\d/);
  }
  for (const stat of ['shown', 'called', 'median', 'confirmed']) {
    const value = dash.locator(`[data-crisis-stat="${stat}"] [data-value]`);
    await expect(value, `crisis ${stat} ${when}`).toHaveText(/\d/);
    await expect(value.locator('[data-suppressed]'), `crisis ${stat} ${when}`).toHaveCount(0);
  }
  const urdu = dash.locator('[data-equity-rows="language"] [data-equity-row="ur"]');
  await expect(urdu, `Urdu row ${when}`).toBeVisible();
  await expect(urdu, `Urdu row ${when}`).not.toHaveAttribute('data-suppressed', /.*/);
  await expect(urdu, `Urdu row ${when}`).toHaveAttribute('data-flagged', 'true');
  const gap = Number(await urdu.getAttribute('data-gap'));
  expect(gap, `Urdu gap ${when}`).toBeLessThanOrEqual(-18);
  expect(gap, `Urdu gap ${when}`).toBeGreaterThanOrEqual(-22);
}

const CASES: Record<string, (ctx: Context) => Promise<void>> = {
  async 'demo-steps-1-to-12'({ page, context, browser, locale }) {
    test.setTimeout(300_000);
    const admin = await signedInPage(context, OPS, ADMIN);

    // Reset: the panel loads the seed and hands the presenter Noura's invite code and the mock TAMM page that takes it.
    const code = await resetFromPanel(admin, locale);
    await expectReadable(await dashboard(browser, locale), 'after the reset');
    await expect(admin.locator(`[data-tamm-link="${locale}"]`)).toHaveAttribute('href', `${BASE}/${locale}/tamm/?code=${code}`);
    expect((await funnelParts(Date.now(), null)).openInvites).toBeGreaterThan(0);

    // Step 1: the mock TAMM page, labelled, leads to the claim screen; Noura claims the invite.
    await page.goto(`${BASE}/${locale}/tamm/?code=${code}`);
    await expect(page.locator('[data-mock-banner]')).toHaveText(msg(locale, 'tamm.mockBanner'));
    await page.locator('[data-continue-with-mawsool]').click();
    await expect(page.locator('#invite-code')).toHaveValue(code);
    await page.getByRole('button', { name: msg(locale, 'claim.claim'), exact: true }).click();
    await expect(page.locator('[data-claimed="tamm"]')).toContainText(msg(locale, 'claim.source.tamm'));

    // Step 2: WHO-5 = 44 offers GAD-7 and PHQ-9; GAD-7 = 9 and PHQ-9 = 7, both mild, with the explainer.
    await takeCheckIn(page, locale, 'who5', [3, 2, 2, 2, 2]);
    await expect(page.locator('[data-score]')).toHaveText('44');
    await page.getByRole('link', { name: msg(locale, 'result.whoFollowUpGad7'), exact: true }).click();
    await answerAll(page, locale, [2, 1, 1, 1, 2, 1, 1]);
    await finishButton(page, locale).click();
    await expect(page.locator('[data-score]')).toHaveText('9');
    await expect(page.getByText(msg(locale, 'clinicalCopy.doesNotMean'))).toBeVisible();
    await page.getByRole('link', { name: msg(locale, 'result.alsoPhq9'), exact: true }).click();
    await answerAll(page, locale, [1, 1, 1, 1, 1, 1, 1, 0, 0]);
    await finishButton(page, locale).click();
    await expect(page.locator('[data-score]')).toHaveText('7');

    // Step 3: guided self-help, which stays on the phone. The demo clock moves three weeks, from the admin panel.
    await page.getByRole('link', { name: msg(locale, 'result.options'), exact: true }).click();
    await expect(page.locator('[data-tier][data-lead]')).toHaveAttribute('data-tier', 'self_help');
    await page.locator('[data-tier][data-lead]').getByRole('button', { name: msg(locale, 'options.choose'), exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: msg(locale, 'options.savedTitle') })).toBeVisible();
    await admin.bringToFront();
    await advanceFromPanel(admin, '3w', 21);

    // Step 4: three weeks later the phone reads the offset on load; GAD-7 = 14 is a reliable deterioration, up 5 points.
    const clockRead = page.waitForResponse((response) => response.url() === `${API}/clock`);
    await page.goto(`/${locale}/check-in/?i=gad7`);
    await clockRead;
    await answerAll(page, locale, [2, 2, 2, 2, 2, 2, 2]);
    await finishButton(page, locale).click();
    await expect(page.locator('[data-score]')).toHaveText('14');
    await expect(page.locator('[data-change]')).toHaveAttribute('data-change', 'reliable_deterioration');
    await expect(page.locator('[data-change]')).toContainText(locale === 'en' ? 'Up 5 points in 3 weeks' : 'ارتفعت النتيجة 5 نقاط خلال 3 أسابيع');
    await page.getByRole('link', { name: msg(locale, 'result.options'), exact: true }).click();
    const cards = page.locator('[data-tier]');
    await expect(cards).toHaveCount(3);
    expect(await cards.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-tier')))).toEqual(['gp', 'tele', 'self_help']);
    await expect(cards.nth(0).locator('[data-promise]')).toHaveAttribute('data-promise', '7');

    // Step 5: the insurance panel, always "indicative".
    await page.locator('#plan').selectOption('daman_basic');
    await expect(page.locator('[data-coverage-row="gp"]')).toContainText(msg(locale, 'options.coverage.covered'));
    await expect(page.locator('[data-coverage-row="specialist"]')).toContainText(msg(locale, 'options.coverage.pay_and_claim'));
    await expect(page.locator('[data-indicative]')).toHaveText(msg(locale, 'options.indicative'));

    // Step 6: scores and trajectory are shared, the free-text note is not; the draft is edited and approved.
    await cards.nth(0).getByRole('button', { name: msg(locale, 'options.choose'), exact: true }).click();
    await expect(page.locator('[data-screen="consent"]')).toBeVisible();
    await page.locator('#note').fill('NOURA-PRIVATE-NOTE-4471');
    await page.locator('input[data-element="scores"]').check();
    await page.locator('input[data-element="trajectory"]').check();
    await page.getByRole('button', { name: msg(locale, 'consent.draft'), exact: true }).click();
    await expect(page.locator('[data-summary="template"]')).toBeVisible();
    await page.locator('#summary').fill('I would like a first appointment about my worry and low mood. Mornings are best.');
    await page.getByRole('button', { name: msg(locale, 'consent.approve'), exact: true }).click();
    await expect(page.getByText(msg(locale, 'consent.approved'))).toBeVisible();

    // Step 7: the ticket: short code, QR code, a deadline seven days out, and the source the TAMM invite gave it.
    await page.getByRole('button', { name: msg(locale, 'consent.send'), exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/${locale}/ticket/\\?id=`));
    await expect(page.locator('[data-code]')).toBeVisible();
    await expect(page.locator('[data-qr]')).toBeVisible();
    const ticketId = new URL(page.url()).searchParams.get('id')!;
    const issued = await stored(ticketId);
    expect(issued.ticket.source).toBe('tamm');
    expect(dubaiDay(Date.parse(issued.ticket.deadlineAt)) - dubaiDay(Date.parse(issued.ticket.createdAt))).toBe(7);
    expect(issued.consents.map((consent) => consent.element).sort()).toEqual(['scores', 'ticket', 'trajectory']);

    // Step 8: the clinic's queue holds the ticket; the GP opens it, sees the note was not shared, and acknowledges.
    const clinic = await signedInPage(context, CLINIC, CLINICIAN_A);
    await clinic.goto(clinicUrl(locale));
    const ticketRow = clinic.locator(`[data-queue] tr[data-ticket="${issued.ticket.shortCode}"]`);
    await expect(ticketRow).toBeVisible();
    await ticketRow.getByRole('button').click();
    await expect(clinic.locator('[data-section="free_text"] [data-not-shared]')).toHaveText(cmsg(locale, 'detail.notShared'));
    await expect(clinic.locator('body')).not.toContainText('NOURA-PRIVATE-NOTE-4471');
    await expect(clinic.locator('[data-export-label]')).toHaveText(cmsg(locale, 'detail.exportLabel'));
    await clinic.getByRole('button', { name: cmsg(locale, 'detail.acknowledge'), exact: true }).click();
    await expect(ticketRow).toHaveAttribute('data-state', 'acknowledged');

    // Step 9: the clock moves seven days. Noura's day-7 check asks "Did you get seen?"; Yes, and the loop closes.
    await admin.bringToFront();
    await advanceFromPanel(admin, '7d', 28);
    const clockReadAgain = page.waitForResponse((response) => response.url() === `${API}/clock`);
    await page.reload();
    await clockReadAgain;
    await expect(page.locator('[data-prompt="follow-up"]')).toBeVisible();
    await page.getByRole('button', { name: msg(locale, 'ticket.followUpYes'), exact: true }).click();
    await expect(page.locator('[data-step="seen"]')).toHaveAttribute('data-done', 'true');
    const closed = await stored(ticketId);
    expect(closed.ticket.state).toBe('seen');
    expect(closed.events.map((event) => event.toState)).toEqual(['issued', 'acknowledged', 'seen']);
    expect(closed.events.some((event) => event.toState === 'overdue')).toBe(false);

    // Step 10: Rashid, on another phone, answers PHQ-9 item 9 "several days": the crisis screen, then Call, then contact confirmed.
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const rashid = await phone.newPage();
    const posts: { body: Record<string, unknown>; status: number }[] = [];
    rashid.on('response', (response) => {
      const request = response.request();
      if (request.url() === `${API}/crisis-events` && request.method() === 'POST') posts.push({ body: JSON.parse(request.postData() ?? '{}'), status: response.status() });
    });
    await rashid.goto(`${BASE}/${locale}/`);
    await takeCheckIn(rashid, locale, 'phq9', [0, 0, 0, 0, 0, 0, 0, 0, 1]);
    await expect(rashid.getByRole('heading', { level: 1 })).toHaveText(msg(locale, 'crisis.heading'));
    for (const number of ['800 725462', '999', '998']) await expect(rashid.locator('[data-screen="crisis"]')).toContainText(number);
    await rashid.getByRole('button', { name: msg(locale, 'crisis.callNow'), exact: true }).click();
    await rashid.locator('a[href="tel:800725462"]').click();
    await rashid.getByRole('button', { name: msg(locale, 'crisis.reachedYes'), exact: true }).click();
    await expect.poll(() => posts.some((post) => post.body['humanContactConfirmed'] === true && post.status < 300), { timeout: 15_000 }).toBe(true);
    const crisisId = posts[0]!.body['id'];
    const rows = (await (await fetch(`${INSPECT}/crisis-events/${crisisId}`)).json()) as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ callTapped: '800725462', humanContactConfirmed: true, contactSource: 'self_report' });
    expect(JSON.stringify(rows[0])).not.toMatch(/personId|person_id/);

    // Step 11: the dashboard. The first stage equals the plan's formula, counted straight from the tables, and Noura's
    // claimed invite and her ticket are one screen, not two.
    const dash = await dashboard(browser, locale);
    const now = Date.now() + (await offsetMs());
    for (const [period, since] of [['all', null], ['90d', since90(now)]] as const) {
      await dash.locator('[data-filter="period"]').selectOption(period);
      const parts = await funnelParts(now, since);
      await expect(stageCount(dash, 'positive_screen').locator('[data-count]')).toHaveText(new Intl.NumberFormat(locale === 'ar' ? 'ar-AE-u-nu-latn' : 'en-GB').format(parts.total));
    }
    await expect(dash.locator('[data-funnel-note]')).toHaveText(omsg(locale, 'dash.funnel.note'));
    // The pitch view: the board's default "Last 90 days", 28 days into the demo, and then all time.
    await dash.locator('[data-filter="period"]').selectOption('90d');
    await expectReadable(dash, 'in the default view after the demo clock moved 28 days');
    await expect(stageCount(dash, 'remeasured')).toBeVisible(); // shown or suppressed: no re-measured ticket is left in the last 90 days by then
    await dash.locator('[data-filter="period"]').selectOption('all');
    await expectReadable(dash, 'in all time after the demo clock moved 28 days');

    // Step 12: the equity view flags Urdu 18 to 22 points below the overall rate. It is served for one period only (the last 90
    // days), so it reads the same with the period filter on All time as on Last 90 days, and says so on the section.
    const equity = dash.locator('[data-section="equity"]');
    await expect(equity.locator('[data-equity-period]')).toHaveText(omsg(locale, 'dash.equity.period'));
    const urdu = dash.locator('[data-equity-rows="language"] [data-equity-row="ur"]');
    await expect(urdu).toHaveAttribute('data-flagged', 'true');
    const gap = Number(await urdu.getAttribute('data-gap'));
    expect(gap).toBeLessThanOrEqual(-18);
    expect(gap).toBeGreaterThanOrEqual(-22);
    await expect(dash.locator('[data-flag="ur"]')).toContainText(omsg(locale, 'dash.equity.value.ur'));
    // The filter is on All time now. Switch it to Last 90 days and back: the funnel moves, the equity section does not, and
    // the page only ever asks the API for equity over 90 days.
    const equityCalls: string[] = [];
    dash.on('request', (request) => {
      if (request.url().includes('/metrics/equity')) equityCalls.push(request.url());
    });
    const firstStage = stageCount(dash, 'positive_screen').locator('[data-count]');
    const allTime = await firstStage.innerText();
    const equityAtAllTime = await equity.innerText();
    await dash.locator('[data-filter="period"]').selectOption('90d');
    await expect(firstStage).not.toHaveText(allTime);
    expect(await equity.innerText(), 'the equity section does not follow the period filter (90 days)').toBe(equityAtAllTime);
    await dash.locator('[data-filter="period"]').selectOption('all');
    await expect(firstStage).toHaveText(allTime);
    expect(await equity.innerText(), 'the equity section does not follow the period filter (all time)').toBe(equityAtAllTime);
    expect(equityCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of equityCalls) expect(call).toContain('period=90d');
    await phone.close();
  },

  async 'dashboard-funnel-formula-and-note'({ context, browser, locale }) {
    const admin = await signedInPage(context, OPS, ADMIN);
    await resetFromPanel(admin, locale);
    const dash = await dashboard(browser, locale);
    const now = Date.now() + (await offsetMs());
    await dash.locator('[data-filter="period"]').selectOption('all');
    const parts = await funnelParts(now, null);
    // Seeded: open invites, parentless tickets, crisis events, and Noura's fresh invite are all in the sum.
    expect(parts.openInvites).toBe(36 + 1);
    expect(parts.journeys).toBe(470);
    expect(parts.crisisEvents).toBe(40);
    const stage = stageCount(dash, 'positive_screen');
    await expect(stage.locator('[data-count]')).toHaveText(new Intl.NumberFormat(locale === 'ar' ? 'ar-AE-u-nu-latn' : 'en-GB').format(parts.total));
    const note = dash.locator('[data-funnel-note]');
    await expect(note).toBeVisible();
    await expect(note).toHaveText(omsg(locale, 'dash.funnel.note'));
    // A filter by source counts rows carrying that field: crisis events drop out. The app has no invites, so its first stage is its
    // journeys. Of the three front doors only tamm shows a first stage on this seed; phc and school are hidden, because the table
    // hides cells around the small ones in it (school has 8 journeys in the community tier).
    await dash.locator('[data-filter="source"]').selectOption('app');
    const app = await numberOf(stageCount(dash, 'positive_screen').locator('[data-count]').innerText());
    expect(app).toBe(await numberOf(stageCount(dash, 'ticket_issued').locator('[data-count]').innerText()));
    expect(app).toBeLessThan(parts.total - parts.crisisEvents);
    // tamm is the door whose first stage is shown here: its twelve open invites (and Noura's) are not a small number, and
    // nothing small beside them needs hiding, so the first stage is its journeys plus those invites.
    await dash.locator('[data-filter="source"]').selectOption('tamm');
    const tammFirst = await numberOf(stageCount(dash, 'positive_screen').locator('[data-count]').innerText());
    const tammIssued = await numberOf(stageCount(dash, 'ticket_issued').locator('[data-count]').innerText());
    expect(tammFirst - tammIssued).toBe(12 + 1);
    await expect(dash.locator('[data-filter-scope]')).toHaveText(omsg(locale, 'dash.filters.scope'));
  },

  async 'dashboard-shows-suppressed-cells'({ context, browser, locale }) {
    const admin = await signedInPage(context, OPS, ADMIN);
    await resetFromPanel(admin, locale);
    const dash = await dashboard(browser, locale);
    await dash.locator('[data-filter="period"]').selectOption('all');
    // The seed has 8 school journeys in the community tier: fewer than ten, so every stage count is hidden, and nothing else stands in its place.
    await dash.locator('[data-filter="source"]').selectOption('school');
    await dash.locator('[data-filter="tier"]').selectOption('community');
    const first = stageCount(dash, 'positive_screen');
    // Every hidden cell says the same neutral thing: many are hidden only to protect a small one, so a size would be false.
    expect(omsg(locale, 'dash.suppressed')).toBe(locale === 'en' ? 'Suppressed to protect small groups' : 'مخفي لحماية المجموعات الصغيرة');
    expect(omsg(locale, 'dash.suppressed')).not.toMatch(/\d|fewer|أقل/);
    await expect(first.locator('[data-suppressed]')).toHaveText(omsg(locale, 'dash.suppressed'));
    await expect(first.locator('[data-count]')).toHaveCount(0);
    await expect(stageCount(dash, 'remeasured').locator('[data-suppressed]')).toBeVisible();
    // The equity table hides every group under ten as "Suppressed", with no bar, flag or rate.
    const hidden = dash.locator('[data-equity-row][data-suppressed]');
    expect(await hidden.count()).toBeGreaterThan(0);
    for (const row of await hidden.all()) {
      await expect(row).not.toHaveAttribute('data-flagged', /.*/);
      await expect(row).toContainText(omsg(locale, 'dash.suppressed'));
    }
  },

  async 'admin-panel-controls-clock-and-reset'({ context, locale }) {
    const admin = await signedInPage(context, OPS, ADMIN);
    await admin.goto(opsUrl(locale));
    // The crisis numbers' last_verified date is on the panel, with the demo on as well as off.
    const section = admin.locator('[data-section="crisis-numbers"]');
    for (const number of ['800725462', '999', '998']) await expect(section.locator(`[data-crisis-number="${number}"] [data-last-verified]`)).toHaveText(omsg(locale, 'admin.crisis.never'));
    await resetFromPanel(admin, locale);
    await expect(admin.locator('[data-offset-days]')).toHaveAttribute('data-offset-days', '0');
    await advanceFromPanel(admin, '6w', 42);
    await advanceFromPanel(admin, '7d', 49);
    // Reset puts the clock back to real time.
    await resetFromPanel(admin, locale);
    await expect(admin.locator('[data-offset-days]')).toHaveAttribute('data-offset-days', '0');
    expect(await offsetMs()).toBe(0);
    // An ops session, not an admin one, sees the dashboard and not the controls; both are refused by the API.
    const opsSession = await staffSession(OPS_USER);
    expect((await call('POST', '/demo/reset', { headers: bearer(opsSession) })).status).toBe(403);
    expect((await call('POST', '/demo/clock/advance', { headers: bearer(opsSession), body: { by: '7d' } })).status).toBe(403);
  },

  async 'clinic-queue-follows-the-demo-clock'({ context, locale }) {
    const admin = await signedInPage(context, OPS, ADMIN);
    await resetFromPanel(admin, locale);
    // A new ticket's row says how many calendar days are left; seven demo days later the same row counts from the demo clock.
    const person = await newPerson();
    const made = await makeTicket(person, { serviceId: await serviceAt(FACILITY_A, 'gp') });
    const staff = await staffSession(CLINICIAN_A);
    const detail = (await call('GET', `/tickets/${made.id}`, { headers: bearer(staff) })).json() as { deadlineAt: string };
    const clinic = await signedInPage(context, CLINIC, CLINICIAN_A);
    await clinic.goto(clinicUrl(locale, '?state=open'));
    const deadline = clinic.locator(`[data-queue] tr[data-ticket="${made.shortCode}"] [data-days-until]`);
    const daysUntil = (now: number) => dubaiDay(Date.parse(detail.deadlineAt)) - dubaiDay(now);
    await expect(deadline).toHaveAttribute('data-days-until', String(daysUntil(Date.now())));
    expect(daysUntil(Date.now())).toBeGreaterThanOrEqual(6);
    await advanceFromPanel(admin, '7d', 7);
    await clinic.reload();
    await expect(deadline).toHaveAttribute('data-days-until', String(daysUntil(Date.now() + 7 * DAY)));
    expect(daysUntil(Date.now() + 7 * DAY)).toBe(0); // seven days on, the promise falls due today
    await advanceFromPanel(admin, '7d', 14);
    await clinic.reload();
    await expect(deadline).toHaveAttribute('data-days-until', String(daysUntil(Date.now() + 14 * DAY)));
    expect(daysUntil(Date.now() + 14 * DAY)).toBe(-7);
  },

  async 'mock-label-audit'({ page, context, browser, locale }) {
    const admin = await signedInPage(context, OPS, ADMIN);
    const code = await resetFromPanel(admin, locale);
    // The mock TAMM page.
    await page.goto(`${BASE}/${locale}/tamm/?code=${code}`);
    await expect(page.locator('[data-mock-banner]')).toHaveText(msg(locale, 'tamm.mockBanner'));
    await expect(page.getByText(msg(locale, 'tamm.mockNote'))).toBeVisible();
    // Instrument wording that is not a validated translation carries its label.
    await page.goto(`/${locale}/check-in/`);
    await expect(page.locator('[data-wording="unverified"]')).toContainText(msg(locale, 'wording.unverifiedTitle'));
    // The sample directory and indicative insurance.
    await takeCheckIn(page, locale, 'phq9', [2, 2, 2, 1, 1, 1, 1, 1, 0]);
    await page.getByRole('link', { name: msg(locale, 'result.options'), exact: true }).click();
    await expect(page.getByText(msg(locale, 'options.sampleServices'))).toBeVisible();
    await expect(page.locator('[data-tier][data-lead]')).toContainText(msg(locale, 'options.sampleData'));
    // The insurance panel carries its own Sample label, apart from its "indicative only" wording, which is not a label.
    await expect(page.locator('[data-panel="insurance"] [data-sample-insurance]')).toHaveText(msg(locale, 'options.sampleInsurance'));
    await expect(page.locator('[data-indicative]')).toHaveText(msg(locale, 'options.indicative'));
    expect(msg(locale, 'options.sampleInsurance')).not.toBe(msg(locale, 'options.indicative'));
    // The clinic's export is labelled "not sent".
    const person = await newPerson();
    const made = await makeTicket(person, { serviceId: await serviceAt(FACILITY_A, 'gp') });
    const clinic = await signedInPage(context, CLINIC, CLINICIAN_A);
    await clinic.goto(clinicUrl(locale, `?ticket=${made.id}`));
    await expect(clinic.locator('[data-export-label]')).toHaveText(cmsg(locale, 'detail.exportLabel'));
    expect(cmsg('en', 'detail.exportLabel')).toBe('Malaffi-ready export — not sent');
    // The dashboard says its figures are simulated, and so does the admin panel.
    const dash = await dashboard(browser, locale);
    await expect(dash.locator('[data-simulated]')).toHaveText(omsg(locale, 'home.simulated'));
    await expect(dash.locator('[data-simulated-note]')).toHaveText(omsg(locale, 'dash.simulatedNote'));
    // The sample directory's waits sit in a closed disclosure; opened, they say they are the mock services' listed waits.
    await dash.locator('details summary').click();
    await expect(dash.getByText(omsg(locale, 'dash.timeliness.waitNote'))).toBeVisible();
    await admin.goto(opsUrl(locale));
    await expect(admin.getByText(omsg(locale, 'home.simulated'))).toBeVisible();
    // Messaging and the crisis-line console are Phase 6 surfaces and are not built, so there is nothing of them to label.
  },

  async 'staff-apps-have-icons-and-log-no-console-error'({ context, locale }) {
    for (const [name, origin, email, home] of [
      ['clinician', CLINIC, CLINICIAN_A, clinicUrl(locale)],
      ['ops', OPS, OPS_USER, opsUrl(locale)],
    ] as const) {
      const signedOut = await context.newPage();
      await signedOut.goto(`${origin}/${locale}/sign-in/`);
      await expect(signedOut.locator('main')).toBeVisible();
      const iconHref = await signedOut.locator('link[rel~="icon"]').first().getAttribute('href');
      expect(iconHref, `${name} declares an icon`).toBeTruthy();
      const icon = await signedOut.request.get(new URL(iconHref!, origin).toString());
      expect(icon.status(), `${name} icon`).toBe(200);
      expect(icon.headers()['content-type']).toContain('image/svg');
      const page = await signedInPage(context, origin, email);
      await page.goto(home);
      await expect(page.locator('main, [data-queue]').first()).toBeVisible();
      await page.waitForLoadState('networkidle');
    }
  },

  async 'dashboard-toggle-and-rtl'({ browser, locale }) {
    const dash = await dashboard(browser, locale);
    await expect(dash.locator('html')).toHaveAttribute('lang', locale);
    await expect(dash.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
    const other = locale === 'ar' ? 'en' : 'ar';
    const toggle = dash.locator('a.lang-toggle');
    await expect(toggle).toHaveAttribute('href', `/${other}/`);
    // In Arabic the page runs right to left: the funnel's first bar starts at the right edge of its card.
    const box = await dash.locator('[data-section="funnel"]').boundingBox();
    const bar = await dash.locator('[data-funnel-stage="positive_screen"] [aria-hidden] > div').boundingBox();
    expect(box && bar).toBeTruthy();
    if (locale === 'ar') expect(Math.abs(box!.x + box!.width - (bar!.x + bar!.width))).toBeLessThan(40);
    else expect(Math.abs(bar!.x - box!.x)).toBeLessThan(40);
    await toggle.click();
    await expect(dash.locator('html')).toHaveAttribute('lang', other);
    await expect(dash.locator('[data-funnel-stage="positive_screen"]')).toBeVisible();
  },

  async 'dashboard-holds-the-board-and-plan-tokens'({ context, browser, locale }) {
    // From a fresh reset, so the figures (and the Urdu flag the checks below read) do not depend on which tests ran before.
    await resetFromPanel(await signedInPage(context, OPS, ADMIN), locale);
    const dash = await dashboard(browser, locale);
    const ar = locale === 'ar';
    const h1 = await computed(dash, 'h1', ['font-size', 'line-height', 'font-weight']);
    expect(h1).toMatchObject({ 'font-size': '24px', 'line-height': ar ? '34px' : '30px', 'font-weight': '600' });
    const tile = await computed(dash, '[data-tile="loop-closed"]', ['border-top-left-radius', 'background-color', 'border-top-color']);
    expect(tile['border-top-left-radius']).toBe('14px');
    expect(tile['background-color']).toBe('rgb(255, 255, 255)');
    expect(tile['border-top-color']).toBe('rgb(213, 223, 220)');
    const select = await computed(dash, '[data-filter="period"]', ['border-top-left-radius', 'font-size']);
    expect(select).toMatchObject({ 'border-top-left-radius': '10px', 'font-size': '15px' });
    expect(Number(select['height'])).toBeGreaterThanOrEqual(44);
    const chip = await computed(dash, '[data-simulated]', ['background-color', 'color', 'border-top-left-radius', 'font-size']);
    expect(chip).toMatchObject({ 'background-color': 'rgb(231, 228, 242)', color: 'rgb(62, 52, 112)', 'border-top-left-radius': '8px', 'font-size': '12px' });
    const value = await computed(dash, '[data-tile="loop-closed"] [data-value]', ['font-size', 'font-weight', 'line-height']);
    expect(value).toMatchObject({ 'font-size': '36px', 'font-weight': '700', 'line-height': '44px' });
    const bar = await computed(dash, '[data-funnel-stage="positive_screen"] [aria-hidden]', ['height', 'border-top-left-radius']);
    expect(bar).toMatchObject({ 'border-top-left-radius': '4px' });
    expect(Number(bar['height'])).toBe(22);
    for (const button of await dash.locator('[data-dimension]').all()) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect(dash.locator('body')).toHaveCSS('background-color', 'rgb(243, 246, 245)');

    // Ops.dc.html, measured at 1440: section headings and column headings are bold, the heading sits 10px above the table, the
    // last row has no rule, and figures are whole numbers.
    await dash.setViewportSize({ width: 1440, height: 900 });
    for (const section of ['funnel', 'equity', 'timeliness', 'safety']) expect((await computed(dash, `[data-section="${section}"] h2`, ['font-weight']))['font-weight'], `${section} heading`).toBe('700');
    expect((await computed(dash, '[data-section="timeliness"] th', ['font-weight']))['font-weight']).toBe('700');
    const heading = (await dash.locator('[data-section="timeliness"] h2').boundingBox())!;
    const table = (await dash.locator('[data-section="timeliness"] table').boundingBox())!;
    expect(Math.round(table.y - (heading.y + heading.height))).toBe(10);
    expect((await computed(dash, '[data-section="timeliness"] tbody tr:last-child td', ['border-bottom-width']))['border-bottom-width']).toBe('0px');
    await expect(dash.locator('[data-section="timeliness"] th')).toHaveCount(6);
    await expect(dash.locator('[data-section="timeliness"] th').nth(1)).toHaveText(omsg(locale, 'dash.timeliness.target'), { ignoreCase: true });
    await expect(dash.locator('[data-tile="loop-closed"] [data-value]')).toHaveText(/^\d+%$/);
    await expect(dash.locator('[data-tile="median-seen"] [data-value]')).toHaveText(/^\d+\D+$/);
    for (const row of await dash.locator('[data-equity-row]:not([data-suppressed]) > span:last-child').all()) await expect(row).toHaveText(/^\d+%/);
    const countColumn = await dash.locator('[data-equity-row="ur"] > span:last-child').boundingBox();
    // The board's 76px count column in English; the Arabic has no board and its longer figures may widen it, but never wrap.
    if (locale === 'en') expect(Math.round(countColumn!.width)).toBe(76);
    else expect(Math.round(countColumn!.width)).toBeGreaterThanOrEqual(76);
    const countLine = parseFloat(String((await computed(dash, '[data-equity-row="ur"] > span:last-child', ['line-height']))['line-height']));
    expect(countColumn!.height, 'the count stays on one line').toBeLessThanOrEqual(countLine + 1);
    const note = dash.locator('[data-tile="within-target"] > div').last();
    const lineHeight = parseFloat(String((await computed(dash, '[data-tile="within-target"] > div:last-child', ['line-height']))['line-height']));
    expect((await note.boundingBox())!.height, 'the tile note fits one line').toBeLessThanOrEqual(lineHeight + 1);
    // The flag note: the board's 18px warning triangle, and only the word "Flag:" in bold.
    const flag = dash.locator('[data-flag="ur"]');
    const icon = await flag.locator('svg').boundingBox();
    expect([Math.round(icon!.width), Math.round(icon!.height)]).toEqual([18, 18]);
    await expect(flag.locator('b')).toHaveCount(1);
    await expect(flag.locator('b')).toHaveText(omsg(locale, 'dash.equity.flagLabel'));
    // A tier whose within-target share is ten points or more under the overall one is marked (the board's 58% against 71%).
    const cell = (within: number) => ({ tickets: 40, withinTarget: { count: Math.round(within * 0.4), of: 40, percent: within }, medianDaysToSeen: 6, p90DaysToSeen: 12 });
    await dash.route(`${API}/metrics/timeliness*`, (route) =>
      route.fulfill({
        json: {
          period: '90d',
          overall: { tickets: 160, withinTarget: { count: 114, of: 160, percent: 71 }, medianDaysToSeen: 6, p90DaysToSeen: 12 },
          tiers: [{ tier: 'community', cell: cell(74) }, { tier: 'tele', cell: cell(88) }, { tier: 'gp', cell: cell(74) }, { tier: 'specialist', cell: cell(58) }],
          overdue: { suppressed: true },
          indicativeWait: [],
        },
      }),
    );
    await dash.reload();
    await expect(dash.locator('[data-tier-row="specialist"]')).toBeVisible();
    const marked = dash.locator('[data-tier-row="specialist"] [data-below-target]');
    await expect(marked).toHaveCount(1);
    expect(await computed(dash, '[data-tier-row="specialist"] [data-below-target]', ['font-weight', 'color'])).toMatchObject({ 'font-weight': '600', color: 'rgb(122, 62, 6)' });
    await expect(dash.locator('[data-below-target]')).toHaveCount(1);
  },

  async 'snapshot-ops-dashboard'({ context, browser, locale }) {
    // From a fresh reset, so the figures do not depend on which tests ran before this one.
    await resetFromPanel(await signedInPage(context, OPS, ADMIN), locale);
    const dash = await dashboard(browser, locale);
    await dash.locator('[data-filter="period"]').selectOption('all');
    await expect(dash.locator('[data-equity-row="ur"]')).toBeVisible();
    await snapshot(dash, `ops-dashboard-${locale}`);
  },
};

const ids = acceptance.map((entry) => entry.id);
if (JSON.stringify([...ids].sort()) !== JSON.stringify(Object.keys(CASES).sort())) {
  throw new Error(`e2e/acceptance-c.json and the cases in this file differ: ${ids.join(', ')} vs ${Object.keys(CASES).join(', ')}`);
}

test.describe('Gate C: the demo', () => {
  for (const entry of acceptance) {
    for (const locale of LOCALES) {
      test(`${entry.id} [${locale}]: ${entry.sentence}`, async ({ page, context, browser, consoleGuard }) => {
        consoleGuard.forbidAllowances();
        await CASES[entry.id]!({ page, context, browser, locale });
      });
    }
  }
});
