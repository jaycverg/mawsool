import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import ar from '../messages/ar.json';
import en from '../messages/en.json';
import commonAr from '../../../packages/ui/messages/ar.json';
import commonEn from '../../../packages/ui/messages/en.json';

const CHECKLIST = readFileSync(join(__dirname, '..', '..', '..', 'docs', 'safe-messaging-checklist.md'), 'utf8');

function has(messages: unknown, path: string): boolean {
  return typeof path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], messages) === 'string';
}

/** The message keys named in the checklist's "Where it shows" column: `a.b` in full, a bare name inside `crisis`. */
function citedKeys(): string[] {
  const keys = new Set<string>();
  for (const row of CHECKLIST.split('\n').filter((line) => line.startsWith('| ') && line.split('|').length >= 5)) {
    const where = row.split('|')[3] ?? '';
    for (const [, token] of where.matchAll(/`([^`]+)`/g)) {
      if (token!.includes('*') || token!.endsWith('.json')) continue;
      keys.add(token!.includes('.') ? token! : `crisis.${token}`);
    }
  }
  return [...keys];
}

describe('docs/safe-messaging-checklist.md', () => {
  it('cites only message keys that exist in both languages', () => {
    const cited = citedKeys();
    expect(cited.length).toBeGreaterThan(10); // the table was read
    const missing = cited.filter((key) => !(has({ ...commonEn, ...en }, key) && has({ ...commonAr, ...ar }, key)));
    expect(missing).toEqual([]);
  });
});
