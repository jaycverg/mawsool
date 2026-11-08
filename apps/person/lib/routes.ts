import { isLocale, localeFromPathname } from '@mawsool/ui';

/**
 * Screens that lead to matching or to a ticket, and the questionnaire that feeds them. While an unresolved crisis
 * trigger exists every one of these sends the person to the crisis screen instead, whether they arrive by reload,
 * by the back button or by a typed address. Add a route here when a screen is added that must not open mid-crisis.
 * Settings, home and the crisis screen itself are deliberately not listed.
 */
export const GUARDED_ROUTES = ['/check-in', '/result', '/check-ins', '/options', '/consent', '/ticket', '/reroute', '/follow-up', '/remeasure', '/next-day'] as const;

/** The path with its locale segment removed and a trailing slash dropped: `/ar/options/` gives `/options`. */
export function stripLocale(pathname: string): string {
  const withoutLocale = localeFromPathname(pathname) ? pathname.replace(/^\/[^/]+/, '') : pathname;
  const trimmed = withoutLocale.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

const isUnder = (pathname: string, routes: readonly string[]): boolean => {
  const path = stripLocale(pathname);
  return routes.some((route) => path === route || path.startsWith(`${route}/`));
};

/** True when the path, or any path beneath it, is a guarded screen. */
export function isGuardedPath(pathname: string): boolean {
  return isUnder(pathname, GUARDED_ROUTES);
}

/**
 * Screens an anonymous session cannot open, because each needs the server: the directory and matching, the consent screen,
 * a ticket and its follow-ups, the re-check of a ticket, and the two ways in with an invite. In an anonymous session they
 * show a short explanation instead, and nothing of them renders, so nothing on them can start a request. Add a route here
 * when a screen is added that talks to the server.
 */
export const ANONYMOUS_WALLED_ROUTES = ['/options', '/consent', '/ticket', '/reroute', '/follow-up', '/remeasure', '/next-day', '/claim', '/tamm'] as const;

/** True when the path, or any path beneath it, is a screen an anonymous session cannot open. */
export function isAnonymousWalledPath(pathname: string): boolean {
  return isUnder(pathname, ANONYMOUS_WALLED_ROUTES);
}

/** A path inside the app for a locale: `href('ar', 'crisis')` gives `/ar/crisis/`. */
export function href(locale: string, screen: string, query?: Record<string, string>): string {
  const base = `/${isLocale(locale) ? locale : 'en'}/${screen ? `${screen}/` : ''}`;
  const search = query ? `?${new URLSearchParams(query).toString()}` : '';
  return `${base}${search}`;
}
