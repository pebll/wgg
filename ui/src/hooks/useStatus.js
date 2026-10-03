import { useCallback, useEffect, useState } from 'react';
import { xhrGet } from '../services/xhr.js';
import { isFetchRunning } from '../services/format.js';

const POLL_MS = 30_000;
const FAST_POLL_MS = 2_000;
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * Polls /api/status (every 30 s; every 2 s while a fetch is running or `watching` one); also returns `now`,
 * refreshed on the same tick so relative times re-render, and `refresh()` for an immediate reload.
 */
export function useStatus(watching = false) {
  const [status, setStatus] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  const fast = watching || isFetchRunning(status, now);

  useEffect(() => {
    let current = true;
    const load = () => {
      setNow(Date.now());
      xhrGet('/api/status')
        .then(({ json }) => current && setStatus(json))
        .catch(() => current && setStatus(null));
    };
    load();
    const timer = setInterval(load, fast ? FAST_POLL_MS : POLL_MS);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [fast, version]);

  // Re-render exactly when the "Fetch now" button becomes available, not only on the next poll.
  const availableAt = status?.manualFetch?.availableAt;
  useEffect(() => {
    if (typeof availableAt !== 'number') return undefined;
    const wait = availableAt - Date.now();
    if (wait <= 0) return undefined;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(wait + 50, MAX_TIMEOUT_MS));
    return () => clearTimeout(timer);
  }, [availableAt]);

  return { status, now, refresh };
}
