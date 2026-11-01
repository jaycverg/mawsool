import { INSURANCE_CLASSES, TIERS, type InsuranceClass, type Screening, type Tier } from '@mawsool/types';
import { describe, expect, it } from 'vitest';
import { FALLBACK_HANDOFF_WINDOW_DAYS, SAMPLE_COVERAGE, indicativeCoverage, match } from '../src';
import { ONE_PER_TIER, gad7, phq9, screening, service } from './fixtures';

const REGION = 'abu_dhabi_city' as const;

function run(history: Screening[], options: { insurance?: InsuranceClass; services?: typeof ONE_PER_TIER; currentTier?: Tier; crisisResolvedAt?: string } = {}) {
  return match(history, {}, options.insurance ?? 'daman_basic', REGION, options.services ?? ONE_PER_TIER, {
    currentTier: options.currentTier ?? null,
    crisisResolvedAt: options.crisisResolvedAt ?? null,
  });
}

/** Screen result, expected recommended tiers in card order, expected hand-off window. */
const BANDS: { name: string; history: Screening[]; recommended: Tier[]; window: number | null }[] = [
  { name: 'no scores', history: [], recommended: ['self_help'], window: null },
  { name: 'PHQ-9 0-4', history: [phq9(3)], recommended: ['self_help'], window: null },
  { name: 'GAD-7 0-4', history: [gad7(4)], recommended: ['self_help'], window: null },
  { name: 'PHQ-9 5-9', history: [phq9(7)], recommended: ['self_help', 'community'], window: 14 },
  { name: 'GAD-7 5-9', history: [gad7(9)], recommended: ['self_help', 'community'], window: 14 },
  { name: 'PHQ-9 10-14', history: [phq9(12)], recommended: ['gp', 'tele'], window: 7 },
  { name: 'GAD-7 10-14', history: [gad7(14)], recommended: ['gp', 'tele'], window: 7 },
  { name: 'PHQ-9 15-19', history: [phq9(15)], recommended: ['specialist', 'gp'], window: 14 },
  { name: 'PHQ-9 20-27', history: [phq9(20)], recommended: ['specialist', 'gp', 'tele'], window: 14 },
  { name: 'GAD-7 15-21', history: [gad7(15)], recommended: ['specialist', 'gp', 'tele'], window: 14 },
];

describe('every screen result x every insurance class', () => {
  for (const band of BANDS) {
    for (const insurance of INSURANCE_CLASSES) {
      it(`${band.name}, ${insurance}`, () => {
        const options = run(band.history, { insurance });
        const recommended = options.filter((o) => o.kind === 'recommended');
        expect(recommended.map((o) => o.tier)).toEqual(band.recommended);
        for (const option of options) {
          expect(option.coverage).toBe(SAMPLE_COVERAGE[insurance][option.tier as Tier]);
          expect(option.coverage).toBe(indicativeCoverage(insurance, option.tier as Tier));
          expect(option.handoffWindowDays).toBe(option.tier === 'self_help' ? null : (band.window ?? FALLBACK_HANDOFF_WINDOW_DAYS));
        }
      });
    }
  }
});

describe('card order and "other options"', () => {
  it('lists recommended tiers first in table order, then every other tier least intensive first', () => {
    const options = run([phq9(12)]);
    expect(options.map((o) => `${o.kind}:${o.tier}`)).toEqual([
      'recommended:gp',
      'recommended:tele',
      'other:self_help',
      'other:community',
      'other:specialist',
    ]);
    expect(options.map((o) => o.rank)).toEqual([1, 2, 3, 4, 5]);
  });

  it('covers every tier exactly once when each has a service', () => {
    for (const band of BANDS) {
      expect(run(band.history).map((o) => o.tier).sort()).toEqual([...TIERS].sort());
    }
  });

  it('skips a tier that has no service', () => {
    const options = run([phq9(12)], { services: ONE_PER_TIER.filter((s) => s.tier !== 'tele') });
    expect(options.map((o) => o.tier)).toEqual(['gp', 'self_help', 'community', 'specialist']);
  });

  it('returns nothing when there are no services at all', () => {
    expect(run([phq9(12)], { services: [] })).toEqual([]);
  });
});

