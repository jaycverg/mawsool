import { expect, test, type BrowserContext, type Page, type Request } from '@playwright/test';
import acceptance from './acceptance.json';
import {
  API,
  INSPECT,
  LOCALES,
  PHQ9_ITEM9_ANSWERS,
  answerAll,
  crisisUrl,
  finishButton,
  goOffline,
  msg,
  staticHits,
  takeCheckIn,
  triggerCrisis,
  visitOnline,
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

const CASES: Record<string, (ctx: Context) => Promise<void>> = {
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

  async 'numbers-visible-and-tappable'({ page, context, locale }) {
    await visitOnline(page, locale);
    await goOffline(context);
    await triggerCrisis(page, locale);
    const screen = page.locator('[data-screen="crisis"]');
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
      await link.click();
      // The tap was logged against that number, and the person is still on the screen.
      await expect(screen).toHaveAttribute('data-last-call', number);
      await expect(page).toHaveURL(crisisUrl(locale));
    }
  },

  async 'call-now-keeps-block'({ page, context, locale }) {
    await visitOnline(page, locale);
    await goOffline(context);
    await triggerCrisis(page, locale);
    await page.getByRole('button', { name: msg(locale, 'crisis.callNow'), exact: true }).click();
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

    // Everything else that went to the API is the unfiltered directory read and nothing more.
    const toApi = seen.filter((request) => !request.url.includes('control='));
    expect(toApi.length, 'the directory was fetched, so the interception was live').toBeGreaterThanOrEqual(1);
    for (const request of toApi) {
      expect(request).toMatchObject({ url: `${API}/services`, method: 'GET', body: null });
      expect(request.headers['authorization']).toBeUndefined();
      expect(request.headers['cookie']).toBeUndefined();
    }
    // And none of the inputs appears in any request the page made, to any origin: URL, body or headers.
    for (const line of everyRequest.filter((entry) => !entry.includes('control='))) {
      expect(line.toLowerCase(), line).not.toMatch(/thiqa|daman|al_ain|cliniciangender|"ur"|=ur\b|evening|tele\b|score|answers/i);
    }
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
