import { describe, expect, it } from 'vitest';
import {
  InvalidAnswersError,
  WHO5_FOLLOW_UP_MAX_SCORE,
  itemCount,
  offersFollowUp,
  scoreCssrs,
  scoreGad7,
  scoreInstrument,
  scorePhq9,
  scoreWho5,
  severityBand,
} from '../src';

/** Answers that sum to `total` using the fewest items at `max`, padded with zeros. */
function answersSummingTo(total: number, items: number, max: number): number[] {
  const out = Array.from({ length: items }, () => 0);
  let left = total;
  for (let i = 0; i < items && left > 0; i++) {
    const take = Math.min(max, left);
    out[i] = take;
    left -= take;
  }
  return out;
}

describe('PHQ-9 totals and bands', () => {
  const table: [number, string][] = [
    [0, 'minimal'],
    [4, 'minimal'],
    [5, 'mild'],
    [9, 'mild'],
    [10, 'moderate'],
    [14, 'moderate'],
    [15, 'moderately_severe'],
    [19, 'moderately_severe'],
    [20, 'severe'],
    [27, 'severe'],
  ];
  it.each(table)('total %i is %s', (total, band) => {
    const result = scorePhq9(answersSummingTo(total, 9, 3));
    expect(result.total).toBe(total);
    expect(result.band).toBe(band);
  });

  it('scores every total from 0 to 27 into exactly one band', () => {
    for (let total = 0; total <= 27; total++) {
      const result = scorePhq9(answersSummingTo(total, 9, 3));
      expect(result.total).toBe(total);
      expect(result.band).toBe(severityBand('phq9', total));
    }
  });

  it('flags item 9 when it is above zero and only then', () => {
    expect(scorePhq9([3, 3, 3, 3, 3, 3, 3, 3, 0]).item9Flag).toBe(false);
    expect(scorePhq9([0, 0, 0, 0, 0, 0, 0, 0, 1]).item9Flag).toBe(true);
    expect(scorePhq9([0, 0, 0, 0, 0, 0, 0, 0, 3]).item9Flag).toBe(true);
  });
});

describe('GAD-7 totals and bands', () => {
  const table: [number, string][] = [
    [0, 'minimal'],
    [4, 'minimal'],
    [5, 'mild'],
    [9, 'mild'],
    [10, 'moderate'],
    [14, 'moderate'],
    [15, 'severe'],
    [21, 'severe'],
  ];
  it.each(table)('total %i is %s', (total, band) => {
    const result = scoreGad7(answersSummingTo(total, 7, 3));
    expect(result.total).toBe(total);
    expect(result.band).toBe(band);
    expect(result.item9Flag).toBe(false);
  });
});

describe('WHO-5', () => {
  it('multiplies the raw total by 4 to give 0-100', () => {
    expect(scoreWho5([0, 0, 0, 0, 0]).total).toBe(0);
    expect(scoreWho5([5, 5, 5, 5, 5]).total).toBe(100);
    expect(scoreWho5([3, 2, 2, 2, 2]).total).toBe(44);
  });

  it('has no severity band', () => {
    expect(scoreWho5([1, 1, 1, 1, 1]).band).toBeNull();
  });

  it('offers the PHQ-9 and GAD-7 at 50 or below, not above', () => {
    expect(WHO5_FOLLOW_UP_MAX_SCORE).toBe(50);
    expect(offersFollowUp(44)).toBe(true);
    expect(offersFollowUp(50)).toBe(true);
    expect(offersFollowUp(52)).toBe(false);
    expect(offersFollowUp(100)).toBe(false);
  });
});

describe('C-SSRS screener', () => {
  it('is negative with no yes answers', () => {
    expect(scoreCssrs([0, 0, 0, 0, 0, 0])).toMatchObject({ total: 0, band: 'negative' });
  });

  it('is positive with any yes answer', () => {
    for (let i = 0; i < 6; i++) {
      const answers = [0, 0, 0, 0, 0, 0];
      answers[i] = 1;
      expect(scoreCssrs(answers)).toMatchObject({ total: 1, band: 'positive' });
    }
  });
});

describe('scoreInstrument', () => {
  it('routes each instrument to its scorer', () => {
    expect(scoreInstrument('who5', [5, 5, 5, 5, 5]).total).toBe(100);
    expect(scoreInstrument('phq9', Array(9).fill(1)).total).toBe(9);
    expect(scoreInstrument('gad7', Array(7).fill(1)).total).toBe(7);
    expect(scoreInstrument('cssrs', [1, 0, 0, 0, 0, 0]).band).toBe('positive');
  });

  it('knows item counts', () => {
    expect(['who5', 'phq9', 'gad7', 'cssrs'].map((i) => itemCount(i as 'who5'))).toEqual([5, 9, 7, 6]);
  });
});

describe('invalid answers are never scored', () => {
  it('rejects the wrong number of answers', () => {
    expect(() => scorePhq9([0, 0, 0])).toThrow(InvalidAnswersError);
    expect(() => scorePhq9(Array(10).fill(0))).toThrow(/needs 9 answers/);
    expect(() => scoreGad7([])).toThrow(InvalidAnswersError);
  });

  it('rejects out-of-range, negative, fractional and NaN answers', () => {
    expect(() => scorePhq9([0, 0, 0, 0, 0, 0, 0, 0, 4])).toThrow(/item 9/);
    expect(() => scorePhq9([-1, 0, 0, 0, 0, 0, 0, 0, 0])).toThrow(InvalidAnswersError);
    expect(() => scoreGad7([0, 0, 0, 0, 0, 0, 1.5])).toThrow(InvalidAnswersError);
    expect(() => scoreWho5([0, 0, 0, 0, Number.NaN])).toThrow(InvalidAnswersError);
    expect(() => scoreWho5([6, 0, 0, 0, 0])).toThrow(InvalidAnswersError);
    expect(() => scoreCssrs([2, 0, 0, 0, 0, 0])).toThrow(InvalidAnswersError);
  });

  it('rejects a total above the instrument maximum', () => {
    expect(() => severityBand('phq9', 28)).toThrow(InvalidAnswersError);
    expect(() => severityBand('gad7', 22)).toThrow(InvalidAnswersError);
  });

  it('names the error class', () => {
    expect(new InvalidAnswersError('x').name).toBe('InvalidAnswersError');
  });
});
