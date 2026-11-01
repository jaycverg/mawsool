import { expect, type BrowserContext, type Page } from '@playwright/test';
import ar from '../messages/ar.json';
import en from '../messages/en.json';
import commonAr from '../../../packages/ui/messages/ar.json';
import commonEn from '../../../packages/ui/messages/en.json';

export type Locale = 'ar' | 'en';
export const LOCALES: readonly Locale[] = ['ar', 'en'];

export const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3450';
export const API = process.env.E2E_API_URL ?? 'http://127.0.0.1:4450';
export const INSPECT = process.env.E2E_INSPECT_URL ?? 'http://127.0.0.1:4451';

const MESSAGES = { ar: { ...commonAr, ...ar }, en: { ...commonEn, ...en } } as unknown as Record<Locale, Record<string, unknown>>;

/** A message in the app's own message file, so the tests read the same words a person sees. */
export function msg(locale: Locale, path: string): string {
  const found = path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], MESSAGES[locale]);
  if (typeof found !== 'string') throw new Error(`no message ${path} in ${locale}`);
  return found;
}

export const crisisUrl = (locale: Locale) => new RegExp(`/${locale}/crisis/$`);

/** How many requests each path has made to the static server (from the Node side, so offline mode does not touch it). */
export async function staticHits(): Promise<Record<string, number>> {
  const response = await fetch(`${BASE}/__e2e/hits`);
  return (await response.json()) as Record<string, number>;
}

/** Waits until the encrypted store holds a value under `key`; the value itself is ciphertext. */
export async function waitForStored(page: Page, key: string): Promise<void> {
  await page.waitForFunction(
    (name) =>
      new Promise<boolean>((resolve) => {
        const opening = indexedDB.open('mawsool');
        opening.onerror = () => resolve(false);
        opening.onupgradeneeded = () => {
          opening.transaction?.abort();
          resolve(false);
        };
        opening.onsuccess = () => {
          const db = opening.result;
          if (!db.objectStoreNames.contains('kv')) return resolve(false);
          const read = db.transaction('kv').objectStore('kv').get(name);
          read.onsuccess = () => {
            db.close();
            resolve(read.result !== undefined);
          };
          read.onerror = () => resolve(false);
        };
      }),
    key,
    { timeout: 20_000 },
  );
}

/**
 * The one online visit the offline checks start from: the app loads, the service worker installs and takes over,
 * and the sample directory is saved on the device.
 */
export async function visitOnline(page: Page, locale: Locale): Promise<void> {
  const directory = page.waitForResponse((response) => response.url() === `${API}/services` && response.ok());
  await page.goto(`/${locale}/`);
  await directory;
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 20_000 });
  await waitForStored(page, 'directory');
}

/** Cuts the network for the browser and returns the static server's request counts as they stand. */
export async function goOffline(context: BrowserContext): Promise<Record<string, number>> {
  await context.setOffline(true);
  return staticHits();
}

/**
 * Answers the question on screen with the option whose value is `value`, then waits for it to show as chosen. An
 * answer that sends the person to the crisis screen leaves the page, so there is nothing left to be checked.
 */
export async function pick(page: Page, value: number, options: { leavesPage?: boolean } = {}): Promise<void> {
  const radio = page.locator(`input[type="radio"][value="${value}"]`);
  await radio.click();
  if (!options.leavesPage) await expect(radio).toBeChecked();
}

/** Takes an instrument through the check-in screen. Stops after the last answer, before Next or Finish. */
export async function answerAll(page: Page, locale: Locale, answers: readonly number[], options: { lastLeavesPage?: boolean } = {}): Promise<void> {
  const progress = page.getByRole('progressbar');
  for (const [index, value] of answers.entries()) {
    await expect(progress).toHaveAttribute('aria-valuenow', String(index + 1));
    await pick(page, value, { leavesPage: options.lastLeavesPage && index === answers.length - 1 });
    if (index < answers.length - 1) await page.getByRole('button', { name: msg(locale, 'flow.next'), exact: true }).click();
  }
}

export const finishButton = (page: Page, locale: Locale) => page.getByRole('button', { name: msg(locale, 'checkIn.finish'), exact: true });

/** Opens a check-in and answers every question. A PHQ-9 whose item 9 is above zero ends on the crisis screen. */
export async function takeCheckIn(page: Page, locale: Locale, instrument: 'who5' | 'phq9' | 'gad7', answers: readonly number[]): Promise<void> {
  await page.goto(`/${locale}/check-in/?i=${instrument}`);
  const triggers = instrument === 'phq9' && (answers[8] ?? 0) > 0;
  await answerAll(page, locale, answers, { lastLeavesPage: triggers });
  if (!triggers) await finishButton(page, locale).click();
}

/** Takes the PHQ-9 with item 9 "several days" and waits for the crisis screen. */
export async function triggerCrisis(page: Page, locale: Locale): Promise<void> {
  await takeCheckIn(page, locale, 'phq9', [0, 0, 0, 0, 0, 0, 0, 0, 1]);
  await expect(page).toHaveURL(crisisUrl(locale));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(msg(locale, 'crisis.heading'));
}

export const PHQ9_ITEM9_ANSWERS = [0, 0, 0, 0, 0, 0, 0, 0, 1] as const;
