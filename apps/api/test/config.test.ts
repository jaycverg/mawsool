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
      personAppUrl: 'http://localhost:3000',
      inboundKeys: {},
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

  describe('the bundle encryption key', () => {
    it('is required: without it the config does not load', () => {
      expect(() => loadConfig({})).toThrow(/BUNDLE_ENCRYPTION_KEY/);
      expect(() => loadConfig({ BUNDLE_ENCRYPTION_KEY: '' })).toThrow(/BUNDLE_ENCRYPTION_KEY/);
    });

    it('must be 32 bytes of base64: shorter, longer and malformed keys are refused', () => {
      for (const bad of [Buffer.alloc(16).toString('base64'), Buffer.alloc(33).toString('base64'), 'not base64 at all!', Buffer.alloc(32).toString('hex')]) {
        expect(() => loadConfig({ BUNDLE_ENCRYPTION_KEY: bad }), bad).toThrow(/BUNDLE_ENCRYPTION_KEY/);
      }
    });
  });

  describe('the summary model flag', () => {
    it('is off by default, and on only for true or 1', () => {
      expect(loadConfig({ BUNDLE_ENCRYPTION_KEY: KEY }).summaryLlmEnabled).toBe(false);
      for (const on of ['true', '1']) expect(loadConfig({ BUNDLE_ENCRYPTION_KEY: KEY, SUMMARY_LLM_ENABLED: on, ANTHROPIC_API_KEY: 'k' }).summaryLlmEnabled).toBe(true);
      expect(loadConfig({ BUNDLE_ENCRYPTION_KEY: KEY, SUMMARY_LLM_ENABLED: '0' }).summaryLlmEnabled).toBe(false);
      expect(() => loadConfig({ BUNDLE_ENCRYPTION_KEY: KEY, SUMMARY_LLM_ENABLED: 'yes' })).toThrow();
    });

    it('refuses to start switched on without a provider key, and reads the model name', () => {
      expect(() => loadConfig({ BUNDLE_ENCRYPTION_KEY: KEY, SUMMARY_LLM_ENABLED: 'true' })).toThrow(/ANTHROPIC_API_KEY/);
      expect(loadConfig({ BUNDLE_ENCRYPTION_KEY: KEY, SUMMARY_MODEL: 'some-model' }).summaryModel).toBe('some-model');
    });
  });

  describe('the front doors that may hand over screens', () => {
    const KEY_TEXT = 'k'.repeat(32);

    it('accepts a source only when its signing key is set: no key, no source', () => {
      expect(loadConfig({ BUNDLE_ENCRYPTION_KEY: KEY }).inboundKeys).toEqual({});
      expect(loadConfig({ BUNDLE_ENCRYPTION_KEY: KEY, INBOUND_KEY_TAMM: KEY_TEXT }).inboundKeys).toEqual({ tamm: KEY_TEXT });
      expect(loadConfig({ BUNDLE_ENCRYPTION_KEY: KEY, INBOUND_KEY_PHC: KEY_TEXT, INBOUND_KEY_SCHOOL: `${KEY_TEXT}2`, INBOUND_KEY_TAMM: KEY_TEXT }).inboundKeys).toEqual({ phc: KEY_TEXT, tamm: KEY_TEXT, school: `${KEY_TEXT}2` });
    });

    it('refuses a key that is too short to be a key', () => {
      for (const name of ['INBOUND_KEY_PHC', 'INBOUND_KEY_TAMM', 'INBOUND_KEY_SCHOOL']) {
        expect(() => loadConfig({ BUNDLE_ENCRYPTION_KEY: KEY, [name]: 'short' }), name).toThrow(/at least 32 characters/);
      }
    });

    it('reads where a person opens the claim link, without a trailing slash', () => {
      expect(loadConfig({ BUNDLE_ENCRYPTION_KEY: KEY, PERSON_APP_URL: 'https://person.test/' }).personAppUrl).toBe('https://person.test');
    });
  });

  it('rejects an invalid port', () => {
    expect(() => loadConfig({ BUNDLE_ENCRYPTION_KEY: KEY, API_PORT: '99999' })).toThrow();
    expect(() => loadConfig({ BUNDLE_ENCRYPTION_KEY: KEY, API_PORT: 'abc' })).toThrow();
  });
});
