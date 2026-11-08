import type {
  CareLanguage,
  Gender,
  InsuranceClass,
  Modality,
  Region,
  StaffRole,
  Tier,
} from '@mawsool/types';

/** The seed is anchored to this instant instead of the wall clock, so every run produces the same data. */
export const SEED_ANCHOR = new Date('2026-11-01T00:00:00+04:00');

export const FACILITY_A_ID = '00000000-0000-4000-8000-00000000fa01';
export const FACILITY_B_ID = '00000000-0000-4000-8000-00000000fb02';

export interface FacilityFixture {
  id: string;
  name: string;
  /** Arabic name. Sample copy that no Arabic speaker has reviewed yet. */
  nameAr: string;
  region: Region;
  contactText: string;
  /** Arabic contact text. Sample copy that no Arabic speaker has reviewed yet. */
  contactTextAr: string;
}

export const FACILITIES: FacilityFixture[] = [
  {
    id: FACILITY_A_ID,
    name: 'Sample PHC · Khalifa City',
    nameAr: 'نموذج: مركز الرعاية الأولية · مدينة خليفة',
    region: 'abu_dhabi_city',
    contactText: 'Sample reception desk. Contact details are placeholders.',
    contactTextAr: 'مكتب استقبال نموذجي. بيانات التواصل مؤقتة وليست حقيقية.',
  },
  {
    id: FACILITY_B_ID,
    name: 'Sample Clinic · Al Ain',
    nameAr: 'نموذج: عيادة · العين',
    region: 'al_ain',
    contactText: 'Sample reception desk. Contact details are placeholders.',
    contactTextAr: 'مكتب استقبال نموذجي. بيانات التواصل مؤقتة وليست حقيقية.',
  },
];

export interface StaffFixture {
  id: string;
  email: string;
  name: string;
  role: StaffRole;
  facilityId: string | null;
}

/** Demo staff. The addresses use the reserved .test domain, so no mail can ever reach a real inbox. */
export const STAFF: StaffFixture[] = [
  { id: '00000000-0000-4000-8000-0000000000c1', email: 'clinician.a@demo.mawsool.test', name: 'Demo clinician A', role: 'clinician', facilityId: FACILITY_A_ID },
  { id: '00000000-0000-4000-8000-0000000000c2', email: 'clinician.b@demo.mawsool.test', name: 'Demo clinician B', role: 'clinician', facilityId: FACILITY_B_ID },
  { id: '00000000-0000-4000-8000-0000000000c3', email: 'ops@demo.mawsool.test', name: 'Demo ops lead', role: 'ops', facilityId: null },
  { id: '00000000-0000-4000-8000-0000000000c4', email: 'admin@demo.mawsool.test', name: 'Demo admin', role: 'admin', facilityId: null },
  { id: '00000000-0000-4000-8000-0000000000c5', email: 'crisisline@demo.mawsool.test', name: 'Demo crisis-line operator (mock)', role: 'crisis_line', facilityId: null },
];

export interface ServiceFixture {
  name: string;
  tier: Tier;
  modality: Modality;
  languages: CareLanguage[];
  genders: Gender[];
  region: Region;
  /** Null for self-help, which has no facility. */
  facility: 'A' | 'B' | null;
  waitDays: [number, number];
}

const ALL_INSURANCE: InsuranceClass[] = ['thiqa', 'daman_basic', 'daman_enhanced', 'other_private', 'not_sure'];
const PUBLIC_INSURANCE: InsuranceClass[] = ['thiqa', 'daman_basic', 'daman_enhanced', 'not_sure'];
export const INSURANCE_BY_TIER: Record<Tier, InsuranceClass[]> = {
  // Free resources take no insurance claim.
  self_help: [],
  community: [],
  tele: ALL_INSURANCE,
  gp: PUBLIC_INSURANCE,
  specialist: ALL_INSURANCE,
};

/**
 * The Arabic name of each sample service, keyed by its English name. Written for the sample directory and not yet
 * reviewed by an Arabic speaker. It holds no Latin letters, so an Arabic reader never sees a Latin service name.
 * It sits apart from `SERVICES` so that adding it cannot touch the order or the values the seed's random draws follow.
 */
