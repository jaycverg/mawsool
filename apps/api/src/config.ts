import { DEFAULT_SUMMARY_MODEL, type SummaryProviderSettings } from '@mawsool/summary';
import type { InboundSource } from '@mawsool/types';
import { CronExpressionParser } from 'cron-parser';
import { z } from 'zod';
import { NOTIFIER_DRIVERS, type NotifierDriverName } from './notifier';

/** A 256-bit key as base64. Anything else is refused, so a truncated or mistyped key cannot start the API. */
const EncryptionKey = z
  .string({ error: 'BUNDLE_ENCRYPTION_KEY is required: the API will not start without a key to encrypt shared bundles' })
  .refine((value) => Buffer.from(value, 'base64').length === 32 && Buffer.from(value, 'base64').toString('base64') === value, {
    message: 'BUNDLE_ENCRYPTION_KEY must be 32 random bytes encoded as base64',
  });

/** A signing key for one front door: at least 32 characters, so a short or placeholder value cannot be accepted. */
const InboundKey = z.string().min(32, { error: 'An inbound signing key must be at least 32 characters' }).optional();

const Flag = z
  .enum(['true', 'false', '1', '0'])
  .default('false')
  .transform((value) => value === 'true' || value === '1');

/**
 * `DEMO_MODE` turns on the demo routes (clock and reset). It is read strictly: only `true` or `1` turns it on; unset,
 * empty, `false` and `0` are off; anything else (`yes`, `TRUE`, `ture`) stops the API from starting, so a typo can neither
 * switch the demo on by accident nor leave a presenter wondering why it is off.
 */
const DemoFlag = z
  .preprocess((value) => (value === '' ? undefined : value), z.enum(['true', 'false', '1', '0'], { error: 'DEMO_MODE must be true or false (or be left unset)' }).default('false'))
  .transform((value) => value === 'true' || value === '1');

/**
 * `NOTIFIER_DRIVER` picks the mock that "delivers" every outbound message (`console` or `log`); neither sends anything. Unset or
 * empty is `log`, the API's own log, where a presenter copies a sign-in link from. Any other value stops the API from starting.
 */
const NotifierDriver = z.preprocess((value) => (value === '' ? undefined : value), z.enum(NOTIFIER_DRIVERS, { error: 'NOTIFIER_DRIVER must be console or log (or be left unset)' }).default('log'));

/** An unset variable and an empty one are the same: a blank line in a `.env` or a container setting must not read as a value. */
const blankIsUnset = (value: unknown) => (value === '' ? undefined : value);

/** `RATE_LIMIT` turns the per-client limits on. Strict like `DEMO_MODE`: only `true` or `1` is on, and any other value (`1x`, `yes`) stops the API from starting. */
const RateLimitFlag = z
  .preprocess(blankIsUnset, z.enum(['true', 'false', '1', '0'], { error: 'RATE_LIMIT must be true or false (or be left unset)' }).default('false'))
  .transform((value) => value === 'true' || value === '1');

/** A header name, lower-case letters, digits and hyphens (`cf-connecting-ip`), so a typo cannot become a header nobody sends. */
const ClientIpHeader = z.preprocess(
  blankIsUnset,
  z.string().regex(/^[a-z0-9-]+$/, { error: 'CLIENT_IP_HEADER must be a header name in lower-case letters, digits and hyphens (for example cf-connecting-ip)' }).optional(),
);

/** A whole number of at least zero. The message never repeats the value. */
const wholeNumber = (name: string) => {
  const error = `${name} must be a whole number of at least 0`;
  return z.coerce.number({ error }).int({ error }).min(0, { error });
};

/**
 * `AI_DEMO_CODE` is the code a hosted demo asks for before the AI drafts a note: 8 to 64 characters, lower-case letters, digits
 * and hyphens (a request's code is trimmed and lower-cased before it is compared). The message never repeats the value.
 */
const AiDemoCode = z.preprocess(
  blankIsUnset,
  z.string().regex(/^[a-z0-9-]{8,64}$/, { error: 'AI_DEMO_CODE must be 8 to 64 characters of lower-case letters, digits and hyphens' }).optional(),
);

/** `DEMO_RESET_CRON` is a five-field cron expression, checked by the parser pg-boss schedules with, so a bad one stops startup instead of making `boss.schedule` throw. */
const DemoResetCron = z.preprocess(
  blankIsUnset,
  z
    .string()
    .refine(
      (value) => {
        try {
          CronExpressionParser.parse(value, { tz: 'UTC', strict: false });
          return value.trim().split(/\s+/).length === 5;
        } catch {
          return false;
        }
      },
      { error: 'DEMO_RESET_CRON must be a five-field cron expression (for example 0 23 * * *)' },
    )
    .optional(),
);

