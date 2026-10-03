import { useState } from 'react';
import { IconChevronDown } from '@douyinfe/semi-icons';
import BarChart from './BarChart.jsx';
import { useStats } from '../hooks/useStats.js';
import { isActiveBin, toggleBin } from '../services/rangeFilters.js';

const OPEN_KEY = 'wgg-distribution-open';
function initialOpen() {
  try {
    return window.localStorage.getItem(OPEN_KEY) !== 'closed';
  } catch {
    return true;
  }
}

/**
 * Collapsible "Distribution" section above the list: Score, AI score, Rent and Distance histograms of the filtered
 * offers, each in its own card. Clicking a bar filters the offers to that bar (`onRangesChange`); clicking it again clears.
 */
export default function Distribution({ filters, version, onRangesChange }) {
  const [open, setOpen] = useState(initialOpen);
  const { stats, error } = useStats(filters, open, version);

  const toggle = () => {
    setOpen(!open);
    try {
      window.localStorage.setItem(OPEN_KEY, open ? 'closed' : 'open');
    } catch {
      // not remembered
    }
  };

  return (
    <section className="distribution" aria-label="Distribution of the current offers">
      <button type="button" className="distribution__toggle" aria-expanded={open} onClick={toggle}>
        <IconChevronDown
          className={open ? 'distribution__chevron' : 'distribution__chevron distribution__chevron--closed'}
        />
        Distribution
        {stats && <span className="distribution__count"> ({stats.total} offers)</span>}
      </button>
      {open && error && <div className="distribution__error">{error}</div>}
      {open && stats && (
        <div className="distribution__charts">
          {[
            {
              key: 'score',
              title: 'Score',
              caption: 'Overall score (1–10)',
              kind: 'score',
              data: stats.score,
              extras: { unscored: stats.score.unscored },
            },
            {
              key: 'ai',
              title: 'AI score',
              caption: 'AI fit score (1–10)',
              kind: 'score',
              data: stats.ai,
              extras: { unassessed: stats.ai?.unassessed },
            },
            {
              key: 'rent',
              title: 'Rent',
              caption: 'Rent in € (50 € steps)',
              kind: 'rent',
              data: stats.rent,
              extras: { unknown: stats.rent.unknown },
            },
            {
              key: 'dist',
              title: 'Distance',
              caption: 'Distance to the target in km',
              kind: 'distance',
              data: stats.distance,
              extras: { unknown: stats.distance.unknown },
            },
          ].map(({ key, title, caption, kind, data, extras }) => (
            <BarChart
              key={key}
              title={title}
              caption={caption}
              kind={kind}
              tone={key}
              bins={data?.bins ?? []}
              extras={extras}
              isActive={(bin, options) => isActiveBin(filters.ranges, key, bin, options)}
              onSelect={(bin, options) => onRangesChange(toggleBin(filters.ranges, key, bin, options))}
            />
          ))}
        </div>
      )}
    </section>
  );
}
