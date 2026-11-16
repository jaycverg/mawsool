import { createSummaryProvider, type SummaryProvider } from '@mawsool/summary';
import { loadConfig } from '../config';

/** What the end-to-end harness gives `buildApp` for the referral-summary assistant. */
export interface E2eSummary {
  enabled: boolean;
  provider: SummaryProvider | null;
  /** The daily allowance of AI drafts from `SUMMARY_DAILY_LIMIT`; `undefined` is no cap. */
  dailyLimit: number | undefined;
}

/**
 * The referral-summary assistant for an end-to-end run: off, with no provider and no cap, unless `E2E_SUMMARY_FROM_ENV` is
 * `1`, in which case the real settings (including `SUMMARY_DAILY_LIMIT`) come from the environment, read the way the API
 * reads them. Throws, naming only setting names, when the switch is on and the environment leaves the assistant off or with
 * no provider, so a recording can never fall back to the template unnoticed. Makes no network call: a provider only sends
 * a request when a draft is asked for.
 *
 * @param env the process environment
 * @param encryptionKey the harness's own throwaway bundle key, so `.env`'s real one is never needed or read
 */
export function summaryFromEnvironment(env: NodeJS.ProcessEnv, encryptionKey: string): E2eSummary {
  if (env.E2E_SUMMARY_FROM_ENV !== '1') return { enabled: false, provider: null, dailyLimit: undefined };
  const config = loadConfig({ ...env, BUNDLE_ENCRYPTION_KEY: encryptionKey });
  if (!config.summaryLlmEnabled || !config.summaryProvider) {
    throw new Error('E2E_SUMMARY_FROM_ENV=1 needs the assistant on: set SUMMARY_LLM_ENABLED=true and SUMMARY_PROVIDER (with that provider\'s key) in .env');
  }
  return { enabled: true, provider: createSummaryProvider(config.summaryProvider), dailyLimit: config.summaryDailyLimit };
}
