import { createSummaryProvider, type SummaryPrompt, type SummaryProvider } from '@mawsool/summary';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { schema } from '../src/db/client';
import { summaryLogContext } from '../src/tickets/service';
import { runSeed } from '../src/seed/run';
import { createTestApp, type TestApp } from './helpers/app';
import { TEST_ENCRYPTION_KEY } from './helpers/config';
import { createTestDb, type TestDb } from './helpers/db';
import { CONDITION, FREE_TEXT, cipher, registerPerson, type TestPerson } from './helpers/flow';

const PROVIDER_TEXT = 'PROVIDER-TEXT-MARKER-6641';

class StubProvider implements SummaryProvider {
  prompts: SummaryPrompt[] = [];
  fail = false;
  answer = PROVIDER_TEXT;
  async complete(prompt: SummaryPrompt): Promise<string> {
    this.prompts.push(prompt);
    if (this.fail) throw new Error('provider down');
    return this.answer;
  }
}

const content = {
  scores: [{ instrument: 'phq9' as const, total: 12, band: 'moderate', takenAt: '2026-10-29T08:00:00+04:00' }],
  free_text: FREE_TEXT,
  conditions: [CONDITION],
};

describe('POST /summary/draft', () => {
  let testDb: TestDb;
  let person: TestPerson;
  const open: TestApp[] = [];

  beforeAll(async () => {
    testDb = await createTestDb();
    await runSeed(testDb.db, testDb.cipher);
  });

  afterEach(async () => {
    for (const ctx of open.splice(0)) await ctx.app.close();
  });

  async function setup(options: { enabled: boolean; provider: StubProvider | null }) {
    const ctx = await createTestApp(testDb.db, { summaryLlmEnabled: options.enabled, summaryProvider: options.provider });
    open.push(ctx);
    person = await registerPerson(ctx);
    const draft = (payload: Record<string, unknown> = {}) =>
      ctx.app.inject({
        method: 'POST',
        url: '/summary/draft',
        headers: person.headers,
        payload: { requestId: crypto.randomUUID(), locale: 'en', useAi: true, consented: ['ticket', 'scores'], content, ...payload },
      });
    return { ctx, draft };
  }

  it('makes no outbound call with the flag off, even when the person ticked the box and a provider is present', async () => {
    const provider = new StubProvider();
    const { draft } = await setup({ enabled: false, provider });
    const res = await draft();
    expect(res.statusCode).toBe(200);
    expect(res.json().source).toBe('template');
    expect(res.json().text).not.toContain(PROVIDER_TEXT);
    expect(provider.prompts).toHaveLength(0);
  });

  it('makes no outbound call with the flag on and the box not ticked', async () => {
    const provider = new StubProvider();
    const { draft } = await setup({ enabled: true, provider });
    const res = await draft({ useAi: false });
    expect(res.json().source).toBe('template');
    expect(provider.prompts).toHaveLength(0);
  });

  it('sends the provider only what was consented to when both are on, and returns its text capped at 120 words', async () => {
    const provider = new StubProvider();
    provider.answer = Array(300).fill('word').join(' ');
    const { draft } = await setup({ enabled: true, provider });
    const res = await draft({ consented: ['ticket', 'scores'] });
    expect(res.json().source).toBe('ai');
    expect(res.json().text.split(' ')).toHaveLength(120);
    expect(provider.prompts).toHaveLength(1);
    const sent = JSON.stringify(provider.prompts[0]);
    expect(sent).toContain('phq9 score: 12');
    expect(sent).not.toContain(FREE_TEXT);
    expect(sent).not.toContain(CONDITION);
  });

  it('includes an element in the provider’s input once it is consented to', async () => {
    const provider = new StubProvider();
    const { draft } = await setup({ enabled: true, provider });
    await draft({ consented: ['ticket', 'free_text'] });
    expect(JSON.stringify(provider.prompts[0])).toContain(FREE_TEXT);
    expect(JSON.stringify(provider.prompts[0])).not.toContain('phq9');
  });

  it('falls back to the template when the provider fails', async () => {
    const provider = new StubProvider();
    provider.fail = true;
    const { draft } = await setup({ enabled: true, provider });
    const res = await draft();
    expect(res.statusCode).toBe(200);
    expect(res.json().source).toBe('template');
  });

  it('logs every draft as ciphertext, and nothing in the clear', async () => {
    const provider = new StubProvider();
    const { draft } = await setup({ enabled: true, provider });
    const requestId = crypto.randomUUID();
    await draft({ requestId });
    const [log] = await testDb.db.select().from(schema.summaryLogs).where(eq(schema.summaryLogs.requestId, requestId));
    expect(log).toMatchObject({ kind: 'draft', personId: person.id, ticketId: null });
    expect(log!.ciphertext).toMatch(/^v1\./);
    expect(log!.ciphertext).not.toContain(PROVIDER_TEXT);
    expect(cipher.decrypt(log!.ciphertext, summaryLogContext(person.id, requestId, 'draft'))).toBe(PROVIDER_TEXT);
  });

  it('reaches Claude on Foundry from the settings the environment gives, and sends only what was consented to', async () => {
    const config = loadConfig({
      BUNDLE_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
      SUMMARY_LLM_ENABLED: 'true',
      SUMMARY_PROVIDER: 'foundry',
      SUMMARY_FOUNDRY_API_KEY: 'test-key-not-real',
      SUMMARY_FOUNDRY_RESOURCE: 'mawsool-test',
      SUMMARY_MODEL: 'my-deployment',
    });
    const seen: { url: string; apiKey: string | null; body: string }[] = [];
    const stub = async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), apiKey: new Headers(init?.headers).get('x-api-key'), body: String(init?.body) });
      const reply = { id: 'msg_1', type: 'message', role: 'assistant', model: 'my-deployment', content: [{ type: 'text', text: 'Foundry note.' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
      return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const ctx = await createTestApp(testDb.db, {
      summaryLlmEnabled: config.summaryLlmEnabled,
      summaryProvider: createSummaryProvider(config.summaryProvider!, { fetch: stub as typeof fetch }),
    });
    open.push(ctx);
    person = await registerPerson(ctx);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/summary/draft',
      headers: person.headers,
      payload: { requestId: crypto.randomUUID(), locale: 'en', useAi: true, consented: ['ticket', 'scores'], content },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ source: 'ai', text: 'Foundry note.' });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://mawsool-test.services.ai.azure.com/anthropic/v1/messages');
    expect(seen[0]!.apiKey).toBe('test-key-not-real');
    expect(JSON.parse(seen[0]!.body)).toMatchObject({ model: 'my-deployment' });
    expect(seen[0]!.body).toContain('phq9 score: 12');
    expect(seen[0]!.body).not.toContain(FREE_TEXT);
    expect(seen[0]!.body).not.toContain(CONDITION);
  });

  it('needs a device credential and refuses an unknown field', async () => {
    const { ctx, draft } = await setup({ enabled: false, provider: null });
    expect((await ctx.app.inject({ method: 'POST', url: '/summary/draft', payload: {} })).statusCode).toBe(401);
    expect((await draft({ diagnosis: 'x' })).statusCode).toBe(400);
  });
});
