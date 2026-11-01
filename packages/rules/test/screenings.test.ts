import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { STEP_ROWS, hasUnresolvedCrisis, isCompleteScreening, latestByInstrument, selectRow, type RowId } from '../src';
import { gad7, phq9, screening } from './fixtures';

const T1 = '2026-10-01T08:00:00+04:00';
const T2 = '2026-10-02T08:00:00+04:00';

/**
 * Independent restatement of the spec's stepped-care table, written as an if-chain from the spec text,
 * not from config.ts. The property test below checks the config-driven selector against it for every
 * PHQ-9 and GAD-7 total, which is what catches overlapping or gapped rows.
 */
function specRow(phq: number | null, gad: number | null): RowId {
  if ((phq !== null && phq >= 20) || (gad !== null && gad >= 15)) return 'specialist_high';
  if (phq !== null && phq >= 15) return 'specialist_or_gp';
  if ((phq !== null && phq >= 10) || (gad !== null && gad >= 10)) return 'gp_or_tele';
  if ((phq !== null && phq >= 5) || (gad !== null && gad >= 5)) return 'self_help_or_community';
  return 'below_5';
}

describe('selectRow', () => {
  it('agrees with the spec table for every PHQ-9 total, GAD-7 total and missing score', () => {
    const phqValues = [null, ...Array.from({ length: 28 }, (_, i) => i)];
    const gadValues = [null, ...Array.from({ length: 22 }, (_, i) => i)];
    for (const p of phqValues) {
      for (const g of gadValues) {
        const history = [...(p === null ? [] : [phq9(p)]), ...(g === null ? [] : [gad7(g)])];
        expect(selectRow(history).row.id, `phq9=${p} gad7=${g}`).toBe(specRow(p, g));
      }
    }
  });

  it('picks the most intensive matching row when two rows match', () => {
    expect(selectRow([phq9(7), gad7(16)]).row.id).toBe('specialist_high');
    expect(selectRow([phq9(17), gad7(12)]).row.id).toBe('specialist_or_gp');
    expect(selectRow([phq9(12), gad7(6)]).row.id).toBe('gp_or_tele');
  });

  it('uses the below-5 row with no PHQ-9 or GAD-7 score, whatever else is on file', () => {
    expect(selectRow([]).row.id).toBe('below_5');
    expect(selectRow([screening('who5', 20, '2026-10-01T08:00:00+04:00')]).row.id).toBe('below_5');
    expect(selectRow([]).phq9Total).toBeNull();
    expect(selectRow([]).gad7Total).toBeNull();
  });

  it('uses the latest score per instrument, not the worst', () => {
    const history = [phq9(22, '2026-09-01T08:00:00+04:00'), phq9(6, '2026-10-01T08:00:00+04:00')];
    expect(selectRow(history).row.id).toBe('self_help_or_community');
    expect(selectRow(history).phq9Total).toBe(6);
  });

  it('puts a total above the instrument maximum on the top row, never on below 5', () => {
    expect(selectRow([phq9(30)]).row.id).toBe('specialist_high');
    expect(selectRow([gad7(22)]).row.id).toBe('specialist_high');
    expect(selectRow([phq9(28), gad7(0)]).row.id).toBe('specialist_high');
  });

  it('ignores a total that is not a finite number rather than matching on it', () => {
    expect(selectRow([screening('phq9', Number.NaN, T1, Array(9).fill(0))]).row.id).toBe('below_5');
    expect(selectRow([screening('gad7', Number.POSITIVE_INFINITY, T1, Array(7).fill(0)), phq9(11)]).row.id).toBe('gp_or_tele');
  });

  it('skips an incomplete screening, so a half-finished check-in does not replace a finished one', () => {
    const complete = phq9(18, T1);
    const partial = screening('phq9', 3, T2, [1, 1, 1]);
    expect(selectRow([complete, partial]).row.id).toBe('specialist_or_gp');
    expect(selectRow([complete, partial]).phq9Total).toBe(18);
    expect(selectRow([partial, complete]).row.id).toBe('specialist_or_gp');
  });

  it('treats an instrument with only incomplete screenings as having no score', () => {
    expect(selectRow([screening('gad7', 19, T1, [3, 3])]).row.id).toBe('below_5');
    expect(selectRow([screening('gad7', 19, T1, [3, 3])]).gad7Total).toBeNull();
    expect(selectRow([screening('phq9', 25, T1, [])]).row.id).toBe('below_5');
  });

  it('counts an over-complete answer list as incomplete too', () => {
    expect(isCompleteScreening(screening('phq9', 3, T1, Array(10).fill(0)))).toBe(false);
    expect(isCompleteScreening(phq9(3))).toBe(true);
    expect(isCompleteScreening(gad7(3))).toBe(true);
  });

  it('has exactly one fallback row, last, and every other row has a range', () => {
    const fallbacks = STEP_ROWS.filter((row) => !row.phq9 && !row.gad7);
    expect(fallbacks.map((row) => row.id)).toEqual(['below_5']);
    expect(STEP_ROWS.at(-1)?.id).toBe('below_5');
  });

  it('never leaves a total unmatched or double-matched in the spec bands', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 27 }), fc.integer({ min: 0, max: 21 }), (p, g) => {
        expect(selectRow([phq9(p), gad7(g)]).row.id).toBe(specRow(p, g));
      }),
    );
  });
});

