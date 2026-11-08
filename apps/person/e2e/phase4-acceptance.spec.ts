import { type Browser, type BrowserContext, type Page } from '@playwright/test';
import { expect, test, type ConsoleGuard } from './fixtures';
import acceptance from './acceptance-phase4.json';
import {
  API,
  BASE,
  INSPECT,
  LOCALES,
  computed,
  crisisUrl,
  msg,
  snapshot,
  takeCheckIn,
  triggerCrisis,
  visitOnline,
  type Locale,
} from './helpers';
import {
  CLINIC,
  CLINICIAN_A,
  CLINICIAN_B,
  CONDITION,
  CRISIS_LINE_USER,
  FACILITY_A,
  FACILITY_B,
  FREE_TEXT,
  OPS,
  OPS_USER,
  SESSION_KEY,
  SUMMARY,
  bearer,
  call,
  cmsg,
  handOver,
  inboundCounts,
  keepSession,
  loggedLink,
  makeTicket,
  newPerson,
  omsg,
  requestLink,
  revokeConsent,
  sendScreen,
  serviceAt,
  signedRequest,
  staffSession,
  validateBundle,
} from './staff-helpers';

/**
 * Every sentence of Phase 4's exit acceptance, and each carried item, as its own named test in both languages.
 * `acceptance-phase4.json` is the registry: the gate fails unless the report holds exactly one passing test per entry and
 * locale. The API is the real one on an in-process database, the person app is the real static export and the clinician
 * and ops apps are real production builds, all in a real Chromium. The inspect listener shows what the API stored.
 *
 * Tests that are about the clinician's screens make their tickets through the API (a person's device is not the point);
 * the demo and reroute tests make theirs through the person app.
 */
interface Context {
  page: Page;
  context: BrowserContext;
  browser: Browser;
  locale: Locale;
  /** Where a test that provokes a failure on purpose names it; nothing else is excused. */
  consoleGuard: ConsoleGuard;
}

/** Names the failures a test makes the API answer on purpose, each by its exact URL and status. Nothing else is excused. */
function provoke(guard: ConsoleGuard, reason: string, calls: readonly (readonly [path: string, status: number])[]): void {
  for (const [path, status] of calls) guard.allow({ url: `${API}${path}`, expect: status, reason });
}

/** PHQ-9 = 11: the "trained GP or tele" row, so a GP is the lead card. Item 9 is 0, so no crisis. */
const PHQ9_ELEVEN = [2, 2, 2, 1, 1, 1, 1, 1, 0] as const;
const UNABLE_REASONS = ['could_not_reach', 'no_capacity', 'not_eligible', 'wrong_service', 'other'];
const NOT_SHARED_EN = 'Not shared by the person';
const WITHDRAWN_EN = 'Withdrawn by the person';

interface Stored {
  ticket: { id: string; personId: string; shortCode: string; state: string; source: string; parentTicketId: string | null };
  events: { seq: number; fromState: string | null; toState: string; actor: string; reason: string | null }[];
  consents: { element: string; revokedAt: string | null }[];
  bundleReads: number;
  bundle: { content: Record<string, unknown> | null } | null;
}

async function stored(ticketId: string): Promise<Stored> {
  return (await (await fetch(`${INSPECT}/tickets/${ticketId}`)).json()) as Stored;
}

async function invite(id: string): Promise<{ claimedBy: string | null; ticketId: string | null; source: string; codeHash: string }> {
  return (await (await fetch(`${INSPECT}/invites/${id}`)).json()) as { claimedBy: string | null; ticketId: string | null; source: string; codeHash: string };
}

const ticketIdOf = (page: Page) => new URL(page.url()).searchParams.get('id')!;
const consentUrl = (locale: Locale) => new RegExp(`/${locale}/consent/$`);
const ticketUrl = (locale: Locale) => new RegExp(`/${locale}/ticket/\\?id=`);
const displayCode = (shortCode: string) => `${shortCode.slice(0, 2)}-${shortCode.slice(2)}`;
const clinicUrl = (locale: Locale, query = '') => `${CLINIC}/${locale}/${query}`;
const row = (page: Page, shortCode: string) => page.locator(`[data-queue] tr[data-ticket="${shortCode}"]`);

/** The text of every answer the API gave this page, to prove a value is in none of them. */
function recordApiBodies(page: Page): () => Promise<string> {
  const bodies: Promise<string>[] = [];
  page.on('response', (response) => {
    if (response.url().startsWith(API)) bodies.push(response.text().catch(() => ''));
  });
  return async () => (await Promise.all(bodies)).join('\n');
}

/** A check-in worth a GP referral, then the options screen. (The same flow as the Phase 3 spec.) */
async function toConsent(page: Page, locale: Locale): Promise<void> {
  await visitOnline(page, locale);
  await takeCheckIn(page, locale, 'phq9', PHQ9_ELEVEN);
  await expect(page.locator('[data-score]')).toHaveText('11');
  await page.getByRole('link', { name: msg(locale, 'result.options'), exact: true }).click();
  await expect(page.locator('[data-tier][data-lead]')).toHaveAttribute('data-tier', 'gp');
  await page.locator('[data-tier][data-lead]').getByRole('button', { name: msg(locale, 'options.choose'), exact: true }).click();
  await expect(page).toHaveURL(consentUrl(locale));
  await expect(page.locator('[data-screen="consent"]')).toBeVisible();
}

const sendConsent = (page: Page, locale: Locale) => page.getByRole('button', { name: msg(locale, 'consent.send'), exact: true }).click();

/** Takes a GP referral all the way to a ticket from the person app, with the given elements ticked and a note typed. */
async function issueViaPersonApp(page: Page, locale: Locale, ticked: string[] = ['scores'], note = FREE_TEXT): Promise<string> {
  await toConsent(page, locale);
  await page.locator('#note').fill(note);
  for (const element of ticked) await page.locator(`input[data-element="${element}"]`).check();
  await sendConsent(page, locale);
  await expect(page).toHaveURL(ticketUrl(locale));
  await expect(page.locator('[data-ticket]')).toBeVisible();
  return ticketIdOf(page);
}

/** A page for the clinician app signed in as the given staff member, the way a finished sign-in leaves the tab. */
async function clinicianPage(context: BrowserContext, email = CLINICIAN_A): Promise<Page> {
  await keepSession(context, CLINIC, await staffSession(email));
  return context.newPage();
}

async function openTicket(clinic: Page, locale: Locale, id: string): Promise<void> {
  await clinic.goto(clinicUrl(locale, `?ticket=${id}`));
  await expect(clinic.locator('[data-detail] [data-code]')).toBeVisible();
}

