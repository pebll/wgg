import { DEFAULT_WINDOW, inWindow, isValidWindow, nextWindowStart } from '../../ui/src/services/schedule.js';

/**
 * The fetch window: WG-Gesucht is only contacted (search cycles and detail pages) while at least one user may receive a
 * Good (bulk) digest, i.e. inside the union of all users' Good send windows (earliest `from` .. latest `to`, local
 * time of the server). Users with Good alerts switched off still count with their window. Without any valid window
 * (no users) it is the default 07-23. The LLM queue never touches WG-Gesucht and is not bound to it.
 *
 * @param {{users: {username: string}[], settings: (userId: string) => any}} directory
 * @returns {{from: number, to: number}}
 */
export function fetchWindowOf(directory) {
  const windows = directory.users
    .map((u) => directory.settings(u.username)?.notify?.bulk?.window)
    .filter(isValidWindow);
  if (windows.length === 0) return { ...DEFAULT_WINDOW };
  return { from: Math.min(...windows.map((w) => w.from)), to: Math.max(...windows.map((w) => w.to)) };
}

/** True when WG-Gesucht may be contacted at `ms`. */
export const isFetchOpen = (window, ms) => inWindow(window, ms);

/** Milliseconds until the window opens (0 when it is open now). */
export function msUntilFetchOpen(window, ms) {
  return isFetchOpen(window, ms) ? 0 : nextWindowStart(window, ms) - ms;
}

/** The next time the window opens, strictly after `ms`. */
export const fetchOpensAt = (window, ms) => nextWindowStart(window, ms);