describe('reasons', () => {
  it('cite the totals behind the row and mark the bridge tiers', () => {
    const options = run([phq9(21), gad7(8)]);
    expect(options[0]?.reasons).toEqual([
      { code: 'score_phq9', params: { total: 21 } },
      { code: 'score_gad7', params: { total: 8 } },
    ]);
    expect(options[1]?.reasons.at(-1)).toEqual({ code: 'bridge_option' });
    expect(options.at(-1)?.reasons).toEqual([{ code: 'other_tier' }]);
  });

  it('say there were no scores when the person has none', () => {
    expect(run([])[0]?.reasons).toEqual([{ code: 'no_scores' }]);
  });

  it('cite only the instrument that was taken', () => {
    expect(run([gad7(11)])[0]?.reasons).toEqual([{ code: 'score_gad7', params: { total: 11 } }]);
  });
});

describe('re-match keeps the current tier as a card (demo step 4)', () => {
  const history = [
    gad7(9, '2026-10-08T08:00:00+04:00'),
    phq9(7, '2026-10-08T08:05:00+04:00'),
    gad7(14, '2026-10-29T08:00:00+04:00'),
  ];

  it('offers a GP, tele, and the self-help the person is on', () => {
    const options = run(history, { currentTier: 'self_help' });
    expect(options.slice(0, 3).map((o) => o.tier)).toEqual(['gp', 'tele', 'self_help']);
    expect(options.slice(0, 3).map((o) => o.kind)).toEqual(['recommended', 'recommended', 'other']);
    expect(options[2]).toMatchObject({ current: true, reasons: [{ code: 'other_tier' }, { code: 'current_tier' }] });
    expect(options[0]?.handoffWindowDays).toBe(7);
  });

  it('marks the current tier in place when the row still recommends it', () => {
    const options = run([phq9(12)], { currentTier: 'gp' });
    expect(options[0]).toMatchObject({ tier: 'gp', kind: 'recommended', current: true });
    expect(options[0]?.reasons.at(-1)).toEqual({ code: 'current_tier' });
    expect(options.filter((o) => o.current)).toHaveLength(1);
  });

  it('flags nothing as current on a first match', () => {
    expect(run(history).some((o) => o.current)).toBe(false);
  });
});

describe('crisis takes precedence', () => {
  const item9 = phq9(5, '2026-10-01T08:00:00+04:00', 1);

  it('returns only the crisis option while a trigger is unresolved', () => {
    const options = run([item9, gad7(20)]);
    expect(options).toEqual([
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
    ]);
  });

  it('fires on a C-SSRS yes', () => {
    const cssrs = screening('cssrs', 1, '2026-10-01T08:00:00+04:00', [1, 0, 0, 0, 0, 0]);
    expect(run([cssrs])[0]?.kind).toBe('crisis');
  });

  it('does not re-fire on an old item 9 once the crisis is resolved, and matches on the scores', () => {
    const options = run([item9], { crisisResolvedAt: '2026-10-01T08:10:00+04:00' });
    expect(options[0]).toMatchObject({ kind: 'recommended', tier: 'self_help' });
  });

  it('fires again on a new item 9 answer after the resolution', () => {
    const again = phq9(8, '2026-10-15T08:00:00+04:00', 3);
    expect(run([item9, again], { crisisResolvedAt: '2026-10-01T08:10:00+04:00' })[0]?.kind).toBe('crisis');
  });

  it('is not triggered by a later check-in that answers item 9 with 0 once the earlier one is resolved', () => {
    const clean = phq9(8, '2026-10-15T08:00:00+04:00', 0);
    expect(run([item9, clean], { crisisResolvedAt: '2026-10-01T08:10:00+04:00' })[0]?.kind).toBe('recommended');
  });
});

