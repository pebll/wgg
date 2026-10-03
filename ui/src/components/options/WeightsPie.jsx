import { WEIGHT_COLORS, describePie, pieSlices } from '../../services/pie.js';

/**
 * Small pie ("camembert") of the rating weights: every parameter's share of the total weight, in the colors of the
 * legend next to it. Zero weights are left out. Updates live with the sliders; the summary text is its alternative.
 *
 * @param {{weights: Record<string, number|null>, parameters: [string, string][]}} props `parameters`: [key, label] in order.
 */
export default function WeightsPie({ weights, parameters }) {
  const slices = pieSlices(parameters.map(([key]) => ({ key, value: weights[key] })));
  const labels = Object.fromEntries(parameters);
  const summary = describePie(slices, labels);
  return (
    <figure className="weights-pie">
      <svg className="weights-pie__svg" viewBox="0 0 100 100" role="img" aria-label={summary}>
        {slices.length === 0 && <circle className="weights-pie__empty" cx="50" cy="50" r="40" />}
        {slices.map((s) =>
          s.full ? (
            <circle key={s.key} className="weights-pie__slice" cx="50" cy="50" r="40" fill={WEIGHT_COLORS[s.key]}>
              <title>{`${labels[s.key]}: 100%`}</title>
            </circle>
          ) : (
            <path key={s.key} className="weights-pie__slice" d={s.path} fill={WEIGHT_COLORS[s.key]}>
              <title>{`${labels[s.key]}: ${Math.round(s.share * 100)}%`}</title>
            </path>
          ),
        )}
      </svg>
      <ul className="weights-pie__legend" aria-label="Weight shares">
        {slices.map((s) => (
          <li key={s.key}>
            <span className="weights-pie__swatch" style={{ background: WEIGHT_COLORS[s.key] }} aria-hidden="true" />
            {labels[s.key]} <strong>{Math.round(s.share * 100)}%</strong>
          </li>
        ))}
        {slices.length === 0 && <li className="options__hint">No weights set.</li>}
      </ul>
    </figure>
  );
}
