import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { TEST_ENCRYPTION_KEY as KEY } from './helpers/config';

describe('loadConfig', () => {
  it('has defaults that match the base ports', () => {
    expect(loadConfig({ BUNDLE_ENCRYPTION_KEY: KEY })).toEqual({
      port: 4000,
      host: '127.0.0.1',
      databaseUrl: 'postgres://mawsool:mawsool@localhost:54329/mawsool',
      corsOrigins: ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:3002'],
      clinicianAppUrl: 'http://localhost:3001',
      opsAppUrl: 'http://localhost:3002',
      encryptionKey: KEY,
      summaryLlmEnabled: false,
      summaryModel: 'claude-sonnet-5-5',
      anthropicApiKey: undefined,
    });
  });

  it('reads overrides and trims the list and the trailing slash', () => {
    const config = loadConfig({
      API_PORT: '4100',
      CORS_ORIGINS: ' http://a.test , http://b.test ,',
      CLINICIAN_APP_URL: 'http://clinic.test/',
      OPS_APP_URL: 'http://ops.test/',
      DATABASE_URL: 'postgres://x',
      BUNDLE_ENCRYPTION_KEY: KEY,
    });
    expect(config).toMatchObject({ port: 4100, corsOrigins: ['http://a.test', 'http://b.test'], clinicianAppUrl: 'http://clinic.test', opsAppUrl: 'http://ops.test', databaseUrl: 'postgres://x' });
  });

  it('rejects an invalid port', () => {
    expect(() => loadConfig({ BUNDLE_ENCRYPTION_KEY: KEY, API_PORT: '99999' })).toThrow();
    expect(() => loadConfig({ BUNDLE_ENCRYPTION_KEY: KEY, API_PORT: 'abc' })).toThrow();
  });
});
