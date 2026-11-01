import { CRISIS_NUMBERS_CONFIG } from '@mawsool/rules';
import { describe, expect, it } from 'vitest';
import { crisisLines, formatDialNumber } from '../lib/crisis-numbers';

describe('crisis numbers', () => {
  it('come from the config: the first is the large button, the rest are the emergency numbers in order', () => {
    expect(CRISIS_NUMBERS_CONFIG.map((entry) => entry.number)).toEqual(['800725462', '999', '998']);
    expect(crisisLines()).toEqual({ primary: '800725462', emergency: ['998', '999'] });
  });

  it('follow a changed config, so the screen never keeps its own copy', () => {
    expect(crisisLines([{ number: '999' }, { number: '998' }])).toEqual({ primary: '999', emergency: ['998'] });
  });

  it('refuse an empty config rather than show a screen with no numbers', () => {
    expect(() => crisisLines([])).toThrow('empty');
  });

  it('read the hotline as 800 725462 and leave short numbers alone', () => {
    expect(formatDialNumber('800725462')).toBe('800 725462');
    expect(formatDialNumber('999')).toBe('999');
  });
});
