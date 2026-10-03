import { Tooltip } from '@douyinfe/semi-ui-19';
import { tierMeta } from '../services/tiers.js';

/**
 * The small icon of a tier: a sparkle for Fantastic (brand coral), a thumb up for Good (green). Decorative: the text
 * label next to it (or `aria-label` on the wrapper) is what assistive technology reads.
 */
export function TierIcon({ tier, size = 14 }) {
  const common = { className: `tier-icon tier-icon--${tier}`, width: size, height: size, viewBox: '0 0 24 24' };
  if (tier === 'fantastic') {
    return (
      <svg {...common} aria-hidden="true" focusable="false">
        <path fill="currentColor" d="M12 1.5l2.6 7.9 7.9 2.6-7.9 2.6L12 22.5l-2.6-7.9L1.5 12l7.9-2.6z" />
      </svg>
    );
  }
  return (
    <svg {...common} aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M1 21h4V9H1v12zm22-11a2 2 0 0 0-2-2h-6.3l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10a2 2 0 0 0 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z"
      />
    </svg>
  );
}

/** Icon and name of a tier as plain inline content (filter options, headings). Renders nothing for an unknown tier. */
export function TierLabel({ tier, children }) {
  const meta = tierMeta(tier);
  if (!meta) return null;
  return (
    <span className="tier-label">
      <TierIcon tier={tier} />
      {children ?? meta.label}
    </span>
  );
}

/** The badge on a tile and in the side panel; only rendered for a listing that has a tier. */
export default function TierBadge({ tier }) {
  const meta = tierMeta(tier);
  if (!meta) return null;
  return (
    <Tooltip content={meta.tooltip}>
      <span className={`tier-badge tier-badge--${tier}`} aria-label={`${meta.label}: ${meta.tooltip}`}>
        <TierIcon tier={tier} size={12} />
        {meta.label}
      </span>
    </Tooltip>
  );
}
