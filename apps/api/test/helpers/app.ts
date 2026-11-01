import type { FastifyInstance } from 'fastify';
import type { SummaryProvider } from '@mawsool/summary';
import { buildApp } from '../../src/app';
import { ManualClock } from '../../src/clock';
import type { Db } from '../../src/db/client';
import type { MagicLinkMessage, MagicLinkNotifier } from '../../src/notifier';
import { TEST_CONFIG } from './config';

export const TEST_START = new Date('2026-11-01T08:00:00+04:00');

/** Captures sign-in links instead of logging them, so tests can use the token. */
export class CapturingNotifier implements MagicLinkNotifier {
  readonly sent: MagicLinkMessage[] = [];
  failWith: Error | null = null;

  async send(message: MagicLinkMessage): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.sent.push(message);
  }

  /** The token inside the most recent link. */
  lastToken(): string {
    const link = this.sent.at(-1)?.link;
    if (!link) throw new Error('no link was sent');
    return new URL(link).searchParams.get('token')!;
  }
}

export interface TestApp {
  app: FastifyInstance;
  clock: ManualClock;
  notifier: CapturingNotifier;
}

export interface TestAppOptions {
  /** Registers the demo routes, as `DEMO_MODE` does. */
  demoMode?: boolean;
  summaryLlmEnabled?: boolean;
  summaryProvider?: SummaryProvider | null;
}

export async function createTestApp(db: Db, options: TestAppOptions = {}): Promise<TestApp> {
  const clock = new ManualClock(TEST_START);
  const notifier = new CapturingNotifier();
  const app = await buildApp({
    db,
    clock,
    notifier,
    config: { ...TEST_CONFIG, summaryLlmEnabled: options.summaryLlmEnabled ?? false, demoMode: options.demoMode ?? false },
    summaryProvider: options.summaryProvider ?? null,
  });
  return { app, clock, notifier };
}

/** Signs a staff user in through the real magic-link flow and returns the session token. */
export async function signIn({ app, notifier }: Pick<TestApp, 'app' | 'notifier'>, email: string): Promise<string> {
  const request = await app.inject({ method: 'POST', url: '/auth/magic-link', payload: { email } });
  if (request.statusCode !== 202) throw new Error(`magic-link request failed: ${request.statusCode}`);
  const verify = await app.inject({ method: 'POST', url: '/auth/verify', payload: { token: notifier.lastToken() } });
  if (verify.statusCode !== 200) throw new Error(`verify failed: ${verify.statusCode} ${verify.body}`);
  return verify.json().sessionToken as string;
}
