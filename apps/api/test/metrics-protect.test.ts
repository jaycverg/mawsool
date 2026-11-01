import { describe, expect, it } from 'vitest';
import { TICKET_SOURCES, TICKET_TIERS } from '@mawsool/types';
import { openingTable } from '../src/metrics/funnel';
import { cellOrSuppressed, hiddenCells, percentile, pinnedCells, rateOrSuppressed, type ProtectedTable } from '../src/metrics/protect';

const table = (cells: Record<string, number[]>, relations: ProtectedTable['relations']): ProtectedTable => ({ cells: new Map(Object.entries(cells)), relations });

/**
 * True when some relation lets a reader work a small number out: for some count, what is hidden holds a single non-empty
 * cell (it is then the total minus the others, or the sum of the others), or, with the total shown, the hidden cells add up
 * to under ten. Hidden cells that are all empty hold no small number. Written apart from the code under test.
 */
function derivable(t: ProtectedTable, hidden: ReadonlySet<string>, threshold = 10): boolean {
  return exposedBy(t, hidden, threshold) !== null;
}

const PRIME = 1_000_000_007n;
const modPow = (base: bigint, exponent: bigint): bigint => {
  let result = 1n;
  for (let b = base % PRIME, e = exponent; e > 0n; e >>= 1n, b = (b * b) % PRIME) if (e & 1n) result = (result * b) % PRIME;
  return result;
};

/** The rank of integer rows, computed in the field of integers modulo a large prime (a different method from the product's exact integer reduction). */
function rankModPrime(rows: bigint[][], width: number, skip = -1): number {
  const m = rows.map((row) => row.filter((_, index) => index !== skip).map((entry) => ((entry % PRIME) + PRIME) % PRIME));
  let rank = 0;
  for (let col = 0; col < width - (skip >= 0 ? 1 : 0) && rank < m.length; col += 1) {
    const at = m.findIndex((row, index) => index >= rank && row[col] !== 0n);
    if (at < 0) continue;
    [m[rank], m[at]] = [m[at]!, m[rank]!];
    const inverse = modPow(m[rank]![col]!, PRIME - 2n);
    for (let r = rank + 1; r < m.length; r += 1) {
      const factor = (m[r]![col]! * inverse) % PRIME;
      if (factor !== 0n) m[r] = m[r]!.map((entry, index) => (((entry - factor * m[rank]![index]!) % PRIME) + PRIME) % PRIME);
    }
    rank += 1;
  }
  return rank;
}

/**
 * What a reader can compute exactly. The hidden cells are unknowns and every relation and equal pair is an equation. A
 * hidden cell is pinned (computable) exactly when dropping its column lowers the rank by one, which is a test on ranks and
 * shares no code with the product's row reduction. Returns a description of the first exposure, or null.
 * - a pinned cell that is non-empty on some count, unless every relation holding it is wholly hidden (nothing left to hide);
 * - a relation whose hidden cells are not empty on every count but, for some count, hold fewer than two non-empty cells, or
 *   (the total being shown) add up to under ten.
 */
