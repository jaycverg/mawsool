import { describe, expect, it } from 'vitest';
import { cellOrSuppressed, hiddenCells, percentile, rateOrSuppressed, type ProtectedTable } from '../src/metrics/protect';

const table = (cells: Record<string, number[]>, relations: ProtectedTable['relations']): ProtectedTable => ({ cells: new Map(Object.entries(cells)), relations });

/**
 * True when some relation lets a reader work a small number out: for some count, what is hidden holds a single non-empty
 * cell (it is then the total minus the others, or the sum of the others), or, with the total shown, the hidden cells add up
 * to under ten. Hidden cells that are all empty hold no small number. Written apart from the code under test.
 */
function derivable(t: ProtectedTable, hidden: ReadonlySet<string>, threshold = 10): boolean {
  return t.relations.some((relation) => {
    const members = [relation.total, ...relation.parts].filter((key) => t.cells.has(key));
    const covered = members.filter((key) => hidden.has(key));
    const width = Math.max(...members.map((key) => t.cells.get(key)!.length));
    for (let index = 0; index < width; index += 1) {
      const values = covered.map((key) => t.cells.get(key)![index] ?? 0);
      const present = values.filter((value) => value > 0).length;
      if (present === 1) return true;
      if (present >= 2 && !hidden.has(relation.total) && values.reduce((a, b) => a + b, 0) < threshold) return true;
    }
    return false;
  });
}

