// @ts-check
// Regenerates the PWA icons: the two-ring Mawsool mark on the accent colour. No dependencies; writes PNGs directly.
// Usage: node scripts/gen-icons.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';
import { resolve } from 'node:path';
import { ROOT } from './lib.mjs';

const BACKGROUND = /** @type {const} */ ([0x0e, 0x6b, 0x63]);
const MARK = /** @type {const} */ ([0xff, 0xff, 0xff]);
const OUT = resolve(ROOT, 'apps/person/public/icons');

/** Coverage (0 to 1) of a ring of the given radius and stroke at a point, by 4x4 supersampling. */
function ringCoverage(/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ cx, /** @type {number} */ cy, /** @type {number} */ r, /** @type {number} */ stroke) {
  let hits = 0;
  for (let sy = 0; sy < 4; sy++) {
    for (let sx = 0; sx < 4; sx++) {
      const d = Math.hypot(x + (sx + 0.5) / 4 - cx, y + (sy + 0.5) / 4 - cy);
      if (Math.abs(d - r) <= stroke / 2) hits++;
    }
  }
  return hits / 16;
}

/**
 * @param {number} size
 * @param {number} markScale fraction of the icon the mark spans (smaller for the maskable safe zone)
 */
function render(size, markScale) {
  // The board's mark: two circles of radius 7 centred at (10,14) and (18,14) in a 28 unit box, stroke 2.5.
  const unit = (size * markScale) / 22;
  const offsetX = (size - 22 * unit) / 2 - 3 * unit;
  const offsetY = (size - 22 * unit) / 2 - 3 * unit;
  const rings = [10, 18].map((cx) => ({ cx: offsetX + cx * unit, cy: offsetY + 14 * unit, r: 7 * unit, stroke: 2.5 * unit }));
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const coverage = Math.min(1, rings.reduce((sum, ring) => sum + ringCoverage(x, y, ring.cx, ring.cy, ring.r, ring.stroke), 0));
      const at = y * (size * 4 + 1) + 1 + x * 4;
      for (const c of /** @type {const} */ ([0, 1, 2])) raw[at + c] = Math.round(BACKGROUND[c] * (1 - coverage) + MARK[c] * coverage);
      raw[at + 3] = 255;
    }
  }
  return raw;
}

/** @param {string} type @param {Buffer} data */
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

/** @param {number} size @param {number} markScale */
function png(size, markScale) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(render(size, markScale), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });
writeFileSync(resolve(OUT, 'icon-192.png'), png(192, 0.72));
writeFileSync(resolve(OUT, 'icon-512.png'), png(512, 0.72));
// Maskable icons keep the mark inside the central 80% safe zone.
writeFileSync(resolve(OUT, 'icon-maskable-512.png'), png(512, 0.5));
console.log(`icons written to ${OUT}`);