export const SERVICE_NAMES_AR: Readonly<Record<string, string>> = {
  'Sample guided self-help programme 1': 'نموذج: برنامج المساعدة الذاتية الموجّه 1',
  'Sample guided self-help programme 2': 'نموذج: برنامج المساعدة الذاتية الموجّه 2',
  'Sample self-help library 1': 'نموذج: مكتبة المساعدة الذاتية 1',
  'Sample self-help library 2': 'نموذج: مكتبة المساعدة الذاتية 2',
  'Sample breathing and sleep course': 'نموذج: دورة التنفس والنوم',
  'Sample wellbeing journal programme': 'نموذج: برنامج يوميات العافية',
  'Sample community support group 1': 'نموذج: مجموعة دعم مجتمعية 1',
  'Sample community support group 2': 'نموذج: مجموعة دعم مجتمعية 2',
  'Sample community support group 3': 'نموذج: مجموعة دعم مجتمعية 3',
  'Sample peer-led circle': 'نموذج: حلقة يقودها الأقران',
  'Sample tele-counselling line 1': 'نموذج: خط الإرشاد عن بُعد 1',
  'Sample tele-counselling line 2': 'نموذج: خط الإرشاد عن بُعد 2',
  'Sample tele-counselling line 3': 'نموذج: خط الإرشاد عن بُعد 3',
  'Sample evening tele-session': 'نموذج: جلسة مسائية عن بُعد',
  'Sample family medicine clinic 1': 'نموذج: عيادة طب الأسرة 1',
  'Sample family medicine clinic 2': 'نموذج: عيادة طب الأسرة 2',
  'Sample primary care centre 1': 'نموذج: مركز الرعاية الأولية 1',
  'Sample primary care centre 2': 'نموذج: مركز الرعاية الأولية 2',
  'Sample primary care centre 3': 'نموذج: مركز الرعاية الأولية 3',
  'Sample outreach clinic': 'نموذج: عيادة التوعية المجتمعية',
  'Sample mental health clinic 1': 'نموذج: عيادة الصحة النفسية 1',
  'Sample mental health clinic 2': 'نموذج: عيادة الصحة النفسية 2',
  'Sample psychiatry service 1': 'نموذج: خدمة الطب النفسي 1',
  'Sample psychiatry service 2': 'نموذج: خدمة الطب النفسي 2',
};

