import { evaluateCrisis } from '@mawsool/instruments';
import { CrisisEventSubmissionSchema, CrisisTriggerSchema, type CrisisEventSubmission, type CrisisNumber, type CrisisTrigger, type Instrument, type Locale } from '@mawsool/types';
import type { StorageAdapter, TabMarkAdapter } from '@mawsool/ui';
import type { NewId, Now } from './clock';
import { enqueueEventLocked } from './crisis-outbox';
import { KEYS } from './keys';
import { withStoreLock } from './lock';
import { within } from './within';

/**
 * What the device remembers about a crisis trigger. `blocked` is the persisted crisis-block flag: while it is true
 * no matching or ticket screen opens. `resolvedAt` is the last time the person resolved the crisis screen, which
 * `match()` needs so an old item 9 answer does not fire again.
 */
export interface CrisisRecord {
  blocked: boolean;
  trigger: CrisisTrigger | null;
  blockedAt: string | null;
  resolvedAt: string | null;
  /** The check-in that fired the trigger, so resolving can carry on to its result. */
  resumeScreeningId: string | null;
  /** The event as last queued for the server. It holds no item answers and no person id. */
  event: CrisisEventSubmission | null;
}

export type BlockState =
  | { status: 'blocked' | 'clear'; record: CrisisRecord }
  /** The record could not be read. Guards treat this as blocked: failing safe means showing help. */
  | { status: 'unknown'; record: null };

/**
 * Whether a guarded screen must stay shut. Only a record that was read and says "clear" opens it: a block that is
 * on, and a record that could not be read or is not a crisis record, both keep it shut.
 */
export function isBlocking(state: BlockState): boolean {
  return state.status !== 'clear';
}

export const CLEAR_RECORD: CrisisRecord = { blocked: false, trigger: null, blockedAt: null, resolvedAt: null, resumeScreeningId: null, event: null };

/** A write that reached storage is `saved`; one that did not is `failed`, and the change then lives in memory only. */
export type WriteStatus = 'saved' | 'failed';

/**
 * What the tab holds about an open crisis, so that a store which refused or hung when the trigger was answered can
 * be repaired later: which trigger it was, the id of the one event this crisis will have, and when it was shown.
 * Each is a field a crisis event already holds. It never holds an item answer, a score or a person id.
 */
export interface CrisisMark {
  trigger: CrisisTrigger;
  eventId: string;
  shownAt: string;
}

export function isCrisisMark(value: unknown): value is CrisisMark {
  const candidate = value as Partial<CrisisMark> | null;
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    CrisisTriggerSchema.safeParse(candidate.trigger).success &&
    typeof candidate.eventId === 'string' &&
    candidate.eventId.length > 0 &&
    typeof candidate.shownAt === 'string' &&
    !Number.isNaN(Date.parse(candidate.shownAt))
  );
}

export interface CrisisDeps {
  now: Now;
  newId: NewId;
  /**
   * The tab's synchronous copy of "a crisis is open". It is set before any storage call, and cleared at the start of
   * a resolution, so a store that refuses or hangs cannot lose the block, and it survives a page navigation in the
   * tab. It holds the event id too, so every writer and the repair open the same single event.
   */
  fallback: TabMarkAdapter<CrisisMark>;
  /** How long a read waits on storage when only the tab mark knows about the block. Reads for a change never use it. */
  readPatienceMs?: number;
}

function isRecord(value: unknown): value is CrisisRecord {
  const candidate = value as Partial<CrisisRecord> | null;
  return typeof candidate === 'object' && candidate !== null && typeof candidate.blocked === 'boolean';
}

/** Whether a trigger answer fires the crisis path. Item numbers are 1-based, as printed. */
export function answerFiresCrisis(instrument: Instrument, index: number, value: number): CrisisTrigger | null {
  const result = evaluateCrisis({ instrument, itemNumber: index + 1, value });
  return result.triggered ? result.trigger : null;
}

