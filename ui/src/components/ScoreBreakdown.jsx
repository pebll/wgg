import { Typography } from '@douyinfe/semi-ui-19';
import CircleRating from './CircleRating.jsx';
import StarRating from './StarRating.jsx';
import { aiScore, breakdownRows, formatScore, publicReason } from '../services/format.js';

/** Overall score as 5 stars plus one row per parameter (stars, value, reason) and the unscored fields. */
export default function ScoreBreakdown({ evaluation, geoPrecision, llm }) {
  if (!evaluation) {
    return <div className="breakdown">Not evaluated yet. Scores appear here once the evaluation has run.</div>;
  }
  const { overall, rows, missing, excludedReason } = breakdownRows(evaluation);

  return (
    <div className="breakdown">
      <div className="breakdown__overall">
        <Typography.Text strong>Overall</Typography.Text>
        <StarRating score={overall} size="default" showValue />
        <div className="breakdown__ai">
          <Typography.Text type="tertiary">AI score</Typography.Text>
          <CircleRating score={aiScore(llm)} showValue showEmpty />
        </div>
      </div>
      {excludedReason && <div className="breakdown__excluded">Excluded: {publicReason(excludedReason)}</div>}
      {geoPrecision === 'district' && (
        <div className="breakdown__note">Location is the district centre only, so the distance is approximate.</div>
      )}
      {rows.length > 0 ? (
        <ul className="breakdown__rows">
          {rows.map((row) => (
            <li key={row.param} className="breakdown__row">
              <span className="breakdown__param">{row.param}</span>
              <StarRating score={row.score} />
              <span className="breakdown__num">{formatScore(row.score)}</span>
              <span className="breakdown__reason">{row.detail ?? '---'}</span>
            </li>
          ))}
        </ul>
      ) : (
        <Typography.Text type="tertiary">No per-parameter scores stored.</Typography.Text>
      )}
      {missing.length > 0 && (
        <ul className="breakdown__rows breakdown__rows--missing">
          {missing.map((field) => (
            <li key={field} className="breakdown__row">
              <span className="breakdown__param">{field}</span>
              <span className="breakdown__reason">not scored (data missing)</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
