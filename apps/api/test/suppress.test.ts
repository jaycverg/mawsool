import { describe, expect, it } from 'vitest';
import { suppress } from '../src/suppress';

describe('suppress', () => {
  it('replaces a value backed by fewer than ten people with the suppressed marker', () => {
    for (const n of [0, 1, 9]) expect(suppress(n, { rate: 0.5 }), `n = ${n}`).toEqual({ suppressed: true });
  });

  it('returns the value untouched at ten and above', () => {
    for (const n of [10, 11, 5000]) expect(suppress(n, { rate: 0.5 }), `n = ${n}`).toEqual({ rate: 0.5 });
  });

  it('uses the threshold it is given', () => {
    expect(suppress(4, 'x', 5)).toEqual({ suppressed: true });
    expect(suppress(5, 'x', 5)).toBe('x');
  });
});
