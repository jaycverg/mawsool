/**
 * The page policy of the staff apps (clinician and ops), which keep a bearer session in the tab and read wellbeing
 * data with it. Decisions, and what they do not do:
 *
 *  - The session stays in `sessionStorage`, in the tab only: it ends when the tab closes and is never sent anywhere
 *    but the API. A cookie would need the API and the apps on one site and CSRF protection, which two origins in
 *    development and an undecided deployment cannot promise. A script that runs in the page can read the session,
 *    so the policy is what limits that.
 *  - `connect-src` names the API and nothing else, so a script cannot send the session or any data to another origin.
 *  - `frame-ancestors 'none'`, `base-uri` and `form-action` close clickjacking and form hijacking; `object-src 'none'`
 *    closes plug-ins.
 *  - Scripts: `'self'` plus `'unsafe-inline'`. Next.js writes the data a page needs to start as an inline script, and
 *    a nonce on it needs every page rendered per request, which these statically built pages are not. This is the
 *    known gap: the policy does not stop an injected inline script. The pages have no way to inject one (every value
 *    is rendered as text, nothing sets raw HTML), and the lint rules and tests hold that line. Development adds
 *    `'unsafe-eval'` and the dev server's socket, which the hot-reload tooling needs; a production build never does.
 */
export function staffContentSecurityPolicy(options: { apiOrigin: string; development: boolean }): string {
  const { apiOrigin, development } = options;
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${development ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    `connect-src 'self' ${apiOrigin}${development ? ' ws: wss:' : ''}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
}

/** The origin (scheme, host, port) of an API address, which is what `connect-src` takes. */
export function originOf(url: string): string {
  return new URL(url).origin;
}

/** The headers every page of a staff app is sent with. */
export function staffSecurityHeaders(options: { apiUrl: string; development: boolean }): { key: string; value: string }[] {
  return [
    { key: 'Content-Security-Policy', value: staffContentSecurityPolicy({ apiOrigin: originOf(options.apiUrl), development: options.development }) },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Referrer-Policy', value: 'no-referrer' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  ];
}
