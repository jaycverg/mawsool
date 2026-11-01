import { describe, expect, it } from 'vitest';
import { createTabFlag } from '../src';

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

describe('tab flag', () => {
  it('is off until set, on at once when set, and off again when cleared', () => {
    const { session, data } = fakeSession();
    const flag = createTabFlag(session, 'k');
    expect(flag.get()).toBe(false);
    flag.set(true);
    expect(flag.get()).toBe(true);
    expect(data.get('k')).toBe('1');
    flag.set(false);
    expect(flag.get()).toBe(false);
    expect(data.has('k')).toBe(false);
  });

  it('is read back by a new page-load in the same tab, which has no memory of it', () => {
    const { session } = fakeSession();
    createTabFlag(session, 'k').set(true);
    expect(createTabFlag(session, 'k').get()).toBe(true);
  });

  it('holds in memory when session storage refuses the write, and is still readable', () => {
    const flag = createTabFlag(fakeSession({ throwOn: 'set' }).session, 'k');
    flag.set(true);
    expect(flag.get()).toBe(true);
    flag.set(false);
    expect(flag.get()).toBe(false);
  });

  it('works with no session storage at all, and when reading it throws', () => {
    const flag = createTabFlag(undefined, 'k');
    expect(flag.get()).toBe(false);
    flag.set(true);
    expect(flag.get()).toBe(true);
    const unreadable = createTabFlag(fakeSession({ throwOn: 'get' }).session, 'k');
    expect(unreadable.get()).toBe(false);
    unreadable.set(true);
    expect(unreadable.get()).toBe(true);
  });

  it('stays on when the stored copy cannot be removed, failing safe', () => {
    const flag = createTabFlag(fakeSession({ throwOn: 'remove' }).session, 'k');
    flag.set(true);
    flag.set(false);
    expect(flag.get()).toBe(true); // the stored copy could not be removed, so it stays on: failing safe
  });
});
