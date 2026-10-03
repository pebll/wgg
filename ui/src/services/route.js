/**
 * Hash routing of the logged-out pages. Hash-only (`#/about`, `#/login`), so every URL is relative to the page and
 * works at / and behind a prefix such as /wgg/ with the SPA fallback; the server never sees the route.
 */

const ROUTE_HASHES = { about: '#/about', login: '#/login' };

/** 'about' | 'login' | 'home' (no hash or an unknown one). */
export function parseRoute(hash) {
  const clean = String(hash ?? '')
    .toLowerCase()
    .replace(/\/+$/, '');
  return Object.keys(ROUTE_HASHES).find((route) => ROUTE_HASHES[route] === clean) ?? 'home';
}

/** The hash of a route; home has none. */
export function routeHash(route) {
  return ROUTE_HASHES[route] ?? '';
}

/**
 * Which page to show: visitors land on the presentation and reach the login form with #/login; a logged-in user sees
 * the app and can still open the presentation with #/about.
 * @returns {'about'|'login'|'app'}
 */
export function visibleView(route, loggedIn) {
  if (loggedIn) return route === 'about' ? 'about' : 'app';
  return route === 'login' ? 'login' : 'about';
}
