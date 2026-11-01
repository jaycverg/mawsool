import { afterEach, describe, expect, it, vi } from 'vitest';

const SESSION = { sessionToken: 't', expiresAt: '2026-11-01T16:00:00.000Z', role: 'clinician', facilityId: null };

/**
 * How many times building and parsing with the schemas tried `new Function('')`, which a script policy without eval
 * reports as a violation, with the build flag set or not. The package is loaded fresh, because Zod decides when a schema
 * is built. Zod itself stays loaded and keeps what it was told, so the default case runs first: this file is one process.
 */
async function probes(jitless: boolean): Promise<number> {
  vi.resetModules();
  if (jitless) vi.stubEnv('NEXT_PUBLIC_ZOD_JITLESS', 'true');
  else vi.unstubAllEnvs();
  const found: unknown[][] = [];
  const Original = globalThis.Function;
  globalThis.Function = new Proxy(Original, {
    construct(target, args, newTarget) {
      if (args.length === 1 && args[0] === '') found.push(args);
      return Reflect.construct(target, args, newTarget);
    },
  });
  try {
    const { SessionSchema } = await import('../src');
    expect(SessionSchema.parse(SESSION)).toMatchObject({ role: 'clinician' });
    expect(SessionSchema.safeParse({ ...SESSION, role: 'nobody' }).success).toBe(false);
  } finally {
    globalThis.Function = Original;
  }
  return found.length;
}

describe('schemas under a script policy without eval', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('probe for eval by default, which is what a strict policy reports', async () => {
    expect(await probes(false)).toBeGreaterThan(0);
  });

  it('do not probe at all in a build that sets NEXT_PUBLIC_ZOD_JITLESS, and still validate', async () => {
    expect(await probes(true)).toBe(0);
  });
});
