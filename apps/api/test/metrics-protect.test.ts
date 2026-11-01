import { describe, expect, it } from 'vitest';
import { cellOrSuppressed, hiddenCells, percentile, rateOrSuppressed, type ProtectedTable } from '../src/metrics/protect';

const table = (cells: Record<string, number[]>, relations: ProtectedTable['relations']): ProtectedTable => ({ cells: new Map(Object.entries(cells)), relations });

/** True when some relation has exactly one hidden member: the hidden one is then the total minus the others, or the sum of the others. */
function derivable(t: ProtectedTable, hidden: ReadonlySet<string>): boolean {
  return t.relations.some((relation) => {
    const members = [relation.total, ...relation.parts].filter((key) => t.cells.has(key));
    return members.length >= 2 && members.filter((key) => hidden.has(key)).length === 1;
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
    expect([...hiddenCells(t)].sort()).toEqual(['a', 'b']);
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
