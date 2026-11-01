import { redact } from '@mawsool/consent';
import { SUMMARY_WORD_LIMIT, type BundleContent, type ConsentElement, type Locale } from '@mawsool/types';

export interface SummaryPrompt {
  system: string;
  user: string;
}

/** A fill-in template for the person to complete when no AI draft is wanted or available. */
const TEMPLATES: Record<Locale, string> = {
  en: 'What I would like help with: \nHow long this has been going on: \nWhat I would like the clinic to know: ',
  ar: 'ما أحتاج إلى مساعدة فيه: \nمنذ متى بدأ ذلك: \nما أود أن تعرفه العيادة: ',
};

export function templateSummary(locale: Locale): string {
  return TEMPLATES[locale];
}

/** Trims to at most `limit` words, keeping the original spacing of what is kept. */
export function capWords(text: string, limit: number = SUMMARY_WORD_LIMIT): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= limit) return text.trim();
  return words.slice(0, limit).join(' ');
}

const SYSTEM = [
  'You help a person write a short note for a clinic they have chosen to contact.',
  `Write in the first person, in plain words, at most ${SUMMARY_WORD_LIMIT} words.`,
  'Use only the facts you are given. Do not diagnose, do not name a condition the person did not name, do not give advice or treatment suggestions, and do not assess or score risk.',
  'Do not invent details. If little is given, write less.',
  'Return only the note text, with no heading and no commentary.',
].join(' ');

/**
 * The prompt for a draft. The content is redacted to the consented elements here, in the only function that builds a
 * prompt, so nothing the person did not consent to can reach the provider whatever the caller passed in.
 */
export function buildPrompt(content: BundleContent, consented: readonly ConsentElement[], locale: Locale): SummaryPrompt {
  const allowed = redact(content, consented);
  const lines: string[] = [];
  for (const score of allowed.scores ?? []) lines.push(`Latest ${score.instrument} score: ${score.total}${score.band ? ` (${score.band})` : ''}.`);
  const trajectory = allowed.trajectory ?? [];
  if (trajectory.length > 0) {
    lines.push(`Earlier scores: ${trajectory.map((entry) => `${entry.instrument} ${entry.total} on ${entry.takenAt.slice(0, 10)}`).join('; ')}.`);
  }
  if (allowed.conditions?.length) lines.push(`Health conditions the person listed: ${allowed.conditions.join(', ')}.`);
  if (allowed.preferences) lines.push(`Care preferences: ${JSON.stringify(allowed.preferences)}.`);
  if (allowed.free_text) lines.push(`The person's own words: ${allowed.free_text}`);
  const language = locale === 'ar' ? 'Arabic' : 'English';
  return { system: SYSTEM, user: `Write the note in ${language}.\n\n${lines.length > 0 ? lines.join('\n') : 'The person has shared nothing else.'}` };
}