describe('choosing a service within a tier', () => {
  it('prefers the service with fewest things to check, then the shorter wait', () => {
    const farAway = service('gp', { name: 'Far', region: 'al_ain', indicativeWaitDays: 1 });
    const near = service('gp', { name: 'Near', indicativeWaitDays: 9 });
    const nearFaster = service('gp', { name: 'Near fast', indicativeWaitDays: 3 });
    const options = match([phq9(12)], {}, 'thiqa', REGION, [farAway, near, nearFaster, ...ONE_PER_TIER.filter((s) => s.tier !== 'gp')]);
    expect(options.find((o) => o.tier === 'gp')?.service?.name).toBe('Near fast');
  });

  it('breaks ties by name, then id', () => {
    const a = service('gp', { name: 'Alpha', id: '00000000-0000-4000-8000-0000000000bb' });
    const b = service('gp', { name: 'Alpha', id: '00000000-0000-4000-8000-0000000000aa' });
    const c = service('gp', { name: 'Beta', id: '00000000-0000-4000-8000-0000000000cc' });
    const pick = (list: typeof ONE_PER_TIER) =>
      match([phq9(12)], {}, 'thiqa', REGION, list).find((o) => o.tier === 'gp')?.service?.id;
    expect(pick([a, b, c])).toBe('00000000-0000-4000-8000-0000000000aa');
    expect(pick([c, b, a])).toBe('00000000-0000-4000-8000-0000000000aa');
    expect(pick([c])).toBe('00000000-0000-4000-8000-0000000000cc');
  });

  it('reports eligibility per need and counts only stated preferences', () => {
    const arabicFemaleTele = service('tele', { languages: ['ar'], clinicianGenders: ['female'], insuranceClasses: ['thiqa'] });
    const [first] = match([phq9(12)], { language: 'ur', clinicianGender: 'male', modality: 'in_person' }, 'daman_basic', 'al_ain', [arabicFemaleTele]);
    expect(first?.eligibility).toEqual([
      { kind: 'insurance', status: 'check' },
      { kind: 'region', status: 'ok' },
      { kind: 'language', status: 'check' },
      { kind: 'gender', status: 'check' },
      { kind: 'modality', status: 'check' },
    ]);
    const [matching] = match([phq9(12)], { language: 'ar', clinicianGender: 'female', modality: 'tele' }, 'thiqa', 'al_ain', [arabicFemaleTele]);
    expect(matching?.eligibility.map((e) => e.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    const [none] = match([phq9(12)], {}, 'thiqa', REGION, [arabicFemaleTele]);
    expect(none?.eligibility.slice(2).map((e) => e.status)).toEqual(['not_requested', 'not_requested', 'not_requested']);
  });

  it('treats a service with no insurance classes as needing no insurance check, and flags a region mismatch', () => {
    const free = service('self_help', { insuranceClasses: [], region: 'al_dhafra' });
    const [option] = match([], {}, 'not_sure', REGION, [free]);
    expect(option?.eligibility.slice(0, 2)).toEqual([
      { kind: 'insurance', status: 'ok' },
      { kind: 'region', status: 'check' },
    ]);
  });

  it('does not change the order or the cards when only a person-irrelevant field changes', () => {
    const before = run([phq9(12)]);
    const after = run([phq9(12)], { services: [...ONE_PER_TIER].reverse() });
    expect(after.map((o) => o.service?.id)).toEqual(before.map((o) => o.service?.id));
  });
});

describe('sample coverage table', () => {
  it('has a value for every insurance class and tier', () => {
    for (const insurance of INSURANCE_CLASSES) {
      expect(Object.keys(SAMPLE_COVERAGE[insurance]).sort()).toEqual([...TIERS].sort());
    }
  });

  it('matches the spec example for Daman Basic: PHC visit covered, private therapy pay and claim', () => {
    expect(indicativeCoverage('daman_basic', 'gp')).toBe('covered');
    expect(indicativeCoverage('daman_basic', 'specialist')).toBe('pay_and_claim');
  });
});
