import type { Instrument, Locale, Screening } from '@mawsool/types';
import type { StorageAdapter } from '@mawsool/ui';
import type { NewId, Now } from './clock';
import { answerFiresCrisis, type CrisisStore } from './crisis';
import { saveAnswer } from './screening-store';

export type AnswerOutcome =
  /** The answer is saved. The check-in carries on. */
  | { kind: 'saved'; screening: Screening }
  /** The answer could not be saved and did not fire the crisis path. The person is asked to try again. */
  | { kind: 'failed' }
  /**
   * The answer fired the crisis path. The caller goes to the crisis screen whatever else happened: `screening` is
   * null when the answer could not be saved in time, and the block may be unsaved (`blockSaved` false).
   */
  | { kind: 'crisis'; screening: Screening | null; blockSaved: boolean };

export interface RecordAnswerDeps {
  storage: StorageAdapter;
  crisis: CrisisStore;
  now: Now;
  newId: NewId;
  locale: Locale;
  /** How long the crisis path waits on storage before it gives up and shows the screen anyway. */
  patienceMs?: number;
}

/** Resolves with `fallback` if `promise` has not settled within `ms`, or if it rejects. Never rejects. */
function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/**
 * Records one answer, and takes the crisis path if the answer fires it.
 *
 * The trigger is decided first, by `packages/instruments`, from the answer alone: it never depends on storage.
 * If the answer fires, saving the answer and setting the persisted block are both attempted, each within a short
 * patience, and the outcome is `crisis` however they turn out: a full disk, a blocked database or a slow one must
 * not stand between a person and the help screen. Any other answer that cannot be saved is a plain failure.
 */
export async function recordAnswer(input: { instrument: Instrument; index: number; value: number; screeningId?: string | null }, deps: RecordAnswerDeps): Promise<AnswerOutcome> {
  const { instrument, index, value, screeningId } = input;
  const trigger = answerFiresCrisis(instrument, index, value);
  const save = saveAnswer(deps.storage, { instrument, index, value, screeningId }, { now: deps.now, newId: deps.newId });

  if (!trigger) {
    try {
      return { kind: 'saved', screening: await save };
    } catch {
      return { kind: 'failed' };
    }
  }

  const patience = deps.patienceMs ?? 2000;
  const screening = await within<Screening | null>(save, patience, null);
  const status = await within(deps.crisis.raise({ trigger, screeningId: screening?.id ?? null, locale: deps.locale }), patience, 'failed' as const);
  return { kind: 'crisis', screening, blockSaved: status === 'saved' };
}