function exposedBy(t: ProtectedTable, hidden: ReadonlySet<string>, threshold = 10): string | null {
  const unknowns = [...hidden].filter((key) => t.cells.has(key)).sort();
  const width = unknowns.length;
  const rows: bigint[][] = [];
  const equations: [string, bigint][][] = [];
  for (const relation of t.relations) {
    const members = [relation.total, ...relation.parts].filter((key) => t.cells.has(key));
    if (members.length >= 2) equations.push(members.map((key): [string, bigint] => [key, key === relation.total ? -1n : 1n]));
  }
  for (const [a, b] of t.equal ?? []) if (t.cells.has(a) && t.cells.has(b)) equations.push([[a, 1n], [b, -1n]]);
  for (const terms of equations) {
    const row = unknowns.map((key) => terms.filter(([term]) => term === key).reduce((sum, [, coefficient]) => sum + coefficient, 0n));
    if (row.some((entry) => entry !== 0n)) rows.push(row);
  }
  const full = rankModPrime(rows, width);
  for (const [at, key] of unknowns.entries()) {
    if (rankModPrime(rows, width, at) !== full - 1) continue;
    const nonEmpty = t.cells.get(key)!.some((count) => count > 0);
    // Nothing left to hide anywhere: no relation that touches a hidden cell has a visible member.
    const stuck = t.relations.every((relation) => {
      const members = [relation.total, ...relation.parts].filter((member) => t.cells.has(member));
      return !members.some((member) => hidden.has(member)) || members.every((member) => hidden.has(member));
    });
    if (nonEmpty && !stuck) return `${key} can be computed`;
  }
  for (const relation of t.relations) {
    const members = [relation.total, ...relation.parts].filter((key) => t.cells.has(key));
    const covered = members.filter((key) => hidden.has(key));
    if (covered.length === 0 || members.every((key) => hidden.has(key))) continue;
    if (covered.every((key) => !t.cells.get(key)!.some((count) => count > 0))) continue;
    const counts = Math.max(...members.map((key) => t.cells.get(key)!.length));
    for (let index = 0; index < counts; index += 1) {
      const values = covered.map((key) => t.cells.get(key)![index] ?? 0);
      if (values.filter((value) => value > 0).length < 2) return `count ${index} of ${covered.join('+')} is exposed`;
      if (!hidden.has(relation.total) && values.reduce((a, b) => a + b, 0) < threshold) return `count ${index} of ${covered.join('+')} is a small sum`;
    }
  }
  return null;
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

  it('leaves nothing a reader can compute, for 1,500 random grids with zero cells', () => {
    let seed = 7;
    const next = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    for (let round = 0; round < 1500; round += 1) {
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

/** A fixed-seed generator, so the fuzz below is the same on every run. */
function prng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

describe('what the hidden cells of all the relations together give away', () => {
  it('does not let two hidden blocks joined by one hidden cell pin the joining cell: nine small cells, everything else 30, no invites', () => {
    // Block A: rows 0-1 x columns 0-1. Block B: rows 2-3 x columns 2-3. The joining cell (1,2) sits in a row of A and a column of B.
    // Each row and column, taken alone, hides two or three non-empty cells adding up to ten or more; together they fix (1,2).
    const small: Record<string, number> = { '00': 6, '01': 5, '10': 6, '11': 5, '22': 6, '23': 5, '32': 6, '33': 5, '12': 4 };
    const cells: Record<string, number[]> = {};
    const relations: { total: string; parts: string[] }[] = [];
    const grid = (r: number, c: number) => small[`${r}${c}`] ?? 30;
    for (let r = 0; r < 4; r += 1) for (let c = 0; c < 4; c += 1) cells[`i${r}${c}`] = [grid(r, c)];
    for (let r = 0; r < 4; r += 1) {
      cells[`row${r}`] = [[0, 1, 2, 3].reduce((sum, c) => sum + grid(r, c), 0)];
      relations.push({ total: `row${r}`, parts: [0, 1, 2, 3].map((c) => `i${r}${c}`) });
    }
    for (let c = 0; c < 4; c += 1) {
      cells[`col${c}`] = [[0, 1, 2, 3].reduce((sum, r) => sum + grid(r, c), 0)];
      relations.push({ total: `col${c}`, parts: [0, 1, 2, 3].map((r) => `i${r}${c}`) });
    }
    cells['grand'] = [Object.values(small).reduce((a, b) => a + b, 0) + 30 * 7];
    relations.push({ total: 'grand', parts: [0, 1, 2, 3].map((r) => `row${r}`) });
    const t = table(cells, relations);
    // The nine small cells hide, and the per-row and per-column rule is satisfied by exactly them; the audit goes further.
    const hidden = hiddenCells(t);
    expect(Object.keys(small).every((key) => hidden.has(`i${key}`))).toBe(true);
    expect(hidden.size).toBeGreaterThan(Object.keys(small).length);
    expect(pinnedCells(t, hidden).filter((key) => t.cells.get(key)![0]! > 0)).toEqual([]);
    expect(exposedBy(t, hidden)).toBeNull();
    // Written the other way round: with only the nine hidden, the joining cell is the one number the reader can compute.
    const nineOnly = new Set(Object.keys(small).map((key) => `i${key}`));
    expect(pinnedCells(t, nineOnly)).toContain('i12');
    expect(exposedBy(t, nineOnly)).toContain('i12');
  });

  it('falls back to a visible cell of any relation that touches a hidden one when the pinned cell’s own relations have none: x = V - T3 + c', () => {
    // t1 = x + a, V = t1 + b, T3 = a + b + c, with x, a, b and t1 small. x appears only in the first relation, whose members
    // are all hidden, yet V, T3 and c (published) give x = 14 - 41 + 30 = 3.
    const t = table(
      { t1: [9], x: [3], a: [6], b: [5], V: [14], T3: [41], c: [30] },
      [{ total: 't1', parts: ['x', 'a'] }, { total: 'V', parts: ['t1', 'b'] }, { total: 'T3', parts: ['a', 'b', 'c'] }],
    );
    const primary = new Set(['t1', 'x', 'a', 'b']);
    expect(pinnedCells(t, primary)).toContain('x');
    expect(exposedBy(t, primary)).toContain('x');
    const hidden = hiddenCells(t);
    expect(['V', 'T3', 'c'].some((key) => hidden.has(key)), 'one of the published cells goes').toBe(true);
    expect(exposedBy(t, hidden)).toBeNull();
  });

  it('does not leave a small group’s 0% or 100% exact: a group of 4 with none closed beside one of 14 with none closed', () => {
    const regions = (closed: [number, number]) =>
      table(
        { overall: [138, 61, 77], abu: [60, 30, 30], ain: [60, 31, 29], dhafra: [4, closed[0], 4 - closed[0]], none: [14, closed[1], 14 - closed[1]] },
        [{ total: 'overall', parts: ['abu', 'ain', 'dhafra', 'none'] }],
      );
    for (const closed of [[0, 0], [4, 14]] as [number, number][]) {
      const t = regions(closed);
      const hidden = hiddenCells(t);
      expect(hidden.has('dhafra') && hidden.has('none')).toBe(true);
      expect(hidden.size, `closed ${closed.join('/')}: a third, non-empty cell goes with them`).toBeGreaterThan(2);
      expect(exposedBy(t, hidden)).toBeNull();
    }
  });

  it('does the same for timeliness: two small tiers that were never late are not a published "0 late"', () => {
    const t = table(
      { overall: [118, 100, 18], gp: [60, 50, 10], tele: [50, 46, 4], community: [4, 4, 0], specialist: [4, 0, 4] },
      [{ total: 'overall', parts: ['gp', 'tele', 'community', 'specialist'] }],
    );
    const hidden = hiddenCells(t);
    expect(exposedBy(t, hidden)).toBeNull();
    expect(hidden.size).toBeGreaterThan(3);
  });

  it('keeps hidden cells that are empty on every count in peace: a count of nobody is not worth another hidden cell', () => {
    const t = table({ total: [60], ur: [0], other: [0], en: [30], ar: [30] }, [{ total: 'total', parts: ['ur', 'other', 'en', 'ar'] }]);
    expect([...hiddenCells(t)].sort()).toEqual(['other', 'ur']);
  });

  it('holds on 4,500 random tables of the three shapes the dashboard publishes, fixed seed', () => {
    const random = prng(20_261_101);
    const pick = (low: number, high: number) => low + Math.floor(random() * (high - low + 1));
    /** Mostly sizeable, sometimes small, sometimes empty. */
    const size = () => (random() < 0.12 ? 0 : random() < 0.35 ? pick(1, 14) : pick(10, 70));
    const check = (name: string, t: ProtectedTable) => {
      const hidden = hiddenCells(t);
      for (const [key, counts] of t.cells) if (counts.some((count) => count < 10)) expect(hidden.has(key), `${name}: ${key} is under ten`).toBe(true);
      expect(exposedBy(t, hidden), name).toBeNull();
    };

    // 1. The funnel's first two stages, with open invites and crisis events, from random journeys.
    for (let round = 0; round < 1500; round += 1) {
      const journeys = [];
      for (const source of TICKET_SOURCES) for (const tier of TICKET_TIERS) for (let i = size(); i > 0; i -= 1) journeys.push({ source, tier, createdAt: new Date(0), acknowledged: true, seen: true, remeasured: false });
      const openInvites = (['phc', 'tamm', 'school'] as const).flatMap((source) => Array.from({ length: random() < 0.5 ? pick(0, 14) : 0 }, () => ({ source, createdAt: new Date(0) })));
      const crisis = Array.from({ length: random() < 0.8 ? size() : 0 }, () => ({ shownAt: new Date(0), callTapped: true, contactConfirmed: false, msToContact: null }));
      check(`funnel ${round}`, openingTable({ journeys, openInvites, crisis, since: null }));
    }

    // 2. Equity: four dimensions over the same tickets, "no bucket given" shared, three counts to a cell.
    const buckets = { age_band: ['a', 'b', 'c', 'd', 'e', 'f'], gender: ['x', 'y', 'z'], language: ['l1', 'l2', 'l3', 'l4', 'l5', 'l6'], region: ['r1', 'r2', 'r3'] } as const;
    for (let round = 0; round < 1500; round += 1) {
      const tickets = Array.from({ length: pick(30, 400) }, () => {
        const optedIn = random() < 0.7;
        const where = Object.fromEntries(Object.entries(buckets).map(([dimension, values]) => [dimension, optedIn ? values[Math.floor(random() ** 2 * values.length)]! : 'not_given']));
        return { where, closed: random() < 0.6 };
      });
      const cells: Record<string, number[]> = { overall: [tickets.length, tickets.filter((ticket) => ticket.closed).length, tickets.filter((ticket) => !ticket.closed).length] };
      const relations: { total: string; parts: string[] }[] = [];
      const equal: [string, string][] = [];
      for (const [dimension, values] of Object.entries(buckets)) {
        const parts = [...values, 'not_given'].map((value) => {
          const inGroup = tickets.filter((ticket) => ticket.where[dimension] === value);
          cells[`${dimension}:${value}`] = [inGroup.length, inGroup.filter((ticket) => ticket.closed).length, inGroup.filter((ticket) => !ticket.closed).length];
          return `${dimension}:${value}`;
        });
        relations.push({ total: 'overall', parts });
        if (dimension !== 'age_band') equal.push(['age_band:not_given', `${dimension}:not_given`]);
      }
      check(`equity ${round}`, { cells: new Map(Object.entries(cells)), relations, equal });
    }

    // 3. Timeliness: an overall figure and four tiers, three counts (settled, within target, late).
    for (let round = 0; round < 1500; round += 1) {
      const tiers = ['community', 'tele', 'gp', 'specialist'].map(() => {
        const settled = size();
        const within = Math.floor(random() * (settled + 1));
        return [settled, within, settled - within];
      });
      const overall = [0, 1, 2].map((index) => tiers.reduce((sum, tier) => sum + tier[index]!, 0));
      check(`timeliness ${round}`, table({ overall, community: tiers[0]!, tele: tiers[1]!, gp: tiers[2]!, specialist: tiers[3]! }, [{ total: 'overall', parts: ['community', 'tele', 'gp', 'specialist'] }]));
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
