import { useCallback, useEffect, useState } from 'react';
import { xhrGet, errorMessage } from '../services/xhr.js';
import { buildListingsQuery } from '../services/listingsQuery.js';

/**
 * Loads /api/listings for the given filters; reloads when they change or when `reload()` is called. Out-of-date responses are
 * ignored so a slow request cannot overwrite a newer one.
 */
export function useListings(filters) {
  const [state, setState] = useState({ items: [], total: 0, hiddenAutomatically: 0, loading: true, error: null });
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  const query = buildListingsQuery(filters);

  useEffect(() => {
    let current = true;
    setState((s) => ({ ...s, loading: true }));
    xhrGet(`/api/listings?${query}`)
      .then(({ json }) => {
        if (current) {
          setState({
            items: json.items ?? [],
            total: json.total ?? 0,
            hiddenAutomatically: json.hiddenAutomatically ?? 0,
            loading: false,
            error: null,
          });
        }
      })
      .catch((e) => {
        if (current) {
          setState((s) => ({ ...s, loading: false, error: errorMessage(e, 'Could not load listings.') }));
        }
      });
    return () => {
      current = false;
    };
  }, [query, version]);

  return { ...state, reload, version };
}
