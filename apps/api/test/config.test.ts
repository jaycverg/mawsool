import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { TEST_ENCRYPTION_KEY as KEY } from './helpers/config';

const ANTHROPIC_ON = { BUNDLE_ENCRYPTION_KEY: KEY, SUMMARY_LLM_ENABLED: 'true', SUMMARY_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k' };

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
      summaryProvider: null,
      demoMode: false,
      notifierDriver: 'log',
    });
  });

  describe('DEMO_MODE', () => {
    const demo = (value: string | undefined) => loadConfig({ BUNDLE_ENCRYPTION_KEY: KEY, ...(value === undefined ? {} : { DEMO_MODE: value }) }).demoMode;

    it('is on only for true or 1', () => {
      expect(demo('true')).toBe(true);
      expect(demo('1')).toBe(true);
    });

    it('is off when unset, empty, false or 0: DEMO_MODE=false is not a truthy string', () => {
      for (const value of [undefined, '', 'false', '0']) expect(demo(value), String(value)).toBe(false);
    });

    it('refuses anything else, so a typo can neither switch the demo on nor leave it silently off', () => {
      for (const value of ['yes', 'TRUE', 'ture', 'on', ' true']) expect(() => demo(value), value).toThrow(/DEMO_MODE/);
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
      for (const on of ['true', '1']) expect(loadConfig({ BUNDLE_ENCRYPTION_KEY: KEY, SUMMARY_LLM_ENABLED: on, SUMMARY_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k' }).summaryLlmEnabled).toBe(true);
      expect(loadConfig({ BUNDLE_ENCRYPTION_KEY: KEY, SUMMARY_LLM_ENABLED: '0' }).summaryLlmEnabled).toBe(false);
      expect(() => loadConfig({ BUNDLE_ENCRYPTION_KEY: KEY, SUMMARY_LLM_ENABLED: 'yes' })).toThrow();
    });

    it('refuses to start switched on with the Anthropic provider and no key, and reads the model name', () => {
      expect(() => loadConfig({ BUNDLE_ENCRYPTION_KEY: KEY, SUMMARY_LLM_ENABLED: 'true', SUMMARY_PROVIDER: 'anthropic' })).toThrow(/ANTHROPIC_API_KEY/);
      expect(loadConfig({ ...ANTHROPIC_ON, SUMMARY_MODEL: 'some-model' }).summaryProvider).toEqual({ kind: 'anthropic', apiKey: 'k', model: 'some-model' });
    });
  });

  describe('the summary provider', () => {
    const FOUNDRY_ON = { BUNDLE_ENCRYPTION_KEY: KEY, SUMMARY_LLM_ENABLED: 'true', SUMMARY_PROVIDER: 'foundry', SUMMARY_FOUNDRY_API_KEY: 'test-key-not-real', SUMMARY_FOUNDRY_RESOURCE: 'my-res' };
    const EVERYTHING = { BUNDLE_ENCRYPTION_KEY: KEY, ANTHROPIC_API_KEY: 'k', SUMMARY_FOUNDRY_API_KEY: 'test-key-not-real', SUMMARY_FOUNDRY_RESOURCE: 'my-res' };

    it('has no default: switched on with no provider chosen is refused, even with every key present', () => {
      expect(() => loadConfig({ ...EVERYTHING, SUMMARY_LLM_ENABLED: 'true' })).toThrow(/SUMMARY_PROVIDER/);
      expect(() => loadConfig({ ...EVERYTHING, SUMMARY_LLM_ENABLED: 'true', SUMMARY_PROVIDER: '' })).toThrow(/SUMMARY_PROVIDER/);
    });

    it('is not needed while the assistant is off: nothing is built whatever else is set', () => {
      expect(loadConfig({ BUNDLE_ENCRYPTION_KEY: KEY }).summaryProvider).toBeNull();
      expect(loadConfig({ ...EVERYTHING, SUMMARY_LLM_ENABLED: 'false' }).summaryProvider).toBeNull();
      expect(loadConfig({ ...EVERYTHING, SUMMARY_LLM_ENABLED: 'false', SUMMARY_PROVIDER: 'foundry' }).summaryProvider).toBeNull();
    });

    it('is read strictly: only anthropic or foundry, in lower case with no spaces', () => {
      for (const bad of ['Foundry', 'azure', ' foundry']) {
        expect(() => loadConfig({ ...FOUNDRY_ON, SUMMARY_PROVIDER: bad }), bad).toThrow(/SUMMARY_PROVIDER must be anthropic or foundry/);
      }
    });

    it('refuses foundry without its key or its resource', () => {
      const { SUMMARY_FOUNDRY_API_KEY: _key, ...noKey } = FOUNDRY_ON;
      const { SUMMARY_FOUNDRY_RESOURCE: _resource, ...noResource } = FOUNDRY_ON;
      expect(() => loadConfig(noKey)).toThrow(/SUMMARY_FOUNDRY_API_KEY/);
      expect(() => loadConfig(noResource)).toThrow(/SUMMARY_FOUNDRY_RESOURCE/);
    });

    it('refuses a resource that is not a name: a host name would build a wrong address', () => {
      expect(() => loadConfig({ ...FOUNDRY_ON, SUMMARY_FOUNDRY_RESOURCE: 'my-res.services.ai.azure.com' })).toThrow(/SUMMARY_FOUNDRY_RESOURCE/);
    });

    it('gives the Foundry settings, with the model as the deployment name', () => {
      expect(loadConfig(FOUNDRY_ON).summaryProvider).toEqual({ kind: 'foundry', apiKey: 'test-key-not-real', resource: 'my-res', model: 'claude-sonnet-5-5' });
      expect(loadConfig({ ...FOUNDRY_ON, SUMMARY_MODEL: 'my-deployment' }).summaryProvider).toEqual({ kind: 'foundry', apiKey: 'test-key-not-real', resource: 'my-res', model: 'my-deployment' });
    });

    it('gives the Anthropic settings', () => {
      expect(loadConfig(ANTHROPIC_ON).summaryProvider).toEqual({ kind: 'anthropic', apiKey: 'k', model: 'claude-sonnet-5-5' });
    });

    it('never reads the names the Foundry SDK and Claude Code read: a shell cannot stand in for the settings', () => {
      const config = loadConfig({
        ...FOUNDRY_ON,
        ANTHROPIC_FOUNDRY_API_KEY: 'shell-key-not-real',
        ANTHROPIC_FOUNDRY_RESOURCE: 'shell.host.example',
        ANTHROPIC_FOUNDRY_BASE_URL: 'https://shell.example.test/anthropic/',
      });
      expect(config.summaryProvider).toEqual({ kind: 'foundry', apiKey: 'test-key-not-real', resource: 'my-res', model: 'claude-sonnet-5-5' });
    });

    it('puts no value in a startup error: a pasted key or address is never echoed', () => {
      const leaked = 'KEY.MUST.NOT.LEAK.7f3a';
      const cases: [string, Record<string, string>][] = [
        ['SUMMARY_FOUNDRY_RESOURCE', { ...FOUNDRY_ON, SUMMARY_FOUNDRY_RESOURCE: leaked }],
        ['SUMMARY_PROVIDER', { ...FOUNDRY_ON, SUMMARY_PROVIDER: 'KEY-MUST-NOT-LEAK-7f3a' }],
      ];
      for (const [name, env] of cases) {
        let message = '';
        try {
          loadConfig(env);
        } catch (error) {
          message = String(error instanceof Error ? error.message : error);
        }
        expect(message, name).toContain(name);
        expect(message, name).not.toMatch(/MUST[.-]NOT[.-]LEAK/);
      }
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
