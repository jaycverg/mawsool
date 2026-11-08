import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import ar from '../messages/ar.json';
import en from '../messages/en.json';
import { SAMPLE_LABS, showsSampleLabs } from '../lib/sample-labs';

describe('the sample labs of the context panel', () => {
  it('are named in both languages, and carry the mock label "Sample — would come from Malaffi" in English', () => {
    for (const lab of SAMPLE_LABS) {
      expect(en.detail.lab[lab.id], `en ${lab.id}`).toBeTruthy();
      expect(ar.detail.lab[lab.id], `ar ${lab.id}`).toMatch(/[؀-ۿ]/);
    }
    expect(en.detail.labsMock).toBe('Sample — would come from Malaffi');
    expect(ar.detail.labsMock).toMatch(/[؀-ۿ]/);
    expect(en.detail.labsNote).toMatch(/not this person/i);
    expect(ar.detail.labsNote).toMatch(/[؀-ۿ]/);
  });

  it('show only beside conditions the person shared and listed', () => {
    expect(showsSampleLabs({ conditions: ['diabetes'] }, true)).toBe(true);
    expect(showsSampleLabs({ conditions: ['diabetes'] }, false)).toBe(false);
    expect(showsSampleLabs({ conditions: [] }, true)).toBe(false);
    expect(showsSampleLabs({}, true)).toBe(false);
  });

  it('are nowhere on the server: no file of the API, the FHIR export, the types or the consent rules names a lab', () => {
    const root = join(__dirname, '..', '..', '..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === 'dist' || name === 'drizzle' || name === 'test' || name.startsWith('.')) continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx|mjs)$/.test(name)) files.push(path);
      }
    };
    for (const dir of ['apps/api/src', 'packages/fhir/src', 'packages/types/src', 'packages/consent/src']) walk(join(root, dir));
    expect(files.length).toBeGreaterThan(30);
    const offenders = files.filter((file) => /HbA1c|hba1c|sample-labs|SAMPLE_LABS|fasting glucose|\bTSH\b/i.test(readFileSync(file, 'utf8'))).map((file) => relative(root, file));
    expect(offenders).toEqual([]);
  });
});
