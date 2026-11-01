import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const PUBLIC = join(__dirname, '..', 'public');
const manifest = JSON.parse(readFileSync(join(PUBLIC, 'manifest.webmanifest'), 'utf8'));

describe('web manifest', () => {
  it('installs as a standalone app with the brand colours', () => {
    expect(manifest).toMatchObject({ display: 'standalone', theme_color: '#0E6B63', background_color: '#F3F6F5', start_url: '/' });
  });

  it('has 192 and 512 icons, and a maskable one, that exist as real PNGs', () => {
    const sizes = manifest.icons.map((icon: { sizes: string }) => icon.sizes);
    expect(sizes).toEqual(expect.arrayContaining(['192x192', '512x512']));
    expect(manifest.icons.some((icon: { purpose: string }) => icon.purpose === 'maskable')).toBe(true);
    for (const icon of manifest.icons as { src: string; sizes: string }[]) {
      const file = join(PUBLIC, icon.src);
      expect(existsSync(file), icon.src).toBe(true);
      const bytes = readFileSync(file);
      expect([...bytes.subarray(1, 4)].map((b) => String.fromCharCode(b)).join('')).toBe('PNG');
      const [w, h] = icon.sizes.split('x').map(Number);
      expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([w, h]);
    }
  });
});
