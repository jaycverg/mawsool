import { type BrowserContext, type Page, type Request } from '@playwright/test';
import { expect, test } from './fixtures';
import acceptance from './acceptance.json';
import {
  API,
  INSPECT,
  LOCALES,
  PHQ9_ITEM9_ANSWERS,
  answerAll,
  computed,
  seedTrend,
  snapshot,
  crisisUrl,
  finishButton,
  goOffline,
  installFailingIndexedDb,
  rawStoreDump,
  rawStoreKeys,
  setIdbMode,
  type IdbMode,
  watchNavigationRequests,
  msg,
  pick,
  staticHits,
  takeCheckIn,
  triggerCrisis,
  visitOnline,
  waitForStored,
  type Locale,
} from './helpers';

/**
 * Every sentence of Phase 2's exit acceptance, as its own named test, in both languages. `acceptance.json` is the
 * registry: the gate fails unless the report holds exactly one passing test per entry and locale.
 */
interface Context {
  page: Page;
  context: BrowserContext;
  locale: Locale;
}

/**
 * The trigger answer arrives while the browser's storage is failing. The crisis screen must still show, and the
 * block must hold for the rest of the tab: Back, a direct visit to each guarded screen, and a reload.
 */
async function blockSurvivesFailingStorage({ page, locale }: Context, mode: IdbMode): Promise<void> {
  const posts: { body: Record<string, unknown>; status: number }[] = [];
  page.on('response', (response) => {
    const request = response.request();
    if (request.url() === `${API}/crisis-events` && request.method() === 'POST') posts.push({ body: JSON.parse(request.postData() ?? '{}'), status: response.status() });
  });
  const eventRows = async (id: unknown) => (await (await fetch(`${INSPECT}/crisis-events/${id}`)).json()) as Record<string, unknown>[];
  /** Turns the failure off and reads the raw store on a fresh load of a page that does not touch the crisis path. */
  const rawStoreKeysOnceBack = async (target: Page) => {
    await setIdbMode(target, null);
    await target.goto(`/${locale}/settings/`);
    return rawStoreKeys(target);
  };
  await installFailingIndexedDb(page);
  await visitOnline(page, locale);
  await page.goto(`/${locale}/check-in/?i=phq9`);
  await answerAll(page, locale, [0, 0, 0, 0, 0, 0, 0, 0]);
  await page.getByRole('button', { name: msg(locale, 'flow.next'), exact: true }).click();
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '9');

  await setIdbMode(page, mode);
  await page.locator('input[type="radio"][value="1"]').click();
  await expect(page).toHaveURL(crisisUrl(locale), { timeout: 15_000 });
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(msg(locale, 'crisis.heading'));

  await page.goBack();
  await expect(page).toHaveURL(crisisUrl(locale), { timeout: 15_000 });
  for (const screen of ['options', 'consent', 'ticket', 'check-in', 'result']) {
    await page.goto(`/${locale}/${screen}/`);
    await expect(page).toHaveURL(crisisUrl(locale), { timeout: 15_000 });
    await expect(page.locator('[data-tier]')).toHaveCount(0);
  }
  await page.reload();
  await expect(page).toHaveURL(crisisUrl(locale));

  if (mode === 'hang') {
    // A store that never answers is waited on for about a second and a half, and then the person is told the truth:
    // no thanks for a contact that was not recorded.
    await page.getByRole('button', { name: msg(locale, 'crisis.callNow'), exact: true }).click();
    await page.getByRole('button', { name: msg(locale, 'crisis.reachedYes') }).click();
    await expect(page.getByText(msg(locale, 'crisis.reachedNotSaved'))).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(msg(locale, 'crisis.reachedThanks'))).toHaveCount(0);
  }

  // The failure was real: nothing about the trigger reached storage, so it was the tab's own mark that held the block.
  const keysWhileFailing = await rawStoreKeysOnceBack(page);
  expect(keysWhileFailing).not.toContain('crisis:block');

  // Storage works again, and a fresh load of the crisis screen repairs: the stored block and the crisis's one event
  // now exist, and the event reaches the API exactly once, with no item answers in it.
  await page.goto(`/${locale}/crisis/`);
  await expect.poll(async () => (await rawStoreKeys(page)).includes('crisis:block'), { timeout: 15_000 }).toBe(true);
  await expect.poll(() => posts.filter((post) => post.status === 201).length, { timeout: 15_000 }).toBe(1);
  const created = posts.find((post) => post.status === 201)!;
  expect(created.body).toMatchObject({ trigger: 'phq9_item9', locale, humanContactConfirmed: false, callTapped: null });
  expect(Object.keys(created.body).filter((key) => /answer|person|item|note|score/i.test(key))).toEqual([]);
  expect(JSON.stringify(created.body)).not.toContain('"answers"');
  const id = created.body['id'];
  expect(await eventRows(id)).toHaveLength(1);

  // A contact confirmed after recovery is recorded on that same event, and still one row.
  await page.getByRole('button', { name: msg(locale, 'crisis.callNow'), exact: true }).click();
  await page.getByRole('button', { name: msg(locale, 'crisis.reachedYes') }).click();
  await expect(page.getByText(msg(locale, 'crisis.reachedThanks'))).toBeVisible();
  await expect.poll(async () => (await eventRows(id))[0]?.['humanContactConfirmed'], { timeout: 15_000 }).toBe(true);
  expect(await eventRows(id)).toHaveLength(1);
  expect(posts.filter((post) => post.status === 201)).toHaveLength(1);
  expect(posts.every((post) => post.body['id'] === id)).toBe(true);

  // The block is stored now, so the guard holds it with or without the tab's mark.
  await page.goto(`/${locale}/options/`);
  await expect(page).toHaveURL(crisisUrl(locale), { timeout: 15_000 });

  // The person is never trapped: "I'm safe right now" gets them out, however storage behaves.
  await setIdbMode(page, mode);
  await page.getByRole('button', { name: msg(locale, 'crisis.safeNow'), exact: true }).click();
  await expect(page).not.toHaveURL(crisisUrl(locale), { timeout: 15_000 });

  // And with storage still failing, a guarded screen opened after the release does not stay blank: it lands on the
  // crisis screen, which shows its numbers without waiting on storage.
  await page.goto(`/${locale}/options/`);
  await expect(page).toHaveURL(crisisUrl(locale), { timeout: 15_000 });
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(msg(locale, 'crisis.heading'));
  for (const number of ['800725462', '998', '999']) await expect(page.locator(`a[href="tel:${number}"]`)).toBeVisible();
}

