import { SUPPRESSION_THRESHOLD } from '@mawsool/rules';
import { suppress, type Suppressed } from '../suppress';

/**
 * A table of aggregates in which some cells add up to others (a row's cells to the row total, the rows to the grand
 * total). A cell is named by a key; the numbers it would publish are its `counts`.
 */
export interface ProtectedTable {
  /** Every number a cell publishes, as a count of people or tickets. A cell is shown only if all of them clear the threshold. */
  cells: ReadonlyMap<string, readonly number[]>;
  /** `total` is the sum of `parts`, for every count of the cell. A member that is not in `cells` is ignored. */
  relations: readonly { total: string; parts: readonly string[] }[];
  /** Pairs of cells that hold the very same value (the same tickets counted twice). Both are shown or both are hidden. */
  equal?: readonly (readonly [string, string])[];
  /** Which visible cell to hide first when one more must go: the lowest rank, then the smallest. Defaults to 0 for every cell. */
  prefer?: (key: string) => number;
  /** Cells that are hidden whatever their counts (for example two groups whose members differ by a handful of people). */
  forceHidden?: ReadonlySet<string>;
}

/**
 * Which cells must be hidden. A cell is hidden when any of its counts is under the threshold (zero included). That is
 * not enough where the table also publishes a total: a reader subtracts the visible cells from it. Two things follow.
 *
 * 1. Each relation, count by count. Unless the hidden members of a relation are empty on EVERY count (a count of nobody
 *    hides no small number), then for every count at least two of them must be non-empty, and when the total is shown they
 *    must add up to at least the threshold. A group of 4 that has no closed tickets would otherwise leave "0 closed" exact.
 *    While a relation falls short, one more visible member is hidden (the lowest `prefer` rank, then the smallest, a part
 *    before the total on a tie). This repeats across all relations, because hiding a cell can leave another short.
 *    `equal` cells follow each other.
 * 2. All relations together. Every relation and every `equal` pair is an equation in the hidden cells, the visible ones
 *    being known. Row-reduced exactly (integer arithmetic), an equation left with a single hidden cell pins that cell to a
 *    number the reader can compute, even though no one relation shows it. While a pinned cell is non-empty on some count,
 *    one more visible cell of a relation holding it is hidden (same order as above) and step 1 runs again.
 *
 * The table is expected to include every group of a dimension, "no bucket given" among them, and the overall figure as
 * the total; leaving a group out leaves a gap the reader can fill from the total. What is NOT covered, by decision: bounds
 * a reader can infer from counts never being negative, and the difference between two periods.
 */
export function hiddenCells(table: ProtectedTable, threshold: number = SUPPRESSION_THRESHOLD): Set<string> {
  const hidden = new Set<string>();
  for (const [key, counts] of table.cells) if (counts.some((count) => count < threshold)) hidden.add(key);
  for (const key of table.forceHidden ?? []) if (table.cells.has(key)) hidden.add(key);

  const size = (key: string): number => table.cells.get(key)![0] ?? 0;
  const rank = (key: string): number => table.prefer?.(key) ?? 0;
  const value = (key: string, index: number): number => table.cells.get(key)![index] ?? 0;
  const width = Math.max(1, ...[...table.cells.values()].map((counts) => counts.length));
  const empty = (key: string): boolean => !table.cells.get(key)!.some((count) => count > 0);
  const membersOf = (relation: ProtectedTable['relations'][number]): string[] => [relation.total, ...relation.parts].filter((key) => table.cells.has(key));
  const cheapest = (relation: ProtectedTable['relations'][number], candidates: string[]): string | undefined =>
    candidates.sort((a, b) => rank(a) - rank(b) || size(a) - size(b) || Number(a === relation.total) - Number(b === relation.total) || a.localeCompare(b))[0];

  /** True when what is hidden in this relation can still be told apart, for some count. */
  const falls = (members: string[], total: string): boolean => {
    const covered = members.filter((key) => hidden.has(key));
    if (covered.length === 0 || covered.every(empty)) return false;
    for (let index = 0; index < width; index += 1) {
      const present = covered.filter((key) => value(key, index) > 0).length;
      if (present < 2) return true;
      if (!hidden.has(total) && covered.reduce((sum, key) => sum + value(key, index), 0) < threshold) return true;
    }
    return false;
  };

  const settle = (): void => {
    for (let changed = true; changed; ) {
      changed = false;
      for (const [a, b] of table.equal ?? []) {
        if (!table.cells.has(a) || !table.cells.has(b) || hidden.has(a) === hidden.has(b)) continue;
        hidden.add(a);
        hidden.add(b);
        changed = true;
      }
      for (const relation of table.relations) {
        const members = membersOf(relation);
        if (members.length < 2) continue;
        while (falls(members, relation.total)) {
          const pick = cheapest(relation, members.filter((key) => !hidden.has(key)));
          if (pick === undefined) break;
          hidden.add(pick);
          changed = true;
        }
      }
    }
  };

  settle();
  for (;;) {
    const pinned = pinnedCells(table, hidden).filter((key) => !empty(key)).sort();
    let hid = false;
    for (const key of pinned) {
      let best: { relation: ProtectedTable['relations'][number]; pick: string } | undefined;
      for (const relation of table.relations) {
        const members = membersOf(relation);
        if (!members.includes(key)) continue;
        const pick = cheapest(relation, members.filter((member) => !hidden.has(member)));
        if (pick !== undefined && (best === undefined || cheapest(best.relation, [best.pick, pick]) === pick)) best = { relation, pick };
      }
      if (best !== undefined) {
        hidden.add(best.pick);
        hid = true;
        break;
      }
    }
    if (!hid) return hidden;
    settle();
  }
}

