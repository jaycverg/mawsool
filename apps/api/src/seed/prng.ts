/**
 * Deterministic random numbers for the seed: the same seed string always yields the same sequence, with no
 * dependence on the wall clock, the process or the platform.
 */
export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max], both included. */
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  /** Picks by relative weight. */
  weighted<T>(items: readonly (readonly [T, number])[]): T;
  /** A new array in random order (Fisher-Yates); the input is untouched. */
  shuffle<T>(items: readonly T[]): T[];
  /** A version 4 UUID built from the sequence. */
  uuid(): string;
  /** A string of `length` characters drawn from `alphabet`. */
  code(length: number, alphabet: string): string;
}

/** xmur3: turns a string into a 32-bit seed. */
function hashSeed(seed: string): number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

/** mulberry32. */
export function createRng(seed: string): Rng {
  let state = hashSeed(seed);
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));
  const pick = <T>(items: readonly T[]): T => items[int(0, items.length - 1)]!;
  return {
    next,
    int,
    pick,
    weighted<T>(items: readonly (readonly [T, number])[]): T {
      const total = items.reduce((sum, [, weight]) => sum + weight, 0);
      let roll = next() * total;
      for (const [value, weight] of items) {
        roll -= weight;
        if (roll < 0) return value;
      }
      return items[items.length - 1]![0];
    },
    shuffle<T>(items: readonly T[]): T[] {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i--) {
        const j = int(0, i);
        [out[i], out[j]] = [out[j]!, out[i]!];
      }
      return out;
    },
    uuid(): string {
      const bytes = Array.from({ length: 16 }, () => int(0, 255));
      bytes[6] = (bytes[6]! & 0x0f) | 0x40;
      bytes[8] = (bytes[8]! & 0x3f) | 0x80;
      const hex = bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    },
    code(length: number, alphabet: string): string {
      return Array.from({ length }, () => alphabet[int(0, alphabet.length - 1)]).join('');
    },
  };
}
