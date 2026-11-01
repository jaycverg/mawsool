import {
  TIERS,
  type Coverage,
  type InsuranceClass,
  type Preferences,
  type Region,
  type Screening,
  type Service,
  type Tier,
} from '@mawsool/types';
import { FALLBACK_HANDOFF_WINDOW_DAYS, SAMPLE_COVERAGE, type StepRow } from './config';
import { hasUnresolvedCrisis, selectRow } from './screenings';

export type ReasonCode =
  | 'crisis_active'
  | 'score_phq9'
  | 'score_gad7'
  | 'no_scores'
  | 'bridge_option'
  | 'current_tier'
  | 'other_tier';

export interface Reason {
  code: ReasonCode;
  params?: Record<string, string | number>;
}

export type EligibilityKind = 'insurance' | 'region' | 'language' | 'gender' | 'modality';
export type EligibilityStatus = 'ok' | 'check' | 'not_requested';

export interface EligibilityItem {
  kind: EligibilityKind;
  status: EligibilityStatus;
}

export interface RankedOption {
  /** 1-based position in the list. */
  rank: number;
  /** `crisis` replaces every other option while an unresolved trigger exists. */
  kind: 'crisis' | 'recommended' | 'other';
  tier: Tier | 'crisis';
  /** Null only for the crisis option. */
  service: Service | null;
  reasons: Reason[];
  eligibility: EligibilityItem[];
  /** Indicative only, from the sample table. Null for the crisis option. */
  coverage: Coverage | null;
  /** Days from issue by which the person should be seen; null for self-help and for the crisis option. */
  handoffWindowDays: number | null;
  /** True for the tier the person is on now, kept as a card on a re-match. */
  current: boolean;
}

export interface MatchContext {
  /** The tier the person chose last time. Stays on screen as a card when the new result moves them on. */
  currentTier?: Tier | null;
  /** When the person resolved the crisis screen. A screening taken at or before this stays resolved. */
  crisisResolvedAt?: string | null;
}

function eligibilityFor(service: Service, prefs: Preferences, insurance: InsuranceClass, region: Region): EligibilityItem[] {
  /** `not_requested` when the person stated no preference, otherwise `ok` or `check`. */
  const preference = <T>(wanted: T | undefined, satisfied: (value: T) => boolean): EligibilityStatus =>
    wanted === undefined ? 'not_requested' : satisfied(wanted) ? 'ok' : 'check';
  return [
    // An empty class list means the service takes no insurance claim (free resources), so nothing to check.
    { kind: 'insurance', status: service.insuranceClasses.length === 0 || service.insuranceClasses.includes(insurance) ? 'ok' : 'check' },
    { kind: 'region', status: service.modality === 'tele' || service.region === region ? 'ok' : 'check' },
    { kind: 'language', status: preference(prefs.language, (language) => service.languages.includes(language)) },
    { kind: 'gender', status: preference(prefs.clinicianGender, (gender) => service.clinicianGenders.includes(gender)) },
    { kind: 'modality', status: preference(prefs.modality, (modality) => modality === service.modality) },
  ];
}

/** Lower sorts first: fewer items to check, then shorter wait, then name and id for a stable order. */
function compareServices(a: { service: Service; checks: number }, b: { service: Service; checks: number }): number {
  return (
    a.checks - b.checks ||
    a.service.indicativeWaitDays - b.service.indicativeWaitDays ||
    a.service.name.localeCompare(b.service.name, 'en') ||
    a.service.id.localeCompare(b.service.id, 'en')
  );
}

function bestService(
  tier: Tier,
  services: readonly Service[],
  prefs: Preferences,
  insurance: InsuranceClass,
  region: Region,
): { service: Service; eligibility: EligibilityItem[] } | null {
  const ranked = services
    .filter((service) => service.tier === tier)
    .map((service) => {
      const eligibility = eligibilityFor(service, prefs, insurance, region);
      return { service, eligibility, checks: eligibility.filter((item) => item.status === 'check').length };
    })
    .sort(compareServices);
  return ranked[0] ?? null;
}

function scoreReasons(phq9Total: number | null, gad7Total: number | null): Reason[] {
  const reasons: Reason[] = [];
  if (phq9Total !== null) reasons.push({ code: 'score_phq9', params: { total: phq9Total } });
  if (gad7Total !== null) reasons.push({ code: 'score_gad7', params: { total: gad7Total } });
  return reasons.length > 0 ? reasons : [{ code: 'no_scores' }];
}

function windowFor(tier: Tier, row: StepRow): number | null {
  if (tier === 'self_help') return null;
  return row.handoffWindowDays ?? FALLBACK_HANDOFF_WINDOW_DAYS;
}

/**
 * Stepped-care matching. Pure and deterministic: runs on the device, so preferences and insurance class never
 * leave it, and uses no network or AI.
 *
 * - An unresolved crisis trigger returns a single `crisis` option and nothing else.
 * - Otherwise the latest PHQ-9 and GAD-7 totals pick one row of the stepped-care table, most intensive first.
 *   With neither score the "below 5" row applies.
 * - The row's tiers come first, in the table's order, one best service each; a tier with no service is skipped.
 * - The person's current tier stays as a card; then the remaining tiers follow as "other options", least
 *   intensive first.
 * - Within a tier, services are ordered by how few of the person's needs need checking (insurance, region,
 *   language, gender, modality), then by indicative wait. `timeOfDay` is accepted but has no service field to
 *   match against.
 */
export function match(
  screenings: readonly Screening[],
  prefs: Preferences,
  insurance: InsuranceClass,
  region: Region,
  services: readonly Service[],
  context: MatchContext = {},
): RankedOption[] {
  if (hasUnresolvedCrisis(screenings, context.crisisResolvedAt ?? null)) {
    return [
      {
        rank: 1,
        kind: 'crisis',
        tier: 'crisis',
        service: null,
        reasons: [{ code: 'crisis_active' }],
        eligibility: [],
        coverage: null,
        handoffWindowDays: null,
        current: false,
      },
    ];
  }

  const { row, phq9Total, gad7Total } = selectRow(screenings);
  const currentTier = context.currentTier ?? null;
  const recommended = row.offered;
  const others = TIERS.filter((tier) => !recommended.includes(tier));
  const ordered: { tier: Tier; kind: 'recommended' | 'other' }[] = [
    ...recommended.map((tier) => ({ tier, kind: 'recommended' as const })),
    // The current tier, when the row no longer recommends it, comes straight after the recommended cards.
    ...others.filter((tier) => tier === currentTier).map((tier) => ({ tier, kind: 'other' as const })),
    ...others.filter((tier) => tier !== currentTier).map((tier) => ({ tier, kind: 'other' as const })),
  ];

  const options: RankedOption[] = [];
  for (const { tier, kind } of ordered) {
    const best = bestService(tier, services, prefs, insurance, region);
    if (!best) continue;
    const reasons: Reason[] = kind === 'recommended' ? scoreReasons(phq9Total, gad7Total) : [{ code: 'other_tier' }];
    if (kind === 'recommended' && tier !== recommended[0]) reasons.push({ code: 'bridge_option' });
    if (tier === currentTier) reasons.push({ code: 'current_tier' });
    options.push({
      rank: options.length + 1,
      kind,
      tier,
      service: best.service,
      reasons,
      eligibility: best.eligibility,
      coverage: SAMPLE_COVERAGE[insurance][tier],
      handoffWindowDays: windowFor(tier, row),
      current: tier === currentTier,
    });
  }
  return options;
}
