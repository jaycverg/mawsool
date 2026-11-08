import { match } from '@mawsool/rules';
import type { Screening, Service, Tier } from '@mawsool/types';
import { describe, expect, it } from 'vitest';
import { clinicFirst } from '../lib/clinic-first';

let counter = 0;
function service(tier: Tier): Service {
  counter += 1;
  return {
    id: `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`,
    name: `Sample ${tier}`,
    tier,
    modality: tier === 'tele' ? 'tele' : 'in_person',
    languages: ['ar', 'en'],
    clinicianGenders: ['female', 'male'],
    insuranceClasses: ['thiqa', 'daman_basic', 'daman_enhanced', 'other_private', 'not_sure'],
    region: 'abu_dhabi_city',
    indicativeWaitDays: 5,
    facilityId: tier === 'self_help' ? null : '11111111-1111-4111-8111-111111111111',
    sample: true,
  };
}
const ALL = (['self_help', 'community', 'tele', 'gp', 'specialist'] as const).map(service);

/** After a crisis from item 9 alone the only finished PHQ-9 totals 1, which `match()` answers with guided self-help. */
const PHQ9_OF_ONE: Screening = { id: 's', instrument: 'phq9', answers: [0, 0, 0, 0, 0, 0, 0, 0, 1], total: 1, band: 'minimal', item9Flag: true, takenAt: '2026-11-01T08:00:00+04:00' } as Screening;
const tiers = (options: { tier: string }[]) => options.map((option) => option.tier);
const options = (services: Service[]) => match([PHQ9_OF_ONE], {}, 'daman_basic', 'abu_dhabi_city', services, { currentTier: null, crisisResolvedAt: '2026-11-01T08:01:00+04:00' });

describe('the options after the next-day check asked for a doctor or a specialist', () => {
  it('starts from a ranking that leads with something else, which is why the order has to change', () => {
    expect(options(ALL)[0]!.tier).toBe('self_help');
  });

  it('leads with the GP and the specialist as the cards, and keeps everything else behind the other options', () => {
    const { cards, others } = clinicFirst(options(ALL));
    expect(tiers(cards).sort()).toEqual(['gp', 'specialist']);
    expect(tiers(others).sort()).toEqual(['community', 'self_help', 'tele']);
  });

  it('keeps the ordinary split when the directory holds no GP and no specialist, so the list is never empty', () => {
    const { cards, others } = clinicFirst(options(ALL.filter((entry) => entry.tier !== 'gp' && entry.tier !== 'specialist')));
    expect(cards.length).toBeGreaterThan(0);
    expect(tiers([...cards, ...others])).not.toContain('gp');
  });
});
