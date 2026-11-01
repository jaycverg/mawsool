import type { Instrument, Screening, Service, Tier } from '@mawsool/types';

let counter = 0;
function uuid(): string {
  counter += 1;
  return `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
}

export function screening(instrument: Instrument, total: number, takenAt: string, answers?: number[]): Screening {
  const defaultAnswers: Record<Instrument, number> = { who5: 5, phq9: 9, gad7: 7, cssrs: 6 };
  return {
    id: uuid(),
    instrument,
    answers: answers ?? Array.from({ length: defaultAnswers[instrument] }, () => 0),
    total,
    band: null,
    item9Flag: false,
    takenAt,
  };
}

/** A PHQ-9 whose item 9 answer is `item9` and whose total is `total`. */
export function phq9(total: number, takenAt = '2026-10-01T08:00:00+04:00', item9 = 0): Screening {
  const answers = Array.from({ length: 9 }, () => 0);
  answers[8] = item9;
  return screening('phq9', total, takenAt, answers);
}

export function gad7(total: number, takenAt = '2026-10-01T08:00:00+04:00'): Screening {
  return screening('gad7', total, takenAt);
}

export function service(tier: Tier, overrides: Partial<Service> = {}): Service {
  const base: Service = {
    id: uuid(),
    name: `Sample ${tier} service`,
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
  return { ...base, ...overrides };
}

export const ONE_PER_TIER: Service[] = [
  service('self_help'),
  service('community'),
  service('tele'),
  service('gp'),
  service('specialist'),
];
