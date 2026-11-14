import type { BundleContent, ConsentElement, Locale } from '@mawsool/types';
import { buildPrompt, capWords, templateSummary, type SummaryPrompt } from './prompt';

/** Anything that can turn a prompt into text. The real ones call Claude through Anthropic's API or Microsoft Foundry; tests pass a stub. */
export interface SummaryProvider {
  complete(prompt: SummaryPrompt): Promise<string>;
}

/**
 * Why a draft came out the way it did. `ai` is the only outcome that called the provider. The others exist so a test
 * can tell a guard that held from one that was deleted: every path that does not call out says which guard it was.
 */
export type DraftOutcome = 'ai' | 'flag_off' | 'not_ticked' | 'provider_failed' | 'provider_empty';

export interface Draft {
  source: 'ai' | 'template';
  text: string;
  outcome: DraftOutcome;
}

export interface DraftInput {
  /** `SUMMARY_LLM_ENABLED`. */
  enabled: boolean;
  /** The person's "Use AI to help write my note" tick. */
  useAi: boolean;
  content: BundleContent;
  consented: readonly ConsentElement[];
  locale: Locale;
  provider: SummaryProvider | null;
}

/**
 * Drafts the referral summary. The provider is called only when the flag is on, the person ticked the box and a
 * provider exists; the prompt carries consented elements only. Any failure, an empty answer or a refusal returns the
 * fill-in template instead, so the person always has something to edit. The text is capped at the word limit.
 */
export async function draftSummary(input: DraftInput): Promise<Draft> {
  const template = (outcome: DraftOutcome): Draft => ({ source: 'template', text: templateSummary(input.locale), outcome });
  if (!input.enabled || !input.provider) return template('flag_off');
  if (!input.useAi) return template('not_ticked');
  try {
    const text = capWords(await input.provider.complete(buildPrompt(input.content, input.consented, input.locale)));
    return text === '' ? template('provider_empty') : { source: 'ai', text, outcome: 'ai' };
  } catch {
    return template('provider_failed');
  }
}
