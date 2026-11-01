import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

describe('loadConfig', () => {
  it('has defaults that match the base ports', () => {
    expect(loadConfig({})).toEqual({
      port: 4000,
      host: '127.0.0.1',
      databaseUrl: 'postgres://mawsool:mawsool@localhost:54329/mawsool',
      corsOrigins: ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:3002'],
      staffLinkBaseUrl: 'http://localhost:3001',
    });
  });

  it('reads overrides and trims the list and the trailing slash', () => {
    const config = loadConfig({
      API_PORT: '4100',
      CORS_ORIGINS: ' http://a.test , http://b.test ,',
      STAFF_LINK_BASE_URL: 'http://staff.test/',
      DATABASE_URL: 'postgres://x',
    });
    expect(config).toMatchObject({ port: 4100, corsOrigins: ['http://a.test', 'http://b.test'], staffLinkBaseUrl: 'http://staff.test', databaseUrl: 'postgres://x' });
  });

  it('rejects an invalid port', () => {
    expect(() => loadConfig({ API_PORT: '99999' })).toThrow();
    expect(() => loadConfig({ API_PORT: 'abc' })).toThrow();
  });
});
