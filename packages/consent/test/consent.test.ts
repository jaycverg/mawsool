import type { BundleContent, ConsentElement } from '@mawsool/types';
import { describe, expect, it } from 'vitest';
import { OPTIONAL_ELEMENTS, REQUIRED_ELEMENT, includesRequired, notShared, redact, withinWordLimit, withoutElement, wordCount } from '../src';

const FULL: BundleContent = {
  scores: [{ instrument: 'phq9', total: 12, band: 'moderate', takenAt: '2026-10-29T08:00:00+04:00' }],
  trajectory: [{ instrument: 'phq9', total: 7, band: 'mild', takenAt: '2026-10-08T08:00:00+04:00' }],
  free_text: 'I have trouble sleeping',
  conditions: ['type 2 diabetes'],
  preferences: { language: 'ar', modality: 'in_person' },
};

describe('elements', () => {
  it('requires the ticket element and offers the other five, none of them required', () => {
    expect(REQUIRED_ELEMENT).toBe('ticket');
    expect(OPTIONAL_ELEMENTS).toEqual(['scores', 'trajectory', 'free_text', 'conditions', 'preferences']);
    expect(includesRequired(['ticket', 'scores'])).toBe(true);
    expect(includesRequired(['scores'])).toBe(false);
  });
});

describe('redact', () => {
  it('keeps nothing when only the ticket element is granted', () => {
    expect(redact(FULL, ['ticket'])).toEqual({});
  });

  it('keeps exactly the granted elements, each as supplied', () => {
    for (const element of OPTIONAL_ELEMENTS) {
      expect(redact(FULL, ['ticket', element])).toEqual({ [element]: FULL[element as keyof BundleContent] });
    }
    expect(Object.keys(redact(FULL, ['ticket', 'scores', 'conditions'])).sort()).toEqual(['conditions', 'scores']);
  });

  it('keeps an empty note as an empty note, and skips an element the content lacks', () => {
    expect(redact({ free_text: '' }, ['free_text', 'scores'])).toEqual({ free_text: '' });
  });

  it('does not mutate its input', () => {
    const copy = structuredClone(FULL);
    redact(FULL, ['scores']);
    expect(FULL).toEqual(copy);
  });
});

describe('notShared and withoutElement', () => {
  it('lists the optional elements that were not granted', () => {
    expect(notShared(['ticket', 'scores', 'free_text'])).toEqual(['trajectory', 'conditions', 'preferences']);
    expect(notShared(['ticket'])).toEqual(OPTIONAL_ELEMENTS);
  });

  it('removes one element and leaves the rest', () => {
    const rest = withoutElement(FULL, 'free_text' satisfies ConsentElement);
    expect(Object.keys(rest).sort()).toEqual(['conditions', 'preferences', 'scores', 'trajectory']);
  });
});

describe('summary word limit', () => {
  it('counts words by runs of non-space characters', () => {
    expect(wordCount('')).toBe(0);
    expect(wordCount('   ')).toBe(0);
    expect(wordCount(' one  two\nthree ')).toBe(3);
  });

  it('allows exactly 120 words and refuses 121', () => {
    expect(withinWordLimit(Array(120).fill('w').join(' '))).toBe(true);
    expect(withinWordLimit(Array(121).fill('w').join(' '))).toBe(false);
  });
});
