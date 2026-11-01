import { hasCompleteAnswers } from '@mawsool/instruments';
import { isCompleteScreening, selectRow } from '@mawsool/rules';
import { describe, expect, it } from 'vitest';
import { findDraft, loadScreenings, saveAnswer } from '../lib/screening-store';
import { fixtureClock, memoryStorage } from './helpers/memory';

const setup = () => {
  const clock = fixtureClock();
  return { ...memoryStorage(), clock, deps: { now: clock.now, newId: clock.newId } };
};

describe('saveAnswer', () => {
  it('opens a check-in on the first answer, stamped with the time it was started', async () => {
    const { storage, deps } = setup();
    const saved = await saveAnswer(storage, { instrument: 'gad7', index: 0, value: 2 }, deps);
    expect(saved).toMatchObject({ instrument: 'gad7', answers: [2], total: 2, band: null, item9Flag: false, takenAt: new Date('2026-11-01T08:00:00+04:00').toISOString() });
    expect(await loadScreenings(storage)).toEqual([saved]);
  });

  it('keeps one check-in in progress and never moves its start time', async () => {
    const { storage, deps, clock } = setup();
    const first = await saveAnswer(storage, { instrument: 'gad7', index: 0, value: 1 }, deps);
    clock.advance(30);
    const second = await saveAnswer(storage, { instrument: 'gad7', index: 1, value: 3 }, deps);
    expect(second.id).toBe(first.id);
    expect(second.takenAt).toBe(first.takenAt);
    expect(second.answers).toEqual([1, 3]);
    expect(await loadScreenings(storage)).toHaveLength(1);
  });

  it('lets an earlier answer be changed without losing the later ones', async () => {
    const { storage, deps } = setup();
    for (const [index, value] of [1, 2, 3].entries()) await saveAnswer(storage, { instrument: 'gad7', index, value }, deps);
    const changed = await saveAnswer(storage, { instrument: 'gad7', index: 0, value: 0 }, deps);
    expect(changed.answers).toEqual([0, 2, 3]);
  });

  it('never stores an empty slot: a question cannot be answered before the ones above it', async () => {
    const { storage, deps } = setup();
    await expect(saveAnswer(storage, { instrument: 'phq9', index: 3, value: 1 }, deps)).rejects.toThrow(RangeError);
    await saveAnswer(storage, { instrument: 'phq9', index: 0, value: 1 }, deps);
    await expect(saveAnswer(storage, { instrument: 'phq9', index: 2, value: 1 }, deps)).rejects.toThrow(RangeError);
    await expect(saveAnswer(storage, { instrument: 'phq9', index: -1, value: 1 }, deps)).rejects.toThrow(RangeError);
    await expect(saveAnswer(storage, { instrument: 'phq9', index: 9, value: 1 }, deps)).rejects.toThrow(RangeError);
    const [stored] = await loadScreenings(storage);
    expect(stored!.answers).toEqual([1]);
    expect(Object.keys(stored!.answers)).toEqual(['0']);
  });

  it('refuses an answer the instrument does not have', async () => {
    const { storage, deps } = setup();
    await expect(saveAnswer(storage, { instrument: 'phq9', index: 0, value: 4 }, deps)).rejects.toThrow('not an answer');
    await expect(saveAnswer(storage, { instrument: 'who5', index: 0, value: 6 }, deps)).rejects.toThrow(RangeError);
    await expect(saveAnswer(storage, { instrument: 'gad7', index: 0, value: 1.5 }, deps)).rejects.toThrow(RangeError);
    expect(await loadScreenings(storage)).toEqual([]);
  });

  it('completes on the last answer with total, band and the item 9 flag', async () => {
    const { storage, deps } = setup();
    let saved;
    for (let index = 0; index < 9; index += 1) saved = await saveAnswer(storage, { instrument: 'phq9', index, value: 1 }, deps);
    expect(saved).toMatchObject({ total: 9, band: 'mild', item9Flag: true });
    expect(hasCompleteAnswers('phq9', saved!.answers)).toBe(true);
    expect(findDraft(await loadScreenings(storage), 'phq9')).toBeUndefined();
  });

  it('scores the WHO-5 as raw times four', async () => {
    const { storage, deps } = setup();
    let saved;
    for (const [index, value] of [3, 2, 2, 2, 2].entries()) saved = await saveAnswer(storage, { instrument: 'who5', index, value }, deps);
    expect(saved).toMatchObject({ total: 44, band: null });
  });

  it('starts a fresh check-in after one is finished, leaving the finished one alone', async () => {
    const { storage, deps, clock } = setup();
    for (let index = 0; index < 7; index += 1) await saveAnswer(storage, { instrument: 'gad7', index, value: 1 }, deps);
    clock.advance(60 * 24 * 21);
    const next = await saveAnswer(storage, { instrument: 'gad7', index: 0, value: 2 }, deps);
    const all = await loadScreenings(storage);
    expect(all).toHaveLength(2);
    expect(all.filter(isCompleteScreening)).toHaveLength(1);
    expect(findDraft(all, 'gad7')?.id).toBe(next.id);
  });

  it('keeps a half-done check-in out of matching: the finished one still decides the row', async () => {
    const { storage, deps, clock } = setup();
    for (let index = 0; index < 7; index += 1) await saveAnswer(storage, { instrument: 'gad7', index, value: 1 }, deps); // total 7
    clock.advance(60 * 24 * 21);
    for (let index = 0; index < 5; index += 1) await saveAnswer(storage, { instrument: 'gad7', index, value: 3 }, deps); // 15 so far, unfinished
    const all = await loadScreenings(storage);
    expect(selectRow(all)).toMatchObject({ row: { id: 'self_help_or_community' }, gad7Total: 7 });
  });

  it('serialises quick taps so none is lost', async () => {
    const { storage, deps } = setup();
    await Promise.all([0, 1, 2, 3].map((index) => saveAnswer(storage, { instrument: 'gad7', index, value: index }, deps)));
    const stored = await loadScreenings(storage);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.answers).toEqual([0, 1, 2, 3]);
  });

  it('reads anything that is not a list of check-ins as none', async () => {
    const { storage, data } = setup();
    data.set('screenings', { not: 'a list' });
    expect(await loadScreenings(storage)).toEqual([]);
  });
});

