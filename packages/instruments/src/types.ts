import type { Instrument, Locale } from '@mawsool/types';

/**
 * `verified` means published validated wording: the text is copied from a published source that was obtained,
 * and a published validation study of that same instrument and language form is cited in `SOURCES.md`.
 *
 * `unverified` is everything less, and shows a visible label wherever the wording appears. That covers text that
 * is only copied from a source with no validation evidence for that form (the Arabic PHQ-9 and GAD-7 editions
 * filed for Tunisia print no validation statement), text transcribed by hand, a form whose validation was not
 * established, and a locale with no text at all (`text` is then null).
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
  /** Why the locale has the status it has, in one sentence. */
  statusBasis: string;
  /** The published validation study behind a `verified` status. Null for every `unverified` row. */
  validationSource: { citation: string; url: string } | null;
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
