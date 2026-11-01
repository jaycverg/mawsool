import { CRISIS_NUMBERS_CONFIG, type CrisisRole } from '@mawsool/rules';
import type { CrisisNumber } from '@mawsool/types';

export interface CrisisLine {
  /** The digits dialled. */
  number: CrisisNumber;
  /** The line's name from the config, such as 800-SAKINA. */
  name: string;
  /** The digits as they are read aloud: `800 725462`. */
  display: string;
}

export interface CrisisLines {
  hotline: CrisisLine;
  /** The emergency numbers in the order they are shown: ambulance, then police. */
  emergency: [CrisisLine, CrisisLine];
  ambulance: CrisisLine;
  police: CrisisLine;
}

/** `800725462` is read as `800 725462`; short numbers stay as they are. */
export function formatDialNumber(number: string): string {
  return number.length > 6 ? `${number.slice(0, 3)} ${number.slice(3)}` : number;
}

type ConfigEntry = { number: CrisisNumber; role: CrisisRole; label: string };

/**
 * The numbers the crisis screen and the privacy screen show, read by role from the single config file in
 * `packages/rules` and nowhere else. No message file holds a number: every string that names one takes it from
 * here, so changing a number, or the name of a line, in the config changes every screen.
 */
export function crisisLines(config: readonly ConfigEntry[] = CRISIS_NUMBERS_CONFIG): CrisisLines {
  const line = (role: CrisisRole): CrisisLine => {
    const entry = config.find((candidate) => candidate.role === role);
    if (!entry) throw new Error(`the crisis number config has no ${role}`);
    return { number: entry.number, name: entry.label, display: formatDialNumber(entry.number) };
  };
  const hotline = line('hotline');
  const ambulance = line('ambulance');
  const police = line('police');
  return { hotline, ambulance, police, emergency: [ambulance, police] };
}
