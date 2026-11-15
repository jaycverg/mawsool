import type { SummaryProvider } from '@mawsool/summary';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { clientKey } from '../src/plugins/rate-limit';
import { demoResetJob } from '../src/jobs';
import { runSeed } from '../src/seed/run';
import { createSummaryBudget } from '../src/summary-budget';
import { ManualClock } from '../src/clock';
import { createTestApp, type TestApp, type TestAppOptions } from './helpers/app';
import { createTestDb, type TestDb } from './helpers/db';
import { registerPerson, type TestPerson } from './helpers/flow';

const content = { scores: [{ instrument: 'phq9' as const, total: 12, band: 'moderate', takenAt: '2026-10-29T08:00:00+04:00' }] };

class CountingProvider implements SummaryProvider {
  calls = 0;
  async complete(): Promise<string> {
    this.calls += 1;
    return 'AI-DRAFT-TEXT';
  }
}

describe('the opt-in limits', () => {
  let testDb: TestDb;
  const open: TestApp[] = [];

  beforeAll(async () => {
    testDb = await createTestDb();
    await runSeed(testDb.db, testDb.cipher);
  });

  afterEach(async () => {
    for (const ctx of open.splice(0)) await ctx.app.close();
  });

  async function setup(options: TestAppOptions = {}) {
    const ctx = await createTestApp(testDb.db, options);
    open.push(ctx);
    return ctx;
  }

  const draft = (ctx: TestApp, person: TestPerson, extra: { remoteAddress?: string; headers?: Record<string, string>; useAi?: boolean } = {}) =>
    ctx.app.inject({
      method: 'POST',
      url: '/summary/draft',
      remoteAddress: extra.remoteAddress ?? '10.0.0.1',
      headers: { ...person.headers, ...extra.headers },
      payload: { requestId: crypto.randomUUID(), locale: 'en', useAi: extra.useAi ?? false, consented: ['ticket', 'scores'], content },
    });

  describe('/summary/draft per client', () => {
    it('serves 30 drafts in a minute with RATE_LIMIT unset', async () => {
      const ctx = await setup();
      const person = await registerPerson(ctx);
      for (let i = 0; i < 30; i += 1) expect((await draft(ctx, person)).statusCode, `draft ${i + 1}`).toBe(200);
    });

    it('with it on, refuses the 11th draft from one client in a minute with 429 rate_limited, while another client is still served', async () => {
      const ctx = await setup({ config: { rateLimit: true } });
      const person = await registerPerson(ctx);
      for (let i = 0; i < 10; i += 1) expect((await draft(ctx, person)).statusCode, `draft ${i + 1}`).toBe(200);
      const refused = await draft(ctx, person);
      expect(refused.statusCode).toBe(429);
      expect(refused.json()).toEqual({ error: 'rate_limited', message: 'Too many requests. Try again shortly.' });
      expect((await draft(ctx, person, { remoteAddress: '10.0.0.2' })).statusCode).toBe(200);
    });

    it('with CLIENT_IP_HEADER set, gives requests from one socket with different header values separate buckets, and the same value one bucket', async () => {
      const ctx = await setup({ config: { rateLimit: true, clientIpHeader: 'cf-connecting-ip' } });
      const person = await registerPerson(ctx);
      for (let i = 0; i < 10; i += 1) expect((await draft(ctx, person, { headers: { 'cf-connecting-ip': '198.51.100.1' } })).statusCode).toBe(200);
      expect((await draft(ctx, person, { headers: { 'cf-connecting-ip': '198.51.100.1' } })).statusCode).toBe(429);
      expect((await draft(ctx, person, { headers: { 'cf-connecting-ip': '198.51.100.2' } })).statusCode).toBe(200);
      expect((await draft(ctx, person, { headers: { 'cf-connecting-ip': '198.51.100.3' } })).statusCode).toBe(200);
    });

    it('falls back to the socket address when the header is absent or empty', async () => {
      const ctx = await setup({ config: { rateLimit: true, clientIpHeader: 'cf-connecting-ip' } });
      const person = await registerPerson(ctx);
      for (let i = 0; i < 5; i += 1) expect((await draft(ctx, person)).statusCode).toBe(200);
      for (let i = 0; i < 5; i += 1) expect((await draft(ctx, person, { headers: { 'cf-connecting-ip': '  ' } })).statusCode).toBe(200);
      expect((await draft(ctx, person)).statusCode).toBe(429);
    });

    it('with CLIENT_IP_HEADER unset, ignores the header and lets the socket address decide', async () => {
      const ctx = await setup({ config: { rateLimit: true } });
      const person = await registerPerson(ctx);
      for (let i = 0; i < 10; i += 1) expect((await draft(ctx, person, { headers: { 'cf-connecting-ip': `198.51.100.${i + 1}` } })).statusCode).toBe(200);
      expect((await draft(ctx, person, { headers: { 'cf-connecting-ip': '198.51.100.99' } })).statusCode).toBe(429);
    });

    it('groups IPv6 addresses by /64: two addresses in one /64 share a bucket, two /64s do not', async () => {
      const ctx = await setup({ config: { rateLimit: true } });
      const person = await registerPerson(ctx);
      for (let i = 0; i < 5; i += 1) expect((await draft(ctx, person, { remoteAddress: `2001:db8:1:1::${i + 1}` })).statusCode).toBe(200);
      for (let i = 0; i < 5; i += 1) expect((await draft(ctx, person, { remoteAddress: `2001:db8:1:1:aaaa::${i + 1}` })).statusCode).toBe(200);
      expect((await draft(ctx, person, { remoteAddress: '2001:db8:1:1:ffff::9' })).statusCode).toBe(429);
      expect((await draft(ctx, person, { remoteAddress: '2001:db8:1:2::1' })).statusCode).toBe(200);
    });

    it('groups IPv6 addresses by /64 through the header too', async () => {
      const ctx = await setup({ config: { rateLimit: true, clientIpHeader: 'cf-connecting-ip' } });
      const person = await registerPerson(ctx);
      for (let i = 0; i < 10; i += 1) expect((await draft(ctx, person, { headers: { 'cf-connecting-ip': `2001:db8:5:5::${i + 1}` } })).statusCode).toBe(200);
      expect((await draft(ctx, person, { headers: { 'cf-connecting-ip': '2001:db8:5:5:1::1' } })).statusCode).toBe(429);
      expect((await draft(ctx, person, { headers: { 'cf-connecting-ip': '2001:db8:5:6::1' } })).statusCode).toBe(200);
    });
  });

  describe('clientKey', () => {
    it('reads the named header when it is set and the socket address otherwise, normalised', () => {
      expect(clientKey({ headers: { 'cf-connecting-ip': '203.0.113.9' }, ip: '10.0.0.1' }, 'cf-connecting-ip')).toBe('203.0.113.9');
      expect(clientKey({ headers: { 'cf-connecting-ip': '203.0.113.9' }, ip: '10.0.0.1' })).toBe('10.0.0.1');
      expect(clientKey({ headers: {}, ip: '10.0.0.1' }, 'cf-connecting-ip')).toBe('10.0.0.1');
      expect(clientKey({ headers: { 'cf-connecting-ip': ['203.0.113.9', '1.1.1.1'] }, ip: '10.0.0.1' }, 'cf-connecting-ip')).toBe('203.0.113.9');
      expect(clientKey({ headers: { 'cf-connecting-ip': 'x'.repeat(65) }, ip: '10.0.0.1' }, 'cf-connecting-ip')).toBe('10.0.0.1');
      expect(clientKey({ headers: {}, ip: '2001:db8:1:1:aaaa:bbbb:cccc:dddd' })).toBe(clientKey({ headers: {}, ip: '2001:db8:1:1::1' }));
    });
  });

  describe('the other limited routes', () => {
    /** Calls a route `max` times and checks it was served each time, then checks the next call is 429. */
    async function limitedAfter(max: number, call: () => Promise<{ statusCode: number; json(): unknown }>, servedStatus: number[] = [200]) {
      for (let i = 0; i < max; i += 1) expect(servedStatus, `call ${i + 1}`).toContain((await call()).statusCode);
      const refused = await call();
      expect(refused.statusCode).toBe(429);
      expect(refused.json()).toMatchObject({ error: 'rate_limited' });
    }

    it('limits POST /auth/magic-link to 5 a minute', async () => {
      const ctx = await setup({ config: { rateLimit: true } });
      await limitedAfter(5, () => ctx.app.inject({ method: 'POST', url: '/auth/magic-link', payload: { email: 'ops@demo.mawsool.test' } }), [202]);
    });

    it('limits POST /demo/guest-session to 20 a minute', async () => {
      const ctx = await setup({ demoMode: true, config: { rateLimit: true } });
      await limitedAfter(20, () => ctx.app.inject({ method: 'POST', url: '/demo/guest-session', payload: { email: 'ops@demo.mawsool.test' } }));
    });

    it('limits POST /demo/clock/advance to 10 a minute, /demo/noura-invite to 10 and /demo/reset to 3', async () => {
      const ctx = await setup({ demoMode: true, config: { rateLimit: true } });
      const admin = (await ctx.app.inject({ method: 'POST', url: '/demo/guest-session', payload: { email: 'admin@demo.mawsool.test' } })).json();
      const headers = { authorization: `Bearer ${admin.sessionToken}` };
      await limitedAfter(10, () => ctx.app.inject({ method: 'POST', url: '/demo/clock/advance', headers, payload: { by: '7d' } }));
      await limitedAfter(10, () => ctx.app.inject({ method: 'POST', url: '/demo/noura-invite', headers }));
      await limitedAfter(3, () => ctx.app.inject({ method: 'POST', url: '/demo/reset', headers }));
    });

    it('leaves every one of them unlimited with RATE_LIMIT unset', async () => {
      const ctx = await setup({ demoMode: true });
      for (let i = 0; i < 25; i += 1) expect((await ctx.app.inject({ method: 'POST', url: '/demo/guest-session', payload: { email: 'ops@demo.mawsool.test' } })).statusCode).toBe(200);
      for (let i = 0; i < 8; i += 1) expect((await ctx.app.inject({ method: 'POST', url: '/auth/magic-link', payload: { email: 'ops@demo.mawsool.test' } })).statusCode).toBe(202);
    });
  });

  describe('the daily AI cap', () => {
    it('gives the template after N AI calls and counts again the next UTC day', async () => {
      const provider = new CountingProvider();
      const ctx = await setup({ summaryLlmEnabled: true, summaryProvider: provider, config: { summaryDailyLimit: 3 } });
      const person = await registerPerson(ctx);
      const sources: string[] = [];
      for (let i = 0; i < 5; i += 1) sources.push((await draft(ctx, person, { useAi: true })).json().source);
      expect(sources).toEqual(['ai', 'ai', 'ai', 'template', 'template']);
      expect(provider.calls).toBe(3);
      ctx.clock.advance(24 * 3_600_000);
      expect((await draft(ctx, person, { useAi: true })).json().source).toBe('ai');
      expect(provider.calls).toBe(4);
    });

    it('does not count a draft that never asked for the AI', async () => {
      const provider = new CountingProvider();
      const ctx = await setup({ summaryLlmEnabled: true, summaryProvider: provider, config: { summaryDailyLimit: 1 } });
      const person = await registerPerson(ctx);
      for (let i = 0; i < 3; i += 1) expect((await draft(ctx, person, { useAi: false })).json().source).toBe('template');
      expect((await draft(ctx, person, { useAi: true })).json().source).toBe('ai');
      expect((await draft(ctx, person, { useAi: true })).json().source).toBe('template');
    });

    it('with the limit at 0 allows no AI call at all, and with it unset there is no cap', async () => {
      const provider = new CountingProvider();
      const zero = await setup({ summaryLlmEnabled: true, summaryProvider: provider, config: { summaryDailyLimit: 0 } });
      const person = await registerPerson(zero);
      expect((await draft(zero, person, { useAi: true })).json().source).toBe('template');
      expect(provider.calls).toBe(0);
      const none = await setup({ summaryLlmEnabled: true, summaryProvider: provider });
      const other = await registerPerson(none);
      for (let i = 0; i < 12; i += 1) expect((await draft(none, other, { useAi: true, remoteAddress: `10.0.1.${i + 1}` })).json().source).toBe('ai');
    });

    it('is a count per UTC day on the clock it is given', () => {
      const clock = new ManualClock(new Date('2026-11-01T23:59:00Z'));
      const budget = createSummaryBudget(2, clock);
      expect([budget.take(), budget.take(), budget.take()]).toEqual([true, true, false]);
      clock.advance(2 * 60_000);
      expect(budget.take()).toBe(true);
    });
  });

  describe('the reset cool-down', () => {
    const adminHeaders = async (ctx: TestApp) => ({ authorization: `Bearer ${(await ctx.app.inject({ method: 'POST', url: '/demo/guest-session', payload: { email: 'admin@demo.mawsool.test' } })).json().sessionToken}` });
    const reset = (ctx: TestApp, headers: Record<string, string>) => ctx.app.inject({ method: 'POST', url: '/demo/reset', headers });

    it('with the cool-down set, two queued resets give 200 then 429 reset_cooldown with the seconds left, not rate_limited, and after the cool-down 200', async () => {
      const ctx = await setup({ demoMode: true, config: { demoResetCooldownMs: 300_000 } });
      const headers = await adminHeaders(ctx);
      const [first, second] = await Promise.all([reset(ctx, headers), reset(ctx, headers)]);
      expect([first.statusCode, second.statusCode].sort()).toEqual([200, 429]);
      const refused = first.statusCode === 429 ? first : second;
      expect(refused.json()).toEqual({ error: 'reset_cooldown', message: 'The demo was reset a moment ago', retryAfterSeconds: 300 });
      ctx.clock.advance(100_000);
      const later = await reset(ctx, headers);
      expect(later.statusCode).toBe(429);
      expect(later.json().retryAfterSeconds).toBe(200);
      ctx.clock.advance(200_000);
      expect((await reset(ctx, headers)).statusCode).toBe(200);
    });

    it('unset, two back-to-back resets give 200 and 200', async () => {
      const ctx = await setup({ demoMode: true });
      const headers = await adminHeaders(ctx);
      expect((await reset(ctx, headers)).statusCode).toBe(200);
      expect((await reset(ctx, headers)).statusCode).toBe(200);
    });

    it('does not slow the clock advance or the new Noura invite', async () => {
      const ctx = await setup({ demoMode: true, config: { demoResetCooldownMs: 300_000 } });
      const headers = await adminHeaders(ctx);
      expect((await reset(ctx, headers)).statusCode).toBe(200);
      expect((await ctx.app.inject({ method: 'POST', url: '/demo/clock/advance', headers, payload: { by: '7d' } })).statusCode).toBe(200);
      expect((await ctx.app.inject({ method: 'POST', url: '/demo/noura-invite', headers })).statusCode).toBe(200);
    });

    it('is decorated on the app as a function with the demo on and null with it off', async () => {
      expect(typeof (await setup({ demoMode: true })).app.demoReset).toBe('function');
      expect((await setup()).app.demoReset).toBeNull();
    });

    it('makes demoResetJob reset without checking the cool-down, and still starts the cool-down for the next press', async () => {
      const ctx = await setup({ demoMode: true, config: { demoResetCooldownMs: 300_000 } });
      const headers = await adminHeaders(ctx);
      expect((await reset(ctx, headers)).statusCode).toBe(200);
      const person = await registerPerson(ctx);
      const job = demoResetJob(ctx.app.demoReset!);
      await job();
      expect((await ctx.app.inject({ method: 'GET', url: '/me/tickets', headers: person.headers })).statusCode).toBe(401);
      expect((await reset(ctx, headers)).statusCode).toBe(429);
    });

    it('hands a failed reset on as a plain error that carries no query or value, and logs the original', async () => {
      const logged: unknown[] = [];
      const failing = async () => {
        throw new Error('Failed query: select ... params: SECRET-ID');
      };
      const job = demoResetJob(failing, { error: (...args: unknown[]) => logged.push(args) } as never);
      const error = await job().then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(error?.message).toBe('demo reset failed');
      expect(JSON.stringify(error)).not.toContain('SECRET-ID');
      expect(logged).toHaveLength(1);
    });
  });
});
