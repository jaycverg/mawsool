import type { BundleContent, ConsentElement } from '@mawsool/types';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SUMMARY_MODEL, buildPrompt, capWords, createAnthropicProvider, createFoundryProvider, createSummaryProvider, draftSummary, templateSummary, type SummaryPrompt, type SummaryProvider } from '../src';

const CONTENT: BundleContent = {
  scores: [{ instrument: 'phq9', total: 12, band: 'moderate', takenAt: '2026-10-29T08:00:00+04:00' }],
  trajectory: [{ instrument: 'gad7', total: 9, band: null, takenAt: '2026-10-08T08:00:00+04:00' }],
  free_text: 'SECRET-NOTE-xyzzy',
  conditions: ['SECRET-CONDITION-plugh'],
  preferences: { language: 'ur' },
};

class Recorder implements SummaryProvider {
  calls: SummaryPrompt[] = [];
  constructor(private readonly answer: string | Error = 'A short note.') {}
  async complete(prompt: SummaryPrompt): Promise<string> {
    this.calls.push(prompt);
    if (this.answer instanceof Error) throw this.answer;
    return this.answer;
  }
}

const base = { enabled: true, useAi: true, content: CONTENT, consented: ['ticket'] as ConsentElement[], locale: 'en' as const };

describe('draftSummary', () => {
  it('calls the provider once, with consented elements only, when the flag is on and the box is ticked', async () => {
    const provider = new Recorder('Hello clinic.');
    const draft = await draftSummary({ ...base, consented: ['ticket', 'scores'], provider });
    expect(draft).toEqual({ source: 'ai', text: 'Hello clinic.', outcome: 'ai' });
    expect(provider.calls).toHaveLength(1);
    const sent = JSON.stringify(provider.calls[0]);
    expect(sent).toContain('phq9 score: 12');
    for (const hidden of ['SECRET-NOTE-xyzzy', 'SECRET-CONDITION-plugh', 'gad7', '"ur"']) expect(sent).not.toContain(hidden);
  });

  it('sends nothing at all when the flag is off, and returns the template', async () => {
    const provider = new Recorder();
    expect(await draftSummary({ ...base, enabled: false, provider })).toEqual({ source: 'template', text: templateSummary('en'), outcome: 'flag_off' });
    expect(provider.calls).toHaveLength(0);
  });

  it('treats a missing provider like the flag being off', async () => {
    expect((await draftSummary({ ...base, provider: null })).outcome).toBe('flag_off');
  });

  it('sends nothing when the flag is on but the box is not ticked', async () => {
    const provider = new Recorder();
    expect(await draftSummary({ ...base, useAi: false, provider, locale: 'ar' })).toEqual({ source: 'template', text: templateSummary('ar'), outcome: 'not_ticked' });
    expect(provider.calls).toHaveLength(0);
  });

  it('falls back to the template when the provider fails or answers with nothing', async () => {
    expect((await draftSummary({ ...base, provider: new Recorder(new Error('boom')) })).outcome).toBe('provider_failed');
    expect((await draftSummary({ ...base, provider: new Recorder('   ') })).outcome).toBe('provider_empty');
  });

  it('caps the text at 120 words', async () => {
    const draft = await draftSummary({ ...base, provider: new Recorder(Array(300).fill('word').join(' ')) });
    expect(draft.text.split(' ')).toHaveLength(120);
  });
});

describe('prompt and helpers', () => {
  it('forbids diagnosis, advice and risk scoring, and names the language', () => {
    const prompt = buildPrompt({}, ['ticket'], 'ar');
    expect(prompt.system).toMatch(/Do not diagnose/);
    expect(prompt.system).toMatch(/advice/);
    expect(prompt.system).toMatch(/risk/);
    expect(prompt.user).toContain('Arabic');
    expect(prompt.user).toContain('shared nothing else');
  });

  it('includes every consented element and formats a score with no band', () => {
    const prompt = buildPrompt(CONTENT, ['ticket', 'scores', 'trajectory', 'free_text', 'conditions', 'preferences'], 'en');
    expect(prompt.user).toContain('gad7 9 on 2026-10-08');
    expect(prompt.user).toContain('SECRET-NOTE-xyzzy');
    expect(prompt.user).toContain('SECRET-CONDITION-plugh');
    expect(prompt.user).toContain('"language":"ur"');
    expect(buildPrompt({ scores: [{ instrument: 'who5', total: 40, band: null, takenAt: '2026-10-29T08:00:00+04:00' }] }, ['scores'], 'en').user).toContain('who5 score: 40.');
  });

  it('keeps short text as it is', () => {
    expect(capWords('  a b  ')).toBe('a b');
  });
});

