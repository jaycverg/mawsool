import type { Coverage, CrisisNumber, InsuranceClass, Tier } from '@mawsool/types';

/**
 * Every threshold, window and sample table the rules read. Proposed defaults: clinical sign-off is still open,
 * so nothing here is clinical advice. Change values here, never in a code path.
 */

/** Reliable change between two check-ins (NHS Talking Therapies convention, per the spec). */
export const RELIABLE_CHANGE = { phq9: 6, gad7: 4 } as const;

/** UAE has no daylight saving, so a fixed offset is exact for Asia/Dubai. */
export const DEPLOYMENT_TIME_ZONE = 'Asia/Dubai';
export const DEPLOYMENT_UTC_OFFSET_MINUTES = 240;

/** A score band. Selection tries rows most intensive first and uses only `min`; `max` documents the band. */
export interface Range {
  min: number;
  max: number;
}

export type RowId = 'specialist_high' | 'specialist_or_gp' | 'gp_or_tele' | 'self_help_or_community' | 'below_5';

export interface StepRow {
  id: RowId;
  /** The row matches when the latest PHQ-9 total is in this range... */
  phq9?: Range;
  /** ...or the latest GAD-7 total is in this range. A row with neither range is the fallback. */
  gad7?: Range;
  /** Offered tiers in the order the cards are shown. */
  offered: readonly Tier[];
  /** Days from issue by which the hand-off should happen; null when no ticket is expected. */
  handoffWindowDays: number | null;
  recheckWeeks: number;
}

/** The spec's stepped-care table, most intensive row first. The first matching row wins. */
export const STEP_ROWS: readonly StepRow[] = [
  {
    id: 'specialist_high',
    phq9: { min: 20, max: 27 },
    gad7: { min: 15, max: 21 },
    offered: ['specialist', 'gp', 'tele'],
    handoffWindowDays: 14,
    recheckWeeks: 6,
  },
  {
    id: 'specialist_or_gp',
    phq9: { min: 15, max: 19 },
    offered: ['specialist', 'gp'],
    handoffWindowDays: 14,
    recheckWeeks: 6,
  },
  {
    id: 'gp_or_tele',
    phq9: { min: 10, max: 14 },
    gad7: { min: 10, max: 14 },
    offered: ['gp', 'tele'],
    handoffWindowDays: 7,
    recheckWeeks: 6,
  },
  {
    id: 'self_help_or_community',
    phq9: { min: 5, max: 9 },
    gad7: { min: 5, max: 9 },
    offered: ['self_help', 'community'],
    handoffWindowDays: 14,
    recheckWeeks: 4,
  },
  {
    id: 'below_5',
    offered: ['self_help'],
    handoffWindowDays: null,
    recheckWeeks: 4,
  },
];

/** The most option cards shown before "Show other options": the spec's "1-3 cards". */
export const MAX_FIRST_VIEW_CARDS = 3;

/** Window for a ticket the person chooses outside the row's own hand-off (a more intensive tier than offered). */
export const FALLBACK_HANDOFF_WINDOW_DAYS = 14;

/** Every hand-off window, in days, that a ticket may be issued with: the rows' own windows and the fallback. */
export const HANDOFF_WINDOWS_DAYS: readonly number[] = [
  ...new Set([...STEP_ROWS.flatMap((row) => (row.handoffWindowDays === null ? [] : [row.handoffWindowDays])), FALLBACK_HANDOFF_WINDOW_DAYS]),
].sort((a, b) => a - b);

/** Aggregates over fewer people than this are never shown (k-anonymity). */
export const SUPPRESSION_THRESHOLD = 10;

/** What a number is for. The crisis screen shows the hotline as the large button and the other two as emergency numbers. */
export type CrisisRole = 'hotline' | 'ambulance' | 'police';

export interface CrisisNumberConfig {
  /** The digits dialled. */
  number: CrisisNumber;
  role: CrisisRole;
  /** The line's name as people know it. Shown in every language as written. */
  label: string;
  /** Dated as YYYY-MM-DD once a person has confirmed the number live; null until then. Shown in the admin view. */
  last_verified: string | null;
  note: string;
}

/**
 * The only place crisis numbers are defined. `last_verified` stays null until someone calls the line:
 * the spec says 800-SAKINA could not be independently confirmed live as of August 2026.
 */
export const CRISIS_NUMBERS_CONFIG: readonly CrisisNumberConfig[] = [
  {
    number: '800725462',
    role: 'hotline',
    label: '800-SAKINA',
    last_verified: null,
    note: 'Claimed 24/7 and bilingual by the DoH announcement cited in the spec; not independently confirmed.',
  },
  { number: '999', role: 'police', label: 'Police', last_verified: null, note: 'Emergency number taken from the spec; not independently confirmed.' },
  { number: '998', role: 'ambulance', label: 'Ambulance', last_verified: null, note: 'Emergency number taken from the spec; not independently confirmed.' },
];

/**
 * SAMPLE insurance table. Indicative only, invented for the demo from the spec's two stated examples
 * (Daman Basic: PHC visit covered, private therapy pay and claim). Not policy wording and not an eligibility check.
 */
export const INSURANCE_TABLE_IS_SAMPLE = true;
export const SAMPLE_COVERAGE: Record<InsuranceClass, Record<Tier, Coverage>> = {
  thiqa: { self_help: 'covered', community: 'covered', tele: 'covered', gp: 'covered', specialist: 'covered' },
  daman_basic: { self_help: 'covered', community: 'covered', tele: 'copay', gp: 'covered', specialist: 'pay_and_claim' },
  daman_enhanced: { self_help: 'covered', community: 'covered', tele: 'covered', gp: 'covered', specialist: 'copay' },
  other_private: { self_help: 'covered', community: 'pay_and_claim', tele: 'pay_and_claim', gp: 'copay', specialist: 'pay_and_claim' },
  not_sure: { self_help: 'covered', community: 'unknown', tele: 'unknown', gp: 'unknown', specialist: 'unknown' },
};
