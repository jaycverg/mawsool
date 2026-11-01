import Anthropic from '@anthropic-ai/sdk';
import type { SummaryPrompt } from './prompt';
import type { SummaryProvider } from './summary';

/** The default model for the referral summary. Set `SUMMARY_MODEL` to change it. */
export const DEFAULT_SUMMARY_MODEL = 'claude-sonnet-5-5';

/**
 * The live provider. This is the only place in the repository that imports an LLM SDK. It asks for a short note at low
 * effort, with no sampling parameters (this model family refuses them), and treats a refusal or an answer with no text
 * as a failure, which `draftSummary` turns into the template. `fetch` is injectable so tests never touch the network.
 */
export function createAnthropicProvider(options: { apiKey: string; model?: string; fetch?: typeof fetch }): SummaryProvider {
  const client = new Anthropic({ apiKey: options.apiKey, fetch: options.fetch, maxRetries: 1, timeout: 20_000 });
  const model = options.model ?? DEFAULT_SUMMARY_MODEL;
  return {
    async complete(prompt: SummaryPrompt): Promise<string> {
      const response = await client.messages.create({
        model,
        max_tokens: 1024,
        output_config: { effort: 'low' },
        system: prompt.system,
        messages: [{ role: 'user', content: prompt.user }],
      });
      if (response.stop_reason === 'refusal') throw new Error('the provider declined to draft a note');
      return response.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
    },
  };
}
