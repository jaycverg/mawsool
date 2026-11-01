import { CONSENT_ELEMENTS, SUMMARY_WORD_LIMIT, type BundleContent, type ConsentElement } from '@mawsool/types';

/** The one element a ticket cannot exist without: its code, tier, deadline and language. */
export const REQUIRED_ELEMENT: ConsentElement = 'ticket';

/** The elements a person may choose to share, in the order the consent screen lists them. All default to off. */
export const OPTIONAL_ELEMENTS: readonly ConsentElement[] = CONSENT_ELEMENTS.filter((element) => element !== REQUIRED_ELEMENT);

/** Whether a set of granted elements includes the required one. */
export function includesRequired(granted: readonly ConsentElement[]): boolean {
  return granted.includes(REQUIRED_ELEMENT);
}

/**
 * Keeps only the elements that were granted. It runs on the phone before anything is sent and again on the server
 * every time a bundle is stored or read, so an element that was not consented to cannot leave through a path that
 * forgot to check. The `ticket` element carries no content here; it is the ticket's own fields.
 */
export function redact(content: BundleContent, granted: readonly ConsentElement[]): BundleContent {
  const allowed = new Set<ConsentElement>(granted);
  const kept: BundleContent = {};
  if (allowed.has('scores') && content.scores) kept.scores = content.scores;
  if (allowed.has('trajectory') && content.trajectory) kept.trajectory = content.trajectory;
  if (allowed.has('free_text') && content.free_text !== undefined) kept.free_text = content.free_text;
  if (allowed.has('conditions') && content.conditions) kept.conditions = content.conditions;
  if (allowed.has('preferences') && content.preferences) kept.preferences = content.preferences;
  return kept;
}

/** The optional elements that are not in the granted set: what a clinic is told "was not shared by the person". */
export function notShared(granted: readonly ConsentElement[]): ConsentElement[] {
  return OPTIONAL_ELEMENTS.filter((element) => !granted.includes(element));
}

/** The bundle content with one element taken out, for a revoke of just that element. */
export function withoutElement(content: BundleContent, element: ConsentElement): BundleContent {
  const { [element as keyof BundleContent]: _removed, ...rest } = content;
  return rest;
}

/** Words in a summary, counted the way the limit is: runs of non-space characters. */
export function wordCount(text: string): number {
  return text.trim() === '' ? 0 : text.trim().split(/\s+/).length;
}

/** True when a summary is within the word limit. */
export function withinWordLimit(text: string): boolean {
  return wordCount(text) <= SUMMARY_WORD_LIMIT;
}
