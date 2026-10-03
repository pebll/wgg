import { useCallback, useEffect, useState } from 'react';
import { setUnauthorizedHandler, xhrGet, xhrSend } from '../services/xhr.js';

/**
 * The login session: `user` is {username, admin, email, targetName} while logged in, null on the login screen, `loading` until
 * /api/me answered. A 401 from any later request (session expired or logged out elsewhere) lands on the login screen
 * too, without a page reload.
 */
export function useSession() {
  const [state, setState] = useState({ user: null, loading: true });

  useEffect(() => {
    let current = true;
    setUnauthorizedHandler(() => current && setState({ user: null, loading: false }));
    xhrGet('/api/me')
      .then(({ json }) => current && setState({ user: json, loading: false }))
      .catch(() => current && setState({ user: null, loading: false }));
    return () => {
      current = false;
      setUnauthorizedHandler(null);
    };
  }, []);

  /** Rejects with the xhr rejection (see loginMessage) when the login fails. */
  const login = useCallback(async (username, password) => {
    const { json } = await xhrSend('POST', '/api/login', { username, password });
    setState({ user: json, loading: false });
  }, []);

  const logout = useCallback(async () => {
    try {
      await xhrSend('POST', '/api/logout');
    } catch {
      // the session is gone either way
    }
    setState({ user: null, loading: false });
  }, []);

  /** Keeps the name of the scoring target in step with Options (the dashboard labels distances with it). */
  const setTargetName = useCallback(
    (targetName) => setState((s) => (s.user ? { ...s, user: { ...s.user, targetName } } : s)),
    [],
  );

  return { ...state, login, logout, setTargetName };
}
