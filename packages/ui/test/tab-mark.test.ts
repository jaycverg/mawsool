import { describe, expect, it } from 'vitest';
import { createTabMark } from '../src';

interface Mark {
  id: string;
}
const isMark = (value: unknown): value is Mark => typeof value === 'object' && value !== null && typeof (value as Mark).id === 'string';

function fakeSession(options: { throwOn?: 'get' | 'set' | 'remove' } = {}) {
  const data = new Map<string, string>();
  return {
    data,
    session: {
      getItem: (key: string) => {
        if (options.throwOn === 'get') throw new Error('blocked');
        return data.get(key) ?? null;
      },
      setItem: (key: string, value: string) => {
        if (options.throwOn === 'set') throw new Error('quota');
        data.set(key, value);
      },
      removeItem: (key: string) => {
        if (options.throwOn === 'remove') throw new Error('blocked');
        data.delete(key);
      },
    },
  };
}

describe('tab mark', () => {
  it('is null until set, readable at once when set, and null again when cleared', () => {
    const { session, data } = fakeSession();
    const mark = createTabMark(session, 'k', isMark);
    expect(mark.get()).toBeNull();
    mark.set({ id: 'a' });
    expect(mark.get()).toEqual({ id: 'a' });
    expect(data.get('k')).toBe('{"id":"a"}');
    mark.set(null);
    expect(mark.get()).toBeNull();
    expect(data.has('k')).toBe(false);
  });

  it('is read back by a new page-load in the same tab, which has no memory of it', () => {
    const { session } = fakeSession();
    createTabMark(session, 'k', isMark).set({ id: 'a' });
    expect(createTabMark(session, 'k', isMark).get()).toEqual({ id: 'a' });
  });

  it('reads anything that is not a valid mark, or not JSON, as no mark', () => {
    const { session, data } = fakeSession();
    data.set('k', '{"id":5}');
    expect(createTabMark(session, 'k', isMark).get()).toBeNull();
    data.set('k', 'not json');
    expect(createTabMark(session, 'k', isMark).get()).toBeNull();
    data.set('k', '1');
    expect(createTabMark(session, 'k', isMark).get()).toBeNull();
  });

  it('holds in memory when session storage refuses the write, and is still readable', () => {
    const mark = createTabMark(fakeSession({ throwOn: 'set' }).session, 'k', isMark);
    mark.set({ id: 'a' });
    expect(mark.get()).toEqual({ id: 'a' });
    mark.set(null);
    expect(mark.get()).toBeNull();
  });

  it('works with no session storage at all, and when reading it throws', () => {
    const mark = createTabMark(undefined, 'k', isMark);
    expect(mark.get()).toBeNull();
    mark.set({ id: 'a' });
    expect(mark.get()).toEqual({ id: 'a' });
    const unreadable = createTabMark(fakeSession({ throwOn: 'get' }).session, 'k', isMark);
    expect(unreadable.get()).toBeNull();
    unreadable.set({ id: 'b' });
    expect(unreadable.get()).toEqual({ id: 'b' });
  });

  it('stays on when the stored copy cannot be removed, failing safe', () => {
    const mark = createTabMark(fakeSession({ throwOn: 'remove' }).session, 'k', isMark);
    mark.set({ id: 'a' });
    mark.set(null);
    expect(mark.get()).toEqual({ id: 'a' }); // the stored copy could not be removed, so the mark stays: failing safe
  });
});
