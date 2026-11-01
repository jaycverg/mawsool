import { describe, expect, it } from 'vitest';
import { RELIABLE_CHANGE, completedSeries, isTracked, latestChange, reliableChange } from '../src';
import { gad7, phq9, screening } from './fixtures';

const T1 = '2026-10-08T08:00:00+04:00';
const T2 = '2026-10-29T08:00:00+04:00';
const T3 = '2026-11-19T08:00:00+04:00';

describe('reliableChange', () => {
  it('reads the thresholds from config: PHQ-9 six points, GAD-7 four', () => {
    expect(RELIABLE_CHANGE).toEqual({ phq9: 6, gad7: 4 });
  });

  it.each([
    ['gad7', 9, 14, 'reliable_deterioration', 5], // demo step 4
    ['gad7', 9, 13, 'reliable_deterioration', 4],
    ['gad7', 9, 12, 'no_reliable_change', 3],
    ['gad7', 14, 10, 'reliable_improvement', -4],
    ['gad7', 14, 11, 'no_reliable_change', -3],
    ['phq9', 7, 13, 'reliable_deterioration', 6],
    ['phq9', 7, 12, 'no_reliable_change', 5],
    ['phq9', 15, 9, 'reliable_improvement', -6],
    ['phq9', 15, 10, 'no_reliable_change', -5],
    ['phq9', 8, 8, 'no_reliable_change', 0],
  ] as const)('%s %i to %i is %s', (instrument, previous, current, kind, delta) => {
    expect(reliableChange(instrument, previous, current)).toEqual({ kind, delta });
  });
});

describe('isTracked', () => {
  it('is true for the PHQ-9 and GAD-7 only', () => {
    expect(isTracked('phq9')).toBe(true);
    expect(isTracked('gad7')).toBe(true);
    expect(isTracked('who5')).toBe(false);
    expect(isTracked('cssrs')).toBe(false);
  });
});

describe('completedSeries', () => {
  it('lists one instrument oldest first, whatever the order it was stored in', () => {
    const series = completedSeries([gad7(14, T2), phq9(7, T1), gad7(9, T1), gad7(6, T3)], 'gad7');
    expect(series.map((s) => s.total)).toEqual([9, 14, 6]);
  });

  it('leaves out a check-in in progress, so a partial check-in never reaches the trajectory', () => {
    const partial = { ...screening('gad7', 12, T3, Array(7).fill(0)), answers: Object.assign(new Array(7), { 0: 3, 1: 3, 2: 3, 3: 3 }) };
    const short = screening('gad7', 6, T3, [2, 2, 2]);
    expect(completedSeries([gad7(9, T1), partial, short], 'gad7').map((s) => s.total)).toEqual([9]);
  });

  it('leaves out a row whose date cannot be read', () => {
    const undated = { ...gad7(20, T2), takenAt: 'not a date' };
    expect(completedSeries([gad7(9, T1), undated], 'gad7').map((s) => s.total)).toEqual([9]);
  });

  it('is empty with nothing taken', () => {
    expect(completedSeries([], 'phq9')).toEqual([]);
  });
});

describe('latestChange', () => {
  it('compares the two most recent finished check-ins (demo step 4: GAD-7 9 to 14)', () => {
    const history = [gad7(9, T1), phq9(7, T1), gad7(14, T2)];
    const change = latestChange(history, 'gad7');
    expect(change).toMatchObject({ kind: 'reliable_deterioration', delta: 5 });
    expect(change?.from.total).toBe(9);
    expect(change?.to.total).toBe(14);
  });

  it('uses the last two of a longer series', () => {
    expect(latestChange([gad7(2, T1), gad7(14, T2), gad7(13, T3)], 'gad7')).toMatchObject({ kind: 'no_reliable_change', delta: -1 });
  });

  it('is null with fewer than two finished check-ins', () => {
    expect(latestChange([], 'gad7')).toBeNull();
    expect(latestChange([gad7(9, T1)], 'gad7')).toBeNull();
    expect(latestChange([gad7(9, T1), screening('gad7', 15, T2, [3, 3])], 'gad7')).toBeNull();
  });

  it('is null for an instrument with no threshold', () => {
    expect(latestChange([screening('who5', 40, T1), screening('who5', 80, T2)], 'who5')).toBeNull();
  });
});
