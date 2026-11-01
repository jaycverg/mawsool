import type { StaffRole } from '@mawsool/types';

/** Base URLs of the two staff apps. */
export interface StaffAppUrls {
  clinician: string;
  ops: string;
}

/** Sign-in links open in English; the page has the language toggle. */
export const STAFF_LINK_LOCALE = 'en';

/** The app a role signs in to: clinicians use the clinician app, ops and admin use the ops app. */
export function staffAppFor(role: StaffRole): keyof StaffAppUrls {
  return role === 'clinician' ? 'clinician' : 'ops';
}

/** The sign-in link for a role: `<app>/<locale>/sign-in/?token=<token>`. */
export function staffSignInLink(role: StaffRole, token: string, apps: StaffAppUrls): string {
  return `${apps[staffAppFor(role)]}/${STAFF_LINK_LOCALE}/sign-in/?token=${encodeURIComponent(token)}`;
}