/**
 * `SUMMARY_PROVIDER` says which client sends the referral-summary request: `anthropic` (Anthropic's API) or `foundry` (Claude on
 * Microsoft Foundry). Unset or empty means not chosen, and there is no default, so where a person's consented details go and
 * which account pays is never decided silently. Anything else stops the API from starting; the message never repeats the value.
 */
const SummaryProviderName = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.enum(['anthropic', 'foundry'], { error: 'SUMMARY_PROVIDER must be anthropic or foundry (or be left unset)' }).optional(),
);

/** The Foundry resource is its name only, as the portal shows it. A host name or address would build a wrong address. */
const FoundryResource = z
  .string()
  .regex(/^[A-Za-z0-9-]+$/, { error: 'SUMMARY_FOUNDRY_RESOURCE must be the resource name only, as shown in the Foundry portal (for example my-resource), not a host name or address' })
  .optional();

const EnvSchema = z
  .object({
    DEMO_MODE: DemoFlag,
    NOTIFIER_DRIVER: NotifierDriver,
    RATE_LIMIT: RateLimitFlag,
    CLIENT_IP_HEADER: ClientIpHeader,
    SUMMARY_DAILY_LIMIT: z.preprocess(blankIsUnset, wholeNumber('SUMMARY_DAILY_LIMIT').optional()),
    AI_DEMO_CODE: AiDemoCode,
    DEMO_RESET_COOLDOWN_MS: z.preprocess(blankIsUnset, wholeNumber('DEMO_RESET_COOLDOWN_MS').default(0)),
    DEMO_RESET_CRON: DemoResetCron,
    API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    API_HOST: z.string().default('127.0.0.1'),
    DATABASE_URL: z.string().default('postgres://mawsool:mawsool@localhost:54329/mawsool'),
    CORS_ORIGINS: z.string().default('http://localhost:3000,http://localhost:3001,http://localhost:3002'),
    CLINICIAN_APP_URL: z.string().url().default('http://localhost:3001'),
    OPS_APP_URL: z.string().url().default('http://localhost:3002'),
    PERSON_APP_URL: z.string().url().default('http://localhost:3000'),
    INBOUND_KEY_PHC: InboundKey,
    INBOUND_KEY_TAMM: InboundKey,
    INBOUND_KEY_SCHOOL: InboundKey,
    BUNDLE_ENCRYPTION_KEY: EncryptionKey,
    SUMMARY_LLM_ENABLED: Flag,
    SUMMARY_MODEL: z.string().min(1).default(DEFAULT_SUMMARY_MODEL),
    SUMMARY_PROVIDER: SummaryProviderName,
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    // Deliberately not the ANTHROPIC_FOUNDRY_* names the Foundry SDK and Claude Code read: a value exported in the shell would
    // silently win over .env and send consented content to a resource nobody configured for this app.
    SUMMARY_FOUNDRY_API_KEY: z.string().min(1).optional(),
    SUMMARY_FOUNDRY_RESOURCE: FoundryResource,
  })
  .superRefine((env, ctx) => {
    if (!env.SUMMARY_LLM_ENABLED) return;
    const missing = (path: string, message: string) => ctx.addIssue({ code: 'custom', message, path: [path] });
    if (env.SUMMARY_PROVIDER === undefined) missing('SUMMARY_PROVIDER', 'SUMMARY_LLM_ENABLED is on, so SUMMARY_PROVIDER must be set to anthropic or foundry');
    if (env.SUMMARY_PROVIDER === 'anthropic' && env.ANTHROPIC_API_KEY === undefined) missing('ANTHROPIC_API_KEY', 'SUMMARY_LLM_ENABLED is on but ANTHROPIC_API_KEY is not set');
    if (env.SUMMARY_PROVIDER === 'foundry' && env.SUMMARY_FOUNDRY_API_KEY === undefined) missing('SUMMARY_FOUNDRY_API_KEY', 'SUMMARY_PROVIDER is foundry but SUMMARY_FOUNDRY_API_KEY is not set');
    if (env.SUMMARY_PROVIDER === 'foundry' && env.SUMMARY_FOUNDRY_RESOURCE === undefined) missing('SUMMARY_FOUNDRY_RESOURCE', 'SUMMARY_PROVIDER is foundry but SUMMARY_FOUNDRY_RESOURCE is not set');
  });

