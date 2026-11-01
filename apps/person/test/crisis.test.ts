import { hasUnresolvedCrisis, match, selectRow } from '@mawsool/rules';
import { CrisisEventSubmissionSchema, type Screening } from '@mawsool/types';
import { describe, expect, it } from 'vitest';
import { answerFiresCrisis, createCrisisStore } from '../lib/crisis';
import { pendingEvents } from '../lib/crisis-outbox';
import { loadScreenings, saveAnswer } from '../lib/screening-store';
import { fixtureClock, memoryStorage } from './helpers/memory';

function setup(initial: Record<string, unknown> = {}) {
  const memory = memoryStorage(initial);
  const clock = fixtureClock();
  const deps = { now: clock.now, newId: clock.newId };
  return { ...memory, clock, deps, crisis: createCrisisStore(memory.storage, deps) };
}

const RAISE = { trigger: 'phq9_item9', screeningId: '00000000-0000-4000-8000-0000000000aa', locale: 'en' } as const;

describe('answerFiresCrisis', () => {
  it('fires on PHQ-9 item 9 above zero and on any C-SSRS yes, and on nothing else', () => {
    expect(answerFiresCrisis('phq9', 8, 1)).toBe('phq9_item9');
    expect(answerFiresCrisis('phq9', 8, 3)).toBe('phq9_item9');
    expect(answerFiresCrisis('phq9', 8, 0)).toBeNull();
    expect(answerFiresCrisis('phq9', 7, 3)).toBeNull();
    expect(answerFiresCrisis('cssrs', 2, 1)).toBe('cssrs');
    expect(answerFiresCrisis('gad7', 8, 3)).toBeNull();
    expect(answerFiresCrisis('who5', 8, 5)).toBeNull();
  });
});

describe('the crisis block', () => {
  it('starts clear', async () => {
    const { crisis } = setup();
    expect((await crisis.read()).status).toBe('clear');
  });

  it('is set by a trigger, persists, and opens one event with no item answers and no person id', async () => {
    const { crisis, storage, deps } = setup();
    expect(await crisis.raise(RAISE)).toBe('saved');
    const reloaded = createCrisisStore(storage, deps); // a new page-load reads the same store
    const state = await reloaded.read();
    expect(state.status).toBe('blocked');
    expect(state.record).toMatchObject({ blocked: true, trigger: 'phq9_item9', resumeScreeningId: RAISE.screeningId });
    const event = state.record!.event!;
    expect(CrisisEventSubmissionSchema.safeParse(event).success).toBe(true);
    expect(Object.keys(event).sort()).toEqual(['callTapped', 'contactAt', 'contactSource', 'contextShared', 'humanContactConfirmed', 'id', 'locale', 'resolvedAt', 'shownAt', 'trigger']);
    expect(await pendingEvents(storage)).toEqual([event]);
  });

  it('keeps the open event when a second trigger arrives while blocked', async () => {
    const { crisis, storage } = setup();
    await crisis.raise(RAISE);
    const first = (await crisis.read()).record!.event!;
    await crisis.raise({ ...RAISE, trigger: 'cssrs' });
    expect((await crisis.read()).record!.event).toEqual(first);
    expect(await pendingEvents(storage)).toHaveLength(1);
  });

  it('"Call now" logs which number and leaves the block on', async () => {
    const { crisis, storage } = setup();
    await crisis.raise(RAISE);
    const record = await crisis.recordCall('800725462');
    expect(record).toMatchObject({ blocked: true, event: { callTapped: '800725462', humanContactConfirmed: false } });
    expect((await crisis.read()).status).toBe('blocked');
    expect((await pendingEvents(storage))[0]).toMatchObject({ callTapped: '800725462' });
  });

  it('records a reached contact as self-report with its time, and the block still stays on', async () => {
    const { crisis, clock } = setup();
    await crisis.raise(RAISE);
    clock.advance(4);
    const record = await crisis.confirmContact();
    expect(record!.event).toMatchObject({ humanContactConfirmed: true, contactSource: 'self_report', contactAt: clock.now().toISOString() });
    expect(record!.blocked).toBe(true);
    expect(CrisisEventSubmissionSchema.safeParse(record!.event).success).toBe(true);
  });

  it('records the contact once, the first time', async () => {
    const { crisis, clock } = setup();
    await crisis.raise(RAISE);
    const first = await crisis.confirmContact();
    clock.advance(10);
    const second = await crisis.confirmContact();
    expect(second).toBeNull();
    expect((await crisis.read()).record!.event!.contactAt).toBe(first!.event!.contactAt);
  });

  it('ignores a call tap or a contact answer when no crisis is open', async () => {
    const { crisis } = setup();
    expect(await crisis.recordCall('999')).toBeNull();
    expect(await crisis.confirmContact()).toBeNull();
    expect((await crisis.read()).status).toBe('clear');
  });

  it('is released by resolving, which records when and queues the resolution', async () => {
    const { crisis, storage, clock } = setup();
    await crisis.raise(RAISE);
    clock.advance(6);
    const result = await crisis.resolve();
    expect(result!.status).toBe('saved');
    const state = await crisis.read();
    expect(state.status).toBe('clear');
    expect(state.record).toMatchObject({ blocked: false, resolvedAt: clock.now().toISOString() });
    expect((await pendingEvents(storage))[0]).toMatchObject({ resolvedAt: clock.now().toISOString() });
  });

  it('can be resolved again without moving the recorded event time', async () => {
    const { crisis, clock } = setup();
    await crisis.raise(RAISE);
    clock.advance(1);
    const first = await crisis.resolve();
    clock.advance(5);
    const second = await crisis.resolve();
    expect(second!.record.event!.resolvedAt).toBe(first!.record.event!.resolvedAt);
    expect(second!.record.resolvedAt).not.toBe(first!.record.resolvedAt);
  });

  it('opens a new event for a new trigger after a resolution, and keeps the earlier resolution time until then', async () => {
    const { crisis, storage, clock } = setup();
    await crisis.raise(RAISE);
    clock.advance(2);
    await crisis.resolve();
    const resolvedAt = (await crisis.read()).record!.resolvedAt;
    clock.advance(60);
    await crisis.raise({ ...RAISE, screeningId: '00000000-0000-4000-8000-0000000000bb' });
    const state = await crisis.read();
    expect(state.status).toBe('blocked');
    expect(state.record!.resolvedAt).toBe(resolvedAt);
    expect(await pendingEvents(storage)).toHaveLength(2);
  });
});