/**
 * The persisted crisis state, behind one object so every screen shares it. Reads fail closed. If storage cannot be
 * written, the change is kept in memory so the person can still continue in this page-load, and the result says
 * `failed`; a hard reload then falls back to what storage holds.
 */
export function createCrisisStore(storage: StorageAdapter, deps: CrisisDeps) {
  /** The newest record that storage refused to take, kept so this page-load still behaves as if it was saved. */
  let unsaved: CrisisRecord | null = null;

  /**
   * The state for a screen or a guard, which must answer in good time. With the tab mark on it is blocked whatever
   * storage says or fails to say; storage is asked only for the open event, and only briefly. A stored record that
   * is clear shows no event: an old resolved one is not this crisis's.
   */
  async function read(): Promise<BlockState> {
    if (unsaved) return { status: unsaved.blocked ? 'blocked' : 'clear', record: unsaved };
    if (deps.fallback.get()) {
      const stored = await within(readStored(), deps.readPatienceMs ?? 300, null);
      if (stored?.status === 'blocked') return stored;
      return { status: 'blocked', record: { ...(stored?.record ?? CLEAR_RECORD), blocked: true, event: null } };
    }
    return readStored();
  }

  /** The record a change starts from: the real stored one, however long the read takes. A guard's patience is not used here. */
  async function readForUpdate(): Promise<CrisisRecord> {
    if (unsaved) return unsaved;
    const stored = await readStored();
    return stored.record ?? { ...CLEAR_RECORD, blocked: true };
  }

  async function readStored(): Promise<BlockState> {
    try {
      const stored = await storage.get<unknown>(KEYS.crisisBlock);
      if (stored === undefined) return { status: 'clear', record: CLEAR_RECORD };
      if (!isRecord(stored)) return { status: 'unknown', record: null };
      return { status: stored.blocked ? 'blocked' : 'clear', record: stored };
    } catch {
      return { status: 'unknown', record: null };
    }
  }

  async function write(record: CrisisRecord): Promise<WriteStatus> {
    try {
      await storage.set(KEYS.crisisBlock, record);
      unsaved = null;
      return 'saved';
    } catch {
      unsaved = record;
      return 'failed';
    }
  }

  /** Queues the event snapshot for the server; only called while the store lock is held. A queue failure never stops the crisis screen. */
  async function queue(event: CrisisEventSubmission): Promise<void> {
    try {
      await enqueueEventLocked(storage, event);
    } catch {
      // The event stays in the crisis record; the next change queues it again.
    }
  }

  /** Reads, changes and writes the record under the store lock, then queues the event it carries. */
  function update(change: (current: CrisisRecord) => CrisisRecord | null): Promise<{ record: CrisisRecord; status: WriteStatus } | null> {
    return withStoreLock(storage, async () => {
      const current = await readForUpdate();
      const next = change(current);
      if (!next) return null;
      const retrying = current === unsaved; // the last write was refused, and so may have been the queue's
      const status = await write(next);
      // Only an event that actually changed is queued, so touching a resolved crisis re-sends nothing. Queueing the
      // same event again is harmless: the queue keeps one entry per event id.
      if (next.event && (retrying || JSON.stringify(next.event) !== JSON.stringify(current.event))) await queue(next.event);
      return { record: next, status };
    });
  }

  /** The tab's mark for the open crisis, made now if there is none. Synchronous: no storage, no lock. */
  function ensureMark(trigger: CrisisTrigger): CrisisMark {
    const held = deps.fallback.get();
    if (held) return held;
    const mark: CrisisMark = { trigger, eventId: deps.newId(), shownAt: deps.now().toISOString() };
    deps.fallback.set(mark);
    return mark;
  }

  /**
   * Opens the crisis's one event in the stored record, from the tab's mark. Shared by `raise` and `repair`, which
   * use the same event id, so whichever runs first makes the event and the other adds nothing. It does nothing if
   * the crisis was resolved, or replaced by a newer one, since `mark` was taken. An event that is already open is
   * left alone, except that it learns which check-in it belongs to and that an unsaved record is written again.
   */
  function openEvent(current: CrisisRecord, mark: CrisisMark, locale: Locale, screeningId: string | null): CrisisRecord | null {
    if (deps.fallback.get()?.eventId !== mark.eventId) return null;
    if (current.blocked && current.event) {
      if (screeningId && !current.resumeScreeningId) return { ...current, resumeScreeningId: screeningId };
      return current === unsaved ? current : null;
    }
    const event = CrisisEventSubmissionSchema.parse({
      id: mark.eventId,
      trigger: mark.trigger,
      shownAt: mark.shownAt,
      callTapped: null,
      contextShared: false,
      humanContactConfirmed: false,
      contactSource: null,
      contactAt: null,
      resolvedAt: null,
      locale,
    });
    return { ...current, blocked: true, trigger: mark.trigger, blockedAt: mark.shownAt, resumeScreeningId: screeningId, event };
  }

  return {
    read,

    /** Sets the tab's mark at once, with no storage involved. Called the moment a trigger answer is decided. */
    markBlocked(trigger: CrisisTrigger): void {
      ensureMark(trigger);
    },

    /**
     * A trigger answer was given: set the block and open the event. A second trigger while already blocked keeps the
     * event that is open. Never throws, so the caller can go to the crisis screen whatever happens.
     */
    raise(input: { trigger: CrisisTrigger; screeningId: string | null; locale: Locale }): Promise<WriteStatus> {
      const mark = ensureMark(input.trigger); // synchronously, before the store lock
      return update((current) => openEvent(current, mark, input.locale, input.screeningId)).then(
        (result) => result?.status ?? 'saved',
        () => 'failed',
      );
    },

    /**
     * Makes the stored block and the one event exist, if the tab says a crisis is open and the stored record has no
     * open event: the case where storage refused or hung when the trigger was answered. It uses the event id the tab
     * holds, so running it twice, at the same time or one after the other, or after a late `raise`, makes one event.
     * It does nothing once the crisis is resolved. Never throws.
     */
    repair(locale: Locale): Promise<'repaired' | 'nothing'> {
      const mark = deps.fallback.get();
      if (!mark) return Promise.resolve('nothing');
      return update((current) => openEvent(current, mark, locale, null)).then(
        (result) => (result ? 'repaired' : 'nothing'),
        () => 'nothing',
      );
    },

    /** "Call now" or a number was tapped: logs which one. The block stays on. */
    recordCall(number: CrisisNumber): Promise<CrisisRecord | null> {
      // Only an open crisis may change its event: a call from "Help now" after a resolved crisis logs nothing.
      return update((current) => (current.blocked && current.event ? { ...current, event: { ...current.event, callTapped: number } } : null)).then((result) => result?.record ?? null);
    },

    /** The person says they reached someone. Self-report only; the block stays on. */
    confirmContact(): Promise<CrisisRecord | null> {
      return update((current) =>
        current.blocked && current.event && !current.event.humanContactConfirmed
          ? { ...current, event: { ...current.event, humanContactConfirmed: true, contactSource: 'self_report', contactAt: deps.now().toISOString() } }
          : null,
      ).then((result) => result?.record ?? null);
    },

    /** "I'm with someone safe" or "I'm safe right now": releases the block and records when. */
    resolve(): Promise<{ record: CrisisRecord; status: WriteStatus } | null> {
      deps.fallback.set(null); // synchronously: releasing never waits on storage
      return update((current) => {
        const resolvedAt = deps.now().toISOString();
        return {
          ...current,
          blocked: false,
          resolvedAt,
          resumeScreeningId: null,
          event: current.event && !current.event.resolvedAt ? { ...current.event, resolvedAt } : current.event,
        };
      });
    },
  };
}

export type CrisisStore = ReturnType<typeof createCrisisStore>;
