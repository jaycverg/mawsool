import { ESLint } from 'eslint';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..', '..', '..');

async function lint(code: string, filePath: string) {
  const eslint = new ESLint({ cwd: ROOT });
  const [result] = await eslint.lintText(code, { filePath: resolve(ROOT, filePath) });
  return result!.messages.filter((m) => m.ruleId === 'no-restricted-syntax');
}

describe('the wall clock is read only in clock.ts', () => {
  it('flags Date.now() and new Date() in other API source files', async () => {
    const messages = await lint('export const a = Date.now();\nexport const b = new Date();\n', 'apps/api/src/example.ts');
    expect(messages.map((m) => m.message)).toEqual([
      'Read the time from clock.ts, not Date.now().',
      'Read the time from clock.ts, not new Date().',
    ]);
  });

  it('allows constructing a Date from a value', async () => {
    expect(await lint('export const a = new Date(0);\n', 'apps/api/src/example.ts')).toEqual([]);
  });

  it('allows the wall clock inside clock.ts', async () => {
    expect(await lint('export const a = () => new Date();\n', 'apps/api/src/clock.ts')).toEqual([]);
  });
});
