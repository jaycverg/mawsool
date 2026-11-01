import { MAX_FIRST_VIEW_CARDS } from './config';
import type { RankedOption } from './match';

export interface CardSplit {
  /** The cards shown at first: the recommended tiers, plus the tier the person is on now. */
  cards: RankedOption[];
  /** Everything else, behind "Show other options". */
  others: RankedOption[];
}

/**
 * Splits a ranked list into the first-view cards and the rest.
 *
 * The first view is every recommended option plus the person's current tier, in ranked order, and shows at most
 * `max` cards. When more than `max` qualify (a top-row result for someone who is on a lower tier), the current
 * tier keeps its card and the last recommended option or options move behind "Show other options": the person is
 * never shown their own tier as an afterthought, and never more than three cards at once. When nothing qualifies
 * (a recommended tier with no service), the first ranked option is shown so the list is never empty. A crisis
 * result is a single card.
 */
export function splitCards(options: readonly RankedOption[], max: number = MAX_FIRST_VIEW_CARDS): CardSplit {
  let cards = options.filter((option) => option.kind === 'recommended' || option.kind === 'crisis' || option.current);
  for (let index = cards.length - 1; index >= 0 && cards.length > max; index -= 1) {
    if (!cards[index]!.current) cards = cards.filter((_, position) => position !== index);
  }
  if (cards.length === 0) cards = options.slice(0, 1);
  return { cards, others: options.filter((option) => !cards.includes(option)) };
}
