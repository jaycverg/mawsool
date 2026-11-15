import type { SummaryProvider } from '@mawsool/summary';
import { SummaryAvailabilitySchema, SummaryDraftSchema } from '@mawsool/types';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runSeed } from '../src/seed/run';
import { createTestApp, type TestApp, type TestAppOptions } from './helpers/app';
import { createTestDb, type TestDb } from './helpers/db';
import { registerPerson, type TestPerson } from './helpers/flow';

const content = { scores: [{ instrument: 'phq9' as const, total: 12, band: 'moderate', takenAt: '2026-10-29T08:00:00+04:00' }] };

class StubProvider implements SummaryProvider {
  calls = 0;
  fail = false;
  async complete(): Promise<string> {
    this.calls += 1;
    if (this.fail) throw new Error('provider down');
    return 'AI-DRAFT-TEXT';
  }
}

describe('what the AI can do right now: GET /summary/availability and aiUnavailable on a draft', () => {
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

  const availability = (ctx: TestApp) => ctx.app.inject({ method: 'GET', url: '/summary/availability' });
  const draft = (ctx: TestApp, person: TestPerson, useAi: boolean) =>
    ctx.app.inject({
      method: 'POST',
      url: '/summary/draft',
      headers: person.headers,
      payload: { requestId: crypto.randomUUID(), locale: 'en', useAi, consented: ['ticket', 'scores'], content },
    });

  describe('GET /summary/availability', () => {
    it('answers off when the flag is unset, whatever else is configured', async () => {
      const ctx = await setup({ summaryLlmEnabled: false, summaryProvider: new StubProvider(), config: { summaryDailyLimit: 5 } });
      const res = await availability(ctx);
      expect(res.statusCode).toBe(200);
      expect(SummaryAvailabilitySchema.parse(res.json())).toEqual({ ai: 'off' });
    });

    it('answers off when the flag is on but there is no provider to call', async () => {
      const ctx = await setup({ summaryLlmEnabled: true, summaryProvider: null });
      expect(SummaryAvailabilitySchema.parse((await availability(ctx)).json())).toEqual({ ai: 'off' });
    });

    it('answers available with the flag on and a provider, with no cap or with allowance left', async () => {
      const uncapped = await setup({ summaryLlmEnabled: true, summaryProvider: new StubProvider() });
      expect((await availability(uncapped)).json()).toEqual({ ai: 'available' });
      const capped = await setup({ summaryLlmEnabled: true, summaryProvider: new StubProvider(), config: { summaryDailyLimit: 2 } });
      expect((await availability(capped)).json()).toEqual({ ai: 'available' });
    });

    it('answers daily_cap once the day’s allowance is spent, and available again the next UTC day', async () => {
      const provider = new StubProvider();
      const ctx = await setup({ summaryLlmEnabled: true, summaryProvider: provider, config: { summaryDailyLimit: 1 } });
      const person = await registerPerson(ctx);
      expect((await draft(ctx, person, true)).json().source).toBe('ai');
      expect((await availability(ctx)).json()).toEqual({ ai: 'daily_cap' });
      ctx.clock.advance(24 * 3_600_000);
      expect((await availability(ctx)).json()).toEqual({ ai: 'available' });
    });

    it('answers daily_cap from the start when the limit is 0', async () => {
      const ctx = await setup({ summaryLlmEnabled: true, summaryProvider: new StubProvider(), config: { summaryDailyLimit: 0 } });
      expect((await availability(ctx)).json()).toEqual({ ai: 'daily_cap' });
    });

    it('prefers off to daily_cap: with the flag unset a limit of 0 still reads off', async () => {
      const ctx = await setup({ summaryLlmEnabled: false, summaryProvider: new StubProvider(), config: { summaryDailyLimit: 0 } });
      expect((await availability(ctx)).json()).toEqual({ ai: 'off' });
    });

    it('needs no sign-in and spends nothing: reading it many times leaves the one allowed AI draft available', async () => {
      const provider = new StubProvider();
      const ctx = await setup({ summaryLlmEnabled: true, summaryProvider: provider, config: { summaryDailyLimit: 1 } });
      for (let i = 0; i < 6; i += 1) expect((await availability(ctx)).statusCode).toBe(200);
      const person = await registerPerson(ctx);
      expect((await draft(ctx, person, true)).json().source).toBe('ai');
      expect(provider.calls).toBe(1);
    });
  });

  describe('aiUnavailable on POST /summary/draft', () => {
    it('is off when the AI was asked for and the flag is unset', async () => {
      const ctx = await setup({ summaryLlmEnabled: false, summaryProvider: new StubProvider() });
      const person = await registerPerson(ctx);
      const body = SummaryDraftSchema.parse((await draft(ctx, person, true)).json());
      expect(body.source).toBe('template');
      expect(body.aiUnavailable).toBe('off');
    });

    it('is off when the AI was asked for, the flag is on and there is no provider', async () => {
      const ctx = await setup({ summaryLlmEnabled: true, summaryProvider: null });
      const person = await registerPerson(ctx);
      expect((await draft(ctx, person, true)).json().aiUnavailable).toBe('off');
    });

    it('is daily_cap when the AI was asked for and the day’s allowance is spent', async () => {
      const provider = new StubProvider();
      const ctx = await setup({ summaryLlmEnabled: true, summaryProvider: provider, config: { summaryDailyLimit: 1 } });
      const person = await registerPerson(ctx);
      const first = (await draft(ctx, person, true)).json();
      expect(first.source).toBe('ai');
      expect('aiUnavailable' in first).toBe(false);
      const second = SummaryDraftSchema.parse((await draft(ctx, person, true)).json());
      expect(second.source).toBe('template');
      expect(second.aiUnavailable).toBe('daily_cap');
      expect(provider.calls).toBe(1);
    });

    it('is absent when the AI was not asked for, however it is configured', async () => {
      const off = await setup({ summaryLlmEnabled: false, summaryProvider: new StubProvider() });
      const offPerson = await registerPerson(off);
      expect('aiUnavailable' in (await draft(off, offPerson, false)).json()).toBe(false);
      const spent = await setup({ summaryLlmEnabled: true, summaryProvider: new StubProvider(), config: { summaryDailyLimit: 0 } });
      const spentPerson = await registerPerson(spent);
      expect('aiUnavailable' in (await draft(spent, spentPerson, false)).json()).toBe(false);
    });

    it('is absent when the AI wrote the draft, and when the provider failed (the template is not for either reason)', async () => {
      const provider = new StubProvider();
      const ctx = await setup({ summaryLlmEnabled: true, summaryProvider: provider });
      const person = await registerPerson(ctx);
      const wrote = (await draft(ctx, person, true)).json();
      expect(wrote.source).toBe('ai');
      expect('aiUnavailable' in wrote).toBe(false);
      provider.fail = true;
      const failed = (await draft(ctx, person, true)).json();
      expect(failed.source).toBe('template');
      expect('aiUnavailable' in failed).toBe(false);
    });
  });
});