const CASES: Record<string, (ctx: Context) => Promise<void>> = {
  async 'demo-steps-1-and-8'({ page, context, locale }) {
    // Step 1: the front door (TAMM) hands the screen over, signed; the person arrives from its mock page and claims it.
    const receipt = await handOver('tamm', locale);
    expect(receipt.claimUrl).toBe(`${BASE}/${locale}/claim/?code=${receipt.code}`);
    await page.goto(`/${locale}/tamm/?code=${receipt.code}`);
    await expect(page.locator('[data-mock-banner]')).toHaveText(msg(locale, 'tamm.mockBanner'));
    await page.locator('[data-continue-with-mawsool]').click();
    await expect(page).toHaveURL(new RegExp(`/${locale}/claim/\\?code=${receipt.code}$`));
    await expect(page.locator('#invite-code')).toHaveValue(receipt.code);
    expect((await invite(receipt.inviteId)).claimedBy).toBeNull(); // opening the link claims nothing
    await page.getByRole('button', { name: msg(locale, 'claim.claim'), exact: true }).click();
    await expect(page.locator('[data-claimed="tamm"]')).toContainText(msg(locale, 'claim.source.tamm'));
    expect((await invite(receipt.inviteId)).claimedBy).not.toBeNull();

    // Steps 2 to 7 in short: a score that leads to a GP, then the consent screen with the free-text note kept back.
    const ticketId = await issueViaPersonApp(page, locale, ['scores']);
    const row0 = await stored(ticketId);
    expect(row0.ticket.source).toBe('tamm');
    expect((await invite(receipt.inviteId)).ticketId).toBe(ticketId);

    // Step 8: the clinic's queue shows the ticket, the GP opens it and sees the note was not shared.
    const clinic = await clinicianPage(context);
    const bodies = recordApiBodies(clinic);
    await clinic.goto(clinicUrl(locale));
    const ticketRow = row(clinic, row0.ticket.shortCode);
    await expect(ticketRow).toBeVisible();
    await expect(ticketRow).toHaveAttribute('data-state', 'issued');
    await expect(ticketRow).toContainText(cmsg(locale, 'tier.gp'));
    await expect(ticketRow).toContainText(cmsg(locale, 'source.tamm'));
    // Tier only: no diagnostic label before the ticket is opened.
    await expect(ticketRow).not.toContainText(/depress|anxi|moderate/i);
    const bundleRead = clinic.waitForResponse((response) => response.url() === `${API}/tickets/${ticketId}/bundle`);
    await ticketRow.getByRole('button').click();
    await expect(clinic.locator('[data-detail] [data-code]')).toHaveText(displayCode(row0.ticket.shortCode));
    const noteSection = clinic.locator('[data-section="free_text"]');
    await expect(noteSection.locator('[data-not-shared]')).toHaveText(cmsg(locale, 'detail.notShared'));
    if (locale === 'en') await expect(noteSection.locator('[data-not-shared]')).toHaveText(NOT_SHARED_EN);
    await expect(noteSection.locator('[data-note]')).toHaveCount(0);
    await expect(clinic.locator('[data-section="scores"]')).toContainText('PHQ-9');
    expect((await (await bundleRead).text())).not.toContain(FREE_TEXT);
    expect(await bodies()).not.toContain(FREE_TEXT);
    await expect(clinic.locator('body')).not.toContainText(FREE_TEXT);

    // Acknowledge: the ticket moves, and the person sees it and who opened their data.
    await clinic.getByRole('button', { name: cmsg(locale, 'detail.acknowledge'), exact: true }).click();
    await expect(clinic.locator('[data-detail] [data-state]')).toHaveAttribute('data-state', 'acknowledged');
    await expect(ticketRow).toHaveAttribute('data-state', 'acknowledged');
    expect((await stored(ticketId)).events.at(-1)).toMatchObject({ fromState: 'issued', toState: 'acknowledged', actor: 'clinic' });
    await page.reload();
    await expect(page.locator('[data-step="acknowledged"]')).toHaveAttribute('data-done', 'true');
    await expect(page.locator('[data-reads] li')).toHaveCount(1);
  },

  async 'tamm-invite-ticket-has-source-tamm'({ context, locale }) {
    const receipt = await handOver('tamm', locale);
    const person = await newPerson();
    const claimed = await call('POST', '/me/invites/claim', { headers: person.headers, body: { code: receipt.code } });
    expect(claimed.status).toBe(200);
    expect(claimed.json()).toMatchObject({ inviteId: receipt.inviteId, source: 'tamm' });
    const gp = await serviceAt(FACILITY_A);
    const fromTamm = await makeTicket(person, { serviceId: gp, inviteId: receipt.inviteId });
    const ownApp = await makeTicket(person, { serviceId: gp });

    expect(fromTamm.source).toBe('tamm');
    expect(ownApp.source).toBe('app');
    expect((await call('GET', `/me/tickets/${fromTamm.id}`, { headers: person.headers })).json().source).toBe('tamm');
    expect((await stored(fromTamm.id)).ticket.source).toBe('tamm');
    expect((await invite(receipt.inviteId)).ticketId).toBe(fromTamm.id);

    // The clinic sees the source on the ticket, labelled as a mock.
    const clinic = await clinicianPage(context);
    await clinic.goto(clinicUrl(locale));
    await expect(row(clinic, fromTamm.shortCode)).toContainText(cmsg(locale, 'source.tamm'));
    await expect(row(clinic, ownApp.shortCode)).toContainText(cmsg(locale, 'source.app'));
    expect(cmsg(locale, 'source.tamm')).toMatch(locale === 'en' ? /mock/i : /تجريبي/);
    const staff = await staffSession(CLINICIAN_A);
    expect((await call('GET', `/tickets/${fromTamm.id}`, { headers: bearer(staff) })).json().source).toBe('tamm');
  },

  async 'revoked-ticket-shows-withdrawn-and-no-data'({ context, locale, consoleGuard }) {
    const person = await newPerson();
    const ticket = await makeTicket(person, { serviceId: await serviceAt(FACILITY_A), consents: ['ticket', 'scores', 'free_text'], approvedSummary: SUMMARY });
    provoke(consoleGuard, 'the person ends the sharing while the clinic has the ticket open, so the clinic’s next calls find it withdrawn (409 to act, 410 to read)', [
      [`/tickets/${ticket.id}/events`, 409],
      [`/tickets/${ticket.id}`, 410],
      [`/tickets/${ticket.id}/bundle`, 410],
    ]);
    const clinic = await clinicianPage(context);
    await openTicket(clinic, locale, ticket.id);
    await expect(clinic.locator('[data-section="free_text"] [data-note]')).toHaveText(FREE_TEXT); // shared, so shown
    await expect(clinic.locator('[data-summary]')).toHaveText(SUMMARY);

    // The person ends the sharing while the clinic has the ticket open. The clinic's next action finds out.
    expect((await revokeConsent(person, ticket, 'ticket')).status).toBe(200);
    await clinic.getByRole('button', { name: cmsg(locale, 'detail.markSeen'), exact: true }).click();
    const banner = clinic.locator('[data-detail-state="withdrawn"]');
    await expect(banner).toBeVisible();
    await expect(banner.getByRole('heading')).toHaveText(cmsg(locale, 'detail.withdrawn'));
    if (locale === 'en') await expect(banner.getByRole('heading')).toHaveText(WITHDRAWN_EN);
    for (const gone of [displayCode(ticket.shortCode), ticket.shortCode, FREE_TEXT, SUMMARY, 'PHQ-9']) await expect(clinic.locator('[data-detail]'), gone).not.toContainText(gone);
    await expect(clinic.locator('[data-detail] [data-code]')).toHaveCount(0);
    await expect(clinic.locator('[data-detail] button')).toHaveCount(0);

    // Opened afresh from a link, the same: the banner and nothing else, and the ticket is gone from the queue.
    const bodies = recordApiBodies(clinic);
    await openWithdrawn(clinic, locale, ticket.id);
    expect(await bodies()).not.toMatch(new RegExp(`${ticket.shortCode}|${FREE_TEXT}|${SUMMARY}`));
    await expect(row(clinic, ticket.shortCode)).toHaveCount(0);

    const staff = bearer(await staffSession(CLINICIAN_A));
    for (const path of [`/tickets/${ticket.id}`, `/tickets/${ticket.id}/bundle`, `/tickets/${ticket.id}/fhir`]) {
      const res = await call('GET', path, { headers: staff });
      expect(res.status, path).toBe(410);
      expect(res.json()).toEqual({ error: 'withdrawn', message: 'Withdrawn by the person' });
    }
    expect((await stored(ticket.id)).bundle).toMatchObject({ contentCiphertext: null });

    // A stale row: the queue is already on screen with the ticket in it when the person ends the sharing. Opening the
    // row finds out (410 at opening), and the row, with its code, tier and deadline, goes with it.
    const stale = await makeTicket(person, { serviceId: await serviceAt(FACILITY_A) });
    provoke(consoleGuard, 'a stale queue row is opened after the person ended the sharing, which answers 410', [[`/tickets/${stale.id}`, 410], [`/tickets/${stale.id}/bundle`, 410]]);
    await clinic.goto(clinicUrl(locale));
    await expect(row(clinic, stale.shortCode)).toBeVisible();
    expect((await revokeConsent(person, stale, 'ticket')).status).toBe(200);
    await row(clinic, stale.shortCode).getByRole('button').click();
    await expect(clinic.locator('[data-detail-state="withdrawn"]')).toBeVisible();
    await expect(row(clinic, stale.shortCode)).toHaveCount(0);
    await expect(clinic.locator('[data-queue]')).not.toContainText(displayCode(stale.shortCode));

    // The same for the export: the ticket is open and shown when the sharing ends, and the export call finds out.
    const exporting = await makeTicket(person, { serviceId: await serviceAt(FACILITY_A) });
    provoke(consoleGuard, 'the export is asked for after the person ended the sharing, which answers 410', [[`/tickets/${exporting.id}/fhir`, 410]]);
    await clinic.goto(clinicUrl(locale));
    await row(clinic, exporting.shortCode).getByRole('button').click();
    await expect(clinic.locator('[data-detail] [data-code]')).toHaveText(displayCode(exporting.shortCode));
    await expect(row(clinic, exporting.shortCode)).toBeVisible();
    expect((await revokeConsent(person, exporting, 'ticket')).status).toBe(200);
    await clinic.getByRole('button', { name: cmsg(locale, 'detail.copyFhir'), exact: true }).click();
    await expect(clinic.locator('[data-detail-state="withdrawn"]')).toBeVisible();
    await expect(clinic.locator('[data-detail] [data-code]')).toHaveCount(0);
    await expect(row(clinic, exporting.shortCode)).toHaveCount(0);
    await expect(clinic.locator('[data-queue]')).not.toContainText(displayCode(exporting.shortCode));
  },

  async 'unable-to-see-prompts-person-to-reroute'({ page, context, locale }) {
    const parent = await issueViaPersonApp(page, locale, ['scores']);
    await expect(page.locator('[data-prompt="unable"]')).toHaveCount(0); // nothing reported yet

    // The clinic reports it cannot see the person.
    const clinic = await clinicianPage(context);
    await openTicket(clinic, locale, parent);
    await clinic.getByRole('button', { name: cmsg(locale, 'detail.unable'), exact: true }).click();
    await clinic.locator('[data-panel="unable"] input[value="no_capacity"]').check();
    await clinic.getByRole('button', { name: cmsg(locale, 'detail.unableConfirm'), exact: true }).click();
    await expect(clinic.locator('[data-unable-standing]')).toContainText(cmsg(locale, 'detail.unableReason.no_capacity'));
    expect((await stored(parent)).events.at(-1)).toMatchObject({ fromState: 'issued', toState: 'issued', actor: 'clinic', reason: 'no_capacity' });
    expect((await stored(parent)).ticket.state).toBe('issued');

    // The person app shows the reroute prompt from that event.
    await page.reload();
    const prompt = page.locator('[data-prompt="unable"]');
    await expect(prompt).toBeVisible();
    await expect(prompt).toContainText(msg(locale, 'ticket.unablePrompt'));
    expect(await computed(page, '[data-prompt="unable"] p', ['font-size', 'font-weight', 'line-height'])).toMatchObject({ 'font-size': '14px', 'font-weight': '600', 'line-height': '20px' });
    await prompt.getByRole('button', { name: msg(locale, 'ticket.findAnother'), exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/${locale}/options/\\?reroute=${parent}&reason=unable_to_see`));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(msg(locale, 'options.rerouteHeading'));
    await page.locator('[data-tier][data-lead] button').click();
    await expect(page).toHaveURL(consentUrl(locale));
    await sendConsent(page, locale);
    await expect(page).toHaveURL(ticketUrl(locale));
    const child = ticketIdOf(page);
    expect(child).not.toBe(parent);
    expect((await stored(child)).ticket.parentTicketId).toBe(parent);
    const parentAfter = await stored(parent);
    expect(parentAfter.ticket.state).toBe('rerouted');
    expect(parentAfter.events.at(-1)).toMatchObject({ toState: 'rerouted', actor: 'person', reason: 'unable_to_see' });

    // Once the person has moved on, the earlier ticket no longer prompts.
    await page.goto(`/${locale}/ticket/?id=${parent}`);
    await expect(page.locator('[data-ticket]')).toBeVisible();
    await expect(page.locator('[data-prompt="unable"]')).toHaveCount(0);
  },

  async 'exported-bundle-validates-and-holds-only-consented'({ context, locale }) {
    const person = await newPerson();
    const ticket = await makeTicket(person, { serviceId: await serviceAt(FACILITY_A), consents: ['ticket', 'scores', 'conditions'], approvedSummary: SUMMARY, summaryBuiltFrom: ['ticket', 'scores'] });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(CLINIC).origin });
    const clinic = await clinicianPage(context);
    await openTicket(clinic, locale, ticket.id);
    await expect(clinic.locator('[data-export-label]')).toHaveText(cmsg(locale, 'detail.exportLabel'));
    if (locale === 'en') await expect(clinic.locator('[data-export-label]')).toHaveText('Malaffi-ready export — not sent');
    await clinic.getByRole('button', { name: cmsg(locale, 'detail.copyFhir'), exact: true }).click();
    await expect(clinic.locator('[data-fhir]')).toBeVisible();
    await expect(clinic.getByText(cmsg(locale, 'detail.copied'))).toBeVisible();

    const text = (await clinic.locator('[data-fhir]').textContent())!;
    expect(await clinic.evaluate(() => navigator.clipboard.readText())).toBe(text);
    const bundle = JSON.parse(text) as { resourceType: string; meta: { tag: { display: string }[] }; entry: { resource: { resourceType: string; meta?: { tag: { code: string }[] } } }[] };
    expect(await validateBundle(text)).toEqual({ valid: true });
    expect(bundle.resourceType).toBe('Bundle');
    expect(bundle.meta.tag[0]!.display).toBe('Malaffi-ready export — not sent');
    expect(bundle.entry.map((entry) => entry.resource.resourceType)).toEqual(['ServiceRequest', 'QuestionnaireResponse', 'Condition']);
    // Everything consented to is there ...
    for (const present of [CONDITION, SUMMARY, 'phq9']) expect(text, present).toContain(present);
    // ... and nothing else is: not the note, the trajectory, the preferences, or anything that names the person.
    for (const absent of [FREE_TEXT, 'gad7', 'in_person', person.id, '"personId"']) expect(text, absent).not.toContain(absent);
    for (const entry of bundle.entry.slice(1)) expect(['scores', 'conditions']).toContain(entry.resource.meta!.tag[0]!.code);

    // The export is a read of the bundle like the screen's: the person can see both.
    expect((await stored(ticket.id)).bundleReads).toBe(2);
    expect((await call('GET', `/me/tickets/${ticket.id}/reads`, { headers: person.headers })).json()).toHaveLength(2);
  },

  async 'bad-signature-and-replay-are-rejected-with-no-invite'({ locale }) {
    const before = await inboundCounts();
    const body = { result: 'positive', screenedAt: new Date().toISOString(), locale };
    const now = Math.floor(Date.now() / 1000);

    const bad: [string, Awaited<ReturnType<typeof sendScreen>>][] = [
      ['wrong key', await sendScreen(signedRequest('tamm', { body, key: 'not-the-key-not-the-key-not-the-key-0123' }))],
      ['another front door’s key', await sendScreen(signedRequest('tamm', { body, key: 'e2e-only-phc-signing-key-0123456789abcdef' }))],
      ['no signature at all', await call('POST', '/inbound/screens', { body })],
      ['a person’s token instead', await call('POST', '/inbound/screens', { body, headers: (await newPerson()).headers })],
      ['a mangled signature', await sendScreen(signedRequest('tamm', { body }), { 'x-mawsool-signature': 'ab'.repeat(32) })],
      ['an unknown source', await sendScreen(signedRequest('tamm', { body }), { 'x-mawsool-source': 'app' })],
      ['a stale timestamp', await sendScreen(signedRequest('tamm', { body, timestamp: now - 3600 }))],
      ['a future timestamp', await sendScreen(signedRequest('tamm', { body, timestamp: now + 3600 }))],
    ];
    // A body changed after it was signed.
    const signed = signedRequest('tamm', { body });
    bad.push(['a body changed after signing', await call('POST', '/inbound/screens', { raw: JSON.stringify({ ...body, locale: locale === 'en' ? 'ar' : 'en' }), headers: signed.headers })]);
    for (const [label, res] of bad) expect(res.status, label).toBe(401);
    expect(await inboundCounts()).toEqual(before);

    // A good request is accepted once, and the identical request sent again is refused as a replay, with no second invite.
    const request = signedRequest('tamm', { body });
    const first = await sendScreen(request);
    expect(first.status).toBe(201);
    expect(await inboundCounts()).toEqual({ invites: before.invites + 1, nonces: before.nonces + 1 });
    const replay = await sendScreen(request);
    expect(replay.status).toBe(401);
    expect(replay.json()).toMatchObject({ error: 'replayed' });
    expect(await inboundCounts()).toEqual({ invites: before.invites + 1, nonces: before.nonces + 1 });
    // The claim code is shown once, and the invite holds only its hash.
    const row0 = await invite(first.json().inviteId);
    expect(JSON.stringify(row0)).not.toContain(first.json().code.replace('-', ''));
  },

  async 'clinician-at-other-facility-gets-404'({ context, locale, consoleGuard }) {
    const person = await newPerson();
    const ticket = await makeTicket(person, { serviceId: await serviceAt(FACILITY_A), consents: ['ticket', 'scores', 'free_text'] });
    const b = await staffSession(CLINICIAN_B);
    const a = await staffSession(CLINICIAN_A);
    expect(b.facilityId).toBe(FACILITY_B);

    // The same 404 body as for a ticket that does not exist, on every route that takes a ticket id, and no audit row.
    const missing = '00000000-0000-4000-8000-ffffffffffff';
    for (const [method, path, body] of [
      ['GET', '', undefined],
      ['GET', '/bundle', undefined],
      ['GET', '/fhir', undefined],
      ['POST', '/events', { to: 'acknowledged' }],
      ['POST', '/events', { unable: true, reason: 'other' }],
    ] as const) {
      const other = await call(method, `/tickets/${ticket.id}${path}`, { headers: bearer(b), body });
      const none = await call(method, `/tickets/${missing}${path}`, { headers: bearer(b), body });
      expect(other.status, `${method} ${path}`).toBe(404);
      expect(other.text).toBe(none.text);
      expect(other.text).not.toContain(ticket.shortCode);
    }
    expect((await stored(ticket.id)).bundleReads).toBe(0);
    expect((await stored(ticket.id)).events).toHaveLength(1); // nothing was changed from the other side
    expect((await call('GET', `/tickets/${ticket.id}`, { headers: bearer(a) })).status).toBe(200);

    // In the clinician app the same: not in the queue, and a link to it says it was not found, with none of its data.
    provoke(consoleGuard, 'a clinician at the other facility opens this ticket from a link, which answers 404', [[`/tickets/${ticket.id}`, 404], [`/tickets/${ticket.id}/bundle`, 404]]);
    const clinic = await clinicianPage(context, CLINICIAN_B);
    const bodies = recordApiBodies(clinic);
    await clinic.goto(clinicUrl(locale));
    await expect(clinic.locator('[data-facility]')).toContainText('Al Ain');
    await expect(clinic.locator('[data-queue] tr[data-ticket]').first()).toBeVisible();
    await expect(row(clinic, ticket.shortCode)).toHaveCount(0);
    await clinic.goto(clinicUrl(locale, `?ticket=${ticket.id}`));
    await expect(clinic.locator('[data-detail-state="not-found"]')).toHaveText(cmsg(locale, 'detail.notFound'));
    await expect(clinic.locator('[data-detail] [data-code]')).toHaveCount(0);
    expect(await bodies()).not.toMatch(new RegExp(`${ticket.shortCode}|${FREE_TEXT}`));
  },

  async 'staff-sign-in-says-not-saved'({ page, context, locale }) {
    // This browser refuses to keep the staff session (full storage, a blocked-storage setting).
    await context.addInitScript((key) => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (name: string, value: string) {
        if (name === key) throw new DOMException('the quota has been exceeded', 'QuotaExceededError');
        return original.call(this, name, value);
      };
    }, SESSION_KEY);
    const link = (await requestLink(CLINICIAN_A)).replace('/en/', `/${locale}/`);
    await page.goto(link);
    await page.getByRole('button', { name: cmsg(locale, 'signIn.action'), exact: true }).click();
    const message = page.locator('[data-phase="not_saved"]');
    await expect(message).toHaveText(cmsg(locale, 'signIn.notSaved'));
    await expect(page.locator('[data-phase="signed_in"]')).toHaveCount(0);
    await expect(page.getByText(cmsg(locale, 'signIn.signedIn'), { exact: true })).toHaveCount(0);
    await expect(page.locator('[data-continue]')).toHaveCount(0);
    expect(await page.evaluate((key) => sessionStorage.getItem(key), SESSION_KEY)).toBeNull();
    // The link is spent, so the page offers a new one rather than the same button.
    await expect(page.getByRole('button', { name: cmsg(locale, 'signIn.action'), exact: true })).toHaveCount(0);
    await expect(page.locator('#staff-email')).toBeVisible();
    const token = new URL(link).searchParams.get('token')!;
    expect((await call('POST', '/auth/verify', { body: { token } })).status).toBe(401);
    // Opening the home page does not pass as signed in either.
    await page.goto(clinicUrl(locale));
    await expect(page).toHaveURL(clinicUrl(locale, 'sign-in/'));
  },

  async 'sign-in-link-whole-path'({ page, browser, locale, consoleGuard }) {
    consoleGuard.allow({ url: `${API}/auth/verify`, expect: 401, reason: 'the used link is tried again, which the API refuses with 401' });
    const verifies: string[] = [];
    page.on('request', (request) => {
      if (request.url() === `${API}/auth/verify`) verifies.push(request.postData() ?? '');
    });
    // 1. Request the link on the page.
    await page.goto(clinicUrl(locale, 'sign-in/'));
    await expect(page.locator('[data-phase="missing_token"]')).toHaveText(cmsg(locale, 'signIn.missingToken'));
    await page.locator('#staff-email').fill(CLINICIAN_A);
    await page.getByRole('button', { name: cmsg(locale, 'signIn.requestAction'), exact: true }).click();
    await expect(page.locator('[data-phase="request_sent"]')).toHaveText(cmsg(locale, 'signIn.requestSent'));
    // 2. The API logged it (it is never sent). It points at the clinician app, as a one-time link with a token.
    const link = (await loggedLink(CLINICIAN_A))!;
    expect(link).toMatch(new RegExp(`^${CLINIC}/en/sign-in/\\?token=[A-Za-z0-9_-]{43}$`));
    const token = new URL(link).searchParams.get('token')!;
    // 3. Open it. The page reads the token from the address but does not spend it on load.
    await page.goto(link.replace('/en/', `/${locale}/`));
    await expect(page.getByRole('button', { name: cmsg(locale, 'signIn.action'), exact: true })).toBeVisible();
    expect(verifies).toEqual([]);
    // 4. Sign in: the request carries the token from the link, and the session is kept for this tab.
    await page.getByRole('button', { name: cmsg(locale, 'signIn.action'), exact: true }).click();
    await expect(page.locator('[data-phase="signed_in"]')).toHaveText(cmsg(locale, 'signIn.signedIn'));
    expect(verifies.map((body) => JSON.parse(body))).toEqual([{ token }]);
    const kept = JSON.parse((await page.evaluate((key) => sessionStorage.getItem(key), SESSION_KEY))!) as { role: string; facilityId: string; sessionToken: string };
    expect(kept).toMatchObject({ role: 'clinician', facilityId: FACILITY_A });
    expect(kept.sessionToken.length).toBeGreaterThan(20);
    // 5. The session works: Continue lands on the queue, and a reload stays signed in.
    await page.locator('[data-continue]').click();
    await expect(page).toHaveURL(clinicUrl(locale));
    await expect(page.locator('[data-facility]')).toContainText('Khalifa City');
    await expect(page.locator('[data-queue] tr[data-ticket]').first()).toBeVisible();
    await page.reload();
    await expect(page.locator('[data-queue] tr[data-ticket]').first()).toBeVisible();
    await expect(page).toHaveURL(clinicUrl(locale));
    // 6. The link worked once: a second browser using it is told so.
    const other = await browser.newContext();
    try {
      const second = await other.newPage();
      await second.goto(link.replace('/en/', `/${locale}/`));
      await second.getByRole('button', { name: cmsg(locale, 'signIn.action'), exact: true }).click();
      await expect(second.locator('[data-phase="failed"]')).toHaveText(cmsg(locale, 'signIn.failed'));
      expect(await second.evaluate((key) => sessionStorage.getItem(key), SESSION_KEY)).toBeNull();
    } finally {
      await other.close();
    }
  },

  async 'staff-homes-lead-to-sign-in'({ page, context, browser, locale }) {
    const dataRequests: string[] = [];
    context.on('request', (request) => {
      if (request.url().startsWith(`${API}/tickets`)) dataRequests.push(request.url());
    });
    // No session: the clinician home goes to sign-in and asks for no tickets.
    await page.goto(clinicUrl(locale), { waitUntil: 'commit' });
    await expect(page).toHaveURL(clinicUrl(locale, 'sign-in/'));
    expect(dataRequests).toEqual([]);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(cmsg(locale, 'signIn.heading'));

    // An expired session, and a session for the other staff app, are not sessions either; the second is forgotten.
    const fresh = await browser.newContext();
    try {
      fresh.on('request', (request) => {
        if (request.url().startsWith(`${API}/tickets`)) dataRequests.push(request.url());
      });
      const expired = { ...(await staffSession(CLINICIAN_A)), expiresAt: new Date(Date.now() - 1000).toISOString() };
      await keepSession(fresh, CLINIC, expired);
      const expiredPage = await fresh.newPage();
      await expiredPage.goto(clinicUrl(locale), { waitUntil: 'commit' });
      await expect(expiredPage).toHaveURL(clinicUrl(locale, 'sign-in/'));
    } finally {
      await fresh.close();
    }
    const wrong = await browser.newContext();
    try {
      await keepSession(wrong, CLINIC, await staffSession(OPS_USER));
      const wrongPage = await wrong.newPage();
      await wrongPage.goto(clinicUrl(locale), { waitUntil: 'commit' });
      await expect(wrongPage).toHaveURL(clinicUrl(locale, 'sign-in/'));
      expect(await wrongPage.evaluate((key) => sessionStorage.getItem(key), SESSION_KEY)).toBeNull();
    } finally {
      await wrong.close();
    }
    expect(dataRequests).toEqual([]);

    // The ops home does the same, and shows its page to an ops session.
    await page.goto(`${OPS}/${locale}/`, { waitUntil: 'commit' });
    await expect(page).toHaveURL(`${OPS}/${locale}/sign-in/`);
    const ops = await browser.newContext();
    try {
      await keepSession(ops, OPS, await staffSession(OPS_USER));
      const opsPage = await ops.newPage();
      await opsPage.goto(`${OPS}/${locale}/`);
      await expect(opsPage.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(opsPage).toHaveURL(`${OPS}/${locale}/`);
    } finally {
      await ops.close();
    }
  },

  async 'staff-pages-and-api-carry-a-strict-policy'({ page, context, browser, locale, consoleGuard }) {
    // This test tries, on purpose, to send a request and an image to another origin and to frame both staff apps. The page's
    // policy blocks each, and the browser logs each block, which is the behaviour under test. Each blocked address is named.
    for (const blocked of [`${INSPECT}/inbound/counts?stolen=1`, `${INSPECT}/inbound/counts`, `${CLINIC}/`, `${OPS}/`]) {
      consoleGuard.allow({ url: blocked, expect: 'csp', reason: 'the test tries to reach or frame this address on purpose; the page policy must block it' });
    }
    const apiOrigin = new URL(API).origin;
    const person = await newPerson();
    const ticket = await makeTicket(person, { serviceId: await serviceAt(FACILITY_A) });

    // The page policy on both staff apps.
    for (const url of [clinicUrl(locale), `${OPS}/${locale}/`]) {
      const response = (await page.goto(url, { waitUntil: 'commit' }))!;
      const headers = response.headers();
      const csp = headers['content-security-policy']!;
      expect(csp, url).toContain(`connect-src 'self' ${apiOrigin};`);
      for (const rule of ["default-src 'self'", "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", "object-src 'none'"]) expect(csp, `${url} ${rule}`).toContain(rule);
      expect(csp).not.toContain('unsafe-eval'); // production build
      expect(headers['x-frame-options']).toBe('DENY');
      expect(headers['x-content-type-options']).toBe('nosniff');
      expect(headers['referrer-policy']).toBe('no-referrer');
    }

    // Working normally under the policy: no violation, no console error, and the queue and a ticket load.
    const problems: string[] = [];
    const clinic = await clinicianPage(context);
    clinic.on('console', (message) => {
      if (message.type() === 'error') problems.push(message.text());
    });
    clinic.on('pageerror', (error) => problems.push(error.message));
    await clinic.addInitScript(() => document.addEventListener('securitypolicyviolation', (event) => console.error(`policy violation: ${event.violatedDirective} ${event.blockedURI} at ${event.sourceFile}:${event.lineNumber}:${event.columnNumber} ${event.sample}`)));
    await openTicket(clinic, locale, ticket.id);
    await expect(row(clinic, ticket.shortCode)).toBeVisible();
    expect(problems).toEqual([]);

    // A script in the page cannot send anything to another origin; the API still answers.
    const outcome = await clinic.evaluate(
      async ([elsewhere, api]) => {
        const violations: string[] = [];
        document.addEventListener('securitypolicyviolation', (event) => violations.push(event.violatedDirective));
        const fetched = await fetch(elsewhere!, { mode: 'no-cors' }).then(() => 'reached', () => 'blocked');
        const imaged = await new Promise((resolve) => {
          const image = new Image();
          image.onload = () => resolve('reached');
          image.onerror = () => resolve('blocked');
          image.src = `${elsewhere}?stolen=1`;
        });
        navigator.sendBeacon(elsewhere!, 'x');
        const toApi = await fetch(`${api}/health`).then((res) => res.status, () => 0);
        await new Promise((resolve) => setTimeout(resolve, 300));
        return { fetched, imaged, toApi, violations };
      },
      [`${INSPECT}/inbound/counts`, API],
    );
    expect(outcome).toMatchObject({ fetched: 'blocked', imaged: 'blocked', toApi: 200 });
    expect(outcome.violations).toEqual(expect.arrayContaining(['connect-src', 'img-src']));
    problems.length = 0;

    // The API's own answers are never stored, framed or sniffed.
    const staff = bearer(await staffSession(CLINICIAN_A));
    for (const res of [await call('GET', '/tickets', { headers: staff }), await call('GET', `/tickets/${ticket.id}/bundle`, { headers: staff }), await call('GET', '/tickets'), await call('GET', '/health')]) {
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; frame-ancestors 'none'");
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    }

    // Neither staff app can be put in a frame by another site.
    const outer = await browser.newContext();
    try {
      const host = await outer.newPage();
      await host.goto(`${BASE}/${locale}/settings/`);
      for (const target of [clinicUrl(locale, 'sign-in/'), `${OPS}/${locale}/sign-in/`]) {
        const loaded = host.waitForEvent('framenavigated', (frame) => frame !== host.mainFrame());
        await host.evaluate((src) => {
          const frame = document.createElement('iframe');
          frame.src = src;
          frame.id = 'framed';
          document.body.append(frame);
        }, target);
        await loaded;
        await host.waitForTimeout(500);
        const framed = host.frames().find((frame) => frame !== host.mainFrame());
        expect(framed!.url(), target).not.toBe(target);
        expect(framed!.url(), target).toMatch(/^chrome-error:/);
        await host.evaluate(() => document.getElementById('framed')?.remove());
      }
    } finally {
      await outer.close();
    }
  },

  async 'clinician-sign-in-has-language-toggle'({ page, locale }) {
    // At 390 wide, in both languages: the toggle is on the sign-in page, names the other language and is a 44 px target.
    await page.goto(`${CLINIC}/${locale}/sign-in/`);
    expect(page.viewportSize()).toEqual({ width: 390, height: 844 });
    const toggle = page.locator('a.lang-toggle');
    await expect(toggle).toBeVisible();
    const other = locale === 'ar' ? 'en' : 'ar';
    await expect(toggle).toHaveAttribute('href', `/${other}/sign-in/`);
    await expect(toggle).toHaveAttribute('lang', other);
    await expect(toggle).toHaveAttribute('aria-label', cmsg(locale, 'common.language'));
    expect((await toggle.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await toggle.click();
    await expect(page).toHaveURL(new RegExp(`/${other}/sign-in/`));
    await expect(page.locator('html')).toHaveAttribute('lang', other);
  },

  async 'queue-tier-select-filters'({ context, locale }) {
    const person = await newPerson();
    const gp = await makeTicket(person, { serviceId: await serviceAt(FACILITY_A, 'gp') });
    const specialist = await makeTicket(person, { serviceId: await serviceAt(FACILITY_A, 'specialist') });
    const clinic = await clinicianPage(context);
    await clinic.goto(clinicUrl(locale));
    await expect(row(clinic, gp.shortCode)).toBeVisible();
    await expect(row(clinic, specialist.shortCode)).toBeVisible();
    const select = clinic.locator('select[data-filter="tier"]');
    await select.selectOption('specialist');
    await expect(clinic).toHaveURL(/tier=specialist/);
    await expect(row(clinic, specialist.shortCode)).toBeVisible();
    await expect(row(clinic, gp.shortCode)).toHaveCount(0);
    for (const tier of await clinic.locator('[data-queue] tr[data-ticket] td:nth-child(2)').allTextContents()) expect(tier).toBe(cmsg(locale, 'tier.specialist'));
    await select.selectOption('gp');
    await expect(row(clinic, gp.shortCode)).toBeVisible();
    await expect(row(clinic, specialist.shortCode)).toHaveCount(0);
    await select.selectOption('');
    await expect(clinic).not.toHaveURL(/tier=/);
    await expect(row(clinic, specialist.shortCode)).toBeVisible();
    await expect(row(clinic, gp.shortCode)).toBeVisible();
  },

  async 'demo-off-routes-404-and-admin-panel-shows-last-verified'({ context, locale }) {
    // This API runs with DEMO_MODE unset. The write controls do not exist: not for an admin, not for anyone.
    const admin = await staffSession('admin@demo.mawsool.test');
    for (const [path, body] of [['/demo/reset', undefined], ['/demo/clock/advance', { by: '7d' }]] as const) {
      expect((await call('POST', path, { headers: bearer(admin), body })).status, path).toBe(404);
      expect((await call('POST', path, { body })).status, `${path} anonymous`).toBe(404);
    }
    // The read the apps use is always there, answers anyone, and says the offset is zero.
    const clock = await call('GET', '/clock');
    expect(clock.status).toBe(200);
    expect(clock.json()).toEqual({ demoMode: false, offsetMs: 0 });
    // The admin panel says the controls are off, disables them, and still shows each crisis number's last_verified.
    const panel = await context.newPage();
    await keepSession(context, OPS, admin);
    await panel.goto(`${OPS}/${locale}/`);
    await expect(panel.locator('[data-clock-state="off"]')).toBeVisible();
    for (const control of ['[data-advance="7d"]', '[data-advance="3w"]', '[data-advance="6w"]', '[data-reset]']) await expect(panel.locator(control)).toBeDisabled();
    const section = panel.locator('[data-section="crisis-numbers"]');
    for (const number of ['800725462', '999', '998']) await expect(section.locator(`[data-crisis-number="${number}"] [data-last-verified]`)).toBeVisible();
    expect(await section.locator('[data-last-verified]').allTextContents()).toHaveLength(3);
  },

  async 'phone-recovers-when-the-server-forgets-it'({ page, locale, consoleGuard }) {
    const ticketId = await issueViaPersonApp(page, locale, ['scores']);
    const personId = (await stored(ticketId)).ticket.personId;
    expect(await (await fetch(`${INSPECT}/persons/${personId}`)).json()).not.toBeNull();
    // The server's database is put back to the seed behind the phone's back: the person, their ticket and their consents are gone.
    expect((await fetch(`${INSPECT}/e2e/reseed`, { method: 'POST' })).status).toBe(200);
    expect(await (await fetch(`${INSPECT}/persons/${personId}`)).json()).toBeNull();

    // The phone opens its ticket screen afresh: it registers again (the server has no such person) and asks for its ticket,
    // which is not there, so the server answers 404 for it and for its reads. The test provokes exactly those two.
    for (const path of [`/me/tickets/${ticketId}?locale=${locale}`, `/me/tickets/${ticketId}/reads?locale=${locale}`]) {
      consoleGuard.allow({ url: `${API}${path}`, expect: 404, reason: 'the server no longer holds this phone’s ticket, which this test provokes on purpose' });
    }
    await page.goto(`/${locale}/ticket/`);
    // Not an error loop: the screen settles on "no ticket", with a way forward, and the phone is a registered person again.
    await expect(page.getByText(msg(locale, 'ticket.noTicket'))).toBeVisible();
    await expect(page.getByRole('link', { name: msg(locale, 'ticket.seeOptions'), exact: true })).toBeVisible();
    await expect(page.getByText(msg(locale, 'ticket.loadFailed'))).toHaveCount(0);
    expect(await (await fetch(`${INSPECT}/persons/${personId}`)).json()).not.toBeNull();
    // And it is usable: a fresh referral goes through from the same phone, to the same person.
    await toConsent(page, locale);
    await sendConsent(page, locale);
    await expect(page).toHaveURL(ticketUrl(locale));
    expect((await stored(ticketIdOf(page))).ticket.personId).toBe(personId);
  },

  async 'queue-applies-the-share-ended-rule'({ context, locale, consoleGuard }) {
    const person = await newPerson();
    const gp = await serviceAt(FACILITY_A);
    const keep = await makeTicket(person, { serviceId: gp });
    const ended = await makeTicket(person, { serviceId: gp });
    provoke(consoleGuard, 'the clinic opens a ticket whose share has ended, which answers 410', [[`/tickets/${ended.id}`, 410], [`/tickets/${ended.id}/bundle`, 410]]);
    const staff = bearer(await staffSession(CLINICIAN_A));
    const queueOf = async (state: string) => (await call('GET', `/tickets?state=${state}&limit=200`, { headers: staff })).json() as { total: number; counts: Record<string, number>; items: { id: string }[] };
    const withdrawnBefore = (await queueOf('withdrawn')).counts['withdrawn']!;
    const openBefore = (await queueOf('open')).total;

    const clinic = await clinicianPage(context);
    await clinic.goto(clinicUrl(locale));
    await expect(row(clinic, keep.shortCode)).toBeVisible();
    await expect(row(clinic, ended.shortCode)).toBeVisible();
    await expect(clinic.locator('[data-count="open"]')).toHaveText(String(openBefore));

    expect((await revokeConsent(person, ended, 'ticket')).status).toBe(200);
    await clinic.reload();
    await expect(row(clinic, keep.shortCode)).toBeVisible();
    await expect(row(clinic, ended.shortCode)).toHaveCount(0);
    await expect(clinic.locator('[data-count="open"]')).toHaveText(String(openBefore - 1));
    // It is not under "Withdrawn" either, and the withdrawn count did not take it in.
    await clinic.locator('select[data-filter="state"]').selectOption('withdrawn');
    await expect(clinic.locator('[data-queue] tr[data-ticket]').first()).toBeVisible();
    await expect(row(clinic, ended.shortCode)).toHaveCount(0);
    const afterWithdrawn = await queueOf('withdrawn');
    expect(afterWithdrawn.counts['withdrawn']).toBe(withdrawnBefore);
    expect(afterWithdrawn.items.map((item) => item.id)).not.toContain(ended.id);
    const allStates = ['open', 'issued', 'acknowledged', 'overdue', 'seen', 'remeasured', 'closed', 'declined', 'rerouted', 'withdrawn'];
    for (const state of allStates) expect((await queueOf(state)).items.map((item) => item.id), state).not.toContain(ended.id);
    // The detail for it says 410, and its link shows the banner and nothing else.
    expect((await call('GET', `/tickets/${ended.id}`, { headers: staff })).status).toBe(410);
    expect((await call('GET', `/tickets/${keep.id}`, { headers: staff })).status).toBe(200);
    await openWithdrawn(clinic, locale, ended.id);
  },

  async 'unable-reason-is-a-fixed-list'({ context, locale }) {
    const person = await newPerson();
    const gp = await serviceAt(FACILITY_A);
    const ticket = await makeTicket(person, { serviceId: gp });
    const clinic = await clinicianPage(context);
    const posts: string[] = [];
    clinic.on('request', (request) => {
      if (request.method() === 'POST' && request.url() === `${API}/tickets/${ticket.id}/events`) posts.push(request.postData() ?? '');
    });
    await openTicket(clinic, locale, ticket.id);
    const unable = clinic.getByRole('button', { name: cmsg(locale, 'detail.unable'), exact: true });
    await unable.click();
    const panel = clinic.locator('[data-panel="unable"]');
    await expect(panel.getByRole('radio')).toHaveCount(5);
    expect(await panel.getByRole('radio').evaluateAll((nodes) => nodes.map((node) => (node as HTMLInputElement).value))).toEqual(UNABLE_REASONS);
    for (const code of UNABLE_REASONS) await expect(panel).toContainText(cmsg(locale, `detail.unableReason.${code}`));
    await expect(panel.locator('textarea, input[type="text"]')).toHaveCount(0); // never free text
    const confirm = panel.getByRole('button', { name: cmsg(locale, 'detail.unableConfirm'), exact: true });
    await expect(confirm).toBeDisabled(); // a reason is required
    await panel.getByRole('button', { name: cmsg(locale, 'detail.cancel'), exact: true }).click();
    await expect(panel).toHaveCount(0);
    expect(posts).toEqual([]);

    await unable.click();
    await panel.locator('input[value="could_not_reach"]').check();
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(clinic.locator('[data-unable-standing]')).toContainText(cmsg(locale, 'detail.unableReason.could_not_reach'));
    expect(posts.map((body) => JSON.parse(body))).toEqual([{ unable: true, reason: 'could_not_reach' }]);
    expect((await stored(ticket.id)).events.at(-1)).toMatchObject({ fromState: 'issued', toState: 'issued', actor: 'clinic', reason: 'could_not_reach' });

    // The API holds the same line: a reason outside the list, extra fields, a person, and a state that cannot be rerouted.
    const staff = bearer(await staffSession(CLINICIAN_A));
    const post = (headers: Record<string, string>, body: unknown, id = ticket.id) => call('POST', `/tickets/${id}/events`, { headers, body });
    expect((await post(staff, { unable: true, reason: 'the patient was rude' })).status).toBe(400);
    expect((await post(staff, { unable: true, reason: 'other', note: 'free text' })).status).toBe(400);
    expect((await post(staff, { unable: true })).status).toBe(400);
    expect((await call('POST', `/me/tickets/${ticket.id}/events`, { headers: person.headers, body: { unable: true, reason: 'other' } })).status).toBe(403);
    const seen = await makeTicket(person, { serviceId: gp });
    expect((await post(staff, { to: 'seen' }, seen.id)).status).toBe(200);
    expect((await post(staff, { unable: true, reason: 'other' }, seen.id)).status).toBe(409);
    // On screen: a seen ticket offers no action at all, an acknowledged one offers seen and unable but not acknowledge.
    await openTicket(clinic, locale, seen.id);
    await expect(clinic.locator('[data-no-actions]')).toHaveText(cmsg(locale, 'detail.noActions'));
    await expect(clinic.locator('[data-detail] button', { hasText: cmsg(locale, 'detail.unable') })).toHaveCount(0);
    const acknowledged = await makeTicket(person, { serviceId: gp });
    expect((await post(staff, { to: 'acknowledged' }, acknowledged.id)).status).toBe(200);
    await openTicket(clinic, locale, acknowledged.id);
    await expect(clinic.getByRole('button', { name: cmsg(locale, 'detail.unable'), exact: true })).toBeVisible();
    await expect(clinic.getByRole('button', { name: cmsg(locale, 'detail.markSeen'), exact: true })).toBeVisible();
    await expect(clinic.getByRole('button', { name: cmsg(locale, 'detail.acknowledge'), exact: true })).toHaveCount(0);
  },

  async 'seeded-withdrawn-ticket-is-handled'({ context, locale, consoleGuard }) {
    // A seeded ticket has no bundle, so opening it asks for one and gets 404, which the screen shows as "nothing shared".
    // The first ticket of each of the two queues this test opens is named before it is opened.
    const firstOf = async (state: string) => ((await call('GET', `/tickets?state=${state}&limit=1`, { headers: bearer(await staffSession(CLINICIAN_A)) })).json() as { items: { id: string }[] }).items[0]!.id;
    for (const state of ['withdrawn', 'overdue']) {
      consoleGuard.allow({ url: `${API}/tickets/${await firstOf(state)}/bundle`, expect: 404, reason: `a seeded ${state} ticket has no bundle, which the test opens on purpose` });
    }
    const clinic = await clinicianPage(context);
    await clinic.goto(clinicUrl(locale, '?state=withdrawn'));
    const first = clinic.locator('[data-queue] tr[data-ticket]').first();
    await expect(first).toBeVisible();
    await expect(first).toHaveAttribute('data-state', 'withdrawn');
    await first.getByRole('button').click();
    await expect(clinic.locator('[data-detail] [data-code]')).toBeVisible();
    const id = new URL(clinic.url()).searchParams.get('ticket')!;

    // A ticket with nothing shared: its own fields, said plainly, and not the person's withdrawal.
    await expect(clinic.locator('[data-detail] [data-state]')).toHaveText(cmsg(locale, 'state.withdrawn'));
    await expect(clinic.locator('[data-nothing-shared]')).toHaveText(cmsg(locale, 'detail.nothingShared'));
    await expect(clinic.locator('[data-detail-state="withdrawn"]')).toHaveCount(0);
    await expect(clinic.locator('[data-detail]')).not.toContainText(cmsg(locale, 'detail.withdrawn'));
    await expect(clinic.locator('[data-no-actions]')).toHaveText(cmsg(locale, 'detail.noActions'));
    await expect(clinic.locator('[data-detail] button')).toHaveCount(0);
    await expect(clinic.locator('[data-fhir], [data-export-label]')).toHaveCount(0);

    // The API: 200 for the ticket, 404 (nothing shared) for the bundle and the export, never 410, because it has no consent rows.
    const staff = bearer(await staffSession(CLINICIAN_A));
    expect((await call('GET', `/tickets/${id}`, { headers: staff })).status).toBe(200);
    expect((await call('GET', `/tickets/${id}/bundle`, { headers: staff })).status).toBe(404);
    expect((await call('GET', `/tickets/${id}/fhir`, { headers: staff })).status).toBe(404);
    expect((await stored(id)).consents).toEqual([]);
    expect((await stored(id)).bundleReads).toBe(0);

    // A seeded ticket that is still open behaves the same, and can be acted on.
    await clinic.goto(clinicUrl(locale, '?state=overdue'));
    await clinic.locator('[data-queue] tr[data-ticket]').first().getByRole('button').click();
    await expect(clinic.locator('[data-nothing-shared]')).toBeVisible();
    await expect(clinic.getByRole('button', { name: cmsg(locale, 'detail.markSeen'), exact: true })).toBeEnabled();
    await expect(clinic.getByRole('button', { name: cmsg(locale, 'detail.unable'), exact: true })).toBeEnabled();
    await expect(clinic.locator('[data-detail-state="withdrawn"]')).toHaveCount(0);
  },

  async 'summary-gone-while-ticket-live'({ context, locale }) {
    const person = await newPerson();
    const ticket = await makeTicket(person, { serviceId: await serviceAt(FACILITY_A), consents: ['ticket', 'conditions'], approvedSummary: SUMMARY, summaryBuiltFrom: ['ticket', 'conditions'] });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(CLINIC).origin });
    const clinic = await clinicianPage(context);
    await openTicket(clinic, locale, ticket.id);
    await expect(clinic.locator('[data-summary]')).toHaveText(SUMMARY);
    await expect(clinic.locator('[data-section="conditions"]')).toContainText(CONDITION);
    await clinic.getByRole('button', { name: cmsg(locale, 'detail.copyFhir'), exact: true }).click();
    await expect(clinic.locator('[data-fhir]')).toContainText(SUMMARY);

    // The person stops the condition the summary was written from. The summary goes; the ticket stays.
    const stopped = await revokeConsent(person, ticket, 'conditions');
    expect(stopped.json()).toMatchObject({ summaryRemoved: true, ticketState: 'issued' });
    await openTicket(clinic, locale, ticket.id);
    await expect(clinic.locator('[data-no-summary]')).toHaveText(cmsg(locale, 'detail.noSummary'));
    await expect(clinic.locator('[data-summary]')).toHaveCount(0);
    await expect(clinic.locator('[data-section="conditions"] [data-not-shared]')).toHaveText(cmsg(locale, 'detail.notShared'));
    // The ticket is live: not the withdrawal banner, and the clinic can still act on it.
    await expect(clinic.locator('[data-detail-state="withdrawn"]')).toHaveCount(0);
    await expect(clinic.getByRole('button', { name: cmsg(locale, 'detail.acknowledge'), exact: true })).toBeEnabled();
    await expect(clinic.locator('body')).not.toContainText(SUMMARY);
    // And the export leaves it out: no note at all, still a valid bundle.
    await clinic.getByRole('button', { name: cmsg(locale, 'detail.copyFhir'), exact: true }).click();
    await expect(clinic.locator('[data-fhir]')).toBeVisible();
    const text = (await clinic.locator('[data-fhir]').textContent())!;
    expect(await validateBundle(text)).toEqual({ valid: true });
    expect(text).not.toContain(SUMMARY);
    expect(text).not.toContain('"note"');
    expect(text).not.toContain(CONDITION);
    expect(JSON.parse(text).entry.map((entry: { resource: { resourceType: string } }) => entry.resource.resourceType)).toEqual(['ServiceRequest']);
  },

  async 'claim-by-link-and-by-code'({ page, context, browser, locale, consoleGuard }) {
    consoleGuard.allow({ url: `${API}/me/invites/claim`, expect: 404, reason: 'an unknown, expired or taken code is typed on purpose, which answers 404' });
    const byLink = await handOver('phc', locale);
    await page.goto(`/${locale}/claim/?code=${byLink.code}`);
    await expect(page.locator('#invite-code')).toHaveValue(byLink.code);
    const claim = page.getByRole('button', { name: msg(locale, 'claim.claim'), exact: true });
    await expect(claim).toBeEnabled();
    expect((await invite(byLink.inviteId)).claimedBy).toBeNull(); // the link alone claims nothing
    await claim.click();
    await expect(page.locator('[data-claimed="phc"]')).toContainText(msg(locale, 'claim.source.phc'));
    expect((await invite(byLink.inviteId)).claimedBy).not.toBeNull();
    await expect(page.locator('[data-claimed] a.btn-primary')).toHaveAttribute('href', `/${locale}/check-in/?i=who5`);

    // By code: nothing to press until the box holds a code, then any case and no dash will do.
    const byCode = await handOver('school', locale);
    await page.goto(`/${locale}/claim/`);
    await expect(claim).toBeDisabled();
    await page.locator('#invite-code').fill('abc');
    await expect(claim).toBeDisabled();
    await page.locator('#invite-code').fill('ABCD-EFG0'); // 0 is not in the alphabet
    await expect(claim).toBeDisabled();
    await page.locator('#invite-code').fill('ZZZZ-ZZZZ');
    await claim.click();
    await expect(page.locator('[data-problem="not_found"]')).toHaveText(msg(locale, 'claim.problem.not_found'));
    await page.locator('#invite-code').fill(byCode.code.replace('-', '').toLowerCase());
    await context.setOffline(true);
    await claim.click();
    await expect(page.locator('[data-problem="offline"]')).toHaveText(msg(locale, 'claim.problem.offline'));
    expect((await invite(byCode.inviteId)).claimedBy).toBeNull();
    await context.setOffline(false);
    await claim.click();
    await expect(page.locator('[data-claimed="school"]')).toBeVisible();
    expect((await invite(byCode.inviteId)).claimedBy).not.toBeNull();

    // Someone else's device cannot take a code that is taken, and is told the same as for a code that does not exist.
    const other = await browser.newContext();
    try {
      const second = await other.newPage();
      await second.goto(`${BASE}/${locale}/claim/?code=${byLink.code}`);
      await second.getByRole('button', { name: msg(locale, 'claim.claim'), exact: true }).click();
      await expect(second.locator('[data-problem="not_found"]')).toHaveText(msg(locale, 'claim.problem.not_found'));
      expect((await invite(byLink.inviteId)).claimedBy).not.toBeNull();
    } finally {
      await other.close();
    }
  },

  async 'tamm-mock-page-is-labelled'({ page, locale }) {
    await page.goto(`/${locale}/tamm/?code=ABCD-EFGH`);
    const banner = page.locator('[data-mock-banner]');
    await expect(banner).toHaveText(msg(locale, 'tamm.mockBanner'));
    expect(await computed(page, '[data-mock-banner]', ['background-color', 'color', 'font-weight'])).toMatchObject({ 'background-color': 'rgb(231, 228, 242)', color: 'rgb(62, 52, 112)', 'font-weight': '600' });
    await expect(page.getByText(msg(locale, 'tamm.mockNote'))).toBeVisible();
    await expect(page.locator('[data-continue-with-mawsool]')).toHaveText(msg(locale, 'tamm.continue'));
    await expect(page.locator('[data-continue-with-mawsool]')).toHaveAttribute('href', `/${locale}/claim/?code=ABCD-EFGH`);
    // Without a usable code there is no link to follow.
    for (const query of ['', '?code=nonsense', '?code=ABCD-EFG0']) {
      await page.goto(`/${locale}/tamm/${query}`);
      await expect(page.locator('[data-mock-banner]')).toBeVisible();
      await expect(page.locator('[data-continue-with-mawsool]')).toHaveCount(0);
      await expect(page.locator('[data-no-code]')).toHaveText(msg(locale, 'tamm.noCode'));
    }
    // The page makes no call of its own to the API: it knows no key and holds no data.
    const toApi: string[] = [];
    page.on('request', (request) => {
      if (request.url().startsWith(API)) toApi.push(`${request.method()} ${new URL(request.url()).pathname} ${request.headers()['authorization'] ?? ''}`.trim());
    });
    await page.goto(`/${locale}/tamm/?code=ABCD-EFGH`);
    await expect(page.locator('[data-continue-with-mawsool]')).toBeVisible();
    // Only the app shell's public read of the sample directory: nothing signed, nothing with a credential, nothing written.
    expect(toApi.every((entry) => entry === 'GET /services' || entry === 'GET /clock')).toBe(true);
  },

  async 'clinician-screen-holds-the-plan-tokens'({ context, locale }) {
    const rgb = { ground: 'rgb(243, 246, 245)', white: 'rgb(255, 255, 255)', ink: 'rgb(16, 48, 45)', muted: 'rgb(74, 95, 92)', border: 'rgb(213, 223, 220)', accent: 'rgb(14, 107, 99)', tint: 'rgb(224, 240, 236)', warning: 'rgb(253, 243, 228)', warningInk: 'rgb(92, 58, 10)', chipWarning: 'rgb(246, 217, 168)', mock: 'rgb(231, 228, 242)', mockInk: 'rgb(62, 52, 112)' };
    const person = await newPerson();
    const ticket = await makeTicket(person, { serviceId: await serviceAt(FACILITY_A), consents: ['ticket', 'scores', 'trajectory', 'conditions', 'preferences'], approvedSummary: SUMMARY, summaryBuiltFrom: ['ticket'] });
    const clinic = await clinicianPage(context);
    await clinic.setViewportSize({ width: 390, height: 844 });
    await clinic.goto(clinicUrl(locale, '?state=overdue'));
    await expect(clinic.locator('[data-queue] tr[data-ticket]').first()).toBeVisible();
    const h1 = locale === 'ar' ? { 'font-size': '24px', 'font-weight': '600', 'line-height': '34px' } : { 'font-size': '24px', 'font-weight': '600', 'line-height': '30px' };
    expect(await computed(clinic, 'main h1', ['font-size', 'font-weight', 'line-height', 'color'])).toMatchObject({ ...h1, color: rgb.ink });
    expect(await computed(clinic, 'body', ['background-color', 'color'])).toMatchObject({ 'background-color': rgb.ground, color: rgb.ink });
    expect(await clinic.evaluate(() => getComputedStyle(document.documentElement).direction)).toBe(locale === 'ar' ? 'rtl' : 'ltr');
    expect(await clinic.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    // The queue: white, 14 radius, a rule in the border colour; the table scrolls inside it rather than the page.
    expect(await computed(clinic, '[data-queue]', ['background-color', 'border-top-left-radius', 'border-top-color', 'overflow-x'])).toMatchObject({ 'background-color': rgb.white, 'border-top-left-radius': '14px', 'border-top-color': rgb.border, 'overflow-x': 'auto' });
    // Overdue rows: the warning ground, the warning chip; ticket codes in Plex Mono 600.
    expect(await computed(clinic, '[data-queue] tr[data-state="overdue"]', ['background-color'])).toMatchObject({ 'background-color': rgb.warning });
    expect(await computed(clinic, '[data-queue] tr[data-state="overdue"] td:last-child span', ['background-color', 'color', 'border-top-left-radius', 'font-size', 'font-weight'])).toMatchObject({ 'background-color': rgb.chipWarning, color: rgb.warningInk, 'border-top-left-radius': '8px', 'font-size': '12px', 'font-weight': '600' });
    expect(await computed(clinic, '[data-queue] tr[data-ticket] button', ['font-family', 'font-weight'])).toMatchObject({ 'font-family': expect.stringMatching(/IBM Plex Mono/), 'font-weight': '600' });
    expect(await computed(clinic, '[data-queue] thead th', ['font-size', 'color', 'letter-spacing', 'text-transform'])).toMatchObject({ 'font-size': '12px', color: rgb.muted, 'letter-spacing': '0.5px', 'text-transform': 'uppercase' });
    // Body text sits on the plan's line box (15/22, Arabic 15/24) as a length, in the nav, the queue and every line of the detail.
    const body = locale === 'ar' ? '24px' : '22px';
    for (const selector of ['body', 'nav button', '[data-queue] td', '[data-brand]']) expect((await computed(clinic, selector, ['line-height']))['line-height'], selector).toBe(body);
    // The sidebar opens with the mark, the wordmark and the 13 px muted "Clinician" label, as on the board; the language toggle is in the page and reachable.
    await expect(clinic.locator('nav [data-brand] svg')).toBeVisible();
    expect(await computed(clinic, 'nav [data-brand] .wordmark', ['font-weight', 'color'])).toMatchObject({ 'font-weight': '700', color: 'rgb(255, 255, 255)' });
    expect(await computed(clinic, 'nav [data-brand] span:last-child', ['font-size', 'color'])).toMatchObject({ 'font-size': '13px', color: 'rgb(185, 207, 203)' });
    await expect(clinic.locator('nav [data-brand] span:last-child')).toHaveText(cmsg(locale, 'nav.label'));
    const toggle = clinic.locator('main .lang-toggle');
    await expect(toggle).toBeVisible();
    expect((await toggle.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    // Everything you can press or choose is at least 44 high.
    for (const selector of ['nav button', 'main select', '[data-queue] tr[data-ticket] button']) {
      for (const control of await clinic.locator(selector).all()) expect((await control.boundingBox())!.height, selector).toBeGreaterThanOrEqual(44);
    }
    expect(await computed(clinic, '[data-facility]', ['background-color', 'border-top-left-radius'])).toMatchObject({ 'background-color': 'rgb(27, 68, 64)', 'border-top-left-radius': '10px' });
    expect(await computed(clinic, 'main .rounded-chip', ['background-color', 'color'])).toMatchObject({ 'background-color': rgb.mock, color: rgb.mockInk });

    // The open ticket: 14 radius panel, 12 px section labels, 44 px pills.
    await openTicket(clinic, locale, ticket.id);
    expect(await computed(clinic, '[data-detail]', ['background-color', 'border-top-left-radius', 'border-top-color', 'padding-top'])).toMatchObject({ 'background-color': rgb.white, 'border-top-left-radius': '14px', 'border-top-color': rgb.border, 'padding-top': '18px' });
    expect(await computed(clinic, '[data-detail] [data-code]', ['font-size', 'font-weight', 'font-family'])).toMatchObject({ 'font-size': '22px', 'font-weight': '600', 'font-family': expect.stringMatching(/IBM Plex Mono/) });
    expect(await computed(clinic, '[data-detail] [data-state]', ['background-color', 'color', 'font-size'])).toMatchObject({ 'background-color': rgb.tint, color: 'rgb(10, 79, 73)', 'font-size': '12px' });
    expect(await computed(clinic, '[data-section="scores"] > span', ['font-size', 'font-weight', 'color', 'letter-spacing', 'text-transform'])).toMatchObject({ 'font-size': '12px', 'font-weight': '600', color: rgb.muted, 'letter-spacing': '0.5px', 'text-transform': 'uppercase' });
    for (const name of [cmsg(locale, 'detail.markSeen'), cmsg(locale, 'detail.unable'), cmsg(locale, 'detail.acknowledge')]) {
      expect(await computed(clinic, `[data-detail] button:text-is("${name}")`, ['border-top-left-radius', 'font-size', 'font-weight'])).toMatchObject({ 'border-top-left-radius': '22px', 'font-size': '15px', 'font-weight': '600' });
      expect((await clinic.locator(`[data-detail] button:text-is("${name}")`).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    expect((await clinic.getByRole('button', { name: cmsg(locale, 'detail.copyFhir'), exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    // Detail details from the board: the "Referred" line is 14 px pulled 8 px up, the action row sits 4 px lower, the export block's gap is 10.
    expect(await computed(clinic, '[data-detail] [data-code] ~ p, [data-detail] > p', ['font-size', 'margin-top', 'color'])).toMatchObject({ 'font-size': '14px', 'margin-top': '-8px', color: rgb.muted });
    expect(await computed(clinic, '[data-detail] button:text-is("' + cmsg(locale, 'detail.markSeen') + '")', ['line-height'])).toMatchObject({ 'line-height': body });
    expect(await computed(clinic, '[data-detail] button:text-is("' + cmsg(locale, 'detail.markSeen') + '") >> xpath=../..', ['margin-top'])).toMatchObject({ 'margin-top': '4px' });
    expect(await computed(clinic, '[data-export-label] >> xpath=../..', ['row-gap', 'border-top-color'])).toMatchObject({ 'row-gap': '10px', 'border-top-color': 'rgb(230, 236, 234)' });
    for (const selector of ['[data-section="scores"] li', '[data-section="conditions"] li', '[data-section="preferences"] p', '[data-summary]']) expect((await computed(clinic, selector, ['line-height']))['line-height'], selector).toBe(body);
    // The status chips of a row, from the board: acknowledged is white on the selected row, in the dark teal; issued is the plain grey.
    await clinic.goto(clinicUrl(locale, `?ticket=${ticket.id}`));
    await expect(clinic.locator('[data-queue] tr[data-ticket]').first()).toBeVisible();
    const acknowledged = await makeTicket(person, { serviceId: await serviceAt(FACILITY_A) });
    expect((await call('POST', `/tickets/${acknowledged.id}/events`, { headers: bearer(await staffSession(CLINICIAN_A)), body: { to: 'acknowledged' } })).status).toBe(200);
    await clinic.goto(clinicUrl(locale, `?ticket=${acknowledged.id}`));
    await expect(row(clinic, acknowledged.shortCode)).toHaveAttribute('data-selected', 'true');
    expect(await computed(clinic, `[data-queue] tr[data-ticket="${acknowledged.shortCode}"] td:last-child span`, ['background-color', 'color'])).toMatchObject({ 'background-color': rgb.white, color: 'rgb(10, 79, 73)' });
    expect(await computed(clinic, `[data-queue] tr[data-ticket="${ticket.shortCode}"] td:last-child span`, ['background-color'])).toMatchObject({ 'background-color': 'rgb(238, 242, 241)' });
    // The sign-in forms' address field has the board's input border.
    await clinic.goto(clinicUrl(locale, 'sign-in/'));
    expect(await computed(clinic, '#staff-email', ['border-top-color', 'border-top-width'])).toMatchObject({ 'border-top-color': 'rgb(154, 170, 167)', 'border-top-width': '1px' });
    expect(await clinic.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  },

  async 'snapshot-clinician'({ page, context, locale }) {
    // A fixed queue and ticket, a fixed clock and a fixed session, so every date and every pixel is the same in every run.
    await context.clock.setFixedTime(new Date('2026-11-02T08:00:00+04:00'));
    const id = '5b5d2f6e-0a0e-4a45-9d2c-3c7e1a4e9a11';
    const item = (code: string, tier: string, deadline: string, state: string, language: string, source: string, n: number) => ({
      id: n === 3 ? id : `5b5d2f6e-0a0e-4a45-9d2c-3c7e1a4e9a${String(20 + n)}`, shortCode: code, tier, state, language, deadlineAt: deadline, source, serviceId: '6c6d2f6e-0a0e-4a45-9d2c-3c7e1a4e9a22', createdAt: '2026-10-29T08:00:00+04:00',
    });
    const queue = {
      facility: { id: FACILITY_A, name: 'Sample PHC · Khalifa City' },
      total: 6,
      counts: { issued: 4, acknowledged: 1, overdue: 1, seen: 19 },
      items: [
        item('MW2HD8', 'specialist', '2026-10-31T23:59:59+04:00', 'overdue', 'ur', 'tamm', 1),
        item('MW9TQ2', 'specialist', '2026-11-03T23:59:59+04:00', 'issued', 'en', 'phc', 2),
        item('MW4K7Q', 'gp', '2026-11-05T23:59:59+04:00', 'acknowledged', 'ar', 'app', 3),
        item('MW7PK4', 'tele', '2026-11-06T23:59:59+04:00', 'issued', 'ar', 'phc', 4),
        item('MW5RX2', 'gp', '2026-11-07T23:59:59+04:00', 'issued', 'tl', 'app', 5),
        item('MW8KC3', 'tele', '2026-11-08T23:59:59+04:00', 'issued', 'hi', 'app', 6),
      ],
    };
    const detail = { ...queue.items[2]!, unable: null };
    const bundle = {
      ticketId: id,
      shortCode: 'MW4K7Q',
      content: {
        scores: [
          { instrument: 'gad7', total: 14, band: 'moderate', takenAt: '2026-10-29T08:00:00+04:00' },
          { instrument: 'phq9', total: 7, band: 'mild', takenAt: '2026-10-29T08:05:00+04:00' },
        ],
        trajectory: [
          { instrument: 'gad7', total: 9, band: 'mild', takenAt: '2026-10-08T08:00:00+04:00' },
          { instrument: 'gad7', total: 14, band: 'moderate', takenAt: '2026-10-29T08:00:00+04:00' },
        ],
        conditions: ['Type 2 diabetes'],
        preferences: { language: 'ar', clinicianGender: 'female', modality: 'in_person' },
      },
      notShared: ['free_text'],
      approvedSummary: 'I would like a first appointment about my worry and low mood. I work long hours and mornings are best.',
    };
    await page.route(`${API}/tickets?**`, (route) => route.fulfill({ json: queue }));
    await page.route(`${API}/tickets/${id}`, (route) => route.fulfill({ json: detail }));
    await page.route(`${API}/tickets/${id}/bundle`, (route) => route.fulfill({ json: bundle }));
    await keepSession(context, CLINIC, { sessionToken: 'snapshot-session', expiresAt: '2026-11-02T16:00:00.000Z', role: 'clinician', facilityId: FACILITY_A });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(clinicUrl(locale, `?ticket=${id}`));
    await expect(page.locator('[data-detail] [data-code]')).toBeVisible();
    await expect(page.locator('[data-queue] tr[data-ticket]')).toHaveCount(6);
    await snapshot(page, `clinician-${locale}`);
  },

  async 'crisis-line-console-reads-a-consented-handoff-and-marks-contact'({ page, context, locale }) {
    const handoff = await handOffFromPhone(page, locale);
    // The totals of the two finished check-ins (the GAD-7, and the PHQ-9 whose item 9 opened the screen), and no item answer.
    expect(handoff.content).toMatchObject({ language: locale, trigger: 'phq9_item9', callbackNumber: HANDOFF_NUMBER });
    expect(handoff.content.scores.map((score) => [score.instrument, score.total]).sort()).toEqual([['gad7', 9], ['phq9', 1]]);
    expect(JSON.stringify(handoff.content)).not.toContain('answers');
    // The raw row is ciphertext: neither the number nor a total is readable in it.
    expect(handoff.ciphertext).toMatch(/^v1\./);
    expect(handoff.ciphertext).not.toContain('971501234567');
    const [event] = await storedCrisisEvents(handoff.crisisEventId);
    expect(event).toMatchObject({ contextShared: true, humanContactConfirmed: false, resolvedAt: null });
    expect(Object.keys(event!)).not.toContain('personId');

    // The operator signs in through the real page: a logged link, one press, then the console.
    const console_ = await context.newPage();
    const link = new URL(await requestLink(CRISIS_LINE_USER));
    await console_.goto(`${OPS}/${locale}/sign-in/?token=${link.searchParams.get('token')}`);
    await console_.getByRole('button', { name: omsg(locale, 'signIn.action'), exact: true }).click();
    await console_.locator('[data-continue]').click();
    await expect(console_).toHaveURL(`${OPS}/${locale}/crisis-line/`);
    await expect(console_.locator('[data-mock-label]')).toHaveText(omsg(locale, 'crisisLine.mock'));
    const item = console_.locator(`[data-handoff="${handoff.id}"]`);
    await expect(item).toHaveAttribute('data-contact', 'waiting');
    await expect(item.locator('[data-callback]')).toHaveText(HANDOFF_NUMBER);
    await expect(item.locator('[data-reason]')).toHaveText(omsg(locale, 'crisisLine.reason.phq9_item9'));
    await expect(item).toContainText('GAD-7 9');

    await item.locator('[data-mark-contact]').click();
    await expect(item).toHaveAttribute('data-contact', 'made');
    await expect(console_.locator('[data-console-message]')).toHaveText(omsg(locale, 'crisisLine.marked'));
    const [done] = await storedCrisisEvents(handoff.crisisEventId);
    expect(done).toMatchObject({ humanContactConfirmed: true, contactSource: 'mock_line' });
    expect(done!.resolvedAt).not.toBeNull();

    // The person stops sharing: the raw row goes, the console shows nothing after a refresh, and the API answers 404 to a direct read.
    await page.goto(`/${locale}/settings/`);
    await page.locator('[data-handoff-stop]').click();
    await expect(page.getByText(msg(locale, 'crisis.handoffStopped'), { exact: true })).toBeVisible();
    expect((await storedHandoffs()).map((row) => row.id)).not.toContain(handoff.id);
    await console_.locator('[data-refresh]').click();
    await expect(console_.locator(`[data-handoff="${handoff.id}"]`)).toHaveCount(0);
    const session = await staffSession(CRISIS_LINE_USER);
    expect((await call('GET', `/crisis-handoffs/${handoff.id}`, { headers: bearer(session) })).status).toBe(404);
  },

  async 'crisis-line-role-is-confined-to-its-console'({ context, browser, locale }) {
    const line = await staffSession(CRISIS_LINE_USER);
    // Other staff's screens do not open for it, and the console does not open for them.
    const asLine = await context.newPage();
    await keepSession(context, OPS, line);
    await asLine.goto(`${OPS}/${locale}/`, { waitUntil: 'commit' });
    await expect(asLine).toHaveURL(`${OPS}/${locale}/sign-in/`);
    const opsContext = await browser.newContext();
    const asOps = await opsContext.newPage();
    await keepSession(opsContext, OPS, await staffSession(OPS_USER));
    await asOps.goto(`${OPS}/${locale}/crisis-line/`, { waitUntil: 'commit' });
    await expect(asOps).toHaveURL(`${OPS}/${locale}/sign-in/`);
    await opsContext.close();
    // The API says the same: no dashboard, no queue, no ticket, no export; and a person (even a registered one) cannot read the console's routes.
    for (const path of ['/metrics/funnel', '/metrics/crisis', '/tickets', '/tickets/00000000-0000-4000-8000-000000000001', '/tickets/00000000-0000-4000-8000-000000000001/bundle', '/tickets/00000000-0000-4000-8000-000000000001/fhir']) {
      expect([401, 403], path).toContain((await call('GET', path, { headers: bearer(line) })).status);
    }
    const person = await newPerson();
    expect((await call('GET', '/crisis-handoffs', { headers: person.headers })).status).toBe(401);
    expect((await call('GET', '/crisis-handoffs')).status).toBe(401);
    expect((await call('GET', '/crisis-handoffs', { headers: bearer(line) })).status).toBe(200);
  },

  async 'crisis-handoff-failure-leaves-the-crisis-screen-alone'({ page, locale, consoleGuard }) {
    consoleGuard.allow({ url: `${API}/me/crisis-handoffs`, expect: 503, reason: 'the hand-off send is answered with a server error, to show the crisis screen carries on' });
    await visitOnline(page, locale);
    const before = (await storedHandoffs()).length;
    await triggerCrisis(page, locale);
    await page.route(`${API}/me/crisis-handoffs`, (route) => route.fulfill({ status: 503, json: { error: 'unavailable' } }));
    await page.locator('[data-handoff-offer]').click();
    await page.locator('[data-handoff-consent]').check();
    await page.locator('[data-handoff-send]').click();
    await expect(page.locator('[data-handoff-failure="offline"]')).toHaveText(msg(locale, 'crisis.handoffOffline'));
    // The numbers, the block and the choices are as they were.
    for (const number of ['800725462', '998', '999']) await expect(page.locator(`a[href="tel:${number}"]`)).toBeVisible();
    expect(await storedHandoffs()).toHaveLength(before);
    await page.reload();
    await expect(page).toHaveURL(crisisUrl(locale));
    await page.goto(`/${locale}/options/`);
    await expect(page).toHaveURL(crisisUrl(locale));
    await page.getByRole('button', { name: msg(locale, 'crisis.safeNow'), exact: true }).click();
    // Releasing leaves the crisis screen for the finished check-in's result, as it always does.
    await expect(page).toHaveURL(new RegExp(`/${locale}/result/\\?id=`));
  },

  async 'stale-contact-made-after-the-person-stopped-sharing-is-refused'({ page, context, locale, consoleGuard }) {
    const handoff = await handOffFromPhone(page, locale);
    provoke(consoleGuard, 'the operator presses "contact made" on a hand-off the person has since stopped sharing, which the API refuses with 404', [[`/crisis-handoffs/${handoff.id}/contact`, 404]]);
    const console_ = await context.newPage();
    await keepSession(context, OPS, await staffSession(CRISIS_LINE_USER));
    await console_.goto(`${OPS}/${locale}/crisis-line/`);
    await expect(console_.locator(`[data-handoff="${handoff.id}"]`)).toBeVisible();
    // The person stops sharing while the operator's list is open.
    await page.goto(`/${locale}/settings/`);
    await page.locator('[data-handoff-stop]').click();
    await expect(page.getByText(msg(locale, 'crisis.handoffStopped'), { exact: true })).toBeVisible();
    // The stale list still shows it; pressing the button is refused, and the list is read again.
    await console_.locator(`[data-handoff="${handoff.id}"] [data-mark-contact]`).click();
    await expect(console_.locator('[data-console-message]')).toHaveText(omsg(locale, 'crisisLine.gone'));
    await expect(console_.locator(`[data-handoff="${handoff.id}"]`)).toHaveCount(0);
    const [event] = await storedCrisisEvents(handoff.crisisEventId);
    expect(event).toMatchObject({ humanContactConfirmed: false, resolvedAt: null });
  },
};

/** Opens a ticket the person has ended the share of, from a link, and checks the clinic is shown the banner and nothing else. */
async function openWithdrawn(clinic: Page, locale: Locale, id: string): Promise<void> {
  await clinic.goto(clinicUrl(locale, `?ticket=${id}`));
  const banner = clinic.locator('[data-detail-state="withdrawn"]');
  await expect(banner).toBeVisible();
  await expect(banner.getByRole('heading')).toHaveText(cmsg(locale, 'detail.withdrawn'));
  await expect(clinic.locator('[data-detail] [data-code]')).toHaveCount(0);
  await expect(clinic.locator('[data-detail] button')).toHaveCount(0);
}


const HANDOFF_NUMBER = '+971501234567';

interface StoredHandoff {
  id: string;
  crisisEventId: string;
  consentId: string;
  contactMadeAt: string | null;
  ciphertext: string;
  content: { language: string; trigger: string; callbackNumber: string | null; scores: { instrument: string; total: number }[] };
}

const storedHandoffs = async (): Promise<StoredHandoff[]> => (await (await fetch(`${INSPECT}/crisis-handoffs`)).json()) as StoredHandoff[];
const storedCrisisEvents = async (id: string): Promise<Record<string, unknown>[]> =>
  ((await (await fetch(`${INSPECT}/crisis-events`)).json()) as { id: string }[]).filter((event) => event.id === id) as Record<string, unknown>[];

/**
 * A GAD-7 of 9, then a PHQ-9 whose item 9 opens the crisis screen, then the hand-off sent from that screen: the offer opened, the
 * preview read, the send held back until the tick, then sent. Leaves the phone on the crisis screen with the hand-off stored.
 */
async function handOffFromPhone(page: Page, locale: Locale): Promise<StoredHandoff> {
  await visitOnline(page, locale);
  const before = await storedHandoffs();
  await takeCheckIn(page, locale, 'gad7', [2, 1, 1, 1, 1, 2, 1]);
  await expect(page.locator('[data-score]')).toHaveText('9');
  await triggerCrisis(page, locale);
  await page.locator('[data-handoff-offer]').click();
  const preview = page.locator('[data-handoff-preview]');
  await expect(preview).toContainText('GAD-7 9');
  await expect(preview).toContainText(msg(locale, 'crisis.handoffReason.phq9_item9'));
  await expect(preview).toContainText(msg(locale, 'crisis.handoffNoNumber'));
  await page.locator('[data-handoff-number]').fill('+971 50 123 4567');
  await expect(preview).toContainText(HANDOFF_NUMBER);
  // Nothing is sent before the explicit tick, and the button does not work without it.
  const send = page.locator('[data-handoff-send]');
  await expect(send).toBeDisabled();
  expect(await storedHandoffs()).toHaveLength(before.length);
  await page.locator('[data-handoff-consent]').check();
  await send.click();
  await expect(page.locator('[data-handoff-sent]')).toHaveText(msg(locale, 'crisis.handoffSent'));
  await expect(page.locator('[data-panel="crisis-handoff"] [data-mock-label]')).toHaveText(msg(locale, 'crisis.handoffMock'));
  await expect(page).toHaveURL(crisisUrl(locale));
  const added = (await storedHandoffs()).filter((row) => !before.some((earlier) => earlier.id === row.id));
  expect(added).toHaveLength(1);
  return added[0]!;
}

const ids = acceptance.map((entry) => entry.id);
if (JSON.stringify([...ids].sort()) !== JSON.stringify(Object.keys(CASES).sort())) {
  throw new Error(`e2e/acceptance-phase4.json and the cases in this file differ: ${ids.join(', ')} vs ${Object.keys(CASES).join(', ')}`);
}

test.describe('Phase 4 exit acceptance', () => {
  for (const entry of acceptance) {
    for (const locale of LOCALES) {
      test(`${entry.id} [${locale}]: ${entry.sentence}`, async ({ page, context, browser, consoleGuard }) => {
        await CASES[entry.id]!({ page, context, browser, locale, consoleGuard });
      });
    }
  }
});
