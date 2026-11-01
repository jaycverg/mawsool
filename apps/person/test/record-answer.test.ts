import { createTabFlag } from '@mawsool/ui';
import { describe, expect, it, vi } from 'vitest';
import { createCrisisStore } from '../lib/crisis';
import { recordAnswer, type RecordAnswerDeps } from '../lib/record-answer';
import { loadScreenings } from '../lib/screening-store';
import { fixtureClock, memoryStorage } from './helpers/memory';

function setup() {
  const memory = memoryStorage();
  const clock = fixtureClock();
  const deps = { now: clock.now, newId: clock.newId };
  const fallback = createTabFlag(undefined, 'crisis');
  const crisis = createCrisisStore(memory.storage, { ...deps, fallback, readPatienceMs: 20 });
  const base: RecordAnswerDeps = { storage: memory.storage, crisis, ...deps, locale: 'en', patienceMs: 20 };
  return { ...memory, crisis, base, fallback };
}

const ITEM9 = { instrument: 'phq9', index: 8, value: 1 } as const;

/** Answers every item above `before` with "no" or "not at all", so the next answer can follow them. */
async function earlierItems(base: RecordAnswerDeps, instrument: 'phq9' | 'cssrs', before: number) {
  for (let index = 0; index < before; index += 1) await recordAnswer({ instrument, index, value: 0 }, base);
}
const firstEight = (base: RecordAnswerDeps) => earlierItems(base, 'phq9', 8);

describe('recordAnswer', () => {
  it('saves an ordinary answer and carries on', async () => {
    const { base, storage } = setup();
    const outcome = await recordAnswer({ instrument: 'gad7', index: 0, value: 2 }, base);
    expect(outcome).toMatchObject({ kind: 'saved', screening: { answers: [2] } });
    expect((await loadScreenings(storage))[0]!.answers).toEqual([2]);
  });

  it('reports a failure when an ordinary answer cannot be saved', async () => {
    const { base, failures, crisis } = setup();
    failures.write = true;
    expect(await recordAnswer({ instrument: 'gad7', index: 0, value: 2 }, base)).toEqual({ kind: 'failed' });
    expect((await crisis.read()).status).toBe('clear');
  });

  it.each([
    ['PHQ-9 item 9 on "several days"', { instrument: 'phq9', index: 8, value: 1 } as const],
    ['PHQ-9 item 9 on "nearly every day"', { instrument: 'phq9', index: 8, value: 3 } as const],
    ['a C-SSRS yes', { instrument: 'cssrs', index: 2, value: 1 } as const],
  ])('takes the crisis path for %s: saves the answer, sets the block, opens one event', async (_name, answer) => {
    const { base, crisis } = setup();
    await earlierItems(base, answer.instrument, answer.index);
    const outcome = await recordAnswer(answer, base);
    expect(outcome).toMatchObject({ kind: 'crisis', blockSaved: true });
    const state = await crisis.read();
    expect(state.status).toBe('blocked');
    expect(state.record).toMatchObject({ trigger: answer.instrument === 'phq9' ? 'phq9_item9' : 'cssrs' });
    if (outcome.kind === 'crisis') expect(state.record!.resumeScreeningId).toBe(outcome.screening!.id);
  });

  it('does not take the crisis path for item 9 on "not at all", or for any other item', async () => {
    const { base, crisis } = setup();
    await firstEight(base);
    expect((await recordAnswer({ instrument: 'phq9', index: 8, value: 0 }, base)).kind).toBe('saved');
    expect((await crisis.read()).status).toBe('clear');
  });

  it('still takes the crisis path when the answer cannot be saved at all', async () => {
    const { base, failures, crisis } = setup();
    await firstEight(base);
    failures.write = true;
    const outcome = await recordAnswer(ITEM9, base);
    expect(outcome).toEqual({ kind: 'crisis', screening: null, blockSaved: false });
    // The block is held in memory for this page-load even though storage refused it.
    expect((await crisis.read()).status).toBe('blocked');
  });

  it('sets the tab flag before it touches storage at all', async () => {
    const { base, storage, fallback } = setup();
    await firstEight(base);
    let seenWhenStorageFirstRead: boolean | null = null;
    const realGet = storage.get.bind(storage);
    storage.get = (async (key: string) => {
      seenWhenStorageFirstRead ??= fallback.get();
      return realGet(key);
    }) as typeof storage.get;
    const pending = recordAnswer(ITEM9, base);
    expect(fallback.get()).toBe(true); // synchronously, before the first await settles
    await pending;
    expect(seenWhenStorageFirstRead).toBe(true);
  });

  it('still takes the crisis path when storage hangs, after its patience runs out', async () => {
    const { base, storage, crisis, fallback } = setup();
    await firstEight(base);
    const never = new Promise<never>(() => undefined);
    storage.get = () => never;
    storage.set = () => never;
    const started = performance.now();
    const outcome = await recordAnswer(ITEM9, base);
    expect(outcome).toEqual({ kind: 'crisis', screening: null, blockSaved: false });
    expect(performance.now() - started).toBeLessThan(1000);
    // The block reads as blocked even though storage never answers, because the tab flag holds it.
    expect(fallback.get()).toBe(true);
    expect((await crisis.read()).status).toBe('blocked');
  });

  it('decides the trigger before it touches storage', async () => {
    const { base, storage } = setup();
    await firstEight(base);
    const order: string[] = [];
    const realGet = storage.get.bind(storage);
    storage.get = vi.fn(async (key: string) => {
      order.push(`get ${key}`);
      return realGet(key);
    }) as typeof storage.get;
    await recordAnswer(ITEM9, base);
    expect(order[0]).toBe('get screenings');
  });
});

describe('recordAnswer on a check-in that is already complete', () => {
  it('blocks when item 9 moves from 0 to 1 afterwards, and the stored row carries the new answer', async () => {
    const { base, crisis, storage } = setup();
    await firstEight(base);
    const first = await recordAnswer({ instrument: 'phq9', index: 8, value: 0 }, base);
    if (first.kind !== 'saved') throw new Error('expected a saved answer');
    expect((await crisis.read()).status).toBe('clear');

    const outcome = await recordAnswer({ instrument: 'phq9', index: 8, value: 1, screeningId: first.screening.id }, base);
    expect(outcome).toMatchObject({ kind: 'crisis', blockSaved: true, screening: { id: first.screening.id, item9Flag: true } });
    const rows = await loadScreenings(storage);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.answers[8]).toBe(1);
    expect((await crisis.read()).record).toMatchObject({ blocked: true, resumeScreeningId: first.screening.id });
  });

  it('saves a changed non-trigger answer on the finished check-in', async () => {
    const { base, storage } = setup();
    let last;
    for (let index = 0; index < 7; index += 1) last = await recordAnswer({ instrument: 'gad7', index, value: 1 }, base);
    if (last?.kind !== 'saved') throw new Error('expected saved');
    const changed = await recordAnswer({ instrument: 'gad7', index: 6, value: 3, screeningId: last.screening.id }, base);
    expect(changed).toMatchObject({ kind: 'saved', screening: { total: 9 } });
    expect(await loadScreenings(storage)).toHaveLength(1);
  });
});
