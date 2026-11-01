import type { Instrument, Locale } from '@mawsool/types';
import { CSSRS_WORDING } from './items/cssrs';
import { GAD7_WORDING } from './items/gad7';
import { PHQ9_WORDING } from './items/phq9';
import { WHO5_WORDING } from './items/who5';
import { WORDING_SOURCES } from './sources';
import type { InstrumentWording, ItemWording, LocaleWording, WordingSource } from './types';

export const WORDING: Record<Instrument, InstrumentWording> = {
  who5: WHO5_WORDING,
  phq9: PHQ9_WORDING,
  gad7: GAD7_WORDING,
  cssrs: CSSRS_WORDING,
};

/** The wording for one instrument in one locale, with its status and source id. */
export function wordingFor(instrument: Instrument, locale: Locale): LocaleWording {
  return WORDING[instrument][locale];
}

/**
 * True when an item must carry a visible "wording not verified" label: the locale's wording is unverified,
 * or no text exists for the item.
 */
export function needsUnverifiedLabel(instrument: Instrument, locale: Locale, item: ItemWording): boolean {
  return wordingFor(instrument, locale).wordingStatus === 'unverified' || item.text === null;
}

/** The published source behind a locale's wording, or null when none was obtained. */
export function sourceFor(instrument: Instrument, locale: Locale): WordingSource | null {
  const id = wordingFor(instrument, locale).sourceId;
  // A test asserts every sourceId used by the wording resolves, so the lookup cannot miss.
  return id === null ? null : WORDING_SOURCES[id]!;
}
