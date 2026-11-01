import { z } from 'zod';

const EnvSchema = z.object({
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  API_HOST: z.string().default('127.0.0.1'),
  DATABASE_URL: z.string().default('postgres://mawsool:mawsool@localhost:54329/mawsool'),
  CORS_ORIGINS: z.string().default('http://localhost:3000,http://localhost:3001,http://localhost:3002'),
  CLINICIAN_APP_URL: z.string().url().default('http://localhost:3001'),
  OPS_APP_URL: z.string().url().default('http://localhost:3002'),
});

export interface AppConfig {
  port: number;
  host: string;
  databaseUrl: string;
  corsOrigins: string[];
  clinicianAppUrl: string;
  opsAppUrl: string;
}

/** Reads and validates the environment. Throws with a readable message on a bad value. */
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = EnvSchema.parse(env);
  return {
    port: parsed.API_PORT,
    host: parsed.API_HOST,
    databaseUrl: parsed.DATABASE_URL,
    corsOrigins: parsed.CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean),
    clinicianAppUrl: parsed.CLINICIAN_APP_URL.replace(/\/$/, ''),
    opsAppUrl: parsed.OPS_APP_URL.replace(/\/$/, ''),
  };
}
