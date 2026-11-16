import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = join(__dirname, '..', 'scripts', 'check-export.mjs');

const WITH_LINKS = '<a href="tel:800725462">800-SAKINA</a> 800 725462 <a href="tel:998">998</a> <a href="tel:999">999</a>';
const AS_TEXT = '<div>800-SAKINA</div> 800 725462 <div>Call 998</div> <div>Call 999</div>';

/** A small folder with only the crisis pages the check reads in both languages; every other check reports its own, unrelated, missing files. */
function exportWith(crisis: string): string {
  const folder = mkdtempSync(join(tmpdir(), 'check-export-'));
  for (const locale of ['en', 'ar']) {
    mkdirSync(join(folder, locale, 'crisis'), { recursive: true });
    writeFileSync(join(folder, locale, 'crisis', 'index.html'), `<html>${crisis}</html>`);
  }
  return folder;
}

/** Runs the real script on a folder and returns the lines it prints about the crisis page, and its exit code. */
function run(folder: string, flag?: string): { crisis: string[]; stderr: string; status: number | null } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NEXT_PUBLIC_PUBLIC_DEMO;
  if (flag !== undefined) env.NEXT_PUBLIC_PUBLIC_DEMO = flag;
  const result = spawnSync('node', [SCRIPT, folder], { env, encoding: 'utf8' });
  return { crisis: result.stderr.split('\n').filter((line) => line.includes('crisis page')), stderr: result.stderr, status: result.status };
}

describe('the export check on the crisis page', () => {
  it('unset: accepts the tap-to-call links and refuses a page without them, in both languages', () => {
    expect(run(exportWith(WITH_LINKS)).crisis).toEqual([]);
    expect(run(exportWith(AS_TEXT)).crisis).toEqual(['export check: en crisis page is missing its numbers', 'export check: ar crisis page is missing its numbers']);
  });

  it('an empty variable is the same as unset', () => {
    expect(run(exportWith(WITH_LINKS), '').crisis).toEqual([]);
    expect(run(exportWith(AS_TEXT), '').crisis).toHaveLength(2);
  });

  it('true: accepts the numbers as text with no link, in both languages', () => {
    expect(run(exportWith(AS_TEXT), 'true').crisis).toEqual([]);
  });

  it('true: refuses a page that still carries a tel: link, and one that lacks a number', () => {
    expect(run(exportWith(WITH_LINKS), 'true').crisis).toEqual([
      'export check: en crisis page has a tel: link, which the public-demo build must not carry',
      'export check: ar crisis page has a tel: link, which the public-demo build must not carry',
    ]);
    expect(run(exportWith('<div>800-SAKINA</div> 800 725462 <div>999</div>'), 'true').crisis).toEqual([
      'export check: en crisis page is missing its numbers as text',
      'export check: ar crisis page is missing its numbers as text',
    ]);
  });

  it('refuses any other value of the variable, and says so before looking at the folder', () => {
    for (const value of ['1', 'TRUE', 'yes', 'false']) {
      const result = run(exportWith(AS_TEXT), value);
      expect(result.status, value).toBe(1);
      expect(result.stderr, value).toContain('NEXT_PUBLIC_PUBLIC_DEMO must be true or be left unset');
    }
  });

  it('fails on a folder that does not exist', () => {
    const result = run(join(tmpdir(), 'check-export-no-such-folder'));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('does not exist');
  });
});
