import { describeFlat, flatLabel, flatmateParts } from '../services/format.js';

/**
 * "3er WG" with the known flatmates as small gender symbols and counts, like WG-Gesucht (only genders with at least
 * one person). Renders nothing when the size is unknown. The whole element has one accessible label.
 */
export default function FlatInfo({ item, className = '' }) {
  const label = flatLabel({ wgSize: item.wgSize ?? item.flatmates?.wgSize });
  if (!label) return null;
  return (
    <span className={`flat ${className}`} role="img" aria-label={describeFlat(item)}>
      <span aria-hidden="true">{label}</span>
      {flatmateParts(item.flatmates).map((p) => (
        <span
          key={p.key}
          className={`flat__mate flat__mate--${p.key}`}
          aria-hidden="true"
          title={`${p.count} ${p.label}`}
        >
          <span className="flat__symbol">{p.symbol}</span>
          {p.count}
        </span>
      ))}
    </span>
  );
}
