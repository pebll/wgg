import { useEffect, useState } from 'react';
import { xhrGet, errorMessage } from '../services/xhr.js';
import { buildStatsQuery } from '../services/listingsQuery.js';

/**
 * Loads /api/stats for the current filters while `enabled`; reloads when the filters or `version`
 * (bumped when the list reloads, e.g. after hiding an offer) change. Stale responses are ignored.
 */
export function useStats(filters, enabled, version) {
  const [state, setState] = useState({ stats: null, error: null });
  const query = buildStatsQuery(filters);

  useEffect(() => {
    if (!enabled) return undefined;
    let current = true;
    xhrGet(`/api/stats?${query}`)
      .then(({ json }) => current && setState({ stats: json, error: null }))
      .catch((e) => current && setState((s) => ({ ...s, error: errorMessage(e, 'Could not load the distribution.') })));
    return () => {
      current = false;
    };
  }, [query, enabled, version]);

  return state;
}
