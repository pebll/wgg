/**
 * Pure helpers of the weights pie chart ("camembert"): one slice per positive weight, sized by its share of the total.
 * Rendering (SVG, legend) lives in WeightsPie.jsx.
 */

/** One color per scoring parameter; mid-tones that stay distinguishable on the light and the dark card. */
export const WEIGHT_COLORS = {
  rent: '#e8704a',
  distance: '#3b82f6',
  recency: '#8b5cf6',
  size: '#10b981',
  stayLength: '#f59e0b',
};

const num = (n) => Number(n.toFixed(3));
const isWeight = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** Point on the circle at `angle` degrees, 0 at 12 o'clock, clockwise. */
function point(cx, cy, radius, angle) {
  const rad = (angle * Math.PI) / 180;
  return [num(cx + radius * Math.sin(rad)), num(cy - radius * Math.cos(rad))];
}

/**
 * @param {{key: string, value: unknown}[]} entries In display order.
 * @param {{cx?: number, cy?: number, radius?: number}} [circle]
 * @returns {{key: string, value: number, share: number, startAngle: number, endAngle: number, full: boolean, path: string}[]}
 *   The slices of the positive weights, clockwise from the top. `full` is a single slice covering the whole circle (draw
 *   a circle: an arc from a point to itself draws nothing); `path` is the SVG path of a wedge otherwise.
 */
export function pieSlices(entries, { cx = 50, cy = 50, radius = 40 } = {}) {
  const positive = entries.filter((e) => isWeight(e.value));
  const total = positive.reduce((sum, e) => sum + e.value, 0);
  let angle = 0;
  return positive.map(({ key, value }) => {
    const share = value / total;
    const startAngle = angle;
    const endAngle = startAngle + share * 360;
    angle = endAngle;
    const full = positive.length === 1;
    const [x1, y1] = point(cx, cy, radius, startAngle);
    const [x2, y2] = point(cx, cy, radius, endAngle);
    const large = endAngle - startAngle > 180 ? 1 : 0;
    const path = full ? '' : `M ${cx} ${cy} L ${x1} ${y1} A ${radius} ${radius} 0 ${large} 1 ${x2} ${y2} Z`;
    return { key, value, share, startAngle, endAngle, full, path };
  });
}

/** Text alternative of the pie: "Share of the total weight: Rent 67%, Distance 33%." */
export function describePie(slices, labels) {
  if (slices.length === 0) return 'No weights set.';
  const parts = slices.map((s) => `${labels[s.key] ?? s.key} ${Math.round(s.share * 100)}%`);
  return `Share of the total weight: ${parts.join(', ')}.`;
}
