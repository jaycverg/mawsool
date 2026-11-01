import { ESLint } from 'eslint';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..', '..', '..');

async function lint(code: string, filePath: string) {
  const eslint = new ESLint({ cwd: ROOT });
  const [result] = await eslint.lintText(code, { filePath: resolve(ROOT, filePath) });
  return result!.messages.filter((m) => m.ruleId === 'react/jsx-no-literals');
}

describe('hard-coded JSX text is a lint error', () => {
  for (const file of ['apps/person/app/[locale]/page.tsx', 'apps/clinician/app/[locale]/page.tsx', 'apps/ops/app/[locale]/page.tsx', 'packages/ui/src/components/x.tsx']) {
    it(`fails on literal text in ${file}`, async () => {
      const messages = await lint('export function A() { return <p>Hello there</p>; }\n', file);
      expect(messages).toHaveLength(1);
      expect(messages[0]!.severity).toBe(2);
    });
  }

  it('fails on literal text mixed with expressions', async () => {
    const messages = await lint('export function A({ n }: { n: string }) { return <p>Welcome {n}</p>; }\n', 'apps/person/app/x.tsx');
    expect(messages.length).toBeGreaterThan(0);
  });

  it('passes when the text comes from a message function', async () => {
    const messages = await lint("export function A({ t }: { t: (k: string) => string }) { return <p>{t('home.title')}</p>; }\n", 'apps/person/app/x.tsx');
    expect(messages).toEqual([]);
  });

  it('allows a bare separator', async () => {
    const messages = await lint('export function A() { return <p>{1} · {2}</p>; }\n', 'apps/person/app/x.tsx');
    expect(messages).toEqual([]);
  });
});
