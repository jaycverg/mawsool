/**
 * The public-demo build: the hosted copy of the app that judges open. It is switched on at build time, by
 * `NEXT_PUBLIC_PUBLIC_DEMO=true`, and by nothing else: with it off (every gate, CI and any real build) the crisis screen's
 * numbers are tap-to-call links and the dialler dials, exactly as the app is meant to work.
 *
 * With it on, nothing on the crisis screen dials (a visitor must not ring a real crisis or emergency line), the numbers are
 * shown as text with a label saying so, a note warns that what is typed is visible to everyone using the demo, and the consent
 * screen carries the same note.
 */

/**
 * Reads the flag strictly: `true` is on; unset and empty are off (an empty build argument is the same as none); anything else
 * (`1`, `TRUE`, `yes`, `fasle`) throws, so a typo can neither switch a build that must not dial into a non-dialling one by
 * accident nor leave a hosted build quietly dialling. `next.config.ts` calls it, so a bad value fails `next build`.
 */
export function readPublicDemoFlag(value: string | undefined): boolean {
  if (value === undefined || value === '') return false;
  if (value === 'true') return true;
  throw new Error('NEXT_PUBLIC_PUBLIC_DEMO must be true or be left unset');
}

/** Whether this build is the public demo. Read where it is used, so a test can set the variable. Next inlines the value into the build. */
export function isPublicDemo(): boolean {
  return process.env.NEXT_PUBLIC_PUBLIC_DEMO === 'true';
}
