import { useEffect, useState } from 'react';
import { Banner, Button, Radio, RadioGroup, Switch, Tag, Toast, Typography } from '@douyinfe/semi-ui-19';
import { IconArrowLeft, IconClose, IconMoon, IconSun } from '@douyinfe/semi-icons';
import BrandLogo from './components/BrandLogo.jsx';
import ListingsGrid from './components/ListingsGrid.jsx';
import ListingDetail from './components/ListingDetail.jsx';
import Distribution from './components/Distribution.jsx';
import FetchStatus from './components/FetchStatus.jsx';
import OptionsPage from './components/OptionsPage.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import UserMenu from './components/UserMenu.jsx';
import { TierLabel } from './components/TierBadge.jsx';
import { useListings } from './hooks/useListings.js';
import { useStatus } from './hooks/useStatus.js';
import {
  fetchOutcome,
  hiddenAutomaticallyLabel,
  isShownWhenHidden,
  isFetchRunning,
  refusalMessage,
  selectedListing,
  selectionAfterDismiss,
} from './services/format.js';
import { errorMessage, xhrSend } from './services/xhr.js';
import {
  DEFAULT_FILTERS,
  RECENCY_OPTIONS,
  SORT_OPTIONS,
  filterMode,
  filterModePatch,
  sortPatch,
} from './services/listingsQuery.js';
import { clearRange, hasRanges, rangeChips } from './services/rangeFilters.js';
import { applyTheme, initialTheme, loadStored, nextTheme, saveStored } from './services/theme.js';

const FETCH_WATCH_MAX_MS = 15 * 60_000;
// The card grid is the only view. An older "table" choice may still sit in localStorage: forget it.
try {
  window.localStorage.removeItem('wgg-view');
} catch {
  // storage not available
}

// Sort, recency and filter are no longer remembered (every visit starts at the defaults): forget the old choice.
try {
  window.localStorage.removeItem('wgg-filters');
} catch {
  // storage not available
}

