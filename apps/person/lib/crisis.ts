import { evaluateCrisis } from '@mawsool/instruments';
import { CrisisEventSubmissionSchema, type CrisisEventSubmission, type CrisisNumber, type CrisisTrigger, type Instrument, type Locale } from '@mawsool/types';
import type { StorageAdapter } from '@mawsool/ui';
import type { NewId, Now } from './clock';
import { enqueueEventLocked } from './crisis-outbox';
import { KEYS } from './keys';
import { withStoreLock } from './lock';

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

export interface CrisisDeps {
  now: Now;
  newId: NewId;
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

  async function read(): Promise<BlockState> {
    if (unsaved) return { status: unsaved.blocked ? 'blocked' : 'clear', record: unsaved };
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
      const state = await read();
      const current = state.record ?? { ...CLEAR_RECORD, blocked: true };
      const next = change(current);
      if (!next) return null;
      const status = await write(next);
      // Only an event that actually changed is queued, so touching a resolved crisis re-sends nothing.
      if (next.event && JSON.stringify(next.event) !== JSON.stringify(current.event)) await queue(next.event);
      return { record: next, status };
    });
  }

  return {
    read,

    /**
     * A trigger answer was given: set the block and open the event. A second trigger while already blocked keeps the
     * event that is open. Never throws, so the caller can go to the crisis screen whatever happens.
     */
    raise(input: { trigger: CrisisTrigger; screeningId: string | null; locale: Locale }): Promise<WriteStatus> {
      return update((current) => {
        if (current.blocked && current.event) return null;
        const event = CrisisEventSubmissionSchema.parse({
          id: deps.newId(),
          trigger: input.trigger,
          shownAt: deps.now().toISOString(),
          callTapped: null,
          contextShared: false,
          humanContactConfirmed: false,
          contactSource: null,
          contactAt: null,
          resolvedAt: null,
          locale: input.locale,
        });
        return { ...current, blocked: true, trigger: input.trigger, blockedAt: event.shownAt, resumeScreeningId: input.screeningId, event };
      }).then(
        (result) => result?.status ?? 'saved',
        () => 'failed',
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