describe('when storage misbehaves', () => {
  it('reads as unknown when the record cannot be read, so guards fail closed', async () => {
    const { crisis, failures } = setup();
    failures.read = true;
    expect(await crisis.read()).toEqual({ status: 'unknown', record: null });
  });

  it('reads as unknown when the stored record is not a crisis record', async () => {
    const { crisis } = setup({ 'crisis:block': 'garbage' });
    expect((await crisis.read()).status).toBe('unknown');
  });

  it('still blocks for this page-load when the write fails, and says so', async () => {
    const { crisis, failures } = setup();
    failures.write = true;
    expect(await crisis.raise(RAISE)).toBe('failed');
    failures.read = true; // even reading is down: the unsaved record is what this page-load knows
    expect((await crisis.read()).status).toBe('blocked');
  });

  it('lets the person resolve for this page-load when the write fails', async () => {
    const { crisis, failures } = setup();
    await crisis.raise(RAISE);
    failures.write = true;
    const result = await crisis.resolve();
    expect(result!.status).toBe('failed');
    expect((await crisis.read()).status).toBe('clear');
  });

  it('goes back to the stored record once a write succeeds again', async () => {
    const { crisis, failures } = setup();
    failures.write = true;
    await crisis.raise(RAISE);
    failures.write = false;
    await crisis.resolve();
    expect((await crisis.read()).status).toBe('clear');
  });

  it('still blocks when only the queue is unwritable', async () => {
    const { crisis, storage, data } = setup();
    const realSet = storage.set.bind(storage);
    storage.set = async (key, value) => {
      if (key === 'crisis:outbox') throw new Error('queue write failed');
      return realSet(key, value);
    };
    expect(await crisis.raise(RAISE)).toBe('saved');
    expect((await crisis.read()).status).toBe('blocked');
    expect(data.has('crisis:outbox')).toBe(false);
  });
});

describe('releasing the block lets matching run (the old item 9 answer does not fire again)', () => {
  async function checkInWithItem9(setupResult: ReturnType<typeof setup>) {
    const { storage, deps } = setupResult;
    let saved!: Screening;
    for (let index = 0; index < 9; index += 1) {
      saved = await saveAnswer(storage, { instrument: 'phq9', index, value: index === 8 ? 1 : 0 }, deps);
      setupResult.clock.advance(1);
    }
    return saved;
  }

  it('matches to the crisis option before the release and to real options after it', async () => {
    const ctx = setup();
    const saved = await checkInWithItem9(ctx);
    expect(saved.item9Flag).toBe(true);
    await ctx.crisis.raise({ trigger: 'phq9_item9', screeningId: saved.id, locale: 'en' });
    ctx.clock.advance(1);
    const screenings = await loadScreenings(ctx.storage);

    expect(hasUnresolvedCrisis(screenings, null)).toBe(true);
    await ctx.crisis.resolve();
    const { record } = await ctx.crisis.read();
    expect(hasUnresolvedCrisis(screenings, record!.resolvedAt)).toBe(false);
    const options = match(screenings, {}, 'not_sure', 'abu_dhabi_city', [], { crisisResolvedAt: record!.resolvedAt });
    expect(options.every((option) => option.kind !== 'crisis')).toBe(true);
    expect(selectRow(screenings).row.id).toBe('below_5');
  });

  it('still blocks a later check-in whose item 9 fires after the release', async () => {
    const ctx = setup();
    const first = await checkInWithItem9(ctx);
    await ctx.crisis.raise({ trigger: 'phq9_item9', screeningId: first.id, locale: 'en' });
    ctx.clock.advance(1);
    await ctx.crisis.resolve();
    ctx.clock.advance(60 * 24);
    const second = await checkInWithItem9(ctx);
    const { record } = await ctx.crisis.read();
    expect(hasUnresolvedCrisis(await loadScreenings(ctx.storage), record!.resolvedAt)).toBe(true);
    expect(second.id).not.toBe(first.id);
  });
});
