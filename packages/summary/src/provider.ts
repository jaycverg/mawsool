import { createAnthropicProvider } from './anthropic';
import { createFoundryProvider } from './foundry';
import type { SummaryProvider } from './summary';

/** Which client to build and everything that client needs, as the API's settings produce it. */
export type SummaryProviderSettings =
  | { kind: 'anthropic'; apiKey: string; model: string }
  | { kind: 'foundry'; apiKey: string; resource: string; model: string };

/**
 * Builds the provider the settings name. The `switch` has no `default` on purpose: the type check proves it exhaustive, so
 * a third kind added to the union fails to compile here instead of falling through to a client nobody chose.
 */
export function createSummaryProvider(settings: SummaryProviderSettings, options: { fetch?: typeof fetch } = {}): SummaryProvider {
  switch (settings.kind) {
    case 'anthropic':
      return createAnthropicProvider({ apiKey: settings.apiKey, model: settings.model, fetch: options.fetch });
    case 'foundry':
      return createFoundryProvider({ apiKey: settings.apiKey, resource: settings.resource, model: settings.model, fetch: options.fetch });
  }
}
