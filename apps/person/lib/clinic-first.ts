import { splitCards, type CardSplit, type RankedOption } from '@mawsool/rules';

/** The query value that asks the options screen to lead with a GP and a specialist. */
export const CLINIC_FOCUS = 'clinic';

/**
 * The options as the person who asked to see a doctor or a specialist should meet them: the GP and the specialist first, as
 * the cards, and everything else (guided self-help among it) behind "Show other options". The ranking and the services are
 * the ones `match()` already made on the phone; only which of them lead changes. With no GP or specialist service in the
 * directory the ordinary split is kept, so the list is never empty.
 */
export function clinicFirst(options: readonly RankedOption[]): CardSplit {
  const clinic = options.filter((option) => option.service !== null && (option.tier === 'gp' || option.tier === 'specialist'));
  if (clinic.length === 0) return splitCards(options);
  return { cards: clinic, others: options.filter((option) => !clinic.includes(option)) };
}
