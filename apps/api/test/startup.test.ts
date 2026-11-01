import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createCipher } from '../src/crypto';
import { createTestDb } from './helpers/db';
import { TEST_CONFIG, TEST_ENCRYPTION_KEY } from './helpers/config';

describe('the API will not start without a good encryption key', () => {
  it('buildApp throws for a missing, short or empty key before any route exists', async () => {
    const { db, close } = await createTestDb();
    try {
      for (const encryptionKey of [undefined, '', Buffer.alloc(16).toString('base64')]) {
        await expect(buildApp({ db, config: { ...TEST_CONFIG, encryptionKey: encryptionKey as string } }), String(encryptionKey)).rejects.toThrow(/BUNDLE_ENCRYPTION_KEY/);
      }
      await expect(buildApp({ db, config: { ...TEST_CONFIG, encryptionKey: TEST_ENCRYPTION_KEY } })).resolves.toBeDefined();
    } finally {
      await close();
    }
  });

  it('the real entry point exits non-zero and names the variable, before it touches a database', () => {
    const env: Record<string, string> = { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '', DATABASE_URL: 'postgres://nobody:nobody@127.0.0.1:1/none' };
    const started = spawnSync('pnpm', ['exec', 'tsx', 'src/main.ts'], { cwd: resolve(__dirname, '..'), env, encoding: 'utf8', timeout: 60_000 });
    expect(started.signal).toBeNull();
    expect(started.status).not.toBe(0);
    expect(started.status).not.toBeNull();
    expect(`${started.stdout}${started.stderr}`).toMatch(/BUNDLE_ENCRYPTION_KEY/);
  });
});

describe('the column cipher', () => {
  const cipher = createCipher(TEST_ENCRYPTION_KEY);

  it('round-trips text with a fresh IV each time, so equal inputs give different ciphertext', () => {
    const a = cipher.encrypt('hello', 'ctx');
    const b = cipher.encrypt('hello', 'ctx');
    expect(a).not.toBe(b);
    expect(cipher.decrypt(a, 'ctx')).toBe('hello');
    expect(cipher.decrypt(b, 'ctx')).toBe('hello');
  });

  it('refuses a different context, a tampered value, another key and a value that is not ciphertext', () => {
    const token = cipher.encrypt('hello', 'ctx');
    expect(() => cipher.decrypt(token, 'other')).toThrow();
    const [version, iv, tag, body] = token.split('.');
    const flipped = `${version}.${iv}.${tag}.${Buffer.from(body!, 'base64url').map((byte) => byte ^ 1).toString('base64url')}`;
    expect(() => cipher.decrypt(flipped, 'ctx')).toThrow();
    expect(() => createCipher(Buffer.alloc(32, 1).toString('base64')).decrypt(token, 'ctx')).toThrow();
    expect(() => cipher.decrypt('plain text', 'ctx')).toThrow(/not encrypted/);
    expect(() => createCipher(undefined)).toThrow(/32 random bytes/);
  });
});
