/**
 * The two alert tiers a listing can have for you (computed by the server from your alert rules). User-facing names:
 * "Fantastic" = the offers wgg emails immediately (config key `notify.priority`), "Good" = the ones collected in the
 * digest (`notify.bulk`). The values `fantastic` / `good` are also the `tier` API parameter.
 */
export const TIER_META = {
  fantastic: {
    label: 'Fantastic',
    tooltip: 'Matches your Fantastic alert rule (sent immediately by email)',
  },
  good: {
    label: 'Good',
    tooltip: 'Matches your Good rule (sent in the bulk digest)',
  },
};

/** Metadata of a tier value, or null when there is none (or it is unknown). */
export function tierMeta(tier) {
  return Object.hasOwn(TIER_META, tier) ? { tier, ...TIER_META[tier] } : null;
}
