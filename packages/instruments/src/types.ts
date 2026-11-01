import type { Instrument, Locale } from '@mawsool/types';

/**
 * `verified` means the text was copied from the named published source and checked against it.
 * It does not mean the translation is clinically validated for any particular population.
 * `unverified` means the text was not obtained from a published source in machine-checkable form,
 * or was not obtained at all (`text` is then null). The UI shows a visible label for every unverified item.
 */
export type WordingStatus = 'verified' | 'unverified';

export interface ResponseOption {
  value: number;
  label: string;
}

export interface ItemWording {
  /** `<instrument>.<1-based item number>`, for example `phq9.9`. */
  id: string;
  /** Null when no published wording was obtained for this locale. */
  text: string | null;
  /** Examples or follow-up text printed under the item on the source form. */
  detail?: string;
}

export interface LocaleWording {
  locale: Locale;
  wordingStatus: WordingStatus;
  /** Key into `WORDING_SOURCES`, or null when nothing was obtained. */
  sourceId: string | null;
  /** The instruction line printed above the items. */
  stem: string | null;
  options: ResponseOption[];
  items: ItemWording[];
}

export type InstrumentWording = Record<Locale, LocaleWording>;

export interface WordingSource {
  id: string;
  instrument: Instrument;
  locale: Locale;
  title: string;
  publisher: string;
  /** Null when no source was obtained. */
  url: string | null;
  fetchedOn: string;
  /** How the text reached this repository. */
  extraction: string;
  licence: string;
  /** What the source itself says about validation. Never filled from outside knowledge. */
  validationStatement: string;
  caveat: string;
}

export interface ItemAnswer {
  instrument: Instrument;
  /** 1-based item number as printed on the form. */
  itemNumber: number;
  /** 0-3 for PHQ-9 and GAD-7, 0-5 for WHO-5, 0 (no) or 1 (yes) for C-SSRS. */
  value: number;
}

export type CrisisReason = 'item9_positive' | 'cssrs_yes' | 'invalid_answer' | 'not_a_trigger_item' | 'no_trigger';

export interface CrisisEvaluation {
  triggered: boolean;
  trigger: 'phq9_item9' | 'cssrs' | null;
  reason: CrisisReason;
}

export interface ScoreResult {
  instrument: Instrument;
  total: number;
  /** Severity band id; null for WHO-5, which has no bands here. */
  band: string | null;
  item9Flag: boolean;
}
