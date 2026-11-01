import { z } from 'zod';

/**
 * The staff apps send a script policy without `eval`. By default Zod probes for it with `new Function` when the first
 * object schema is built, the browser refuses and reports a policy violation (validation itself still works), and every
 * staff page load would carry a console error. A build that sets `NEXT_PUBLIC_ZOD_JITLESS=true` (the clinician and ops
 * apps do, in `next.config.ts`) switches the compiled fast path off before any schema exists, so nothing probes.
 * Zod reads this once, when a schema is built, which is why it is set from here, the first import of this package,
 * and not from a function a screen calls later. The API and the person app leave it unset and keep the fast path.
 */
if (process.env.NEXT_PUBLIC_ZOD_JITLESS === 'true') z.config({ jitless: true });