/** The settings of the chosen provider, or `null` when the assistant is off or no provider is chosen (the checks above refuse the second when it is on). */
function summaryProviderSettings(env: z.infer<typeof EnvSchema>): SummaryProviderSettings | null {
  if (!env.SUMMARY_LLM_ENABLED) return null;
  if (env.SUMMARY_PROVIDER === 'anthropic') return { kind: 'anthropic', apiKey: env.ANTHROPIC_API_KEY!, model: env.SUMMARY_MODEL };
  if (env.SUMMARY_PROVIDER === 'foundry') return { kind: 'foundry', apiKey: env.SUMMARY_FOUNDRY_API_KEY!, resource: env.SUMMARY_FOUNDRY_RESOURCE!, model: env.SUMMARY_MODEL };
  return null;
}

export interface AppConfig {
  port: number;
  host: string;
  databaseUrl: string;
  corsOrigins: string[];
  clinicianAppUrl: string;
  opsAppUrl: string;
  /** Where a person opens an invite's claim link. */
  personAppUrl: string;
  /** The signing key of each front door that may hand over screens. A source with no key is refused. */
  inboundKeys: Partial<Record<InboundSource, string>>;
  /** Base64 of the 32-byte AES-256-GCM key for shared bundles and logged summaries. */
  encryptionKey: string;
  /** Off by default. When off, no summary text ever goes to a provider. */
  summaryLlmEnabled: boolean;
  /** The chosen provider and its own settings. `null` whenever the flag is off, whatever else is set. */
  summaryProvider: SummaryProviderSettings | null;
  /** Registers the demo routes (clock and reset). Off unless `DEMO_MODE` is `true` or `1`. */
  demoMode: boolean;
  /** Which mock "delivers" outbound messages. */
  notifierDriver: NotifierDriverName;
  /** Turns the per-client rate limits on. Off by default, so nothing changes unless a hosted demo asks. */
  rateLimit: boolean;
  /** The header that carries the real client address behind a proxy (`cf-connecting-ip`); unset means the socket address. */
  clientIpHeader: string | undefined;
  /** At most this many AI calls per UTC day, then the template. Unset means no cap; 0 means no AI call at all. */
  summaryDailyLimit: number | undefined;
  /** When set, the AI drafts only for a request that carries this code (lower-case). */
  aiDemoCode: string | undefined;
  /** Milliseconds after a reset during which another reset is refused (429). 0 means no cool-down. */
  demoResetCooldownMs: number;
  /** When set (and `DEMO_MODE` is on), the demo resets itself on this cron schedule (UTC). */
  demoResetCron: string | undefined;
}

/** Reads and validates the environment. Throws with a readable message on a bad or missing value, the key included. */
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = EnvSchema.parse(env);
  return {
    port: parsed.API_PORT,
    host: parsed.API_HOST,
    databaseUrl: parsed.DATABASE_URL,
    corsOrigins: parsed.CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean),
    clinicianAppUrl: parsed.CLINICIAN_APP_URL.replace(/\/$/, ''),
    opsAppUrl: parsed.OPS_APP_URL.replace(/\/$/, ''),
    personAppUrl: parsed.PERSON_APP_URL.replace(/\/$/, ''),
    inboundKeys: {
      ...(parsed.INBOUND_KEY_PHC ? { phc: parsed.INBOUND_KEY_PHC } : {}),
      ...(parsed.INBOUND_KEY_TAMM ? { tamm: parsed.INBOUND_KEY_TAMM } : {}),
      ...(parsed.INBOUND_KEY_SCHOOL ? { school: parsed.INBOUND_KEY_SCHOOL } : {}),
    },
    encryptionKey: parsed.BUNDLE_ENCRYPTION_KEY,
    summaryLlmEnabled: parsed.SUMMARY_LLM_ENABLED,
    summaryProvider: summaryProviderSettings(parsed),
    demoMode: parsed.DEMO_MODE,
    notifierDriver: parsed.NOTIFIER_DRIVER,
    rateLimit: parsed.RATE_LIMIT,
    clientIpHeader: parsed.CLIENT_IP_HEADER,
    summaryDailyLimit: parsed.SUMMARY_DAILY_LIMIT,
    aiDemoCode: parsed.AI_DEMO_CODE,
    demoResetCooldownMs: parsed.DEMO_RESET_COOLDOWN_MS,
    demoResetCron: parsed.DEMO_RESET_CRON,
  };
}
