import Anthropic from '@anthropic-ai/sdk';
import type { SummaryPrompt } from './prompt';
import type { SummaryProvider } from './summary';

/** The default model for the referral summary. Set `SUMMARY_MODEL` to change it. On Foundry it is the deployment name. */
export const DEFAULT_SUMMARY_MODEL = 'claude-sonnet-5-5';

/** The retry and time limits both clients use, so a slow provider ends in the template the same way on either. */
export const SUMMARY_CLIENT_LIMITS = { maxRetries: 1, timeout: 20_000 } as const;

/**
 * What the summary needs from a client: the `create` call of the messages API. Anthropic's own client and the Foundry client
 * both satisfy it, which `Anthropic` itself does not for the Foundry client (it redeclares `messages` and `models`).
 */
export type MessagesClient = { messages: Pick<Anthropic['messages'], 'create'> };

/**
 * The request and the refusal handling both providers share. It asks for a short note at low effort, with no sampling
 * parameters (this model family refuses them), and treats a refusal or an answer with no text as a failure, which
 * `draftSummary` turns into the template.
 */
export function messagesProvider(client: MessagesClient, model: string): SummaryProvider {
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

/**
 * The provider that calls Anthropic's own API. This file, `foundry.ts` and `provider.ts` are the only places in the
 * repository that import an LLM SDK. `fetch` is injectable so tests never touch the network.
 */
export function createAnthropicProvider(options: { apiKey: string; model?: string; fetch?: typeof fetch }): SummaryProvider {
  const client = new Anthropic({ apiKey: options.apiKey, fetch: options.fetch, ...SUMMARY_CLIENT_LIMITS });
  return messagesProvider(client, options.model ?? DEFAULT_SUMMARY_MODEL);
}