/** Twenty-four sample services. Every record is labelled sample; none is a real provider. */
export const SERVICES: ServiceFixture[] = [
  { name: 'Sample guided self-help programme 1', tier: 'self_help', modality: 'tele', languages: ['ar', 'en'], genders: [], region: 'abu_dhabi_city', facility: null, waitDays: [0, 1] },
  { name: 'Sample guided self-help programme 2', tier: 'self_help', modality: 'tele', languages: ['ar', 'en', 'ur'], genders: [], region: 'al_ain', facility: null, waitDays: [0, 1] },
  { name: 'Sample self-help library 1', tier: 'self_help', modality: 'tele', languages: ['ar', 'en', 'hi'], genders: [], region: 'al_dhafra', facility: null, waitDays: [0, 0] },
  { name: 'Sample self-help library 2', tier: 'self_help', modality: 'tele', languages: ['en', 'tl'], genders: [], region: 'abu_dhabi_city', facility: null, waitDays: [0, 0] },
  { name: 'Sample breathing and sleep course', tier: 'self_help', modality: 'tele', languages: ['ar', 'en'], genders: [], region: 'abu_dhabi_city', facility: null, waitDays: [0, 1] },
  { name: 'Sample wellbeing journal programme', tier: 'self_help', modality: 'tele', languages: ['ar', 'en', 'ur', 'hi', 'tl'], genders: [], region: 'al_ain', facility: null, waitDays: [0, 1] },
  { name: 'Sample community support group 1', tier: 'community', modality: 'in_person', languages: ['ar', 'en'], genders: ['female', 'male'], region: 'abu_dhabi_city', facility: 'A', waitDays: [3, 10] },
  { name: 'Sample community support group 2', tier: 'community', modality: 'in_person', languages: ['ar', 'ur', 'hi'], genders: ['female', 'male'], region: 'al_ain', facility: 'B', waitDays: [4, 12] },
  { name: 'Sample community support group 3', tier: 'community', modality: 'in_person', languages: ['ar', 'en', 'tl'], genders: ['female'], region: 'al_dhafra', facility: 'B', waitDays: [5, 14] },
  { name: 'Sample peer-led circle', tier: 'community', modality: 'in_person', languages: ['en', 'ur', 'hi'], genders: ['male'], region: 'abu_dhabi_city', facility: 'A', waitDays: [3, 9] },
  { name: 'Sample tele-counselling line 1', tier: 'tele', modality: 'tele', languages: ['ar', 'en'], genders: ['female', 'male'], region: 'abu_dhabi_city', facility: 'A', waitDays: [1, 4] },
  { name: 'Sample tele-counselling line 2', tier: 'tele', modality: 'tele', languages: ['ar', 'en', 'ur'], genders: ['female'], region: 'al_ain', facility: 'B', waitDays: [1, 5] },
  { name: 'Sample tele-counselling line 3', tier: 'tele', modality: 'tele', languages: ['en', 'hi', 'tl'], genders: ['female', 'male'], region: 'al_dhafra', facility: 'B', waitDays: [2, 6] },
  { name: 'Sample evening tele-session', tier: 'tele', modality: 'tele', languages: ['ar', 'en', 'ur', 'hi'], genders: ['male'], region: 'abu_dhabi_city', facility: 'A', waitDays: [1, 3] },
  { name: 'Sample family medicine clinic 1', tier: 'gp', modality: 'in_person', languages: ['ar', 'en'], genders: ['female', 'male'], region: 'abu_dhabi_city', facility: 'A', waitDays: [2, 7] },
  { name: 'Sample family medicine clinic 2', tier: 'gp', modality: 'in_person', languages: ['ar', 'en', 'ur', 'hi'], genders: ['female', 'male'], region: 'abu_dhabi_city', facility: 'A', waitDays: [3, 8] },
  { name: 'Sample primary care centre 1', tier: 'gp', modality: 'in_person', languages: ['ar', 'en', 'tl'], genders: ['female'], region: 'abu_dhabi_city', facility: 'A', waitDays: [2, 6] },
  { name: 'Sample primary care centre 2', tier: 'gp', modality: 'in_person', languages: ['ar', 'en', 'ur'], genders: ['female', 'male'], region: 'al_ain', facility: 'B', waitDays: [3, 9] },
  { name: 'Sample primary care centre 3', tier: 'gp', modality: 'in_person', languages: ['ar', 'en', 'hi'], genders: ['male'], region: 'al_ain', facility: 'B', waitDays: [2, 7] },
  { name: 'Sample outreach clinic', tier: 'gp', modality: 'in_person', languages: ['ar', 'en'], genders: ['female', 'male'], region: 'al_dhafra', facility: 'B', waitDays: [4, 10] },
  { name: 'Sample mental health clinic 1', tier: 'specialist', modality: 'in_person', languages: ['ar', 'en', 'ur'], genders: ['female', 'male'], region: 'abu_dhabi_city', facility: 'A', waitDays: [6, 14] },
  { name: 'Sample mental health clinic 2', tier: 'specialist', modality: 'in_person', languages: ['ar', 'en', 'hi', 'tl'], genders: ['female'], region: 'abu_dhabi_city', facility: 'A', waitDays: [7, 15] },
  { name: 'Sample psychiatry service 1', tier: 'specialist', modality: 'in_person', languages: ['ar', 'en', 'ur'], genders: ['male'], region: 'al_ain', facility: 'B', waitDays: [8, 16] },
  { name: 'Sample psychiatry service 2', tier: 'specialist', modality: 'in_person', languages: ['ar', 'en'], genders: ['female', 'male'], region: 'al_ain', facility: 'B', waitDays: [7, 14] },
];
