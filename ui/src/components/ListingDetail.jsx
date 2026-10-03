import { Empty, Tag } from '@douyinfe/semi-ui-19';
import DetailContent from './DetailContent.jsx';
import AiAssessment from './AiAssessment.jsx';
import DismissButton from './DismissButton.jsx';
import FlatInfo from './FlatInfo.jsx';
import TierBadge from './TierBadge.jsx';
import Photo from './Photo.jsx';
import ScoreBreakdown from './ScoreBreakdown.jsx';
import {
  formatAvailability,
  formatDistance,
  formatLocation,
  formatNotified,
  formatRent,
  formatSize,
  detailStatusLabel,
  hiddenLabel,
  messagedLabel,
  postedAt,
  publicReason,
  safeLink,
} from '../services/format.js';

/** Always-visible side panel for the selected listing: photo, facts, link and score breakdown. */
export default function ListingDetail({ item, onDismiss, onMessaged, onRestore, badgeThreshold, now, targetName }) {
  if (!item) {
    return (
      <aside className="detail" aria-label="Selected offer">
        <Empty title="No offer selected" description="Pick a tile to see its details." />
      </aside>
    );
  }
  const href = safeLink(item.link);
  const title = item.title || 'Untitled listing';
  const excludedReason = item.evaluation?.excludedReason;
  const detailStatus = detailStatusLabel(item.details);
  const hidden = hiddenLabel(item);
  const messaged = hidden ? null : messagedLabel(item);

  return (
    <aside className="detail" aria-label="Selected offer">
      <Photo key={item.image} className="detail__photo" src={item.image} alt={title} eager />
      <h2 className="detail__title">{title}</h2>
      {href && (
        <a className="detail__link" href={href} target="_blank" rel="noopener noreferrer">
          Open on WG-Gesucht
        </a>
      )}
      <div className="detail__actions">
        {hidden && (
          <Tag color={item.hidden?.by === 'program' ? 'orange' : 'grey'} className="detail__hidden">
            {hidden}
          </Tag>
        )}
        {messaged && (
          <Tag color="light-blue" className="detail__hidden">
            {messaged}
          </Tag>
        )}
        <DismissButton item={item} onDismiss={onDismiss} onMessaged={onMessaged} onRestore={onRestore} size="default" />
      </div>
      {excludedReason && <div className="detail__excluded">Excluded: {publicReason(excludedReason)}</div>}
      <dl className="detail__facts">
        <dt>Rent</dt>
        <dd>
          <strong>{formatRent(item.price)}</strong>
        </dd>
        <dt>Size</dt>
        <dd>{formatSize(item.size)}</dd>
        <dt>Flat</dt>
        <dd>{item.wgSize != null || item.flatmates ? <FlatInfo item={item} /> : '---'}</dd>
        <dt>Location</dt>
        <dd>{formatLocation(item.district, item.street)}</dd>
        <dt>Distance</dt>
        <dd>{formatDistance(item.distanceKm, item.geoPrecision, targetName)}</dd>
        <dt>Posted</dt>
        <dd>{postedAt(item)}</dd>
        <dt>Available</dt>
        <dd>{formatAvailability(item.availableFrom, item.availableUntil)}</dd>
        {item.tier && (
          <>
            <dt>Alert tier</dt>
            <dd>
              <TierBadge tier={item.tier} />
            </dd>
          </>
        )}
        <dt>Notified</dt>
        <dd>{item.notified ? <Tag color="green">{formatNotified(item)}</Tag> : 'No'}</dd>
      </dl>
      {detailStatus && (
        <div className="detail__status" role="status">
          {detailStatus}
        </div>
      )}
      <AiAssessment llm={item.llm} badgeThreshold={badgeThreshold} now={now} />
      <DetailContent details={item.details} />
      <h3 className="detail__heading">Score</h3>
      <ScoreBreakdown evaluation={item.evaluation} llm={item.llm} geoPrecision={item.geoPrecision} />
    </aside>
  );
}
