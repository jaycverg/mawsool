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
}

/**
 * Which cells must be hidden. A cell is hidden when any of its counts is under the threshold (zero included). That is
 * not enough where the table also publishes a total: with exactly one cell of a row hidden, the reader subtracts the
 * visible cells from the total and has it. So whenever a relation has exactly one hidden member, the smallest visible
 * member is hidden too (a part before the total on a tie), and this repeats until no relation has exactly one hidden
 * member, because hiding a cell can leave another relation with just one.
 *
 * The table is expected to include every group of a dimension, "no bucket given" among them, and the overall figure as
 * the total; leaving a group out leaves a gap the reader can fill from the total.
 */
export function hiddenCells(table: ProtectedTable, threshold: number = SUPPRESSION_THRESHOLD): Set<string> {
  const hidden = new Set<string>();
  for (const [key, counts] of table.cells) if (counts.some((count) => count < threshold)) hidden.add(key);

  const size = (key: string): number => table.cells.get(key)![0] ?? 0;
  for (let changed = true; changed; ) {
    changed = false;
    for (const relation of table.relations) {
      const members = [relation.total, ...relation.parts].filter((key) => table.cells.has(key));
      if (members.length < 2) continue;
      if (members.filter((key) => hidden.has(key)).length !== 1) continue;
      const [pick] = members
        .filter((key) => !hidden.has(key))
        .sort((a, b) => size(a) - size(b) || Number(a === relation.total) - Number(b === relation.total) || a.localeCompare(b));
      hidden.add(pick!);
      changed = true;
    }
  }
  return hidden;
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
