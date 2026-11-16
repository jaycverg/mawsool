import type { StaffRole } from './enums';

/** One of the seeded demo staff accounts a guest may sign in as. */
export interface DemoGuestAccount {
  /** The seeded staff email (the reserved `.test` domain, so no mail can ever reach it). */
  email: string;
  role: StaffRole;
  /** Names the button's wording in each staff app's message files. */
  key: 'clinicianA' | 'clinicianB' | 'ops' | 'admin' | 'crisisLine';
}

/**
 * The five seeded demo accounts a guest sign-in may open, and nothing else: the API allows exactly these emails, and the
 * clinic and ops sign-in pages build their buttons from this one list. A staff address outside it can never be signed in
 * to by this route, whatever the database holds.
 */
export const DEMO_GUEST_ACCOUNTS: readonly DemoGuestAccount[] = [
  { email: 'clinician.a@demo.mawsool.test', role: 'clinician', key: 'clinicianA' },
  { email: 'clinician.b@demo.mawsool.test', role: 'clinician', key: 'clinicianB' },
  { email: 'ops@demo.mawsool.test', role: 'ops', key: 'ops' },
  { email: 'admin@demo.mawsool.test', role: 'admin', key: 'admin' },
  { email: 'crisisline@demo.mawsool.test', role: 'crisis_line', key: 'crisisLine' },
];
