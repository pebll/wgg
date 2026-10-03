import { matchesRules } from './rules.js';

/** The alert tiers, best first. Internally the rule sets are still called `priority` and `bulk`. */
export const TIERS = ['fantastic', 'good'];

/**
 * The tier a listing has for a user: 'fantastic' when it matches the priority rules (emailed immediately), else 'good'
 * when it matches the bulk rules (collected in the digest), else null. The one place that decides it: the notifier (who
 * gets which mail) and the stored `user_listings.tier` (the filter in the UI) both call this, so they cannot disagree.
 *
 * @param {{priority?: {rules?: object[]}, bulk?: {rules?: object[]}}} notify The user's notify settings.
 * @param {Parameters<typeof matchesRules>[1]} values See `notifyValues` in notifyStorage.js.
 * @returns {'fantastic'|'good'|null}
 */
export function tierFor(notify, values) {
  if (matchesRules(notify?.priority?.rules ?? [], values)) return 'fantastic';
  if (matchesRules(notify?.bulk?.rules ?? [], values)) return 'good';
  return null;
}
