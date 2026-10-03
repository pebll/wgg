import { useCallback, useEffect, useState } from 'react';
import { errorMessage, xhrGet, xhrSend } from '../services/xhr.js';

/**
 * The logged-in user's settings (GET /api/settings: `settings` and the `defaults` for "reset"), and `save(partial)`
 * (PUT; resolves with the stored settings, rejects with the xhr rejection so the caller can show the message).
 */
export function useSettings() {
  const [state, setState] = useState({ settings: null, defaults: null, error: null });

  useEffect(() => {
    let current = true;
    xhrGet('/api/settings')
      .then(({ json }) => current && setState({ settings: json.settings, defaults: json.defaults, error: null }))
      .catch((e) => current && setState((s) => ({ ...s, error: errorMessage(e, 'Could not load your settings.') })));
    return () => {
      current = false;
    };
  }, []);

  const save = useCallback(async (partial) => {
    const { json } = await xhrSend('PUT', '/api/settings', partial);
    setState((s) => ({ ...s, settings: json.settings }));
    return json.settings;
  }, []);

  return { ...state, save };
}