describe('changing an answer after the check-in is complete', () => {
  async function finishedGad7(ctx = setup()) {
    let saved;
    for (let index = 0; index < 7; index += 1) saved = await saveAnswer(ctx.storage, { instrument: 'gad7', index, value: 1 }, ctx.deps);
    return { ...ctx, id: saved!.id };
  }

  it.each([
    ['the last', 6, 3, 9],
    ['a middle', 3, 3, 9],
    ['the first', 0, 0, 6],
  ])('rescores the same check-in when %s answer changes', async (_name, index, value, total) => {
    const { storage, deps, id } = await finishedGad7();
    const changed = await saveAnswer(storage, { instrument: 'gad7', index, value, screeningId: id }, deps);
    expect(changed).toMatchObject({ id, total, band: 'mild' });
    expect(changed.answers[index]).toBe(value);
    expect(await loadScreenings(storage)).toEqual([changed]);
  });

  it('moves the band when the total crosses one, and keeps the start time', async () => {
    const { storage, deps, id, clock } = await finishedGad7();
    const before = (await loadScreenings(storage))[0]!;
    clock.advance(60);
    for (let index = 0; index < 7; index += 1) await saveAnswer(storage, { instrument: 'gad7', index, value: 2, screeningId: id }, deps);
    const [after] = await loadScreenings(storage);
    expect(after).toMatchObject({ id, total: 14, band: 'moderate', takenAt: before.takenAt });
  });

  it('moves item 9 from 0 to 1 on a finished PHQ-9: the stored row carries it, flagged', async () => {
    const ctx = setup();
    let saved;
    for (let index = 0; index < 9; index += 1) saved = await saveAnswer(ctx.storage, { instrument: 'phq9', index, value: 0 }, ctx.deps);
    expect(saved).toMatchObject({ total: 0, item9Flag: false });
    const changed = await saveAnswer(ctx.storage, { instrument: 'phq9', index: 8, value: 1, screeningId: saved!.id }, ctx.deps);
    expect(changed).toMatchObject({ id: saved!.id, total: 1, item9Flag: true });
    expect((await loadScreenings(ctx.storage))[0]).toEqual(changed);
  });

  it('clears the flag when item 9 goes back to 0', async () => {
    const ctx = setup();
    let saved;
    for (let index = 0; index < 9; index += 1) saved = await saveAnswer(ctx.storage, { instrument: 'phq9', index, value: index === 8 ? 2 : 0 }, ctx.deps);
    const changed = await saveAnswer(ctx.storage, { instrument: 'phq9', index: 8, value: 0, screeningId: saved!.id }, ctx.deps);
    expect(changed).toMatchObject({ total: 0, item9Flag: false });
  });

  it('falls back to the check-in in progress when the id is unknown, and never opens a second one for a known id', async () => {
    const { storage, deps, id } = await finishedGad7();
    await saveAnswer(storage, { instrument: 'gad7', index: 0, value: 3, screeningId: id }, deps);
    expect(await loadScreenings(storage)).toHaveLength(1);
    const fresh = await saveAnswer(storage, { instrument: 'gad7', index: 0, value: 2, screeningId: '00000000-0000-4000-8000-0000000000ff' }, deps);
    expect(fresh.id).not.toBe(id);
    expect(await loadScreenings(storage)).toHaveLength(2);
  });
});
