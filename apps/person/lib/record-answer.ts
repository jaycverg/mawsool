import type { Instrument, Locale, Screening } from '@mawsool/types';
import type { StorageAdapter } from '@mawsool/ui';
import type { NewId, Now } from './clock';
import { answerFiresCrisis, type CrisisStore } from './crisis';
import { saveAnswer } from './screening-store';
import { within } from './within';

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

/**
 * Records one answer, and takes the crisis path if the answer fires it.
 *
 * The trigger is decided first, by `packages/instruments`, from the answer alone: it never depends on storage, and
 * the tab's crisis flag is set at once. If the answer fires, saving the answer and setting the persisted block are both attempted, each within a short
 * patience, and the outcome is `crisis` however they turn out: a full disk, a blocked database or a slow one must
 * not stand between a person and the help screen. Any other answer that cannot be saved is a plain failure.
 */
export async function recordAnswer(input: { instrument: Instrument; index: number; value: number; screeningId?: string | null; notBefore?: number }, deps: RecordAnswerDeps): Promise<AnswerOutcome> {
  const { instrument, index, value, screeningId, notBefore } = input;
  const trigger = answerFiresCrisis(instrument, index, value);
  // Before anything asynchronous: the tab's crisis flag is set at once, so whatever storage does next, Back and a
  // direct visit to a guarded screen in this tab still land on the crisis screen.
  if (trigger) deps.crisis.markBlocked(trigger);
  const save = saveAnswer(deps.storage, { instrument, index, value, screeningId, notBefore }, { now: deps.now, newId: deps.newId });

  if (!trigger) {
    try {
      return { kind: 'saved', screening: await save };
    } catch {
      return { kind: 'failed' };
    }
  }

  const patience = deps.patienceMs ?? 1500;
  const screening = await within<Screening | null>(save, patience, null);
  // Setting the persisted block is best effort now: the flag above already holds it, and a hung save may be
  // holding the store's lock, so this waits only briefly.
  const status = await within(deps.crisis.raise({ trigger, screeningId: screening?.id ?? null, locale: deps.locale }), Math.min(patience, 300), 'failed' as const);
  return { kind: 'crisis', screening, blockSaved: status === 'saved' };
}
