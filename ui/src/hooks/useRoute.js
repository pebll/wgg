import { useCallback, useEffect, useState } from 'react';
import { parseRoute, routeHash } from '../services/route.js';

/**
 * The hash route ('home' | 'about' | 'login'), kept in sync with the address bar (back/forward included).
 * `navigate(route, {replace})` changes it; home clears the hash. Hash-only, so it needs no server support.
 */
export function useRoute() {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));

  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  const navigate = useCallback((next, { replace = false } = {}) => {
    const hash = routeHash(next);
    if (replace || hash === '') {
      // replaceState does not fire hashchange (and leaves no "#" behind for home)
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${hash}`);
      setRoute(next);
    } else {
      window.location.hash = hash;
    }
  }, []);

  return [route, navigate];
}
