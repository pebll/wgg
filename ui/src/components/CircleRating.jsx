import { formatScore, scoreToStars } from '../services/format.js';

const R = 6;
const STEP = 16;

/** Read-only 5-circle display of a 1-10 score (half circle = left half filled). */
export default function CircleRating({ score, label, showValue = false, showEmpty = false }) {
  const filled = scoreToStars(score);
  if (filled === null) {
    return showEmpty ? <span className="circles circles--none">AI: not assessed yet</span> : null;
  }
  const text = `AI score ${formatScore(score)} out of 10`;
  return (
    <span className="circles" role="img" aria-label={text}>
      {label && <span className="circles__label">{label}</span>}
      <svg
        className="circles__svg"
        width={STEP * 5 - 4}
        height={R * 2}
        viewBox={`0 0 ${STEP * 5 - 4} ${R * 2}`}
        aria-hidden="true"
      >
        {[0, 1, 2, 3, 4].map((i) => {
          const cx = R + i * STEP;
          const part = Math.min(1, Math.max(0, filled - i));
          return (
            <g key={i}>
              <circle className="circles__empty" cx={cx} cy={R} r={R} />
              {part === 1 && <circle className="circles__fill" cx={cx} cy={R} r={R} />}
              {part === 0.5 && <path className="circles__fill" d={`M${cx} 0 A${R} ${R} 0 0 0 ${cx} ${R * 2} Z`} />}
            </g>
          );
        })}
      </svg>
      {showValue && <span className="circles__value">{formatScore(score)}/10</span>}
    </span>
  );
}
