import { test as base, expect, type Browser, type BrowserContext, type ConsoleMessage } from '@playwright/test';

/**
 * Every browser suite fails on a console error. The browser logs one for a failed resource (a 404, a refused connection)
 * as well as for an uncaught exception, so a screen that asks for something that is not there, or throws, cannot pass.
 *
 * There is no allow-list by pattern and none for a suite. A test that deliberately provokes a failure names the exact
 * URL and the exact status (or network error) it provokes, for that test alone, with the reason; an allowance nothing
 * matched fails the test, so a stale one cannot stay. The gate for the demo (`gate:c`) allows nothing at all, except in the
 * one test that provokes an error on purpose (see `PROVOKES_AN_ERROR` in its spec).
 *
 * One more case is named by the test itself rather than by a URL: a test that cuts the network (`setOffline(true)`) makes
 * every request fail with `net::ERR_INTERNET_DISCONNECTED`, which the browser logs as a console error however the app
 * handles it. In such a test, and only in it, that one error is accepted, and each URL it was seen for is printed.
 */
export interface Allowance {
  /** The exact URL of the failing resource. */
  url: string;
  /**
   * The HTTP status the test provokes (a 4xx), the browser's network error (such as `net::ERR_FAILED`), or `'csp'` for a
   * request or frame the page's own security policy blocks. For `'csp'`, `url` is the exact blocked address.
   */
  expect: number | string;
  /** Why this test provokes it. */
  reason: string;
}

export class ConsoleGuard {
  readonly errors: string[] = [];
  readonly allowances: (Allowance & { hits: number })[] = [];
  private readonly watched = new WeakSet<BrowserContext>();
  /** Set once this test has cut the network. */
  private cutTheNetwork = false;
  readonly cutFailures = new Map<string, number>();

  watch(context: BrowserContext): void {
    if (this.watched.has(context)) return;
    this.watched.add(context);
    const setOffline = context.setOffline.bind(context);
    context.setOffline = async (offline: boolean) => {
      if (offline) this.cutTheNetwork = true;
      await setOffline(offline);
    };
    context.on('console', (message) => void this.record(message));
    context.on('weberror', (error) => this.errors.push(`uncaught: ${error.error().message}`));
  }

  private strict = false;

  /** Gate C: nothing may be excused. After this, `allow` throws. */
  forbidAllowances(): void {
    this.strict = true;
  }

  allow(allowance: Allowance): void {
    if (this.strict) throw new Error(`this suite allows no console error (asked for ${allowance.expect} ${allowance.url})`);
    this.allowances.push({ ...allowance, hits: 0 });
  }

  private record(message: ConsoleMessage): void {
    if (message.type() !== 'error') return;
    const text = message.text();
    const url = message.location().url;
    const status = /status of (\d{3})/.exec(text)?.[1];
    const network = /net::ERR_[A-Z_]+/.exec(text)?.[0];
    const policy = text.includes('Content Security Policy') || text.startsWith('policy violation:');
    const match = this.allowances.find((entry) =>
      entry.expect === 'csp'
        ? policy && text.includes(entry.url)
        : entry.url === url && (status ? entry.expect === Number(status) : network ? entry.expect === network : false),
    );
    if (match) {
      match.hits += 1;
      return;
    }
    if (this.cutTheNetwork && network === 'net::ERR_INTERNET_DISCONNECTED') {
      this.cutFailures.set(url, (this.cutFailures.get(url) ?? 0) + 1);
      return;
    }
    this.errors.push(`${text}${url ? ` (${url})` : ''}`);
  }
}

/** The guard of the test that is running. The suites run one test at a time, so a module variable is enough. */
let current: ConsoleGuard | null = null;

const patched = new WeakSet<Browser>();

/** Makes every context a test opens by hand (`browser.newContext`) watched by the guard of the test that opened it. */
function watchBrowser(browser: Browser): void {
  if (patched.has(browser)) return;
  patched.add(browser);
  const original = browser.newContext.bind(browser);
  browser.newContext = async (...args: Parameters<Browser['newContext']>) => {
    const context = await original(...args);
    current?.watch(context);
    return context;
  };
}

export const test = base.extend<{ consoleGuard: ConsoleGuard }>({
  consoleGuard: [
    async ({ context, browser }, use) => {
      const guard = new ConsoleGuard();
      current = guard;
      watchBrowser(browser);
      guard.watch(context);
      await use(guard);
      current = null;
      const unused = guard.allowances.filter((entry) => entry.hits === 0);
      expect(unused.map((entry) => `${entry.expect} ${entry.url}`), 'an allowance that nothing matched').toEqual([]);
      for (const entry of guard.allowances) console.log(`[console-guard] allowed ${entry.expect} ${entry.url} x${entry.hits}: ${entry.reason}`);
      for (const [url, hits] of guard.cutFailures) console.log(`[console-guard] network cut by the test: net::ERR_INTERNET_DISCONNECTED ${url} x${hits}`);
      expect(guard.errors, 'console errors').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
