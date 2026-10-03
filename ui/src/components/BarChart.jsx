import { barGeometry, binLabel, describeHistogram, sideCounts } from '../services/histogram.js';

const WIDTH = 240;
const HEIGHT = 96;
const MAX_X_LABELS = 6;
const MARGIN = { top: 6, right: 6, bottom: 18, left: 24 };

/**
 * Small inline-SVG bar chart (no chart dependency) in its own card. Colors come from Semi's CSS variables, so it
 * follows the light/dark theme. Each bar carries a <title> tooltip; the figure has an aria-label summary.
 * A bar is a button: `onSelect(bin, {last})` sets (or, when it is the `isActive` bar, clears) the range filter of
 * this chart; the active bar is highlighted and the others dimmed.
 *
 * `tone` (score, ai, rent, dist) picks the bar color of the chart (see the --chart-color rules in Index.less).
 *
 * @param {{title: string, caption: string, tone?: string, bins: {from: number, to: number, count: number}[], kind: 'score'|'rent'|'distance', extras?: object,
 *   isActive?: (bin: object, options: {last: boolean}) => boolean, onSelect?: (bin: object, options: {last: boolean}) => void}} props
 */
export default function BarChart({ title, caption, bins, kind, tone, extras = {}, isActive, onSelect }) {
  const { plot, maxCount, bars } = barGeometry(bins, { width: WIDTH, height: HEIGHT, margin: MARGIN });
  const labelEvery = Math.max(1, Math.ceil(bars.length / MAX_X_LABELS));
  const baseline = plot.y + plot.height;
  const side = sideCounts(extras);
  const last = (i) => i === bars.length - 1;
  const activeIndex = isActive ? bars.findIndex((bar, i) => isActive(bar, { last: last(i) })) : -1;

  return (
    <figure className={`chart${tone ? ` chart--${tone}` : ''}${activeIndex >= 0 ? ' chart--filtered' : ''}`}>
      <figcaption className="chart__title">{title}</figcaption>
      {bars.length === 0 ? (
        <div className="chart__empty">No data</div>
      ) : (
        <svg
          className="chart__svg"
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          role="img"
          aria-label={describeHistogram(title, bins, kind, extras, activeIndex >= 0 ? bars[activeIndex] : null)}
        >
          <line className="chart__axis" x1={plot.x} x2={plot.x + plot.width} y1={baseline} y2={baseline} />
          <text className="chart__tick" x={plot.x - 4} y={baseline} textAnchor="end" dominantBaseline="middle">
            0
          </text>
          <text className="chart__tick" x={plot.x - 4} y={plot.y} textAnchor="end" dominantBaseline="middle">
            {maxCount}
          </text>
          {bars.map((bar, i) => {
            const active = i === activeIndex;
            const label = `${binLabel(bar, kind)}: ${bar.count} ${bar.count === 1 ? 'offer' : 'offers'}`;
            const select = () => onSelect?.(bar, { last: last(i) });
            return (
              <g
                key={bar.from}
                className={`chart__bin${active ? ' chart__bin--active' : ''}${onSelect ? ' chart__bin--clickable' : ''}`}
                {...(onSelect
                  ? {
                      role: 'button',
                      tabIndex: 0,
                      'aria-pressed': active,
                      'aria-label': `${label}. ${active ? 'Selected, press to clear the filter' : 'Press to filter to this range'}`,
                      onClick: select,
                      onKeyDown: (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          select();
                        }
                      },
                    }
                  : {})}
              >
                {/* the whole column is clickable, also above a short or empty bar */}
                <rect className="chart__hit" x={bar.x} y={plot.y} width={bar.width} height={plot.height} />
                <rect className="chart__bar" x={bar.x} y={bar.y} width={bar.width} height={bar.height} rx="2" />
                <title>{label}</title>
                {i % labelEvery === 0 && (
                  <text className="chart__tick" x={bar.x + bar.width / 2} y={baseline + 12} textAnchor="middle">
                    {bar.from}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      )}
      <div className="chart__caption">
        {caption}
        {side.length > 0 && <span className="chart__side"> · {side.join(', ')}</span>}
      </div>
    </figure>
  );
}
