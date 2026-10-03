const DEFAULT_MARGIN = { top: 8, right: 8, bottom: 24, left: 28 };
const GAP_RATIO = 0.15;

/**
 * Pure layout of a bar chart: one bar per bin, heights scaled to the largest count, sitting on the
 * plot baseline. Rendering (SVG, colors) lives in the component.
 *
 * @param {{from: number, to: number, count: number}[]} bins
 * @param {{width: number, height: number, margin?: {top: number, right: number, bottom: number, left: number}}} size
 */
export function barGeometry(bins, { width, height, margin = DEFAULT_MARGIN }) {
  const plot = {
    x: margin.left,
    y: margin.top,
    width: width - margin.left - margin.right,
    height: height - margin.top - margin.bottom,
  };
  const maxCount = bins.reduce((m, b) => Math.max(m, b.count), 0);
  const band = bins.length > 0 ? plot.width / bins.length : 0;
  const barWidth = band * (1 - GAP_RATIO);
  const bars = bins.map((bin, i) => {
    const barHeight = maxCount > 0 ? (plot.height * bin.count) / maxCount : 0;
    return {
      ...bin,
      x: plot.x + i * band + (band - barWidth) / 2,
      y: plot.y + plot.height - barHeight,
      width: barWidth,
      height: barHeight,
    };
  });
  return { plot, maxCount, bars };
}

/** "5–6", "400–450 €", "2–3 km". */
export function binLabel({ from, to }, kind) {
  const range = `${from}–${to}`;
  if (kind === 'rent') return `${range} €`;
  if (kind === 'distance') return `${range} km`;
  return range;
}

/** "2 not assessed" style counts shown next to a chart. `extras`: {unscored?, unassessed?, unknown?}. */
export function sideCounts(extras = {}) {
  return [
    ['not scored', extras.unscored],
    ['not assessed', extras.unassessed],
    ['unknown', extras.unknown],
  ]
    .filter(([, n]) => n > 0)
    .map(([label, n]) => `${n} ${label}`);
}

/** Screen-reader summary of a histogram; `selected` is the bar a range filter is set to, if any. */
export function describeHistogram(title, bins, kind, extras = {}, selected = null) {
  const total = bins.reduce((n, b) => n + b.count, 0);
  const side = sideCounts(extras);
  if (total === 0 && side.length === 0) return `${title}: no data`;
  const parts = [`${total} ${total === 1 ? 'offer' : 'offers'}`];
  if (total > 0) {
    const top = bins.reduce((best, b) => (b.count > best.count ? b : best), bins[0]);
    parts.push(`most in ${binLabel(top, kind)} (${top.count})`);
  }
  if (selected) parts.push(`selected: ${binLabel(selected, kind)}`);
  return `${title}: ${[...parts, ...side].join(', ')}`;
}