/**
 * Pixel snapshots of the key screens at 390 x 844, in both languages, from the same stored data and a clock fixed
 * at 29 Oct 2026 08:00 Dubai: a GAD-7 of 9 three weeks before one of 14. The baselines are for Chromium on macOS and on Linux,
 * one file each (see docs/browser-baselines.md).
 */
function screenSnapshot(screen: string, open: (ctx: Context) => Promise<void>): (ctx: Context) => Promise<void> {
  return async (ctx) => {
    await visitOnline(ctx.page, ctx.locale);
    await seedTrend(ctx.page, ctx.context, ctx.locale);
    await open(ctx);
    await snapshot(ctx.page, `${screen}-${ctx.locale}`);
  };
}


const CASES: Record<string, (ctx: Context) => Promise<void>> = {
  'snapshot-home': screenSnapshot('home', async ({ page, locale }) => {
    await page.goto(`/${locale}/`);
    await expect(page.locator('[data-trend]')).toBeVisible();
    await expect(page.getByText(msg(locale, 'home.greetingMorning'))).toBeVisible();
  }),
  'snapshot-check-in': screenSnapshot('check-in', async ({ page, locale }) => {
    await page.goto(`/${locale}/check-in/?i=phq9`);
    await expect(page.getByRole('progressbar')).toBeVisible();
  }),
  // The result is the screen the seeding ends on.
  'snapshot-result': screenSnapshot('result', async ({ page }) => {
    await expect(page.locator('[data-change="reliable_deterioration"]')).toBeVisible();
  }),
  'snapshot-check-ins': screenSnapshot('check-ins', async ({ page, locale }) => {
    await page.goto(`/${locale}/check-ins/`);
    await expect(page.locator('ul li')).toHaveCount(2);
  }),
  'snapshot-options': screenSnapshot('options', async ({ page, locale }) => {
    await page.goto(`/${locale}/options/`);
    await expect(page.locator('[data-tier]').first()).toBeVisible();
  }),
  'snapshot-crisis': screenSnapshot('crisis', async ({ page, locale }) => {
    await page.goto(`/${locale}/crisis/`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(msg(locale, 'crisis.heading'));
  }),
  'snapshot-settings': screenSnapshot('settings', async ({ page, locale }) => {
    await page.goto(`/${locale}/settings/`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(msg(locale, 'settings.title'));
  }),

  async 'block-survives-refused-storage'(ctx) {
    await blockSurvivesFailingStorage(ctx, 'refuse');
  },

  async 'block-survives-hung-storage'(ctx) {
    await blockSurvivesFailingStorage(ctx, 'hang');
  },

  // --- crisis, with the network off after one online visit --------------------------------------------------------

  async 'halts-at-crisis'({ page, context, locale }) {
    await visitOnline(page, locale);
    const before = await goOffline(context);
    await triggerCrisis(page, locale);
    // Nothing was fetched from the server while offline: every page came from the service worker's cache.
    expect(await staticHits()).toEqual(before);
    await expect(page.locator('[data-screen="crisis"]')).toBeVisible();
    await expect(page.locator('[data-tier]')).toHaveCount(0);
  },

  async 'reload-lands-on-crisis'({ page, context, locale }) {
    await visitOnline(page, locale);
    await goOffline(context);
    await triggerCrisis(page, locale);
    await page.reload();
    await expect(page).toHaveURL(crisisUrl(locale));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(msg(locale, 'crisis.heading'));
    // The questionnaire itself is shut as well: reloading it goes to the crisis screen.
    await page.goto(`/${locale}/check-in/?i=phq9`);
    await expect(page).toHaveURL(crisisUrl(locale));
  },

  async 'back-lands-on-crisis'({ page, context, locale }) {
    await visitOnline(page, locale);
    await goOffline(context);
    await triggerCrisis(page, locale);
    await page.goBack();
    await expect(page).toHaveURL(crisisUrl(locale));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(msg(locale, 'crisis.heading'));
    await expect(page.locator('input[type="radio"]')).toHaveCount(0);
  },

  async 'direct-options-lands-on-crisis'({ page, context, locale }) {
    await visitOnline(page, locale);
    await goOffline(context);
    await triggerCrisis(page, locale);
    for (const screen of ['options', 'consent', 'ticket']) {
      await page.goto(`/${locale}/${screen}/`);
      await expect(page).toHaveURL(crisisUrl(locale));
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(msg(locale, 'crisis.heading'));
    }
    // Not even briefly: the matching screen never rendered.
    await expect(page.locator('[data-tier]')).toHaveCount(0);
  },

  async 'direct-unslashed-lands-on-crisis'({ page, context, locale }) {
    await visitOnline(page, locale);
    const before = await goOffline(context);
    await triggerCrisis(page, locale);
    for (const screen of ['options', 'consent', 'ticket', 'check-in', 'check-ins', 'result']) {
      await page.goto(`/${locale}/${screen}`);
      await expect(page).toHaveURL(crisisUrl(locale));
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(msg(locale, 'crisis.heading'));
    }
    await expect(page.locator('[data-tier]')).toHaveCount(0);
    // All of it came from the service worker's cache: the server saw nothing while offline.
    expect(await staticHits()).toEqual(before);
  },

  async 'numbers-visible-and-tappable'({ page, context, locale }) {
    await visitOnline(page, locale);
    await goOffline(context);
    await triggerCrisis(page, locale);
    const screen = page.locator('[data-screen="crisis"]');
    const navigations = await watchNavigationRequests(page);
    for (const [number, text] of [
      ['800725462', '800 725462'],
      ['999', '999'],
      ['998', '998'],
    ] as const) {
      const link = screen.locator(`a[href="tel:${number}"]`);
      await expect(link).toBeVisible();
      await expect(link).toContainText(text);
      const box = (await link.boundingBox())!;
      expect(box.height, `${number} tap height`).toBeGreaterThanOrEqual(44);
      expect(box.width, `${number} tap width`).toBeGreaterThanOrEqual(44);
      const before = navigations.urls().length;
      await link.click();
      // The tap starts a real dial of exactly this number...
      await expect.poll(() => navigations.urls().slice(before)).toEqual([`tel:${number}`]);
      // ...it is logged against that number, and the person is still on the screen.
      await expect(screen).toHaveAttribute('data-last-call', number);
      await expect(page).toHaveURL(crisisUrl(locale));
    }
  },

  async 'call-now-keeps-block'({ page, context, locale }) {
    await visitOnline(page, locale);
    await goOffline(context);
    await triggerCrisis(page, locale);
    const navigations = await watchNavigationRequests(page);
    await page.getByRole('button', { name: msg(locale, 'crisis.callNow'), exact: true }).click();
    await expect.poll(() => navigations.urls()).toEqual(['tel:800725462']);
    await expect(page.getByRole('heading', { name: msg(locale, 'crisis.reachedTitle') })).toBeVisible();
    await expect(page.locator('[data-screen="crisis"]')).toHaveAttribute('data-last-call', '800725462');
    await page.getByRole('button', { name: msg(locale, 'crisis.reachedYes') }).click();
    await expect(page.getByText(msg(locale, 'crisis.reachedThanks'))).toBeVisible();
    // Calling, and even saying they reached someone, does not release the block.
    await expect(page).toHaveURL(crisisUrl(locale));
    for (const screen of ['options', 'consent', 'ticket']) {
      await page.goto(`/${locale}/${screen}/`);
      await expect(page).toHaveURL(crisisUrl(locale));
    }
    await page.reload();
    await expect(page).toHaveURL(crisisUrl(locale));
  },

  async 'safe-continue-releases-and-matches'({ page, context, locale }) {
    await visitOnline(page, locale);
    await goOffline(context);
    await triggerCrisis(page, locale);
    await page.getByRole('button', { name: msg(locale, 'crisis.safeNow'), exact: true }).click();
    // Released: on to the result of the check-in that fired it, then to matching, all offline.
    await expect(page).toHaveURL(new RegExp(`/${locale}/result/\\?id=`));
    await page.getByRole('link', { name: msg(locale, 'result.options'), exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/${locale}/options/`));
    const lead = page.locator('[data-tier][data-lead]');
    await expect(lead).toHaveCount(1);
    await expect(lead).toContainText(msg(locale, 'options.bestMatch'));
    await expect(page).not.toHaveURL(crisisUrl(locale));
    // And it stays released: a direct visit now opens the screen.
    await page.goto(`/${locale}/options/`);
    await expect(page).toHaveURL(new RegExp(`/${locale}/options/`));
    await expect(page.locator('[data-tier]').first()).toBeVisible();
    await expect(page.locator('[data-screen="crisis"]')).toHaveCount(0);
  },

  async 'queued-event-arrives-once'({ page, context, locale }) {
    const posts: { url: string; body: string; status: number | null; auth: string | undefined }[] = [];
    const bodies: string[] = [];
    page.on('request', (request) => {
      if (request.url().startsWith(API) && request.postData()) bodies.push(request.postData()!);
    });
    page.on('response', (response) => {
      const request = response.request();
      if (request.url() === `${API}/crisis-events` && request.method() === 'POST') {
        posts.push({ url: request.url(), body: request.postData() ?? '', status: response.status(), auth: request.headers()['authorization'] });
      }
    });

    await visitOnline(page, locale);
    await goOffline(context);
    await triggerCrisis(page, locale);
    await page.getByRole('button', { name: msg(locale, 'crisis.callNow'), exact: true }).click();
    await page.getByRole('button', { name: msg(locale, 'crisis.reachedYes') }).click();
    await expect(page.getByText(msg(locale, 'crisis.reachedThanks'))).toBeVisible();
    // Still offline: nothing has reached the server.
    expect(posts).toEqual([]);

    const arrived = page.waitForResponse((response) => response.url() === `${API}/crisis-events` && response.request().method() === 'POST' && response.ok());
    await context.setOffline(false);
    await arrived;
    await page.waitForTimeout(1500); // long enough for a duplicate to show up, if there were one

    expect(posts.filter((post) => post.status === 201 || post.status === 200)).toHaveLength(1);
    const body = JSON.parse(posts.at(-1)!.body) as Record<string, unknown>;
    // No item answers, no person id, no free text: exactly the event's own fields.
    expect(Object.keys(body).sort()).toEqual(
      ['callTapped', 'contactAt', 'contactSource', 'contextShared', 'humanContactConfirmed', 'id', 'locale', 'resolvedAt', 'shownAt', 'trigger'].sort(),
    );
    expect(body).toMatchObject({ trigger: 'phq9_item9', locale, callTapped: '800725462', humanContactConfirmed: true, contactSource: 'self_report', resolvedAt: null });
    expect(posts.at(-1)!.auth).toMatch(/^Bearer [0-9a-f-]{36}\./);
    // The check-in's answers appear in no request body at all.
    for (const sent of bodies) {
      expect(sent).not.toContain(JSON.stringify(PHQ9_ITEM9_ANSWERS));
      expect(sent).not.toMatch(/"answers"|"item9"|"personId"/);
    }
    // And the stored row, read from the database behind the API, is one row with the same facts.
    const rows = (await (await fetch(`${INSPECT}/crisis-events/${body['id']}`)).json()) as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: body['id'], trigger: 'phq9_item9', locale, callTapped: '800725462', humanContactConfirmed: true, contactSource: 'self_report', contextShared: false });
    expect(Object.keys(rows[0]!).sort()).toEqual(
      ['callTapped', 'contactAt', 'contactSource', 'contextShared', 'followUpAt', 'humanContactConfirmed', 'id', 'locale', 'resolvedAt', 'shownAt', 'trigger'].sort(),
    );
  },

  // --- the person flow --------------------------------------------------------------------------------------------

  async 'demo-persona-1-steps-2-5'({ page, context, locale }) {
    const dayOne = new Date('2026-10-08T08:00:00+04:00');
    const threeWeeksLater = new Date('2026-10-29T08:00:00+04:00');
    await context.clock.setFixedTime(dayOne);
    await visitOnline(page, locale);

    // Step 2: WHO-5 = 44, so GAD-7 and PHQ-9 are offered; GAD-7 = 9 (mild) and PHQ-9 = 7 (mild).
    await takeCheckIn(page, locale, 'who5', [3, 2, 2, 2, 2]);
    await expect(page.locator('[data-score]')).toHaveText('44');
    await expect(page.getByText(msg(locale, 'result.whoFollowUp'))).toBeVisible();
    await page.getByRole('link', { name: msg(locale, 'result.whoFollowUpGad7'), exact: true }).click();
    await answerAll(page, locale, [2, 1, 1, 1, 2, 1, 1]);
    await finishButton(page, locale).click();
    await expect(page.locator('[data-score]')).toHaveText('9');
    await expect(page.locator('[data-result="gad7"]')).toContainText(msg(locale, 'result.bands.mild'));
    await expect(page.getByRole('heading', { name: msg(locale, 'result.means') })).toBeVisible();
    await expect(page.getByRole('heading', { name: msg(locale, 'result.doesNotMean') })).toBeVisible();
    await expect(page.getByText(msg(locale, 'clinicalCopy.doesNotMean'))).toBeVisible();
    await page.getByRole('link', { name: msg(locale, 'result.alsoPhq9'), exact: true }).click();
    await answerAll(page, locale, [1, 1, 1, 1, 1, 1, 1, 0, 0]);
    await finishButton(page, locale).click();
    await expect(page.locator('[data-score]')).toHaveText('7');
    await expect(page.locator('[data-result="phq9"]')).toContainText(msg(locale, 'result.bands.mild'));

    // Step 3: guided self-help. It stays on the phone: no consent screen, no ticket.
    await page.getByRole('link', { name: msg(locale, 'result.options'), exact: true }).click();
    const lead = page.locator('[data-tier][data-lead]');
    await expect(lead).toHaveAttribute('data-tier', 'self_help');
    await lead.getByRole('button', { name: msg(locale, 'options.choose'), exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: msg(locale, 'options.savedTitle') })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/${locale}/options/`));

    // The clock moves three weeks. Step 4: GAD-7 = 14, up 5 points: reliable deterioration.
    await context.clock.setFixedTime(threeWeeksLater);
    await takeCheckIn(page, locale, 'gad7', [2, 2, 2, 2, 2, 2, 2]);
    await expect(page.locator('[data-score]')).toHaveText('14');
    await expect(page.locator('[data-result="gad7"]')).toContainText(msg(locale, 'result.bands.moderate'));
    const callout = page.locator('[data-change]');
    await expect(callout).toHaveAttribute('data-change', 'reliable_deterioration');
    await expect(callout).toContainText(locale === 'en' ? 'Up 5 points in 3 weeks' : 'ارتفعت النتيجة 5 نقاط خلال 3 أسابيع');

    // Matching re-runs: a trained GP within 7 days, a tele session, and the self-help the person is on.
    await page.getByRole('link', { name: msg(locale, 'result.options'), exact: true }).click();
    const cards = page.locator('[data-tier]');
    await expect(cards).toHaveCount(3);
    expect(await cards.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-tier')))).toEqual(['gp', 'tele', 'self_help']);
    await expect(cards.nth(0)).toHaveAttribute('data-lead', 'true');
    await expect(cards.nth(0)).toContainText(msg(locale, 'options.bestMatch'));
    await expect(cards.nth(0).locator('[data-promise]')).toHaveAttribute('data-promise', '7');
    await expect(cards.nth(2)).toContainText(msg(locale, 'options.currentSupport'));

    // Step 5: Daman Basic. A primary care visit is covered; private therapy is pay and claim. Always "indicative".
    await page.locator('#plan').selectOption('daman_basic');
    await expect(page.locator('[data-coverage-row="gp"]')).toContainText(msg(locale, 'options.coverage.covered'));
    await expect(page.locator('[data-coverage-row="specialist"]')).toContainText(msg(locale, 'options.coverage.pay_and_claim'));
    await expect(page.locator('[data-indicative]')).toHaveText(msg(locale, 'options.indicative'));
    await expect(cards.nth(0).locator('[data-coverage]')).toHaveAttribute('data-coverage', 'covered');
    await expect(page.getByText(msg(locale, 'options.sampleServices'))).toBeVisible();
    await expect(cards.nth(0)).toContainText(msg(locale, 'options.sampleData'));
  },

  async 'unverified-item-shows-label'({ page, locale }) {
    const label = page.locator('[data-wording="unverified"]');
    // The WHO-5 opener is unverified in both languages.
    await page.goto(`/${locale}/check-in/`);
    await expect(label).toBeVisible();
    await expect(label).toContainText(msg(locale, 'wording.unverifiedTitle'));
    await expect(label).toContainText(msg(locale, 'wording.unverifiedBody'));
    // The PHQ-9 is verified in English and unverified in Arabic.
    await page.goto(`/${locale}/check-in/?i=phq9`);
    await expect(page.getByRole('progressbar')).toBeVisible();
    await expect(label).toHaveCount(locale === 'ar' ? 1 : 0);
    // The result of an unverified check-in carries the label too.
    await page.goto(`/${locale}/check-in/`);
    await answerAll(page, locale, [3, 3, 3, 3, 3]);
    await finishButton(page, locale).click();
    await expect(page.locator('[data-result="who5"]')).toContainText(msg(locale, 'result.unverified'));
  },

  async 'no-matching-input-reaches-network'({ page, locale }) {
    const seen: { url: string; method: string; body: string | null; headers: Record<string, string> }[] = [];
    // Interception, not a log: every request to the API origin passes through here before it leaves.
    await page.route(`${API}/**`, async (route) => {
      const request: Request = route.request();
      seen.push({ url: request.url(), method: request.method(), body: request.postData(), headers: request.headers() });
      await route.continue();
    });
    const everyRequest: string[] = [];
    page.on('request', (request) => everyRequest.push(`${request.method()} ${request.url()} ${request.postData() ?? ''} ${JSON.stringify(request.headers())}`));

    await visitOnline(page, locale);
    // Distinctive matching inputs: a health plan, every preference, and scores.
    await takeCheckIn(page, locale, 'gad7', [3, 3, 3, 3, 3, 3, 0]);
    await page.getByRole('link', { name: msg(locale, 'result.options'), exact: true }).click();
    await page.locator('#plan').selectOption('thiqa');
    await page.locator('details[data-panel="preferences"] summary').click();
    await page.locator('#pref-language').selectOption('ur');
    await page.locator('#pref-clinicianGender').selectOption('female');
    await page.locator('#pref-modality').selectOption('tele');
    await page.locator('#pref-region').selectOption('al_ain');
    await page.locator('#pref-timeOfDay').selectOption('evening');
    await expect(page.locator('[data-tier]').first()).toBeVisible();
    await expect(page.locator('#plan')).toHaveValue('thiqa');

    // Positive control: the interception does see a request, with its query string, when the page makes one.
    await page.evaluate((url) => fetch(`${url}/health?control=thiqa-al_ain`).catch(() => undefined), API);
    const control = seen.filter((request) => request.url.includes('control='));
    expect(control, 'the control request was intercepted').toHaveLength(1);
    expect(control[0]!.url).toContain('thiqa-al_ain');

    // Everything else that went to the API is the unfiltered directory read and the demo clock's offset read: two plain
    // GETs of fixed addresses with no body and no credential, and nothing more. The directory's one query value is the
    // page's own language, so its names come back in it; no filter and nothing about the person goes with it.
    const toApi = seen.filter((request) => !request.url.includes('control='));
    expect(toApi.length, 'the directory was fetched, so the interception was live').toBeGreaterThanOrEqual(1);
    expect(toApi.some((request) => request.url === `${API}/services?locale=${locale}`)).toBe(true);
    for (const request of toApi) {
      expect([`${API}/services?locale=${locale}`, `${API}/clock`]).toContain(request.url);
      expect(request).toMatchObject({ method: 'GET', body: null });
      expect(request.headers['authorization']).toBeUndefined();
      expect(request.headers['cookie']).toBeUndefined();
    }
    // And none of the inputs appears in any request the page made, to any origin: URL, body or headers.
    for (const line of everyRequest.filter((entry) => !entry.includes('control='))) {
      expect(line.toLowerCase(), line).not.toMatch(/thiqa|daman|al_ain|cliniciangender|"ur"|=ur\b|evening|tele\b|score|answers/i);
    }
  },

  async 'crisis-path-does-not-wait-for-the-clock-read'({ page, locale }) {
    // The demo clock's offset read is held open for ever and never answered. The crisis screen, the release and matching
    // must all work as if it did not exist.
    const sent: string[] = [];
    await page.route(`${API}/clock`, () => {
      sent.push('GET /clock (held)');
    });
    await page.route(`${API}/**`, async (route) => {
      const request = route.request();
      if (request.url() === `${API}/clock`) return route.fallback();
      sent.push(`${request.method()} ${new URL(request.url()).pathname} ${request.postData() ?? ''}`);
      await route.continue();
    });
    await visitOnline(page, locale);
    await expect.poll(() => sent.some((entry) => entry.startsWith('GET /clock')), { timeout: 10_000 }).toBe(true);
    await triggerCrisis(page, locale);
    await expect(page.locator('[data-screen="crisis"]')).toBeVisible();
    await expect(page.locator('[data-tier]')).toHaveCount(0);
    await page.getByRole('button', { name: msg(locale, 'crisis.safeNow'), exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/${locale}/result/\\?id=`));
    await page.getByRole('link', { name: msg(locale, 'result.options'), exact: true }).click();
    await expect(page.locator('[data-tier]').first()).toBeVisible();
  },

  async 'self-help-sends-nothing'({ page, locale }) {
    const seen: string[] = [];
    // Interception, not a log: every request to the API origin passes through here before it leaves.
    await page.route(`${API}/**`, async (route) => {
      seen.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
      await route.continue();
    });
    const afterChoice: string[] = [];
    let chosen = false;
    page.on('request', (request) => {
      if (chosen) afterChoice.push(`${request.method()} ${request.url()}`);
    });

    await visitOnline(page, locale);
    await page.goto(`/${locale}/options/`);
    const lead = page.locator('[data-tier][data-lead]');
    await expect(lead).toHaveAttribute('data-tier', 'self_help');
    await expect(page.locator('[data-tier]').first()).toBeVisible();

    // Positive control: a request the page makes after the choice would be seen by both the interception and the log.
    chosen = true;
    await lead.getByRole('button', { name: msg(locale, 'options.choose'), exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: msg(locale, 'options.savedTitle') })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/${locale}/options/`));
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
    expect(afterChoice, 'choosing self-help sent nothing').toEqual([]);
    chosen = false;

    await page.evaluate((url) => fetch(`${url}/health?control=1`).catch(() => undefined), API);
    expect(seen.filter((entry) => entry.includes('/health')), 'the interception sees a request the page makes').toEqual(['GET /health']);
    // Everything that ever went to the API on this device is the unfiltered directory read and the demo clock's offset read: no registration, no consent, no ticket.
    expect(seen.filter((entry) => !entry.includes('/health')).every((entry) => entry === 'GET /services' || entry === 'GET /clock')).toBe(true);
    expect(seen.some((entry) => /^(POST|PUT|DELETE|PATCH) /.test(entry))).toBe(false);
  },

  async 'tokens-at-phone-width'({ page, locale }) {
    await visitOnline(page, locale);
    const lineHeight = locale === 'ar' ? { h1: '34px', body: '24px' } : { h1: '30px', body: '22px' };
    for (const screen of ['', 'check-in/', 'check-ins/', 'options/', 'settings/', 'crisis/']) {
      await page.goto(`/${locale}/${screen}`);
      await expect(page.locator('main').first()).toBeVisible();
      if (screen === 'options/') await expect(page.locator('[data-tier]').first()).toBeVisible();

      // Nothing runs off the 390 px screen, and the document sits in the right direction.
      const layout = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, dir: document.documentElement.dir }));
      expect(layout.width, `${screen} overflows 390 px`).toBeLessThanOrEqual(390);
      expect(layout.dir).toBe(locale === 'ar' ? 'rtl' : 'ltr');

      // Every control a finger can reach is at least 44 px each way; the call to action is 52 px tall.
      const small = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('a[href], button, select, summary')]
          .filter((element) => element.offsetParent !== null)
          .map((element) => ({ name: (element.textContent ?? element.getAttribute('aria-label') ?? element.tagName).trim().slice(0, 40), box: element.getBoundingClientRect() }))
          .filter(({ box }) => box.width > 0 && (box.height < 43.5 || box.width < 43.5))
          .map(({ name, box }) => `${name}: ${Math.round(box.width)}x${Math.round(box.height)}`),
      );
      expect(small, `${screen} has controls under 44 px`).toEqual([]);
      for (const cta of await page.locator('.btn-primary:visible').all()) {
        expect((await cta.boundingBox())!.height).toBeGreaterThanOrEqual(52);
      }
    }

    // Type from the plan: h1 24/30 (Arabic 24/34) at weight 600, body 15/22 (Arabic 15/24), IBM Plex Sans.
    await page.goto(`/${locale}/`);
    const h1 = page.locator('h1');
    await expect(h1).toHaveCSS('font-size', '24px');
    await expect(h1).toHaveCSS('line-height', lineHeight.h1);
    await expect(h1).toHaveCSS('font-weight', '600');
    await expect(page.locator('p.t-body').first()).toHaveCSS('font-size', '15px');
    await expect(page.locator('p.t-body').first()).toHaveCSS('line-height', lineHeight.body);
    await expect(page.locator('body')).toHaveCSS('font-family', /IBM Plex Sans/);
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(243, 246, 245)');
    await expect(page.locator('body')).toHaveCSS('color', 'rgb(16, 48, 45)');
    await expect(page.locator('.btn-primary').first()).toHaveCSS('background-color', 'rgb(14, 107, 99)');
    await expect(page.locator('section').first()).toHaveCSS('border-radius', '16px');
  },

  async 'edit-after-last-answer'({ page, locale }) {
    await visitOnline(page, locale);
    const progress = page.getByRole('progressbar');
    const back = async (steps: number) => {
      for (let step = 0; step < steps; step += 1) await page.getByRole('button', { name: msg(locale, 'flow.back'), exact: true }).click();
    };

    // Seven GAD-7 answers of 1 (total 7), then change the last, a middle one and the first, all on the same check-in.
    await page.goto(`/${locale}/check-in/?i=gad7`);
    await answerAll(page, locale, [1, 1, 1, 1, 1, 1, 1]);
    await pick(page, 3); // last: 7 -> 9
    await back(3);
    await expect(progress).toHaveAttribute('aria-valuenow', '4');
    await pick(page, 3); // middle: 9 -> 11
    await back(3);
    await expect(progress).toHaveAttribute('aria-valuenow', '1');
    await pick(page, 0); // first: 11 -> 10
    await expect(page.getByText(msg(locale, 'checkIn.saveFailed'))).toHaveCount(0);
    for (let step = 0; step < 6; step += 1) await page.getByRole('button', { name: msg(locale, 'flow.next'), exact: true }).click();
    await finishButton(page, locale).click();
    await expect(page.locator('[data-score]')).toHaveText('10');
    await expect(page.locator('[data-result="gad7"]')).toContainText(msg(locale, 'result.bands.moderate'));
    // One check-in, not two.
    await page.goto(`/${locale}/check-ins/`);
    await expect(page.locator('ul li')).toHaveCount(1);

    // A finished PHQ-9 whose item 9 moves from "not at all" to "several days" blocks, and the result carries it.
    await page.goto(`/${locale}/check-in/?i=phq9`);
    await answerAll(page, locale, [0, 0, 0, 0, 0, 0, 0, 0, 0]);
    await page.locator('input[type="radio"][value="1"]').click();
    await expect(page).toHaveURL(crisisUrl(locale));
    await page.getByRole('button', { name: msg(locale, 'crisis.safeNow'), exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/${locale}/result/\\?id=`));
    await expect(page.locator('[data-score]')).toHaveText('1');
  },

  async 'help-now-after-resolved-crisis-logs-nothing'({ page, locale }) {
    const posts: { body: Record<string, unknown>; status: number }[] = [];
    page.on('response', (response) => {
      const request = response.request();
      if (request.url() === `${API}/crisis-events` && request.method() === 'POST') posts.push({ body: JSON.parse(request.postData() ?? '{}'), status: response.status() });
    });
    const row = async (id: unknown) => (await (await fetch(`${INSPECT}/crisis-events/${id}`)).json()) as Record<string, unknown>[];

    await visitOnline(page, locale);
    await triggerCrisis(page, locale);
    await page.getByRole('button', { name: msg(locale, 'crisis.safeNow'), exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/${locale}/result/\\?id=`));
    // The resolved event reaches the API: one row, with its resolution.
    await expect.poll(() => posts.some((post) => post.body['resolvedAt'] !== null && post.status < 300), { timeout: 15_000 }).toBe(true);
    const id = posts[0]!.body['id'];
    await expect.poll(async () => (await row(id))[0]?.['resolvedAt'] ?? null, { timeout: 15_000 }).not.toBeNull();
    const settled = { posts: posts.length, row: await row(id) };

    // "Help now" from the result screen: the screen opens, a number can be tapped, nothing is asked or logged.
    await page.getByRole('link', { name: msg(locale, 'common.helpNow') }).click();
    await expect(page).toHaveURL(crisisUrl(locale));
    await page.getByRole('button', { name: msg(locale, 'crisis.callNow'), exact: true }).click();
    await page.locator('a[href="tel:998"]').click();
    await expect(page.getByRole('heading', { name: msg(locale, 'crisis.reachedTitle') })).toHaveCount(0);
    await expect(page.locator('[data-screen="crisis"]')).not.toHaveAttribute('data-last-call', /.+/);
    // Reload it too: the old event is not brought back, with its prompt.
    await page.reload();
    await expect(page.getByRole('heading', { name: msg(locale, 'crisis.reachedTitle') })).toHaveCount(0);
    await page.waitForTimeout(1500); // long enough for a stray send to show up
    expect(posts.length).toBe(settled.posts);
    expect(await row(id)).toEqual(settled.row);
  },

  async 'board-measurements-at-390'({ page, context, locale }) {
    const ar = locale === 'ar';
    const lh = { h1: ar ? '34px' : '30px', body: ar ? '24px' : '22px' };
    const firstFamily = ar ? 'IBM Plex Sans Arabic' : 'IBM Plex Sans';
    await visitOnline(page, locale);
    await seedTrend(page, context, locale);

    // Result: h2 700, body 15/22 (Arabic 15/24), eyebrow plain in Arabic, trend 150 tall, the Arabic face first.
    for (const key of ['result.means', 'result.doesNotMean']) {
      expect(await computed(page, `h2:text-is("${msg(locale, key)}")`, ['font-size', 'font-weight']), key).toMatchObject({ 'font-size': '16px', 'font-weight': '700' });
    }
    expect(await computed(page, `h2:text-is("${msg(locale, 'result.means')}") + p`, ['font-size', 'line-height'])).toMatchObject({ 'font-size': '15px', 'line-height': lh.body });
    expect(await computed(page, '[data-result] > span:first-child', ['text-transform', 'letter-spacing'])).toMatchObject(
      ar ? { 'text-transform': 'none', 'letter-spacing': 'normal' } : { 'text-transform': 'uppercase', 'letter-spacing': '0.6px' },
    );
    expect(await computed(page, 'svg[role="img"]', [])).toMatchObject({ height: 150 });
    expect(String((await computed(page, 'body', ['font-family']))['font-family'])).toMatch(new RegExp(`^"?${firstFamily}"?,`));

    // Home: the sparkline is 64 tall; the Help now pill pads 14 (Arabic 12); the privacy note is 20 in Arabic.
    await page.goto(`/${locale}/`);
    expect(await computed(page, 'svg[role="img"]', [])).toMatchObject({ height: 64 });
    expect(await computed(page, `a:has-text("${msg(locale, 'common.helpNow')}")`, ['padding-left', 'padding-right'])).toMatchObject({ 'padding-left': ar ? '12px' : '14px', 'padding-right': ar ? '12px' : '14px' });
    if (ar) expect(await computed(page, `p:has-text("${msg(locale, 'home.stored')}")`, ['line-height'])).toMatchObject({ 'line-height': '20px' });

    // Check-in: disclaimer 19, and Back and Next in a 1:2 split of the 346 px left after the gap.
    await page.goto(`/${locale}/check-in/?i=who5`);
    expect(await computed(page, `p:text-is("${msg(locale, 'checkIn.note')}")`, ['line-height'])).toMatchObject({ 'line-height': '19px' });
    const [back, next] = await page.locator('main > div:has(> .btn-primary) > *').evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().width));
    expect(back).toBeCloseTo(115.33, 0);
    expect(next).toBeCloseTo(230.67, 0);

    // Options: h1 on the plan token, card h2 700, and the compact self-help card.
    await page.goto(`/${locale}/options/`);
    await expect(page.locator('[data-tier]').first()).toBeVisible();
    expect(await computed(page, 'h1', ['font-size', 'line-height', 'font-weight'])).toMatchObject({ 'font-size': '24px', 'line-height': lh.h1, 'font-weight': '600' });
    expect(await computed(page, '[data-tier][data-lead] h2', ['font-size', 'font-weight'])).toMatchObject({ 'font-size': '18px', 'font-weight': '700' });
    await page.getByRole('button', { name: msg(locale, 'options.showOther'), exact: true }).click();
    const selfHelp = page.locator('[data-tier="self_help"]:not([data-lead])');
    expect(await computed(page, '[data-tier="self_help"]:not([data-lead])', ['padding-top', 'padding-bottom'])).toMatchObject({ 'padding-top': '14px', 'padding-bottom': '14px' });
    await expect(selfHelp.locator('h2')).toHaveCSS('font-size', '16px');
    await expect(selfHelp.locator('h2')).toHaveCSS('font-weight', '700');
    await expect(selfHelp.locator('button')).toHaveCSS('font-size', '15px');
    await expect(selfHelp.locator('button')).toHaveCSS('border-top-left-radius', '22px');
    expect(await computed(page, '[data-tier="self_help"]:not([data-lead]) button', [])).toMatchObject({ height: 44 });

    // Crisis: plain wordmark and dark toggle; the hotline card's second line is one 14/19 line of number and detail.
    await page.goto(`/${locale}/crisis/`);
    expect(await computed(page, 'h1', ['font-size', 'line-height', 'font-weight'])).toMatchObject({ 'font-size': '24px', 'line-height': lh.h1, 'font-weight': '600' });
    if (!ar) expect(await computed(page, '.wordmark', ['letter-spacing'])).toMatchObject({ 'letter-spacing': 'normal' });
    expect(await computed(page, 'a.lang-toggle', ['color'])).toMatchObject({ color: 'rgb(42, 20, 20)' });
    const detail = page.locator('a[href="tel:800725462"] > span:last-child > span:last-child');
    await expect(detail).toHaveCSS('font-size', '14px');
    await expect(detail).toHaveCSS('line-height', '19px');
    await expect(detail).toContainText('800 725462');
    await expect(detail).toContainText('·');
    // The call title has the board's `normal` line height: 25 tall and a 97 tall card in English (Arabic has its own).
    const title = page.locator('a[href="tel:800725462"] > span:last-child > span:first-child');
    await expect(title).toHaveCSS('line-height', 'normal');
    if (!ar) {
      // `normal` is the font's own height, which Chromium rounds one way on macOS (the board's 25) and another on Linux (27, in
      // the official Playwright image). Each platform's figure is exact, and the card is the title plus the same 72 px of padding
      // and detail line on both.
      const titleHeight = process.platform === 'darwin' ? 25 : 27;
      expect(await computed(page, 'a[href="tel:800725462"] > span:last-child > span:first-child', [])).toMatchObject({ height: titleHeight });
      expect(await computed(page, 'a[href="tel:800725462"]', [])).toMatchObject({ height: titleHeight + 72 });
    }

    // Crisis prompt answers are body text: 15/22 in English, 15/24 in Arabic.
    await triggerCrisis(page, locale);
    await page.getByRole('button', { name: msg(locale, 'crisis.callNow'), exact: true }).click();
    await page.getByRole('button', { name: msg(locale, 'crisis.reachedNo') }).click();
    expect(await computed(page, `p:text-is("${msg(locale, 'crisis.reachedLater')}")`, ['font-size', 'line-height'])).toMatchObject({ 'font-size': '15px', 'line-height': lh.body });
    await page.getByRole('button', { name: msg(locale, 'crisis.callNow'), exact: true }).click();
    await page.getByRole('button', { name: msg(locale, 'crisis.reachedYes') }).click();
    expect(await computed(page, `p:text-is("${msg(locale, 'crisis.reachedThanks')}")`, ['font-size', 'line-height'])).toMatchObject({ 'font-size': '15px', 'line-height': lh.body });
  },

  async 'data-is-encrypted-at-rest'({ page, locale }) {
    await visitOnline(page, locale);
    // Real data through the real screens: a PHQ-9, a health plan and every preference.
    await takeCheckIn(page, locale, 'phq9', [3, 2, 1, 0, 1, 2, 3, 1, 0]);
    await expect(page.locator('[data-score]')).toHaveText('13');
    await page.getByRole('link', { name: msg(locale, 'result.options'), exact: true }).click();
    await page.locator('#plan').selectOption('thiqa');
    await page.locator('details[data-panel="preferences"] summary').click();
    await page.locator('#pref-language').selectOption('ur');
    await page.locator('#pref-region').selectOption('al_ain');
    await expect(page.locator('[data-tier]').first()).toBeVisible();
    // Guided self-help stays on the phone: a choice is saved without leaving the screen.
    await page.getByRole('button', { name: msg(locale, 'options.showOther'), exact: true }).click();
    await page.locator('[data-tier="self_help"] button').click();
    await expect(page.getByRole('status').filter({ hasText: msg(locale, 'options.savedTitle') })).toBeVisible();

    // And a crisis trigger, so the crisis block and the queued event are rows in the store too.
    await triggerCrisis(page, locale);
    await waitForStored(page, 'crisis:block');
    await waitForStored(page, 'crisis:outbox');

    await expect.poll(async () => (await rawStoreDump(page)).map((entry) => entry.key).sort(), { timeout: 10_000 }).toEqual(
      expect.arrayContaining(['__device-key', 'choice', 'crisis:block', 'crisis:outbox', 'directory', 'insurance', 'preferences', 'screenings']),
    );
    const dump = await rawStoreDump(page);
    const key = dump.find((entry) => entry.key === '__device-key')!;
    expect(key).toMatchObject({ kind: 'crypto-key', extractable: false, exportRejected: true, algorithm: { name: 'AES-GCM', length: 256 } });
    expect(key.usages).toEqual(expect.arrayContaining(['encrypt', 'decrypt']));

    const rows = dump.filter((entry) => entry.key !== '__device-key');
    expect(rows.length).toBeGreaterThanOrEqual(7);
    for (const row of rows) {
      // Each row is an IV and AES-GCM ciphertext, never the data.
      expect(row, row.key).toMatchObject({ kind: 'envelope', envelopeFields: ['ct', 'iv', 'v'], ivLength: 12 });
      expect(row.text, `${row.key} leaks`).not.toMatch(/answers|instrument|phq9|gad7|thiqa|al_ain|takenAt|item9|trigger|shownAt|eventId|"ur"|secret|services|Sample/i);
    }
  },

  async 'settings-download-and-delete'({ page, locale }) {
    await visitOnline(page, locale);
    await takeCheckIn(page, locale, 'phq9', [3, 2, 1, 0, 1, 2, 3, 1, 0]);
    await expect(page.locator('[data-score]')).toHaveText('13');

    await page.goto(`/${locale}/settings/`);
    await page.getByRole('button', { name: msg(locale, 'settings.download'), exact: true }).click();
    const exported = JSON.parse(await page.getByLabel(msg(locale, 'settings.dataLabel')).inputValue()) as { screenings: Record<string, unknown>[] } & Record<string, unknown>;
    expect(Object.keys(exported).sort()).toEqual(['choice', 'crisis', 'exportedAt', 'insurance', 'preferences', 'reminders', 'screenings', 'sharing', 'tickets']);
    expect(exported.screenings).toHaveLength(1);
    expect(exported.screenings[0]).toMatchObject({ instrument: 'phq9', answers: [3, 2, 1, 0, 1, 2, 3, 1, 0], total: 13, band: 'moderate', item9Flag: false });
    expect(JSON.stringify(exported)).not.toMatch(/secret/i); // the device credential is not the person's data

    expect((await rawStoreDump(page)).length).toBeGreaterThan(0);
    await page.getByRole('button', { name: msg(locale, 'settings.delete'), exact: true }).click();
    await page.getByRole('button', { name: msg(locale, 'settings.deleteYes'), exact: true }).click();
    await expect(page.getByText(msg(locale, 'settings.deleted'))).toBeVisible();
    // Nothing is left in the raw store, key included.
    await expect.poll(() => rawStoreKeys(page), { timeout: 10_000 }).toEqual([]);

    await page.goto(`/${locale}/check-ins/`);
    await expect(page.getByText(msg(locale, 'checkIns.empty'))).toBeVisible();
  },

  async 'console-clean-and-favicon'({ page, locale }) {
    const problems: string[] = [];
    const requested: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') problems.push(`console ${message.type()}: ${message.text()}`);
    });
    page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
    page.on('requestfailed', (request) => problems.push(`request failed: ${request.url()} ${request.failure()?.errorText}`));
    page.on('response', (response) => {
      requested.push(response.url());
      if (response.status() >= 400) problems.push(`HTTP ${response.status()}: ${response.url()}`);
    });

    await visitOnline(page, locale);
    for (const screen of ['', 'check-ins/', 'check-in/', 'check-in/?i=phq9', 'result/', 'options/', 'settings/', 'consent/', 'ticket/', 'crisis/']) {
      await page.goto(`/${locale}/${screen}`);
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      await expect(page.locator('main, [data-screen]').first()).toBeVisible();
      // The page links a favicon and it answers 200 as an image. (Browsers fetch favicons outside the page's own
      // network log, so the link is fetched here, and the server's log shows no request for /favicon.ico.)
      const icon = await page.evaluate(async () => {
        const link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
        if (!link) return null;
        const response = await fetch(link.href);
        return { status: response.status, type: response.headers.get('content-type') };
      });
      expect(icon, `${screen} links a favicon`).toEqual({ status: 200, type: expect.stringContaining('image/svg+xml') });
    }
    expect(problems).toEqual([]);
    expect(requested.length).toBeGreaterThan(10); // the log was live
    expect((await staticHits())['/favicon.ico']).toBeUndefined();
  },
};

const ids = acceptance.map((entry) => entry.id);
if (JSON.stringify([...ids].sort()) !== JSON.stringify(Object.keys(CASES).sort())) {
  throw new Error(`e2e/acceptance.json and the cases in this file differ: ${ids.join(', ')} vs ${Object.keys(CASES).join(', ')}`);
}

test.describe('Phase 2 exit acceptance', () => {
  for (const entry of acceptance) {
    for (const locale of LOCALES) {
      test(`${entry.id} [${locale}]: ${entry.sentence}`, async ({ page, context }) => {
        await CASES[entry.id]!({ page, context, locale });
      });
    }
  }
});
