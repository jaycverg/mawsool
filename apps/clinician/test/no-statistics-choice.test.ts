import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');

/** Every source and message file of the clinic's app, except its tests and build output. */
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (['node_modules', '.next', '.next-e2e', 'out', 'test', 'e2e'].includes(name)) return [];
    return statSync(path).isDirectory() ? files(path) : /\.(tsx?|json|mjs)$/.test(name) ? [path] : [];
  });
}

describe('the clinic\'s screens', () => {
  it('know nothing of the person\'s choice to count their totals in anonymous statistics: no screen, message, call or type names it', () => {
    const all = files(ROOT);
    expect(all.length, 'found the app\'s sources, so the check below is not vacuous').toBeGreaterThan(10);
    for (const path of all) {
      expect(readFileSync(path, 'utf8'), path.slice(ROOT.length)).not.toMatch(/outcomeStat|statisticsOptIn|outcome-statistics|anonymous statistics/i);
    }
  });
});
