import { DEFAULT_SUMMARY_MODEL } from '@mawsool/summary';
import type { InboundSource } from '@mawsool/types';
import { z } from 'zod';

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

const EnvSchema = z
  .object({
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
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
  })
  .refine((env) => !env.SUMMARY_LLM_ENABLED || env.ANTHROPIC_API_KEY !== undefined, {
    message: 'SUMMARY_LLM_ENABLED is on but ANTHROPIC_API_KEY is not set',
    path: ['ANTHROPIC_API_KEY'],
  });

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
  summaryModel: string;
  anthropicApiKey: string | undefined;
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
    summaryModel: parsed.SUMMARY_MODEL,
    anthropicApiKey: parsed.ANTHROPIC_API_KEY,
  };
}
