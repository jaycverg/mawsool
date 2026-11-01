import type { CrisisLine, CrisisLines } from './crisis-numbers';

/** The shape of a message function from `useTranslations` or `createTranslator`. */
export type Translate = (key: string, values?: Record<string, string | number>) => string;

export interface CrisisLineText {
  /** The digits to dial. */
  dial: string;
  title: string;
  detail: string;
}

/**
 * Every string on the crisis screen that names a number, filled in from the config. The message files hold the
 * words and a place for the number; the number itself only ever comes from `lines`.
 */
export function crisisTexts(t: Translate, lines: CrisisLines): { hotline: CrisisLineText; emergency: CrisisLineText[]; offline: string } {
  const emergency = (line: CrisisLine, role: 'ambulance' | 'police'): CrisisLineText => ({
    dial: line.number,
    title: t('callEmergency', { number: line.display }),
    detail: t(role),
  });
  return {
    hotline: { dial: lines.hotline.number, title: t('hotlineTitle', { name: lines.hotline.name }), detail: t('hotlineDetail', { number: lines.hotline.display }) },
    emergency: [emergency(lines.ambulance, 'ambulance'), emergency(lines.police, 'police')],
    offline: t('offline', { police: lines.police.display, ambulance: lines.ambulance.display }),
  };
}

/** The privacy screen's line listing the numbers, from the same config. */
export function numbersText(t: Translate, lines: CrisisLines): string {
  return t('numbersBody', { name: lines.hotline.name, hotline: lines.hotline.display, ambulance: lines.ambulance.display, police: lines.police.display });
}
