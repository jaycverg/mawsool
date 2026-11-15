import { Writable } from 'node:stream';
import type { SummaryPrompt, SummaryProvider } from '@mawsool/summary';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { ManualClock } from '../src/clock';
import { runSeed } from '../src/seed/run';
import { createTestApp, TEST_START, type TestApp, type TestAppOptions } from './helpers/app';
import { TEST_CONFIG } from './helpers/config';
import { createTestDb, type TestDb } from './helpers/db';
import { FREE_TEXT, registerPerson, type TestPerson } from './helpers/flow';

const CODE = 'sand-river-lamp';
const content = {
  scores: [{ instrument: 'phq9' as const, total: 12, band: 'moderate', takenAt: '2026-10-29T08:00:00+04:00' }],
  free_text: FREE_TEXT,
};

class StubProvider implements SummaryProvider {
  prompts: SummaryPrompt[] = [];
  async complete(prompt: SummaryPrompt): Promise<string> {
    this.prompts.push(prompt);
    return 'AI-DRAFT-TEXT';
  }
}

describe('the AI demo code on POST /summary/draft', () => {
  let testDb: TestDb;
  const open: TestApp[] = [];

  beforeAll(async () => {
    testDb = await createTestDb();
    await runSeed(testDb.db, testDb.cipher);
  });

  afterEach(async () => {
    for (const ctx of open.splice(0)) await ctx.app.close();
  });

  async function setup(options: TestAppOptions & { provider?: StubProvider | null } = {}) {
    const provider = options.provider === undefined ? new StubProvider() : options.provider;
    const ctx = await createTestApp(testDb.db, { summaryLlmEnabled: options.summaryLlmEnabled ?? true, summaryProvider: provider, config: { aiDemoCode: CODE, ...options.config } });
    open.push(ctx);
    const person: TestPerson = await registerPerson(ctx);
    const draft = (payload: Record<string, unknown> = {}) =>
      ctx.app.inject({
        method: 'POST',
        url: '/summary/draft',
        headers: person.headers,
        payload: { requestId: crypto.randomUUID(), locale: 'en', useAi: true, consented: ['ticket', 'scores'], content, ...payload },
      });
    return { ctx, draft, provider };
  }

  it('uses the AI for the right code: source ai and demoCode accepted', async () => {
    const { draft, provider } = await setup();
    const res = await draft({ demoCode: CODE });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ source: 'ai', text: 'AI-DRAFT-TEXT', demoCode: 'accepted' });
    expect(provider!.prompts).toHaveLength(1);
  });

  it('writes the template for a wrong code and for none, says refused, and never calls the provider', async () => {
    const { draft, provider } = await setup();
    for (const payload of [{ demoCode: 'sand-river-lam' }, { demoCode: '' }, {}]) {
      const res = await draft(payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(200);
      expect(res.json()).toMatchObject({ source: 'template', demoCode: 'refused' });
      expect(res.json().text).not.toContain('AI-DRAFT-TEXT');
    }
    expect(provider!.prompts).toHaveLength(0);
  });

  it('accepts the right code capitalised and with a trailing space, as a phone keyboard types it', async () => {
    const { draft } = await setup();
    const res = await draft({ demoCode: 'Sand-River-Lamp ' });
    expect(res.json()).toMatchObject({ source: 'ai', demoCode: 'accepted' });
    expect((await draft({ demoCode: '  SAND-RIVER-LAMP' })).json()).toMatchObject({ source: 'ai', demoCode: 'accepted' });
  });

  it('does not let a refused code use up the daily cap', async () => {
    const { draft, provider } = await setup({ config: { summaryDailyLimit: 1 } });
    for (let i = 0; i < 4; i += 1) expect((await draft({ demoCode: 'wrong-code-here' })).json().demoCode).toBe('refused');
    expect(provider!.prompts).toHaveLength(0);
    expect((await draft({ demoCode: CODE })).json()).toMatchObject({ source: 'ai', demoCode: 'accepted' });
    // The allowance is now spent: the right code still reads accepted, and the draft is the template.
    expect((await draft({ demoCode: CODE })).json()).toMatchObject({ source: 'template', demoCode: 'accepted' });
  });

  it('checks the code only when the AI was asked for: with useAi false the reply carries no demoCode, whatever code is sent', async () => {
    const { draft, provider } = await setup();
    for (const payload of [{}, { demoCode: CODE }, { demoCode: 'wrong' }]) {
      const res = await draft({ useAi: false, ...payload });
      expect(res.json().source).toBe('template');
      expect(Object.keys(res.json())).toEqual(['source', 'text']);
    }
    expect(provider!.prompts).toHaveLength(0);
  });

  it('with the AI switched off and a code set, answers accepted or refused and always the template', async () => {
    const { draft } = await setup({ summaryLlmEnabled: false });
    expect((await draft({ demoCode: CODE })).json()).toMatchObject({ source: 'template', demoCode: 'accepted' });
    expect((await draft({ demoCode: 'nope' })).json()).toMatchObject({ source: 'template', demoCode: 'refused' });
  });

  it('with no code set, changes nothing: no demoCode in the reply, the AI is used, and a sent code is ignored', async () => {
    const provider = new StubProvider();
    const ctx = await createTestApp(testDb.db, { summaryLlmEnabled: true, summaryProvider: provider });
    open.push(ctx);
    const person = await registerPerson(ctx);
    for (const extra of [{}, { demoCode: CODE }]) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/summary/draft',
        headers: person.headers,
        payload: { requestId: crypto.randomUUID(), locale: 'en', useAi: true, consented: ['ticket', 'scores'], content, ...extra },
      });
      expect(res.json()).toEqual({ source: 'ai', text: 'AI-DRAFT-TEXT' });
    }
    expect(provider.prompts).toHaveLength(2);
  });

  it('refuses a code longer than 64 characters as a malformed request', async () => {
    const { draft } = await setup();
    expect((await draft({ demoCode: 'x'.repeat(65) })).statusCode).toBe(400);
  });

  it('puts neither the code nor the request body in any log line, accepted, refused or rate limited', async () => {
    const raw: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, done) {
        raw.push(String(chunk));
        done();
      },
    });
    const app = await buildApp({
      db: testDb.db,
      clock: new ManualClock(TEST_START),
      config: { ...TEST_CONFIG, summaryLlmEnabled: true, aiDemoCode: CODE, rateLimit: true },
      summaryProvider: new StubProvider(),
      logger: { level: 'trace', stream },
    });
    try {
      const ctx = { app } as Pick<TestApp, 'app'>;
      const person = await registerPerson(ctx);
      const send = (demoCode: string) =>
        app.inject({
          method: 'POST',
          url: '/summary/draft',
          headers: person.headers,
          payload: { requestId: crypto.randomUUID(), locale: 'en', useAi: true, consented: ['ticket', 'scores'], content, demoCode },
        });
      const statuses: number[] = [];
      statuses.push((await send(CODE)).statusCode, (await send('Wrong-Code-Marker-7731')).statusCode);
      for (let i = 0; i < 10; i += 1) statuses.push((await send(CODE)).statusCode);
      expect(statuses).toContain(429);
      const log = raw.join('');
      expect(log.length).toBeGreaterThan(0);
      for (const secret of [CODE, 'Wrong-Code-Marker-7731', 'wrong-code-marker-7731', FREE_TEXT, 'AI-DRAFT-TEXT']) expect(log, secret).not.toContain(secret);
    } finally {
      await app.close();
    }
  });
});
