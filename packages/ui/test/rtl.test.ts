import { describe, expect, it } from 'vitest';
import { RTL_FLIP_CLASS, htmlAttributes, physicalSide, progressFillStyle } from '../src';

describe('rtl helpers', () => {
  it('sets lang and dir for the html element', () => {
    expect(htmlAttributes('ar')).toEqual({ lang: 'ar', dir: 'rtl' });
    expect(htmlAttributes('en')).toEqual({ lang: 'en', dir: 'ltr' });
  });

  it('maps logical sides to physical sides per direction', () => {
    expect(physicalSide('en', 'start')).toBe('left');
    expect(physicalSide('en', 'end')).toBe('right');
    expect(physicalSide('ar', 'start')).toBe('right');
    expect(physicalSide('ar', 'end')).toBe('left');
  });

  it('fills a progress bar by inline size so it mirrors by itself, and clamps', () => {
    expect(progressFillStyle(3 / 7)).toEqual({ inlineSize: '42.86%' });
    expect(progressFillStyle(-1)).toEqual({ inlineSize: '0%' });
    expect(progressFillStyle(2)).toEqual({ inlineSize: '100%' });
  });

  it('exposes the flip class the stylesheet defines', () => {
    expect(RTL_FLIP_CLASS).toBe('rtl-flip');
  });
});