describe('the live provider, with the network replaced', () => {
  const reply = (body: unknown) => async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const message = (stop_reason: string, content: unknown[]) => ({ id: 'msg_1', type: 'message', role: 'assistant', model: DEFAULT_SUMMARY_MODEL, content, stop_reason, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
  const prompt = { system: 's', user: 'u' };

  it('sends the configured model with no sampling parameters, and returns the text', async () => {
    const seen: Record<string, unknown>[] = [];
    const provider = createAnthropicProvider({
      apiKey: 'test-key-not-real',
      model: 'a-model',
      fetch: async (_url, init) => {
        seen.push(JSON.parse(String(init?.body)));
        return reply(message('end_turn', [{ type: 'text', text: 'Note.' }, { type: 'thinking', thinking: '', signature: 'x' }]))();
      },
    });
    expect(await provider.complete(prompt)).toBe('Note.');
    expect(seen[0]).toMatchObject({ model: 'a-model', output_config: { effort: 'low' } });
    expect(Object.keys(seen[0]!)).not.toEqual(expect.arrayContaining(['temperature']));
  });

  it('defaults the model and treats a refusal as a failure', async () => {
    let model: unknown;
    const provider = createAnthropicProvider({
      apiKey: 'test-key-not-real',
      fetch: async (_url, init) => {
        model = JSON.parse(String(init?.body)).model;
        return reply(message('refusal', []))();
      },
    });
    await expect(provider.complete(prompt)).rejects.toThrow(/declined/);
    expect(model).toBe('claude-sonnet-5-5');
  });
});

describe('the Foundry provider and the factory, with the network replaced', () => {
  const message = (stop_reason: string, content: unknown[]) => ({ id: 'msg_1', type: 'message', role: 'assistant', model: DEFAULT_SUMMARY_MODEL, content, stop_reason, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
  const prompt = { system: 's', user: 'u' };
  type Seen = { url: string; apiKey: string | null; body: Record<string, unknown> };

  /** A stand-in for `fetch` that records what was asked and answers with one canned message. */
  function recordingFetch(answer: unknown): { fetch: typeof fetch; seen: Seen[] } {
    const seen: Seen[] = [];
    const stub = async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), apiKey: new Headers(init?.headers).get('x-api-key'), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    return { fetch: stub as typeof fetch, seen };
  }

  /** Runs `body` with environment variables set (or deleted, when `undefined`) and puts every one back afterwards. */
  async function withEnv(vars: Record<string, string | undefined>, body: () => Promise<void>): Promise<void> {
    const before = Object.fromEntries(Object.keys(vars).map((name) => [name, process.env[name]]));
    try {
      for (const [name, value] of Object.entries(vars)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await body();
    } finally {
      for (const [name, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }

  it('sends the request to the resource address with the key, the deployment name and no sampling parameters', async () => {
    const { fetch, seen } = recordingFetch(message('end_turn', [{ type: 'text', text: 'Foundry note.' }]));
    const provider = createFoundryProvider({ apiKey: 'test-key-not-real', resource: 'mawsool-test', model: 'a-deployment', fetch });
    expect(await provider.complete(prompt)).toBe('Foundry note.');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://mawsool-test.services.ai.azure.com/anthropic/v1/messages');
    expect(seen[0]!.apiKey).toBe('test-key-not-real');
    expect(seen[0]!.body).toMatchObject({ model: 'a-deployment', output_config: { effort: 'low' }, system: 's', messages: [{ role: 'user', content: 'u' }] });
    expect(Object.keys(seen[0]!.body)).not.toContain('temperature');
  });

  it('ignores the SDK environment variables: a shell base address neither redirects the request nor stops the client', async () => {
    const { fetch, seen } = recordingFetch(message('end_turn', [{ type: 'text', text: 'Foundry note.' }]));
    await withEnv(
      { ANTHROPIC_FOUNDRY_BASE_URL: 'https://elsewhere.example.test/anthropic/', ANTHROPIC_FOUNDRY_RESOURCE: 'elsewhere', ANTHROPIC_FOUNDRY_API_KEY: 'other-key-not-real' },
      async () => {
        const provider = createFoundryProvider({ apiKey: 'test-key-not-real', resource: 'mawsool-test', fetch });
        expect(await provider.complete(prompt)).toBe('Foundry note.');
      },
    );
    expect(seen[0]!.url).toBe('https://mawsool-test.services.ai.azure.com/anthropic/v1/messages');
    expect(seen[0]!.apiKey).toBe('test-key-not-real');
  });

  it('defaults the model and treats a refusal as a failure', async () => {
    const { fetch, seen } = recordingFetch(message('refusal', []));
    const provider = createFoundryProvider({ apiKey: 'test-key-not-real', resource: 'mawsool-test', fetch });
    await expect(provider.complete(prompt)).rejects.toThrow(/declined/);
    expect(seen[0]!.body.model).toBe('claude-sonnet-5-5');
  });

  it('builds the Anthropic client for kind anthropic, ignoring a base address in the shell', async () => {
    const { fetch, seen } = recordingFetch(message('end_turn', [{ type: 'text', text: 'Anthropic note.' }]));
    await withEnv({ ANTHROPIC_BASE_URL: undefined }, async () => {
      const provider = createSummaryProvider({ kind: 'anthropic', apiKey: 'test-key-not-real', model: 'a-model' }, { fetch });
      expect(await provider.complete(prompt)).toBe('Anthropic note.');
    });
    expect(seen[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(seen[0]!.body.model).toBe('a-model');
  });

  it('builds the Foundry client for kind foundry', async () => {
    const { fetch, seen } = recordingFetch(message('end_turn', [{ type: 'text', text: 'Foundry note.' }]));
    const provider = createSummaryProvider({ kind: 'foundry', apiKey: 'test-key-not-real', resource: 'mawsool-test', model: 'a-deployment' }, { fetch });
    expect(await provider.complete(prompt)).toBe('Foundry note.');
    expect(seen[0]!.url).toBe('https://mawsool-test.services.ai.azure.com/anthropic/v1/messages');
    expect(seen[0]!.body.model).toBe('a-deployment');
  });
});
