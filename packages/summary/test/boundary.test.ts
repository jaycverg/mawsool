import { ESLint } from 'eslint';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..', '..', '..');

/**
 * One ESLint for every case, loaded before them: the first load of the repo's config (typescript-eslint and the React
 * plugins) is the slow part, and on a cold CI runner it alone passed a test's 5-second limit.
 */
let eslint: ESLint;

async function boundaryErrors(code: string, filePath: string) {
  const [result] = await eslint.lintText(code, { filePath: resolve(ROOT, filePath) });
  return result!.messages.filter((message) => message.ruleId === 'no-restricted-imports');
}

describe('the LLM import boundary', () => {
  beforeAll(async () => {
    eslint = new ESLint({ cwd: ROOT });
    // Loads the config and its plugins now, so no case pays for it.
    await eslint.calculateConfigForFile(resolve(ROOT, 'apps/api/src/example.ts'));
  }, 60_000);

  for (const sdk of ['@anthropic-ai/sdk', '@anthropic-ai/bedrock-sdk', 'openai', '@google/genai', 'ai', '@langchain/core']) {
    it(`fails the lint when code outside packages/summary imports ${sdk}`, async () => {
      for (const file of ['apps/api/src/example.ts', 'apps/person/lib/example.ts', 'packages/rules/src/example.ts', 'packages/consent/src/example.ts']) {
        const errors = await boundaryErrors(`import X from '${sdk}';\nexport default X;\n`, file);
        expect(errors, `${sdk} in ${file}`).toHaveLength(1);
        expect(errors[0]!.message).toContain('An LLM SDK may only be imported inside packages/summary.');
      }
    });
  }

  it('allows the same import inside packages/summary', async () => {
    expect(await boundaryErrors(`import Anthropic from '@anthropic-ai/sdk';\nexport default Anthropic;\n`, 'packages/summary/src/example.ts')).toEqual([]);
  });

  it('leaves ordinary imports alone', async () => {
    expect(await boundaryErrors(`import { z } from 'zod';\nimport x from 'aim';\nexport { z, x };\n`, 'apps/api/src/example.ts')).toEqual([]);
  });

  it('lists an LLM SDK as a dependency of packages/summary and of no other package', () => {
    const manifests = execFileSync('git', ['ls-files', '--', '**/package.json', 'package.json'], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n');
    expect(manifests.length).toBeGreaterThan(10);
    const sdkNames = /^(@anthropic-ai\/|openai$|@openai\/|@google\/gen|@aws-sdk\/client-bedrock-runtime$|@mistralai\/|cohere-ai$|ollama$|langchain$|@langchain\/|ai$|@ai-sdk\/)/;
    const holders = manifests.filter((file) => {
      const manifest = JSON.parse(readFileSync(resolve(ROOT, file), 'utf8')) as Record<string, Record<string, string> | undefined>;
      return Object.keys({ ...manifest['dependencies'], ...manifest['devDependencies'], ...manifest['peerDependencies'], ...manifest['optionalDependencies'] }).some((name) => sdkNames.test(name));
    });
    expect(holders).toEqual(['packages/summary/package.json']);
  });
});
