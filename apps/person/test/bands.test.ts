import { severityBand } from '@mawsool/instruments';
import { describe, expect, it } from 'vitest';
import { BAND_SEGMENTS, MAX_TOTAL, markerFraction } from '../lib/bands';

/** The segment a total falls in, reading the bar left to right as a person would: by counting score values. */
function segmentOf(instrument: 'phq9' | 'gad7', total: number): string {
  let start = 0;
  for (const segment of BAND_SEGMENTS[instrument]!) {
    if (total < start + segment.values) return segment.id;
    start += segment.values;
  }
  throw new Error(`total ${total} is past the end of the ${instrument} bar`);
}

describe.each(['phq9', 'gad7'] as const)('%s severity bar', (instrument) => {
  it('has one score value per segment slot, so the segments sum to the maximum total plus one', () => {
    const sum = BAND_SEGMENTS[instrument]!.reduce((total, segment) => total + segment.values, 0);
    expect(sum).toBe(MAX_TOTAL[instrument] + 1);
  });

  it('puts every total from 0 to the maximum in the segment of the band the scoring gives it', () => {
    for (let total = 0; total <= MAX_TOTAL[instrument]; total += 1) {
      expect(segmentOf(instrument, total), `total ${total}`).toBe(severityBand(instrument, total));
    }
  });

  it('puts the first and last total of every band in that band, and the one beside it in the next', () => {
    const segments = BAND_SEGMENTS[instrument]!;
    let start = 0;
    for (const [position, segment] of segments.entries()) {
      expect(segmentOf(instrument, start)).toBe(segment.id);
      expect(segmentOf(instrument, start + segment.values - 1)).toBe(segment.id);
      if (position < segments.length - 1) expect(segmentOf(instrument, start + segment.values)).toBe(segments[position + 1]!.id);
      start += segment.values;
    }
  });
});

describe('the severe GAD-7 band', () => {
  it('holds 15 to 21, seven values, so a total of 15 is inside it and not inside moderate', () => {
    expect(BAND_SEGMENTS.gad7!.find((segment) => segment.id === 'severe')!.values).toBe(7);
    expect(segmentOf('gad7', 15)).toBe('severe');
    expect(segmentOf('gad7', 14)).toBe('moderate');
  });
});

describe('markerFraction', () => {
  it('sits in the middle of the total\'s own slot and stays on the bar', () => {
    expect(markerFraction('gad7', 0)).toBeCloseTo(0.5 / 22);
    expect(markerFraction('gad7', 21)).toBeCloseTo(21.5 / 22);
    expect(markerFraction('phq9', 99)).toBe(1);
    expect(markerFraction('phq9', -3)).toBe(0);
  });
});
