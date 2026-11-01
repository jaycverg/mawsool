import type { BundleContent, ConsentElement } from '@mawsool/types';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SUMMARY_MODEL, buildPrompt, capWords, createAnthropicProvider, draftSummary, templateSummary, type SummaryPrompt, type SummaryProvider } from '../src';

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
