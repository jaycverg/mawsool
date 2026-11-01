import { describe, expect, it } from 'vitest';
import {
  CRISIS_NUMBERS_CONFIG,
  HANDOFF_WINDOWS_DAYS,
  SUPPRESSION_THRESHOLD,
  DEPLOYMENT_TIME_ZONE,
  INSURANCE_TABLE_IS_SAMPLE,
  RELIABLE_CHANGE,
  STEP_ROWS,
} from '../src';

describe('config', () => {
  it('holds the spec thresholds', () => {
    expect(RELIABLE_CHANGE).toEqual({ phq9: 6, gad7: 4 });
    expect(DEPLOYMENT_TIME_ZONE).toBe('Asia/Dubai');
  });

  it('offers the hand-off windows the rows use and the fallback, and suppresses groups under ten', () => {
    expect(HANDOFF_WINDOWS_DAYS).toEqual([7, 14]);
    expect(SUPPRESSION_THRESHOLD).toBe(10);
  });

  it('lists the three crisis numbers with no last_verified date until someone confirms them', () => {
    expect(CRISIS_NUMBERS_CONFIG.map((n) => n.number)).toEqual(['800725462', '999', '998']);
    expect(CRISIS_NUMBERS_CONFIG.every((n) => n.last_verified === null)).toBe(true);
    expect(Object.fromEntries(CRISIS_NUMBERS_CONFIG.map((n) => [n.role, n.number]))).toEqual({ hotline: '800725462', police: '999', ambulance: '998' });
  });

  it('labels the insurance table as a sample', () => {
    expect(INSURANCE_TABLE_IS_SAMPLE).toBe(true);
  });

  it('keeps hand-off windows to the spec values: 14, 14, 7, 14 and none', () => {
    expect(STEP_ROWS.map((row) => row.handoffWindowDays)).toEqual([14, 14, 7, 14, null]);
    expect(STEP_ROWS.map((row) => row.recheckWeeks)).toEqual([6, 6, 6, 4, 4]);
  });
});
