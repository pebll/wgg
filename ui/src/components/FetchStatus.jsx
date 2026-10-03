import { Button, Tooltip } from '@douyinfe/semi-ui-19';
import { IconHelpCircle, IconRefresh } from '@douyinfe/semi-icons';
import {
  describeLastFetch,
  describeNextFetch,
  describeDetailsQueue,
  describeLlmQueue,
  fetchNowState,
  queueHelp,
} from '../services/format.js';

/**
 * Header block: when the last fetch ran, when the next one is planned, and the "Fetch now" button
 * (spinner while a fetch runs). Without a running scheduler it says how to get automatic fetching.
 */
export default function FetchStatus({ status, now, fetching, onFetch }) {
  const details = describeDetailsQueue(status?.details, now);
  const llm = describeLlmQueue(status?.llm);
  const fetchNow = fetchNowState(status, now);
  const busy = fetching || !fetchNow.enabled;
  const fetchButton = (
    <Button
      size="small"
      icon={<IconRefresh />}
      loading={fetching}
      disabled={busy}
      onClick={onFetch}
      aria-label={fetchNow.tooltip ? `Fetch now. ${fetchNow.tooltip}` : 'Fetch now'}
    >
      {fetching ? 'Fetching...' : fetchNow.label}
    </Button>
  );
  const problem = status?.lastFetch && (status.lastFetch.botDetected || status.lastFetch.errorCount > 0);
  return (
    <div className="status">
      <div className="status__line" aria-live="off">
        <span className={problem ? 'status__item status__item--warn' : 'status__item'}>
          Last fetch: <strong>{status ? describeLastFetch(status.lastFetch, now) : 'unknown'}</strong>
        </span>
        <span className="status__item">
          Next fetch: <strong>{describeNextFetch(status, now)}</strong>
        </span>
        {details && (
          <span className="status__item">
            Details: <strong>{details}</strong>
          </span>
        )}
        {llm && (
          <span className="status__item">
            AI: <strong>{llm}</strong>
          </span>
        )}
        {(details || llm) && (
          <Tooltip content={<span className="status__help">{queueHelp()}</span>} position="bottom">
            <button type="button" className="status__info" aria-label={`How the queues work. ${queueHelp()}`}>
              <IconHelpCircle size="small" />
            </button>
          </Tooltip>
        )}
        {fetchNow.tooltip ? (
          <Tooltip content={fetchNow.tooltip} position="bottom">
            <span className="status__fetch">{fetchButton}</span>
          </Tooltip>
        ) : (
          fetchButton
        )}
      </div>
      {status && !status.schedulerRunning && (
        <div className="status__hint">
          Automatic fetching is off — start <code>wgg run</code>.
        </div>
      )}
    </div>
  );
}
