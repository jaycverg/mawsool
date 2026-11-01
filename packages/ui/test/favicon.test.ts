import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COLORS } from '../src';

const ROOT = join(__dirname, '..', '..', '..');
const APPS = ['person', 'clinician', 'ops'] as const;

describe('favicon', () => {
  const icons = APPS.map((app) => [app, join(ROOT, 'apps', app, 'app', 'icon.svg')] as const);

  it.each(icons)('%s ships app/icon.svg, which Next links from every page', (_app, file) => {
    expect(existsSync(file)).toBe(true);
    const svg = readFileSync(file, 'utf8');
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  });

  it('is the same two-ring mark on the accent colour in all three apps', () => {
    const [first, ...rest] = icons.map(([, file]) => readFileSync(file, 'utf8'));
    for (const other of rest) expect(other).toBe(first);
    expect(first!.toLowerCase()).toContain(COLORS.accent);
    expect((first!.match(/<circle /g) ?? []).length).toBe(2);
  });
});
