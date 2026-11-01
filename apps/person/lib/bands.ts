import type { Instrument } from '@mawsool/types';

export interface BandSegment {
  id: string;
  /** Number of score values in the band, which sets the segment's width. */
  values: number;
  /** Fill colour. The boards' own greens and ambers where they exist; the plan's danger red for the top PHQ-9 band. */
  color: string;
}

/** Bands from lowest to highest, with widths in score values. Colours are the Result board's. */
export const BAND_SEGMENTS: Partial<Record<Instrument, BandSegment[]>> = {
  phq9: [
    { id: 'minimal', values: 5, color: '#E0F0EC' },
    { id: 'mild', values: 5, color: '#A9D4CA' },
    { id: 'moderate', values: 5, color: '#E8B46A' },
    { id: 'moderately_severe', values: 5, color: '#B3621B' },
    { id: 'severe', values: 8, color: '#A61B1B' },
  ],
  gad7: [
    { id: 'minimal', values: 5, color: '#E0F0EC' },
    { id: 'mild', values: 5, color: '#A9D4CA' },
    { id: 'moderate', values: 5, color: '#E8B46A' },
    { id: 'severe', values: 7, color: '#B3621B' },
  ],
};

/** Highest possible total of each instrument's 0-100 or 0-n scale. */
export const MAX_TOTAL: Record<Instrument, number> = { who5: 100, phq9: 27, gad7: 21, cssrs: 6 };

/** Where a total sits along its bar, as a fraction from the start edge: the middle of its own score slot. */
export function markerFraction(instrument: Instrument, total: number): number {
  const max = MAX_TOTAL[instrument];
  return Math.min(1, Math.max(0, (total + 0.5) / (max + 1)));
}

/** Short instrument name as printed on the forms. The names are not translated. */
export const INSTRUMENT_TAG: Record<Instrument, string> = { who5: 'WHO-5', phq9: 'PHQ-9', gad7: 'GAD-7', cssrs: 'C-SSRS' };
