import type { Locale } from '@mawsool/types';
import { directionFor } from './i18n';

/** Class that mirrors a directional icon in right-to-left layouts (see `.rtl-flip` in tokens.css). */
export const RTL_FLIP_CLASS = 'rtl-flip';

/** Attributes for the `<html>` element: language and direction. */
export function htmlAttributes(locale: Locale): { lang: Locale; dir: 'rtl' | 'ltr' } {
  return { lang: locale, dir: directionFor(locale) };
}

/**
 * Picks the physical value for a logical side. Prefer logical CSS properties (margin-inline-start, ps-4); use
 * this only where a physical value is unavoidable, such as an absolutely positioned badge.
 */
export function physicalSide(locale: Locale, side: 'start' | 'end'): 'left' | 'right' {
  const rtl = directionFor(locale) === 'rtl';
  if (side === 'start') return rtl ? 'right' : 'left';
  return rtl ? 'left' : 'right';
}

/** Mirrors a horizontal progress fraction: a bar fills from the start edge in both directions. */
export function progressFillStyle(fraction: number): { inlineSize: string } {
  const clamped = Math.min(1, Math.max(0, fraction));
  return { inlineSize: `${Math.round(clamped * 10000) / 100}%` };
}
