import { describe, expect, it } from 'vitest';
import { evaluateCrisis, evaluateCrisisForAnswers, itemCount } from '../src';
import type { Instrument } from '@mawsool/types';

describe('PHQ-9 item 9', () => {
  it('does not fire on 0', () => {
    expect(evaluateCrisis({ instrument: 'phq9', itemNumber: 9, value: 0 })).toEqual({
      triggered: false,
      trigger: null,
      reason: 'no_trigger',
    });
  });

  it.each([1, 2, 3])('fires on %i', (value) => {
    expect(evaluateCrisis({ instrument: 'phq9', itemNumber: 9, value })).toEqual({
      triggered: true,
      trigger: 'phq9_item9',
      reason: 'item9_positive',
    });
  });

  it.each([4, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('fails safe and fires on invalid value %s', (value) => {
    expect(evaluateCrisis({ instrument: 'phq9', itemNumber: 9, value })).toEqual({
      triggered: true,
      trigger: 'phq9_item9',
      reason: 'invalid_answer',
    });
  });

  it('never fires on items 1 to 8, whatever the value', () => {
    for (let itemNumber = 1; itemNumber <= 8; itemNumber++) {
      for (const value of [0, 1, 2, 3]) {
        expect(evaluateCrisis({ instrument: 'phq9', itemNumber, value }).triggered).toBe(false);
      }
    }
  });

  it('does not treat a zero-based index 8 (item 9 less one) as item 9', () => {
    expect(evaluateCrisis({ instrument: 'phq9', itemNumber: 8, value: 3 }).triggered).toBe(false);
    expect(evaluateCrisis({ instrument: 'phq9', itemNumber: 10, value: 3 }).reason).toBe('not_a_trigger_item');
  });
});

describe('C-SSRS screener', () => {
  it.each([1, 2, 3, 4, 5, 6])('fires on yes for item %i', (itemNumber) => {
    expect(evaluateCrisis({ instrument: 'cssrs', itemNumber, value: 1 })).toEqual({
      triggered: true,
      trigger: 'cssrs',
      reason: 'cssrs_yes',
    });
  });

  it.each([1, 2, 3, 4, 5, 6])('does not fire on no for item %i', (itemNumber) => {
    expect(evaluateCrisis({ instrument: 'cssrs', itemNumber, value: 0 }).triggered).toBe(false);
  });

  it.each([2, -1, Number.NaN])('fails safe on invalid value %s', (value) => {
    expect(evaluateCrisis({ instrument: 'cssrs', itemNumber: 3, value })).toMatchObject({
      triggered: true,
      reason: 'invalid_answer',
    });
  });

  it('ignores item numbers that are not on the screener', () => {
    for (const itemNumber of [0, 7, 1.5, -1]) {
      expect(evaluateCrisis({ instrument: 'cssrs', itemNumber, value: 1 })).toMatchObject({
        triggered: false,
        reason: 'not_a_trigger_item',
      });
    }
  });
});

describe('instruments with no crisis trigger', () => {
  it.each(['who5', 'gad7'] as Instrument[])('%s never fires', (instrument) => {
    for (let itemNumber = 1; itemNumber <= itemCount(instrument); itemNumber++) {
      for (const value of [0, 1, 2, 3, 4, 5]) {
        expect(evaluateCrisis({ instrument, itemNumber, value }).triggered).toBe(false);
      }
    }
  });
});

describe('evaluateCrisisForAnswers', () => {
  it('returns the first trigger in a stored PHQ-9', () => {
    expect(evaluateCrisisForAnswers('phq9', [0, 0, 0, 0, 0, 0, 0, 0, 2])).toMatchObject({ triggered: true, trigger: 'phq9_item9' });
  });

  it('returns not triggered when nothing fires', () => {
    expect(evaluateCrisisForAnswers('phq9', [3, 3, 3, 3, 3, 3, 3, 3, 0])).toMatchObject({ triggered: false, reason: 'no_trigger' });
    expect(evaluateCrisisForAnswers('cssrs', [0, 0, 0, 0, 0, 0]).triggered).toBe(false);
    expect(evaluateCrisisForAnswers('cssrs', [0, 0, 0, 1, 0, 0])).toMatchObject({ triggered: true, trigger: 'cssrs' });
  });

  it('is not triggered by an empty answer list', () => {
    expect(evaluateCrisisForAnswers('phq9', []).triggered).toBe(false);
  });

  it('does not throw for a row that lost its answers altogether: a C-SSRS row fires as an invalid answer, the other instruments do not', () => {
    for (const lost of [null, undefined]) {
      expect(evaluateCrisisForAnswers('cssrs', lost)).toEqual({ triggered: true, trigger: 'cssrs', reason: 'invalid_answer' });
      for (const instrument of ['phq9', 'gad7', 'who5'] as const) expect(evaluateCrisisForAnswers(instrument, lost)).toMatchObject({ triggered: false, reason: 'no_trigger' });
    }
  });
});
