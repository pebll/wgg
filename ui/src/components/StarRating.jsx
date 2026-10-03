import { Rating } from '@douyinfe/semi-ui-19';
import { formatScore, scoreToStars } from '../services/format.js';

/** Read-only 5-star display of a 1-10 score (half stars), with the numeric value as accessible label. */
export default function StarRating({ score, size = 'small', showValue = false }) {
  const stars = scoreToStars(score);
  if (stars === null) return <span className="stars stars--none">not scored</span>;
  return (
    <span className="stars" role="img" aria-label={`${formatScore(score)} out of 10, ${stars} of 5 stars`}>
      <Rating disabled allowHalf count={5} value={stars} size={size} />
      {showValue && <span className="stars__value">{formatScore(score)}/10</span>}
    </span>
  );
}
