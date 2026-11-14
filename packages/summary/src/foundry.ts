import AnthropicFoundry from '@anthropic-ai/foundry-sdk';
import { DEFAULT_SUMMARY_MODEL, messagesProvider, SUMMARY_CLIENT_LIMITS } from './anthropic';
import type { SummaryProvider } from './summary';

/**
 * The provider that calls Claude on Microsoft Foundry, through a resource name (the name only, as the Foundry portal shows
 * it). `model` is the deployment name, which defaults to the model id. The key and the resource are always passed, and
 * `baseURL` is `null`, so the client never reads `ANTHROPIC_FOUNDRY_*` from the environment: a shell variable can neither
 * redirect the request nor make the client refuse to build.
 */
export function createFoundryProvider(options: { apiKey: string; resource: string; model?: string; fetch?: typeof fetch }): SummaryProvider {
  const client = new AnthropicFoundry({ apiKey: options.apiKey, resource: options.resource, baseURL: null, fetch: options.fetch, ...SUMMARY_CLIENT_LIMITS });
  return messagesProvider(client, options.model ?? DEFAULT_SUMMARY_MODEL);
}