export default function App({ user, onLogout, onAbout, onTargetName }) {
  const targetName = user?.targetName;
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [theme, setTheme] = useState(initialTheme);
  const [selectedId, setSelectedId] = useState(null);
  const [tab, setTab] = useState('offers');
  // "Custom" was picked but no bar has been clicked yet: show the hint instead of chips.
  const [customHint, setCustomHint] = useState(false);
  const { items, total, hiddenAutomatically, loading, error, reload, version } = useListings(filters);
  // A manual fetch in progress: { prevRunId, startedAt } until its run has finished (polls /api/status every 2 s).
  const [pendingFetch, setPendingFetch] = useState(null);
  const { status, now, refresh: refreshStatus } = useStatus(pendingFetch !== null);
  const badgeThreshold = status?.llm?.badgeThreshold;
  const fetching = pendingFetch !== null || isFetchRunning(status, now);
  const selected = selectedListing(items, selectedId);

  // Watch a manual fetch: once its run has finished, show the result and refresh the list.
  useEffect(() => {
    if (pendingFetch === null) return;
    const outcome = fetchOutcome(pendingFetch.prevRunId, status);
    if (outcome) {
      (outcome.type === 'success' ? Toast.success : Toast.error)(outcome.message);
      setPendingFetch(null);
      reload();
    } else if (Date.now() - pendingFetch.startedAt > FETCH_WATCH_MAX_MS) {
      Toast.error('The fetch did not report back. Check the wgg log.');
      setPendingFetch(null);
    }
  }, [pendingFetch, status, reload]);

  const fetchNow = async () => {
    try {
      await xhrSend('POST', '/api/fetch');
      setPendingFetch({ prevRunId: status?.lastFetch?.id ?? null, startedAt: Date.now() });
      refreshStatus();
    } catch (e) {
      Toast.warning(refusalMessage(e));
    }
  };

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Follow the system preference live until the user has picked a theme explicitly.
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!media) return undefined;
    const onChange = (e) => {
      if (!loadStored()) setTheme(e.matches ? 'dark' : 'light');
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  const toggleTheme = () => {
    const next = nextTheme(theme);
    saveStored(next);
    setTheme(next);
  };

  const restore = async (item) => {
    try {
      await xhrSend('DELETE', `/api/listings/${item.id}/dismiss`);
      reload();
    } catch (e) {
      Toast.error(errorMessage(e, 'Could not restore the offer.'));
    }
  };

  const hide = async (item, reason) => {
    try {
      await xhrSend('POST', `/api/listings/${item.id}/dismiss`, { reason });
    } catch (e) {
      Toast.error(errorMessage(e, 'Could not hide the offer.'));
      return;
    }
    // A hidden offer leaves the list (unless hidden ones are shown): move the selection to its neighbour.
    if (!isShownWhenHidden(filters, reason) && item.id === selected?.id)
      setSelectedId(selectionAfterDismiss(items, item.id));
    reload();
    const toastId = Toast.info({
      duration: 8,
      content: (
        <span>
          {reason === 'messaged' ? 'Marked as messaged.' : 'Offer hidden.'}{' '}
          <Button
            size="small"
            theme="borderless"
            onClick={() => {
              Toast.close(toastId);
              restore(item);
            }}
          >
            Undo
          </Button>
        </span>
      ),
    });
  };

  const dismiss = (item) => hide(item, 'not_interested');
  const messaged = (item) => hide(item, 'messaged');

  // Changing a filter or the sort goes back to the first page.
  const update = (patch) => setFilters((f) => ({ ...f, page: 1, ...patch }));

  return (
    <div className="app">
      <div className="app__header">
        <Typography.Title heading={3} className="app__title">
          <BrandLogo />
        </Typography.Title>
        <FetchStatus status={status} now={now} fetching={fetching} onFetch={fetchNow} />
        <div className="app__count" aria-live="polite">
          {loading && items.length === 0 ? 'Loading...' : `${total} ${total === 1 ? 'offer' : 'offers'}`}
        </div>
        <div className="app__actions">
          <Button
            theme="borderless"
            icon={theme === 'dark' ? <IconSun /> : <IconMoon />}
            onClick={toggleTheme}
            aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          />
          <UserMenu
            user={user}
            onLogout={onLogout}
            onAbout={onAbout}
            optionsOpen={tab === 'options'}
            onOptions={() => setTab((t) => (t === 'options' ? 'offers' : 'options'))}
          />
        </div>
      </div>
      {tab === 'options' && (
        <>
          <div className="app__back">
            <Button theme="borderless" icon={<IconArrowLeft />} onClick={() => setTab('offers')}>
              Back to offers
            </Button>
            <Button
              theme="borderless"
              icon={<IconClose />}
              onClick={() => setTab('offers')}
              aria-label="Close options"
            />
          </div>
          <OptionsPage onTargetName={onTargetName} />
        </>
      )}
      {tab === 'offers' && (
        <>
          <div className="app__toolbar">
            <div className="app__filter" role="group" aria-label="Sort by">
              Sort by:
              <RadioGroup type="button" value={filters.sort} onChange={(e) => update(sortPatch(e.target.value))}>
                {SORT_OPTIONS.map((o) => (
                  <Radio key={o.value} value={o.value}>
                    {o.label}
                  </Radio>
                ))}
              </RadioGroup>
            </div>
            <div className="app__filter" role="group" aria-label="Recency">
              Recency:
              <RadioGroup
                type="button"
                value={filters.maxAgeHours}
                onChange={(e) => update({ maxAgeHours: e.target.value })}
              >
                {RECENCY_OPTIONS.map((o) => (
                  <Radio key={o.hours} value={o.hours}>
                    {o.label}
                  </Radio>
                ))}
              </RadioGroup>
            </div>
            <div className="app__filter filterbar" role="group" aria-label="Filter by chart ranges">
              Filter:
              <RadioGroup
                type="button"
                value={filterMode(filters, customHint)}
                onChange={(e) => {
                  // Good / Fantastic and the chart ranges exclude each other.
                  setCustomHint(e.target.value === 'custom');
                  update(filterModePatch(e.target.value));
                }}
              >
                <Radio value="all">All</Radio>
                <Radio value="good">
                  <TierLabel tier="good" />
                </Radio>
                <Radio value="fantastic">
                  <TierLabel tier="fantastic" />
                </Radio>
                <Radio value="custom">Custom</Radio>
              </RadioGroup>
              {rangeChips(filters.ranges).map(({ key, label }) => (
                <Tag
                  key={key}
                  closable
                  color="light-blue"
                  onClose={() => update({ ranges: clearRange(filters.ranges, key) })}
                  aria-label={`${label}, remove filter`}
                >
                  {label}
                </Tag>
              ))}
              {customHint && !hasRanges(filters.ranges) && (
                <span className="app__muted">Click a bar in a chart below to filter by its range.</span>
              )}
            </div>
            <label className="app__filter">
              Show not interested
              <Switch
                checked={filters.showNotInterested}
                onChange={(checked) => update({ showNotInterested: checked })}
                aria-label="Show not interested offers"
              />
            </label>
            <label className="app__filter">
              Show messaged
              <Switch
                checked={filters.showMessaged}
                onChange={(checked) => update({ showMessaged: checked })}
                aria-label="Show messaged offers"
              />
            </label>
            <label className="app__filter">
              Show removed automatically
              <Switch
                checked={filters.showAuto}
                onChange={(checked) => update({ showAuto: checked })}
                aria-label="Show offers removed automatically"
              />
            </label>
            {!filters.showAuto && hiddenAutomaticallyLabel(hiddenAutomatically) && (
              <span className="app__muted">{hiddenAutomaticallyLabel(hiddenAutomatically)}</span>
            )}
          </div>
          {error && <Banner className="app__error" type="danger" description={error} closeIcon={null} />}
          <Distribution
            filters={filters}
            version={version}
            onRangesChange={(ranges) => {
              setCustomHint(false);
              update({ ranges, tier: null }); // clicking a bar switches to Custom
            }}
          />
          <div className="app__main">
            <div className="app__list">
              <ListingsGrid
                listings={items}
                total={total}
                loading={loading}
                filters={filters}
                onChange={(patch) => setFilters((f) => ({ ...f, ...patch }))}
                selectedId={selected?.id ?? null}
                onSelect={setSelectedId}
                onDismiss={dismiss}
                onMessaged={messaged}
                onRestore={restore}
                badgeThreshold={badgeThreshold}
                targetName={targetName}
              />
            </div>
            <ErrorBoundary resetKey={selected?.id} onBack={() => setSelectedId(null)}>
              <ListingDetail
                item={selected}
                onDismiss={dismiss}
                onMessaged={messaged}
                onRestore={restore}
                badgeThreshold={badgeThreshold}
                now={now}
                targetName={targetName}
              />
            </ErrorBoundary>
          </div>
        </>
      )}
    </div>
  );
}
