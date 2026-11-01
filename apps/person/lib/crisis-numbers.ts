import { CRISIS_NUMBERS_CONFIG } from '@mawsool/rules';
import type { CrisisNumber } from '@mawsool/types';

export interface CrisisLines {
  /** The first number in the config: the 24/7 mental health line, shown as the large call button. */
  primary: CrisisNumber;
  /** The emergency numbers, in ascending order: ambulance 998, then police 999. */
  emergency: CrisisNumber[];
}

/**
 * The numbers the crisis screen shows, read from the single config file in `packages/rules` and nowhere else, so
 * the screen, the dialler and the admin view's `last_verified` date can never disagree about which numbers exist.
 */
export function crisisLines(config: readonly { number: CrisisNumber }[] = CRISIS_NUMBERS_CONFIG): CrisisLines {
  const [primary, ...rest] = config.map((entry) => entry.number);
  if (!primary) throw new Error('the crisis number config is empty');
  return { primary, emergency: [...rest].sort() };
}

/** `800725462` is read as `800 725462`; short numbers stay as they are. */
export function formatDialNumber(number: string): string {
  return number.length > 6 ? `${number.slice(0, 3)} ${number.slice(3)}` : number;
}
