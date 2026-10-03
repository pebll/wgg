import FlatInfo from './FlatInfo.jsx';
import { Tag } from '@douyinfe/semi-ui-19';
import DismissButton from './DismissButton.jsx';
import Photo from './Photo.jsx';
import CircleRating from './CircleRating.jsx';
import StarRating from './StarRating.jsx';
import VerbindungBadge from './VerbindungBadge.jsx';
import TierBadge from './TierBadge.jsx';
import {
  aiScore,
  formatAvailability,
  formatDistance,
  formatLocation,
  formatNotified,
  formatRent,
  formatSize,
  hiddenLabel,
  messagedLabel,
  isNewListing,
  postedAt,
  scoreChip,
  scoreBucket,
} from '../services/format.js';

/**
 * One listing as a tile: the content is a real button (Enter/Space select it), the "Not interested" / "Restore"
 * action is a sibling button (buttons cannot nest). Details live in the side panel.
 */
export default function ListingCard({
  item,
  sort,
  selected,
  onSelect,
  onDismiss,
  onMessaged,
  onRestore,
  badgeThreshold,
  targetName,
}) {
  const title = item.title || 'Untitled listing';
  const distance = formatDistance(item.distanceKm, item.geoPrecision, targetName);
  const bucket = scoreBucket(item.evaluation);
  const excluded = bucket === 'excluded';
  const hidden = hiddenLabel(item);
  const chip = scoreChip(item, sort);
  const messaged = hidden ? null : messagedLabel(item);

  return (
    <div
      className={`card${excluded ? ' card--excluded' : ''}${selected ? ' card--selected' : ''}${item.dismissed ? ' card--dismissed' : ''}`}
    >
      <button type="button" className="card__select" aria-pressed={selected} onClick={() => onSelect(item.id)}>
        <span className="card__media">
          <Photo className="card__photo" src={item.image} alt="" fallback={item.photoFallback} />
          {isNewListing(item) && <span className="card__new">New</span>}
          <span className={`card__score card__score--${chip.bucket}`}>
            <span className="card__score-value">{chip.value}</span>
            <span className="card__score-label">{chip.label}</span>
          </span>
        </span>
        <span className="card__body">
          <span className="card__title">{title}</span>
          <span className="card__facts">
            <strong>{formatRent(item.price)}</strong>
            <span>{formatSize(item.size)}</span>
            <FlatInfo item={item} />
          </span>
          {hidden && <span className="card__hidden">{hidden}</span>}
          <span className="card__muted">{formatLocation(item.district, item.street)}</span>
          <span className="card__muted">Available: {formatAvailability(item.availableFrom, item.availableUntil)}</span>
          <span className="card__distance" title={distance}>
            {distance}
          </span>
          <span className="card__meta">
            <span className="card__ratings">
              <StarRating score={item.evaluation?.overall} />
              <CircleRating score={aiScore(item.llm)} label="AI" />
            </span>
            <span className="card__muted">{postedAt(item)}</span>
            <TierBadge tier={item.tier} />
            <VerbindungBadge llm={item.llm} threshold={badgeThreshold} />
            {item.notified ? <Tag color="green">{formatNotified(item)}</Tag> : null}
            {messaged ? <Tag color="light-blue">Messaged</Tag> : null}
          </span>
        </span>
      </button>
      <div className="card__actions">
        <DismissButton item={item} onDismiss={onDismiss} onMessaged={onMessaged} onRestore={onRestore} />
      </div>
    </div>
  );
}
