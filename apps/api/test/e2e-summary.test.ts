import { afterEach, describe, expect, it, vi } from 'vitest';
import { summaryFromEnvironment } from '../src/cli/e2e-summary';
import { TEST_ENCRYPTION_KEY as KEY } from './helpers/config';

/** A dummy provider key. It is checked for in error messages, so it must be recognisable, and it opens nothing. */
const DUMMY_KEY = 'dummy-key-must-never-be-printed-9f3a';

const SWITCH_ON = { E2E_SUMMARY_FROM_ENV: '1' };
const ANTHROPIC_ON = { SUMMARY_LLM_ENABLED: 'true', SUMMARY_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: DUMMY_KEY };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('summaryFromEnvironment (the end-to-end harness)', () => {
  it('leaves the assistant off, with no provider and no cap, when the switch is unset, whatever else the environment holds', () => {
    expect(summaryFromEnvironment({ ...ANTHROPIC_ON, SUMMARY_DAILY_LIMIT: '5' }, KEY)).toEqual({ enabled: false, provider: null, dailyLimit: undefined });
  });

  it('leaves the assistant off when the switch is anything but 1', () => {
    for (const value of ['', '0', 'true']) {
      expect(summaryFromEnvironment({ ...ANTHROPIC_ON, E2E_SUMMARY_FROM_ENV: value }, KEY)).toEqual({ enabled: false, provider: null, dailyLimit: undefined });
    }
  });

  it('stops when the switch is on and SUMMARY_LLM_ENABLED is off, naming the settings and never a value', () => {
    const env = { ...SWITCH_ON, SUMMARY_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: DUMMY_KEY };
    expect(() => summaryFromEnvironment(env, KEY)).toThrow(/SUMMARY_LLM_ENABLED/);
    expect(() => summaryFromEnvironment(env, KEY)).toThrow(/SUMMARY_PROVIDER/);
    let message = '';
    try {
      summaryFromEnvironment(env, KEY);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain(DUMMY_KEY);
    expect(message).not.toContain('anthropic');
  });

  it('stops when the switch is on, the assistant is on and no provider is chosen, without printing the key', () => {
    let message = '';
    try {
      summaryFromEnvironment({ ...SWITCH_ON, SUMMARY_LLM_ENABLED: 'true', ANTHROPIC_API_KEY: DUMMY_KEY }, KEY);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('SUMMARY_PROVIDER');
    expect(message).not.toContain(DUMMY_KEY);
  });

  it('returns the assistant on with a provider, and no cap, without making a network call', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = summaryFromEnvironment({ ...SWITCH_ON, ...ANTHROPIC_ON }, KEY);
    expect(result.enabled).toBe(true);
    expect(result.provider).not.toBeNull();
    expect(typeof result.provider?.complete).toBe('function');
    expect(result.dailyLimit).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns the cap from SUMMARY_DAILY_LIMIT, zero included', () => {
    expect(summaryFromEnvironment({ ...SWITCH_ON, ...ANTHROPIC_ON, SUMMARY_DAILY_LIMIT: '25' }, KEY).dailyLimit).toBe(25);
    expect(summaryFromEnvironment({ ...SWITCH_ON, ...ANTHROPIC_ON, SUMMARY_DAILY_LIMIT: '0' }, KEY).dailyLimit).toBe(0);
  });

  it('reads the bundle key from the harness, so an unset or real BUNDLE_ENCRYPTION_KEY in the environment is not needed', () => {
    expect(summaryFromEnvironment({ ...SWITCH_ON, ...ANTHROPIC_ON, BUNDLE_ENCRYPTION_KEY: 'not-a-key' }, KEY).enabled).toBe(true);
  });
});