describe('latestByInstrument', () => {
  it('keeps the newest screening per instrument', () => {
    const older = phq9(10, '2026-09-01T08:00:00+04:00');
    const newer = phq9(5, '2026-10-01T08:00:00+04:00');
    expect(latestByInstrument([newer, older]).phq9).toBe(newer);
    expect(latestByInstrument([older, newer]).phq9).toBe(newer);
  });

  it('lets the later entry win on equal timestamps', () => {
    const first = gad7(9, '2026-10-01T08:00:00+04:00');
    const second = gad7(14, '2026-10-01T08:00:00+04:00');
    expect(latestByInstrument([first, second]).gad7).toBe(second);
  });

  it('never lets a screening with an unreadable date beat one with a readable date', () => {
    const garbled = { ...phq9(20), takenAt: 'not a date' };
    const valid = phq9(7, T1);
    expect(latestByInstrument([garbled, valid]).phq9).toBe(valid);
    expect(latestByInstrument([valid, garbled]).phq9).toBe(valid);
    expect(selectRow([garbled, valid]).row.id).toBe('self_help_or_community');
    expect(selectRow([valid, garbled]).row.id).toBe('self_help_or_community');
  });

  it('falls back to the later entry when no date can be read', () => {
    const first = { ...phq9(20), takenAt: 'x' };
    const second = { ...phq9(7), takenAt: 'y' };
    expect(latestByInstrument([first, second]).phq9).toBe(second);
  });

  it('keeps instruments apart', () => {
    const result = latestByInstrument([phq9(4), gad7(3)]);
    expect(Object.keys(result).sort()).toEqual(['gad7', 'phq9']);
  });
});

describe('hasUnresolvedCrisis', () => {
  const item9 = phq9(1, '2026-10-01T08:00:00+04:00', 2);

  it('is false with no triggering answer', () => {
    expect(hasUnresolvedCrisis([phq9(20), gad7(15)], null)).toBe(false);
    expect(hasUnresolvedCrisis([], null)).toBe(false);
  });

  it('is true for an item 9 answer with no resolution', () => {
    expect(hasUnresolvedCrisis([item9], null)).toBe(true);
  });

  it('is true for a C-SSRS yes with no resolution', () => {
    expect(hasUnresolvedCrisis([screening('cssrs', 1, '2026-10-01T08:00:00+04:00', [0, 0, 1, 0, 0, 0])], null)).toBe(true);
  });

  it('is false once resolved after the answer, and on the same instant', () => {
    expect(hasUnresolvedCrisis([item9], '2026-10-01T08:05:00+04:00')).toBe(false);
    expect(hasUnresolvedCrisis([item9], '2026-10-01T08:00:00+04:00')).toBe(false);
  });

  it('fires again for an answer given after the resolution', () => {
    const later = phq9(3, '2026-10-20T08:00:00+04:00', 1);
    expect(hasUnresolvedCrisis([item9, later], '2026-10-01T08:05:00+04:00')).toBe(true);
  });

  it('counts an incomplete screening for crisis detection even though row selection skips it', () => {
    const partialCssrs = screening('cssrs', 1, T1, [1]);
    expect(isCompleteScreening(partialCssrs)).toBe(false);
    expect(hasUnresolvedCrisis([partialCssrs], null)).toBe(true);
    expect(selectRow([partialCssrs]).row.id).toBe('below_5');
  });

  it('treats a stored item 9 flag as a trigger even when the answers are missing', () => {
    const flagged = { ...screening('phq9', 0, T1, []), item9Flag: true };
    expect(hasUnresolvedCrisis([flagged], null)).toBe(true);
    const shortened = { ...screening('phq9', 4, T1, [0, 0, 0]), item9Flag: true };
    expect(hasUnresolvedCrisis([shortened], null)).toBe(true);
  });

  it('lets a resolution cover a flagged screening, and fires again for a later flagged one', () => {
    const flagged = { ...screening('phq9', 0, T1, []), item9Flag: true };
    expect(hasUnresolvedCrisis([flagged], '2026-10-01T09:00:00+04:00')).toBe(false);
    const later = { ...screening('phq9', 0, T2, []), item9Flag: true };
    expect(hasUnresolvedCrisis([flagged, later], '2026-10-01T09:00:00+04:00')).toBe(true);
  });

  it('does not fire on a screening with no flag and no triggering answer', () => {
    expect(hasUnresolvedCrisis([screening('phq9', 0, T1, [])], null)).toBe(false);
  });

  it('fails safe when a timestamp cannot be read', () => {
    expect(hasUnresolvedCrisis([item9], 'not a date')).toBe(true);
    const garbled = { ...item9, takenAt: 'not a date' };
    expect(hasUnresolvedCrisis([garbled], '2026-10-01T08:05:00+04:00')).toBe(true);
  });
});