/**
 * The hidden cells a reader can compute exactly from the published ones, by any combination of the table's relations and
 * `equal` pairs. Every relation is one equation (the parts less the total is zero) in the hidden cells, with the visible
 * cells known; the equations are row-reduced with integer arithmetic (no floating point), and a hidden cell is pinned when
 * a reduced equation holds only it. This looks at the shape of the table only: whether a pinned cell is worth hiding more
 * for (it is not, if it is empty) is for the caller.
 */
export function pinnedCells(table: ProtectedTable, hidden: ReadonlySet<string>): string[] {
  const variables = [...hidden].filter((key) => table.cells.has(key)).sort();
  const column = new Map(variables.map((key, index) => [key, index]));
  const rows: bigint[][] = [];
  const equation = (terms: [string, bigint][]): void => {
    const row = Array<bigint>(variables.length).fill(0n);
    for (const [key, coefficient] of terms) {
      const at = column.get(key);
      if (at !== undefined) row[at] = row[at]! + coefficient;
    }
    if (row.some((entry) => entry !== 0n)) rows.push(row);
  };
  for (const relation of table.relations) {
    const members = [relation.total, ...relation.parts].filter((key) => table.cells.has(key));
    if (members.length >= 2) equation(members.map((key): [string, bigint] => [key, key === relation.total ? -1n : 1n]));
  }
  for (const [a, b] of table.equal ?? []) if (table.cells.has(a) && table.cells.has(b)) equation([[a, 1n], [b, -1n]]);

  const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? (a < 0n ? -a : a) : gcd(b, a % b));
  const reduce = (row: bigint[]): void => {
    const divisor = row.reduce((g, entry) => gcd(g, entry), 0n);
    if (divisor > 1n) for (let i = 0; i < row.length; i += 1) row[i] = row[i]! / divisor;
  };
  let used = 0;
  for (let col = 0; col < variables.length && used < rows.length; col += 1) {
    const at = rows.findIndex((row, index) => index >= used && row[col] !== 0n);
    if (at < 0) continue;
    [rows[used], rows[at]] = [rows[at]!, rows[used]!];
    const pivot = rows[used]!;
    for (let r = 0; r < rows.length; r += 1) {
      const row = rows[r]!;
      if (r === used || row[col] === 0n) continue;
      const [a, b] = [pivot[col]!, row[col]!];
      for (let i = 0; i < row.length; i += 1) row[i] = row[i]! * a - pivot[i]! * b;
      reduce(row);
    }
    used += 1;
  }
  const pinned: string[] = [];
  for (const row of rows) {
    const nonZero = row.flatMap((entry, index) => (entry !== 0n ? [index] : []));
    if (nonZero.length === 1) pinned.push(variables[nonZero[0]!]!);
  }
  return pinned;
}

/**
 * A cell's value, or `{ suppressed: true }` when the cell is in `hidden`. Every cell goes through `suppress`: a cell
 * hidden only because of its neighbours is handed in as size zero, so it is turned away by the same helper as one that is
 * too small, and what it returns carries no flag, no gap and no hint of size.
 */
export function cellOrSuppressed<T>(hidden: ReadonlySet<string>, key: string, counts: readonly number[], value: () => T): T | Suppressed {
  const shown = suppress(hidden.has(key) ? 0 : Math.min(...counts), true as const);
  return shown === true ? value() : shown;
}

/**
 * A share of `count` in `of`, or suppressed. A percentage also tells the reader the other side, so it is published only
 * when the part, the whole and what is left over all clear the threshold.
 */
export function rateOrSuppressed(count: number, of: number): { count: number; of: number; percent: number } | Suppressed {
  const shown = suppress(Math.min(count, of, of - count), true as const);
  return shown === true ? { count, of, percent: percentOf(count, of) } : shown;
}

/** A percentage to one decimal. */
export function percentOf(count: number, of: number): number {
  return of === 0 ? 0 : Math.round((count / of) * 1000) / 10;
}

/** The median (`p` = 0.5) or another percentile of a list by the nearest-rank method; null for an empty list. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
}
