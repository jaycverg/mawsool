import { hasUnresolvedCrisis, match, selectRow } from '@mawsool/rules';
import { CrisisEventSubmissionSchema, type Screening } from '@mawsool/types';
import { describe, expect, it } from 'vitest';
import { answerFiresCrisis, createCrisisStore, isBlocking, isCrisisMark, type CrisisMark } from '../lib/crisis';
import { pendingEvents } from '../lib/crisis-outbox';
import { loadScreenings, saveAnswer } from '../lib/screening-store';
import { createTabMark } from '@mawsool/ui';
import { fixtureClock, memoryStorage } from './helpers/memory';

function setup(initial: Record<string, unknown> = {}) {
  const memory = memoryStorage(initial);
  const clock = fixtureClock();
  // The same wiring as production: the tab's mark sits beside the store and outlives a "page-load" (a new store).
  const fallback = createTabMark<CrisisMark>(undefined, 'crisis', isCrisisMark);
  const deps = { now: clock.now, newId: clock.newId, fallback, readPatienceMs: 20 };
  return { ...memory, clock, deps, fallback, crisis: createCrisisStore(memory.storage, deps) };
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

describe('isBlocking', () => {
  it('keeps a guarded screen shut for a block that is on and for one that cannot be read, and opens it only for a clear record', async () => {
    const { crisis, failures } = setup();
    expect(isBlocking(await crisis.read())).toBe(false);
    await crisis.raise(RAISE);
    expect(isBlocking(await crisis.read())).toBe(true);
    await crisis.resolve();
    expect(isBlocking(await crisis.read())).toBe(false);
    failures.read = true;
    expect(isBlocking(await crisis.read())).toBe(true);
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

describe('Help now after a resolved crisis', () => {
  async function resolved() {
    const ctx = setup();
    await ctx.crisis.raise(RAISE);
    await ctx.crisis.recordCall('999');
    ctx.clock.advance(5);
    await ctx.crisis.resolve();
    const event = (await ctx.crisis.read()).record!.event;
    const queued = JSON.stringify(await pendingEvents(ctx.storage));
    return { ...ctx, event, queued };
  }

  it('does not change the event or touch the outbox when a number is tapped or contact is claimed', async () => {
    const { crisis, storage, event, queued, clock } = await resolved();
    clock.advance(30);
    expect(await crisis.recordCall('800725462')).toBeNull();
    expect(await crisis.confirmContact()).toBeNull();
    expect((await crisis.read()).record!.event).toEqual(event);
    expect(event).toMatchObject({ callTapped: '999', humanContactConfirmed: false });
    expect(JSON.stringify(await pendingEvents(storage))).toBe(queued);
  });

  it('forgets which check-in the resolved crisis belonged to', async () => {
    const { crisis } = await resolved();
    expect((await crisis.read()).record).toMatchObject({ blocked: false, resumeScreeningId: null });
  });

  it('queues nothing when it is resolved again with the event unchanged, and can still be resolved from a clear state', async () => {
    const { crisis, storage, queued, clock } = await resolved();
    clock.advance(10);
    const again = await crisis.resolve();
    expect(again!.record.blocked).toBe(false);
    expect(JSON.stringify(await pendingEvents(storage))).toBe(queued);
    const fresh = setup();
    expect((await fresh.crisis.resolve())!.record).toMatchObject({ blocked: false, event: null });
  });
});

describe('the tab mark, when storage cannot be trusted', () => {
  function hung() {
    const ctx = setup();
    const never = new Promise<never>(() => undefined);
    return { ...ctx, hang: () => { ctx.storage.get = () => never; ctx.storage.set = () => never; } };
  }

  it('is set synchronously by raise, before the store lock and before any storage call', () => {
    const { crisis, fallback, hang } = hung();
    hang();
    void crisis.raise(RAISE);
    expect(fallback.get()).toMatchObject({ trigger: 'phq9_item9' });
  });

  it('is set by markBlocked with nothing else, and holds the trigger, one event id and the time, and no answers', () => {
    const { crisis, fallback, clock } = hung();
    crisis.markBlocked('cssrs');
    const mark = fallback.get()!;
    expect(Object.keys(mark).sort()).toEqual(['eventId', 'shownAt', 'trigger']);
    expect(mark).toMatchObject({ trigger: 'cssrs', shownAt: clock.now().toISOString() });
    crisis.markBlocked('phq9_item9'); // a second trigger in the same crisis keeps the first mark and its id
    expect(fallback.get()).toEqual(mark);
  });

  it('reads as blocked, in time, when storage hangs', async () => {
    const { crisis, hang } = hung();
    hang();
    void crisis.raise(RAISE);
    const started = performance.now();
    expect((await crisis.read()).status).toBe('blocked');
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('reads as blocked when storage says clear, and as blocked when it refuses, while the mark is on', async () => {
    const { crisis, failures, crisis: store } = hung();
    store.markBlocked('phq9_item9');
    expect((await crisis.read()).status).toBe('blocked');
    failures.read = true;
    expect((await crisis.read()).status).toBe('blocked');
  });

  it('shows no event for a stored clear record, and keeps its resolution time', async () => {
    const { crisis } = hung();
    await crisis.raise(RAISE);
    await crisis.resolve();
    const resolvedAt = (await crisis.read()).record!.resolvedAt;
    crisis.markBlocked('phq9_item9');
    const state = await crisis.read();
    expect(state.status).toBe('blocked');
    expect(state.record).toMatchObject({ blocked: true, event: null, resolvedAt });
  });

  it('keeps the open event when storage can still be read', async () => {
    const { crisis } = hung();
    await crisis.raise(RAISE);
    const state = await crisis.read();
    expect(state.status).toBe('blocked');
    expect(state.record!.event).not.toBeNull();
  });

  it('is cleared by resolve at once, without waiting for storage, so a hung store cannot keep the person here', async () => {
    const { crisis, fallback, hang } = hung();
    await crisis.raise(RAISE);
    hang();
    void crisis.resolve();
    expect(fallback.get()).toBeNull();
  });
});

/** A store whose reads take `ms`, as a slow disk or a busy tab does. */
function slow(ctx: ReturnType<typeof setup>, ms = 350) {
  const realGet = ctx.storage.get.bind(ctx.storage);
  ctx.storage.get = (async (key: string) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return realGet(key);
  }) as typeof ctx.storage.get;
}

describe('a slow read never makes up a record for a change', () => {
  it('logs the call and the contact on the real event, although a read takes longer than the guard patience', async () => {
    const ctx = setup();
    await ctx.crisis.raise(RAISE);
    slow(ctx);
    const called = await ctx.crisis.recordCall('999');
    expect(called).toMatchObject({ blocked: true, event: { callTapped: '999' } });
    const contact = await ctx.crisis.confirmContact();
    expect(contact?.event).toMatchObject({ callTapped: '999', humanContactConfirmed: true, contactSource: 'self_report' });
    expect((await pendingEvents(ctx.storage))[0]).toMatchObject({ callTapped: '999', humanContactConfirmed: true });
  });

  it('keeps resolvedAt, and replaces the old event, when a second crisis opens on a slow read', async () => {
    const ctx = setup();
    await ctx.crisis.raise(RAISE);
    ctx.clock.advance(5);
    await ctx.crisis.resolve();
    const first = (await ctx.crisis.read()).record!;
    ctx.clock.advance(60);
    slow(ctx);
    await ctx.crisis.raise({ ...RAISE, screeningId: '00000000-0000-4000-8000-0000000000bb' });
    const second = ctx.data.get('crisis:block') as typeof first; // the stored record, not the guard's quick read
    expect(second.resolvedAt).toBe(first.resolvedAt);
    expect(second.resolvedAt).not.toBeNull();
    expect(second.event!.id).not.toBe(first.event!.id);
    expect(second.event!.resolvedAt).toBeNull();
  });

  it('does not touch the old event of a stored clear record when only the mark is on', async () => {
    const ctx = setup();
    await ctx.crisis.raise(RAISE);
    await ctx.crisis.recordCall('998');
    await ctx.crisis.resolve();
    const stored = JSON.stringify((await ctx.crisis.read()).record!.event);
    ctx.crisis.markBlocked('phq9_item9');
    slow(ctx);
    expect(await ctx.crisis.recordCall('999')).toBeNull();
    expect(await ctx.crisis.confirmContact()).toBeNull();
    expect(JSON.stringify(ctx.data.get('crisis:block') && (ctx.data.get('crisis:block') as { event: unknown }).event)).toBe(stored);
  });
});

describe('repair after a failed trigger write', () => {
  /** A crisis whose block write was refused, then a fresh "page-load": a new store over the same storage and tab mark. */
  async function refusedThenFresh() {
    const ctx = setup();
    ctx.failures.write = true;
    expect(await ctx.crisis.raise(RAISE)).toBe('failed');
    ctx.failures.write = false;
    return { ...ctx, fresh: createCrisisStore(ctx.storage, ctx.deps) };
  }

  it('makes the stored block and exactly one event, with the id and trigger the tab held', async () => {
    const { fresh, storage, fallback, data } = await refusedThenFresh();
    expect(data.has('crisis:block')).toBe(false);
    expect(await pendingEvents(storage)).toEqual([]);
    const held = fallback.get()!;
    expect(await fresh.repair('ar')).toBe('repaired');
    const stored = data.get('crisis:block') as { blocked: boolean; trigger: string; event: { id: string; trigger: string; locale: string; shownAt: string } };
    expect(stored).toMatchObject({ blocked: true, trigger: held.trigger, event: { id: held.eventId, trigger: held.trigger, locale: 'ar', shownAt: held.shownAt } });
    const queued = await pendingEvents(storage);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toEqual(stored.event);
    expect(Object.keys(queued[0]!).filter((key) => /answer|person|item|note/i.test(key))).toEqual([]);
  });

  it('is idempotent: a second run, and a run at the same time, add nothing', async () => {
    const { fresh, storage } = await refusedThenFresh();
    const outcomes = await Promise.all([fresh.repair('en'), fresh.repair('en')]);
    expect(outcomes.filter((outcome) => outcome === 'repaired')).toHaveLength(1);
    expect(await pendingEvents(storage)).toHaveLength(1);
    expect(await fresh.repair('en')).toBe('nothing');
    expect(await pendingEvents(storage)).toHaveLength(1);
  });

  it('gives one event when two page-loads repair at the same time', async () => {
    const { fresh, storage, deps, data } = await refusedThenFresh();
    const other = createCrisisStore(storage, deps);
    const [a, b] = await Promise.all([fresh.repair('en'), other.repair('en')]);
    expect([a, b].filter((outcome) => outcome === 'repaired').length).toBeGreaterThanOrEqual(1);
    expect(await pendingEvents(storage)).toHaveLength(1);
    expect((data.get('crisis:block') as { event: { id: string } }).event.id).toBe(deps.fallback.get()!.eventId);
  });

  it('adds nothing when the original raise did complete', async () => {
    const ctx = setup();
    await ctx.crisis.raise(RAISE);
    const before = JSON.stringify(ctx.data.get('crisis:block'));
    const queued = JSON.stringify(await pendingEvents(ctx.storage));
    expect(await createCrisisStore(ctx.storage, ctx.deps).repair('en')).toBe('nothing');
    expect(JSON.stringify(ctx.data.get('crisis:block'))).toBe(before);
    expect(JSON.stringify(await pendingEvents(ctx.storage))).toBe(queued);
  });

  it('does nothing once the crisis is resolved, which clears the mark', async () => {
    const { fresh, storage, data } = await refusedThenFresh();
    await fresh.resolve();
    expect(await fresh.repair('en')).toBe('nothing');
    expect(await pendingEvents(storage)).toEqual([]);
    expect((data.get('crisis:block') as { blocked: boolean; event: unknown }).blocked).toBe(false);
    expect((data.get('crisis:block') as { event: unknown }).event).toBeNull();
  });

  it('does nothing when no crisis is open', async () => {
    const { crisis, data } = setup();
    expect(await crisis.repair('en')).toBe('nothing');
    expect(data.has('crisis:block')).toBe(false);
  });

  it('is not undone by a raise that finishes after it: same event, and it learns which check-in it belongs to', async () => {
    const ctx = setup();
    ctx.crisis.markBlocked('phq9_item9'); // the answer was decided; the raise has not run yet
    const lateRaise = createCrisisStore(ctx.storage, ctx.deps);
    expect(await createCrisisStore(ctx.storage, ctx.deps).repair('en')).toBe('repaired');
    await lateRaise.raise(RAISE);
    expect(await pendingEvents(ctx.storage)).toHaveLength(1);
    const stored = ctx.data.get('crisis:block') as { resumeScreeningId: string; event: { id: string } };
    expect(stored.event.id).toBe(ctx.fallback.get()!.eventId);
    expect(stored.resumeScreeningId).toBe(RAISE.screeningId);
  });

  it('does not reopen a crisis that was resolved before a stuck raise got its turn', async () => {
    const ctx = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { withStoreLock } = await import('../lib/lock');
    void withStoreLock(ctx.storage, () => gate); // something holds the store
    const raising = ctx.crisis.raise(RAISE);
    const resolving = ctx.crisis.resolve(); // clears the mark at once
    release();
    await Promise.all([raising, resolving]);
    expect((ctx.data.get('crisis:block') as { blocked: boolean; event: unknown }).blocked).toBe(false);
    expect(await pendingEvents(ctx.storage)).toEqual([]);
  });

  it('writes an unsaved block again when storage has come back, once, with no second event', async () => {
    const ctx = setup();
    ctx.failures.write = true;
    await ctx.crisis.raise(RAISE); // refused: held in memory only
    ctx.failures.write = false;
    expect(await ctx.crisis.repair('en')).toBe('repaired');
    expect(ctx.data.has('crisis:block')).toBe(true);
    expect(await ctx.crisis.repair('en')).toBe('nothing');
    expect(await pendingEvents(ctx.storage)).toHaveLength(1);
  });

  it('opens a new event for a new crisis after a resolution, with a new id', async () => {
    const ctx = setup();
    await ctx.crisis.raise(RAISE);
    const first = ctx.data.get('crisis:block') as { event: { id: string } };
    await ctx.crisis.resolve();
    ctx.crisis.markBlocked('phq9_item9');
    expect(await ctx.crisis.repair('en')).toBe('repaired');
    expect((ctx.data.get('crisis:block') as { event: { id: string } }).event.id).not.toBe(first.event.id);
  });
});