describe('hiddenCells', () => {
  it('hides a cell under ten, and zero', () => {
    const t = table({ total: [40], a: [25], b: [9], c: [0], d: [6] }, [{ total: 'total', parts: ['a', 'b', 'c', 'd'] }]);
    const hidden = hiddenCells(t);
    expect([...hidden].sort()).toEqual(['b', 'c', 'd']);
  });

  it('keeps ten itself', () => {
    expect([...hiddenCells(table({ total: [20], a: [10], b: [10] }, [{ total: 'total', parts: ['a', 'b'] }]))]).toEqual([]);
  });

  it('hides the next smallest when exactly one cell of a row is hidden, so it cannot be taken out of the total', () => {
    const t = table({ total: [100], a: [60], b: [31], c: [9] }, [{ total: 'total', parts: ['a', 'b', 'c'] }]);
    const hidden = hiddenCells(t);
    expect([...hidden].sort()).toEqual(['b', 'c']); // b (31) is the next smallest after c
    expect(derivable(t, hidden)).toBe(false);
  });

  it('prefers a part to the total when they are tied, and the first of equal parts by name', () => {
    const t = table({ total: [20], a: [20], b: [4] }, [{ total: 'total', parts: ['a', 'b'] }]);
    expect([...hiddenCells(t)].sort()).toEqual(['a', 'b']);
  });

  it('repeats until no relation has a single hidden member: hiding one cell can expose another row', () => {
    // Row r1 = a + b, row r2 = c + d, columns x = a + c, y = b + d. Only d is small.
    const t = table(
      { r1: [50], r2: [40], x: [45], y: [45], a: [20], b: [30], c: [25], d: [5] },
      [
        { total: 'r1', parts: ['a', 'b'] },
        { total: 'r2', parts: ['c', 'd'] },
        { total: 'x', parts: ['a', 'c'] },
        { total: 'y', parts: ['b', 'd'] },
      ],
    );
    const hidden = hiddenCells(t);
    expect(hidden.has('d')).toBe(true);
    expect(derivable(t, hidden)).toBe(false);
    expect(hidden.size).toBeGreaterThan(3);
  });

  it('hides a cell when any one of the counts it publishes is under ten', () => {
    const t = table({ total: [100, 50, 50], a: [60, 8, 52], b: [40, 42, 0] }, [{ total: 'total', parts: ['a', 'b'] }]);
    // a (8 closed) and b (0 not closed) are both under ten on a count; for the not-closed count only a is non-empty among
    // the hidden, so the total goes too.
    expect([...hiddenCells(t)].sort()).toEqual(['a', 'b', 'total']);
  });

  it('does not take an empty group for the second hidden cell: a group of 4 and a group of 0 still leave the 4 to be subtracted', () => {
    const t = table({ total: [60], ur: [4], other: [0], en: [30], ar: [26] }, [{ total: 'total', parts: ['ur', 'other', 'en', 'ar'] }]);
    const hidden = hiddenCells(t);
    expect(hidden.has('ur') && hidden.has('other')).toBe(true);
    expect(hidden.size).toBeGreaterThan(2); // a third, non-empty cell went with them
    expect(derivable(t, hidden)).toBe(false);
  });

  it('does not publish a hidden pair that adds up to under ten: 4 and 3 are a 7 the reader can subtract', () => {
    const t = table({ total: [60], a: [4], b: [3], c: [30], d: [23] }, [{ total: 'total', parts: ['a', 'b', 'c', 'd'] }]);
    const hidden = hiddenCells(t);
    expect(hidden.size).toBeGreaterThanOrEqual(3);
    expect(derivable(t, hidden)).toBe(false);
  });

  it('keeps two tied cells together, and hides the lower-ranked visible cell first when another has to go', () => {
    const t: ProtectedTable = {
      cells: new Map([['total', [100]], ['a', [4]], ['preferred', [60]], ['small', [36]]]),
      relations: [{ total: 'total', parts: ['a', 'preferred', 'small'] }],
      prefer: (key) => (key === 'preferred' ? 0 : 1),
    };
    expect([...hiddenCells(t)].sort()).toEqual(['a', 'preferred']); // the larger one, because it ranks first
    const linked: ProtectedTable = { cells: new Map([['x', [4]], ['y', [40]]]), relations: [], equal: [['x', 'y']] };
    expect([...hiddenCells(linked)].sort()).toEqual(['x', 'y']);
  });

  it('ignores a relation member that has no cell', () => {
    const t = table({ total: [30], a: [30] }, [{ total: 'total', parts: ['a', 'missing'] }]);
    expect([...hiddenCells(t)]).toEqual([]);
  });

  it('leaves no relation with a single hidden member, for tables of random sizes', () => {
    let seed = 7;
    const next = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    for (let round = 0; round < 400; round += 1) {
      const rows = 2 + Math.floor(next() * 4);
      const cols = 2 + Math.floor(next() * 4);
      const cells: Record<string, number[]> = {};
      const grid: number[][] = [];
      for (let r = 0; r < rows; r += 1) {
        grid.push([]);
        for (let c = 0; c < cols; c += 1) {
          const value = next() < 0.3 ? Math.floor(next() * 14) : Math.floor(next() * 60);
          grid[r]!.push(value);
          cells[`i${r}${c}`] = [value];
        }
      }
      const relations: { total: string; parts: string[] }[] = [];
      let grand = 0;
      for (let r = 0; r < rows; r += 1) {
        const sum = grid[r]!.reduce((a, b) => a + b, 0);
        cells[`row${r}`] = [sum];
        grand += sum;
        relations.push({ total: `row${r}`, parts: grid[r]!.map((_, c) => `i${r}${c}`) });
      }
      for (let c = 0; c < cols; c += 1) {
        cells[`col${c}`] = [grid.reduce((a, row) => a + row[c]!, 0)];
        relations.push({ total: `col${c}`, parts: grid.map((_, r) => `i${r}${c}`) });
      }
      cells['grand'] = [grand];
      relations.push({ total: 'grand', parts: grid.map((_, r) => `row${r}`) }, { total: 'grand', parts: Array.from({ length: cols }, (_, c) => `col${c}`) });
      const t = table(cells, relations);
      const hidden = hiddenCells(t);
      expect(derivable(t, hidden), `round ${round}`).toBe(false);
      for (const [key, counts] of t.cells) if (counts[0]! < 10) expect(hidden.has(key), `${key} in round ${round}`).toBe(true);
    }
  });
});

describe('cellOrSuppressed, rateOrSuppressed and percentile', () => {
  it('turns a hidden cell away through suppress, however large it is, with nothing else in it', () => {
    const hidden = new Set(['big']);
    expect(cellOrSuppressed(hidden, 'big', [500], () => ({ rate: 99 }))).toEqual({ suppressed: true });
    expect(cellOrSuppressed(hidden, 'ok', [500], () => ({ rate: 99 }))).toEqual({ rate: 99 });
    expect(cellOrSuppressed(hidden, 'small', [9], () => ({ rate: 99 }))).toEqual({ suppressed: true });
  });

  it('publishes a share only when its part, its whole and what is left over all reach ten', () => {
    expect(rateOrSuppressed(10, 20)).toEqual({ count: 10, of: 20, percent: 50 });
    expect(rateOrSuppressed(9, 40)).toEqual({ suppressed: true });
    expect(rateOrSuppressed(31, 40)).toEqual({ suppressed: true }); // 9 left over: 31 of 40 would say so
    expect(rateOrSuppressed(0, 0)).toEqual({ suppressed: true });
    expect(rateOrSuppressed(40, 40)).toEqual({ suppressed: true });
  });

  it('takes the median and a percentile by nearest rank', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([5], 0.9)).toBe(5);
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
    expect(percentile([10, 1, 5], 0.5)).toBe(5);
  });
});
