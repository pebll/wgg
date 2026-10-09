const NONE = '---';

const has = (v) => v !== null && v !== undefined && v !== '';
const pad = (n) => String(n).padStart(2, '0');

export function formatRent(price) {
  return has(price) ? `${price} €` : NONE;
}

export function formatSize(size) {
  return has(size) ? `${size} m²` : NONE;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const DASH = '—';

/** Local calendar date of an epoch-ms timestamp as "YYYY-MM-DD". */
function localIsoDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Epoch ms -> "2 October 2026" (local day, European order, English month). */
export function formatDay(ms) {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/**
 * "YYYY-MM-DD" -> "1 November 2026" (European order, English month, no leading zero). A date that
 * is today or earlier reads "immediately" (the room is free now). Unknown -> "—"; text that is not
 * an ISO date is returned unchanged rather than guessed.
 */
export function formatAvailableDate(iso, now = Date.now()) {
  if (!has(iso)) return DASH;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso));
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return String(iso);
  if (iso <= localIsoDate(now)) return 'immediately';
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

/** "immediately – 30 April 2027", "1 November 2026", "until 31 January 2027" or "—". */
export function formatAvailability(from, until, now = Date.now()) {
  if (has(from) && has(until)) return `${formatAvailableDate(from, now)} – ${formatAvailableDate(until, now)}`;
  if (has(from)) return formatAvailableDate(from, now);
  if (has(until)) return `until ${formatAvailableDate(until, now)}`;
  return DASH;
}

export function formatOnlineAge(minutes) {
  if (!has(minutes)) return NONE;
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)} h`;
  return `${Math.floor(minutes / (60 * 24))} d`;
}

export function formatLocation(district, street) {
  const parts = [district, street].filter(has);
  return parts.length > 0 ? parts.join(', ') : NONE;
}

export function formatScore(score) {
  if (!has(score)) return NONE;
  return String(Math.round(score * 10) / 10);
}

/** True when `url` is the image that failed to load (a failure of another listing's image does not count). */
export function photoFailed(failedUrl, url) {
  return failedUrl != null && failedUrl === url;
}

/** Scraped links are rendered as hrefs, so only http(s) is allowed. */
export function safeLink(link) {
  if (!has(link)) return null;
  try {
    const url = new URL(link);
    return url.protocol === 'https:' || url.protocol === 'http:' ? link : null;
  } catch {
    return null;
  }
}

/**
 * Normalizes an evaluation ({overall, scores, details, missing, excludedReason} - every part optional)
 * into table rows: one per parameter that has a score or a detail text.
 */
export function breakdownRows(evaluation) {
  const scores = evaluation?.scores ?? {};
  const details = evaluation?.details ?? {};
  const params = [...new Set([...Object.keys(scores), ...Object.keys(details)])];
  return {
    overall: evaluation?.overall ?? null,
    rows: params.map((param) => ({
      param,
      score: scores[param] ?? null,
      detail: has(details[param]) ? String(details[param]) : null,
    })),
    missing: Array.isArray(evaluation?.missing) ? evaluation.missing : [],
    excludedReason: evaluation?.excludedReason ?? null,
  };
}

/** "just now" / "5 min ago" / "3 h ago" / "2 d ago" for an epoch-ms timestamp. */
export function formatRelativeTime(ms, now = Date.now()) {
  if (!has(ms)) return NONE;
  const minutes = Math.floor((now - ms) / 60_000);
  if (minutes < 1) return 'just now';
  return `${formatOnlineAge(minutes)} ago`;
}

/** "posted 3 h ago" from publishedAt; falls back to the first-seen time and says so. */
export function postedAt(item, now = Date.now()) {
  if (has(item?.publishedAt)) return `posted ${formatRelativeTime(item.publishedAt, now)}`;
  if (has(item?.firstSeenAt)) return `first seen ${formatRelativeTime(item.firstSeenAt, now)}`;
  return NONE;
}

const NEW_LISTING_MS = 60 * 60 * 1000;

/** True when the listing was posted less than an hour ago (posting time first, first seen as fallback). */
export function isNewListing(item, now = Date.now()) {
  const since = has(item?.publishedAt) ? item.publishedAt : item?.firstSeenAt;
  return has(since) && now - Number(since) < NEW_LISTING_MS;
}

/**
 * Distance label with a hint about how exact the geocoded position is: "3.2 km to <targetName>", or just "3.2 km"
 * when the user's target has no name.
 */
export function formatDistance(km, precision, targetName) {
  if (!has(km)) return 'distance unknown';
  const name = typeof targetName === 'string' ? targetName.trim() : '';
  const value = `${Number(km).toFixed(1)} km${name ? ` to ${name}` : ''}`;
  return precision === 'district' ? `≈ ${value} (district only)` : value;
}

/** Badge bucket for an evaluation: good (>=8), ok (5-8), bad (<5), excluded, none. */
export function scoreBucket(evaluation) {
  if (!evaluation) return 'none';
  if (evaluation.excludedReason) return 'excluded';
  const score = evaluation.overall;
  if (!has(score)) return 'none';
  if (score >= 8) return 'good';
  if (score >= 5) return 'ok';
  return 'bad';
}

/** 1-10 score -> 0-5 stars in 0.5 steps (null when there is no score). */
export function scoreToStars(score) {
  if (!has(score)) return null;
  const stars = Math.round(Number(score)) / 2;
  return Math.min(5, Math.max(0, stars));
}

/** LLM fit score (1-10) of a finished assessment, else null (pending, failed, skipped, missing). */
export function aiScore(llm) {
  if (llm?.status !== 'done') return null;
  const score = llm.result?.fitScore;
  return has(score) ? Number(score) : null;
}

/**
 * Badge text for an alert email: "Fantastic alert sent · 14:32", "In Good digest · 14:40"; null when none was sent.
 * (Stored kinds stay `priority` / `bulk`; the user-facing names are Fantastic and Good.)
 */
export function formatNotified(item) {
  if (!item?.notified) return null;
  const when = has(item.notifiedAt) ? ` · ${formatClock(item.notifiedAt)}` : '';
  if (item.notifiedKind === 'priority') return `Fantastic alert sent${when}`;
  if (item.notifiedKind === 'bulk') return `In Good digest${when}`;
  return `Alert sent${when}`;
}

/** Epoch ms -> "HH:MM" in the browser's local time. */
export function formatClock(ms) {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "in 5 min" / "in 2 h" / "any moment" for a future epoch-ms timestamp. */
export function formatUntil(ms, now = Date.now()) {
  const minutes = Math.floor((ms - now) / 60_000);
  if (minutes < 1) return 'any moment';
  return `in ${formatOnlineAge(minutes)}`;
}

/** Header text for the last fetch: "9 min ago (12:01, 3 new, 2 errors)". */
export function describeLastFetch(lastFetch, now = Date.now()) {
  if (!lastFetch) return 'no fetch recorded yet';
  if (!has(lastFetch.finishedAt)) return 'fetching now...';
  const parts = [formatClock(lastFetch.finishedAt), `${lastFetch.newCount} new`];
  if (lastFetch.botDetected) parts.push('bot detection');
  else if (lastFetch.errorCount > 0)
    parts.push(`${lastFetch.errorCount} ${lastFetch.errorCount === 1 ? 'error' : 'errors'}`);
  return `${formatRelativeTime(lastFetch.finishedAt, now)} (${parts.join(', ')})`;
}

/** Header text for the next fetch: "in 5 min (12:05)", "backing off: ...", "07:00 (night pause)", "scheduler not running". */
export function describeNextFetch(status, now = Date.now()) {
  if (!status) return 'unknown';
  if (!status.schedulerRunning || !has(status.nextFetchAt)) return 'scheduler not running';
  // Night pause: nothing is fetched until the window of the users' Good alerts opens (see lib/scheduler/fetchWindow.js).
  if (status.manualFetch?.nightPause && has(status.manualFetch.availableAt)) {
    return `${formatClock(status.manualFetch.availableAt)} (night pause)`;
  }
  const text = `${formatUntil(status.nextFetchAt, now)} (${formatClock(status.nextFetchAt)})`;
  return status.backoff ? `backing off: ${text}` : text;
}

/**
 * Header text for the detail-page queue: "12 pending (next in 45 s), 1 failed", "up to date"; null when the server
 * sends no detail numbers.
 * @param {{pending: number, failed: number, running: boolean, nextAt: number|null}|null|undefined} details
 */
export function describeDetailsQueue(details, now = Date.now()) {
  if (!details) return null;
  const parts = [];
  if (details.pending > 0) {
    let text = `${details.pending} pending`;
    if (details.running && has(details.nextAt))
      text += ` (next in ${Math.max(1, Math.round((details.nextAt - now) / 1000))} s)`;
    else if (details.running) text += ' (fetching)';
    parts.push(text);
  } else {
    parts.push('up to date');
  }
  if (details.failed > 0) parts.push(`${details.failed} failed`);
  return parts.join(', ');
}

/** Status line for listings whose detail page is not stored; null once fetched (or for an older server). */
export function detailStatusLabel(details) {
  if (!details || details.status === 'fetched') return null;
  if (details.status === 'skipped') return 'Details skipped (listing too old)';
  if (details.status === 'failed') return has(details.error) ? `Details failed: ${details.error}` : 'Details failed';
  if (details.attempts > 0 && has(details.error)) {
    return `Details pending (attempt ${details.attempts} failed: ${details.error})`;
  }
  return 'Details pending';
}

/** A fact exactly as the page words it: "Wohnungsgröße: 84m²", or just "3er WG" / "möbliert". */
export function formatFact({ label, value }) {
  if (has(label) && has(value)) return `${label}: ${value}`;
  return String(has(label) ? label : (value ?? ''));
}

/** Consecutive facts with the same `group` (WG-Details has "Die WG" / "Gesucht wird") as [{group, facts}]. */
export function groupFacts(facts) {
  const groups = [];
  for (const fact of facts ?? []) {
    const group = fact.group ?? null;
    const last = groups[groups.length - 1];
    if (last && last.group === group) last.facts.push(fact);
    else groups.push({ group, facts: [fact] });
  }
  return groups;
}

/** One-paragraph preview: line breaks collapsed, cut at a word boundary with an ellipsis. */
export function excerpt(text, max) {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > 0 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** A cost row's amount: "819 €" for a number, "not given" for "n.a.", else the page's own words. */
export function formatCost({ raw, value }) {
  if (value !== null && value !== undefined) return `${value} €`;
  return /^n\.?\s?a\.?$/i.test(String(raw ?? '').trim()) ? 'not given' : String(raw ?? NONE);
}

/** The selected listing: keeps the current selection while it is still listed, else the first one. */
export function selectedListing(items, selectedId) {
  if (items.length === 0) return null;
  return items.find((item) => item.id === selectedId) ?? items[0];
}

/** After dismissing `id` from the visible list: the next tile's id, else the previous one, else null. */
export function selectionAfterDismiss(items, id) {
  const index = items.findIndex((item) => item.id === id);
  if (index === -1) return null;
  return (items[index + 1] ?? items[index - 1])?.id ?? null;
}

/** A run without finished_at older than this is a leftover of a crashed process, not a running fetch (matches the server). */
const STALE_RUN_MS = 15 * 60_000;

/** True while the latest recorded run is unfinished and recent. */
export function isFetchRunning(status, now = Date.now()) {
  const last = status?.lastFetch;
  return Boolean(last) && !has(last.finishedAt) && now - last.startedAt < STALE_RUN_MS;
}

/**
 * The toast for a manual fetch: null until a run newer than `prevRunId` has finished, then
 * {type: 'success' | 'error', message}.
 */
export function fetchOutcome(prevRunId, status) {
  const last = status?.lastFetch;
  if (!last || last.id === prevRunId || !has(last.finishedAt)) return null;
  if (last.botDetected) {
    return {
      type: 'error',
      message: 'Bot detection triggered. wgg will not try to bypass it; wait before fetching again.',
    };
  }
  if (has(last.error)) return { type: 'error', message: `Fetch failed: ${last.error}` };
  if (last.errorCount > 0) {
    return {
      type: 'error',
      message: `Fetch finished with ${last.errorCount} ${last.errorCount === 1 ? 'error' : 'errors'}.`,
    };
  }
  return { type: 'success', message: `${last.newCount} new ${last.newCount === 1 ? 'offer' : 'offers'}` };
}

/** "45 s" / "2 min" for a waiting time in seconds. */
export function formatRetryAfter(seconds) {
  return seconds < 60 ? `${seconds} s` : `${Math.ceil(seconds / 60)} min`;
}

/**
 * State of the "Fetch now" button from `status.manualFetch` (see `manualFetchState` of the fetch coordinator).
 * Disabling is a convenience: the server's 409/429 stays the authority, so without the numbers the button is enabled.
 * @returns {{enabled: boolean, label: string, tooltip: string}}
 */
export function fetchNowState(status, now = Date.now()) {
  const manual = status?.manualFetch;
  if (manual?.running) return { enabled: false, label: 'Fetching...', tooltip: '' };
  if (!has(manual?.availableAt) || manual.availableAt <= now) return { enabled: true, label: 'Fetch now', tooltip: '' };
  const minutes = Math.ceil((manual.availableAt - now) / 60_000);
  const wait = minutes <= 1 ? 'less than a minute' : `${minutes} min`;
  return { enabled: false, label: 'Fetch now', tooltip: `Available in ${wait} (${formatClock(manual.availableAt)})` };
}

/** Message for a refused fetch request (409/429 body), with the waiting time when the server gave one. */
export function refusalMessage(rejection) {
  const error = rejection?.json?.error;
  if (typeof error !== 'string' || error.length === 0) return 'Could not start a fetch.';
  const wait = rejection.json.retryAfterSeconds;
  return typeof wait === 'number' ? `${error} Try again in ${formatRetryAfter(wait)}.` : error;
}

// ---- LLM assessment ----

const DEFAULT_BADGE_THRESHOLD = 0.3;
const HIGH_VERBINDUNG = 0.6; // the default llm.excludeThreshold: from here the listing is normally excluded

/** An exclusion reason as shown to the user: the internal "(p=0.82)" probability is dropped. */
export function publicReason(reason) {
  return typeof reason === 'string' ? reason.replace(/\s*\(p=[\d.]+\)/, '') : reason;
}

/** Colour tone of a Verbindung probability: low (below the badge threshold), mid, high. */
export function verbindungTone(probability, badgeThreshold = DEFAULT_BADGE_THRESHOLD) {
  if (probability >= HIGH_VERBINDUNG) return 'high';
  return probability >= badgeThreshold ? 'mid' : 'low';
}

/** The tile's warning badge: {text: "Verbindung !", tone} from `badgeThreshold` on, else null. */
export function verbindungBadge(llm, badgeThreshold = DEFAULT_BADGE_THRESHOLD) {
  const p = llm?.status === 'done' ? llm.result?.verbindungProbability : null;
  if (!has(p) || p < (badgeThreshold ?? DEFAULT_BADGE_THRESHOLD)) return null;
  return { text: 'Verbindung !', tone: verbindungTone(p, badgeThreshold) };
}

/** "Not eligible: only women wanted" when the AI found the ad explicitly excludes the user, else null. */
export function eligibilityLabel(result) {
  if (result?.eligible !== false) return null;
  return has(result.eligibilityReason) ? `Not eligible: ${result.eligibilityReason}` : 'Not eligible';
}

/** Status line while there is no result: pending, failed (with the reason) or skipped (with the reason). */
export function llmStatusLabel(llm) {
  if (!llm || llm.status === 'done') return null;
  if (llm.status === 'failed') return has(llm.error) ? `AI assessment failed: ${llm.error}` : 'AI assessment failed';
  if (llm.status === 'skipped') {
    return has(llm.error) ? `AI assessment skipped: ${llm.error}` : 'AI assessment skipped';
  }
  return 'AI assessment pending';
}

/** "model-id, evaluated 3 h ago" */
export function describeLlmModel(llm, now = Date.now()) {
  if (!has(llm?.model)) return null;
  return has(llm.evaluatedAt)
    ? `${llm.model}, evaluated ${formatRelativeTime(llm.evaluatedAt, now)}`
    : String(llm.model);
}

/** Tooltip text of the header: how the two queues work, so "N pending" is not a mystery. */
export function queueHelp() {
  return [
    'Details: wgg opens one offer page every 30–90 seconds (a polite pace), the best-scored offers first.',
    'AI: the assessment of an offer starts right after its details are stored. Offers are assessed one at a time, for all users in turns, so your number can take a while to fall (the estimate in brackets uses the measured time per assessment). Only offers from the last days are assessed.',
    'The counts are your own: offers you cannot see, have hidden, or that your rules exclude are not counted, and neither are offers without a description.',
  ].join(' ');
}

const DEFAULT_LLM_SECONDS = 8; // one assessment of the free local model, until the server has measured it

/** Seconds the user's AI backlog takes: the server's estimate (measured average, all users in turns), else 8 s each. */
function llmEtaSeconds(llm) {
  return has(llm.etaSeconds) ? llm.etaSeconds : llm.pending * DEFAULT_LLM_SECONDS;
}

/** "1 min", "21 min", "2 h" for a duration in seconds (rounded to whole minutes). */
function formatEta(seconds) {
  const minutes = Math.max(1, Math.round(seconds / 60));
  return minutes < 120 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
}

/** Header summary of the LLM queue (/api/status.llm). */
export function describeLlmQueue(llm) {
  if (!llm) return null;
  const parts = [llm.pending > 0 ? `${llm.pending} pending (~${formatEta(llmEtaSeconds(llm))})` : 'up to date'];
  if (llm.failed > 0) parts.push(`${llm.failed} failed`);
  return parts.join(', ');
}

/** True when an offer just hidden for `reason` ('messaged' | 'not_interested') stays in the list (its switch is on). */
export function isShownWhenHidden(filters, reason) {
  return reason === 'messaged' ? Boolean(filters.showMessaged) : Boolean(filters.showNotInterested);
}

/** "3 removed automatically" for the muted toolbar line, or null when there are none. */
export function hiddenAutomaticallyLabel(count) {
  return Number.isFinite(count) && count > 0 ? `${count} removed automatically` : null;
}

/** "Messaged on 2 October 2026" when the user marked the offer as messaged (also after a restore), else null. */
export function messagedLabel(item, fallbackAt = null) {
  const at = item?.messagedAt ?? fallbackAt;
  return has(at) ? `Messaged on ${formatDay(at)}` : null;
}

/** "Hidden by you" / "Removed automatically: <reason>" for a hidden listing; null while it is visible. */
export function hiddenLabel(item) {
  const hidden = item?.hidden ?? (item?.dismissed ? { by: 'user' } : null);
  if (!hidden) return null;
  if (hidden.by === 'user' && hidden.reason === 'Messaged') return messagedLabel(item, hidden.at);
  if (hidden.by === 'program') {
    return has(hidden.reason) ? `Removed automatically: ${publicReason(hidden.reason)}` : 'Removed automatically';
  }
  return 'Hidden by you';
}

/** True when the LLM flags the listing as a likely Studentenverbindung (probability from the badge threshold on). */
export function isVerbindung(llm, badgeThreshold = DEFAULT_BADGE_THRESHOLD) {
  return verbindungBadge(llm, badgeThreshold) !== null;
}

function bucketOf(score) {
  if (!has(score)) return 'none';
  if (score >= 8) return 'good';
  return score >= 5 ? 'ok' : 'bad';
}

/** Tile chip for the current sort: base score ('overall'), AI fit score ('ai') or rent ('price'). */
export function scoreChip(item, sort) {
  const excluded = Boolean(item?.evaluation?.excludedReason);
  if (sort === 'ai') {
    const ai = aiScore(item?.llm);
    return { value: formatScore(ai), label: 'AI', bucket: excluded ? 'excluded' : bucketOf(ai) };
  }
  if (sort === 'price') {
    const price = item?.price;
    return { value: formatRent(price), label: 'rent', bucket: excluded ? 'excluded' : has(price) ? 'neutral' : 'none' };
  }
  return {
    value: formatScore(item?.evaluation?.overall),
    label: excluded ? 'excluded' : '/ 10',
    bucket: scoreBucket(item?.evaluation),
  };
}

// ---- the flat ("3er WG") and who lives in it ----

const GENDERS = [
  { key: 'female', symbol: '♀', one: 'woman', many: 'women' },
  { key: 'male', symbol: '♂', one: 'man', many: 'men' },
  { key: 'diverse', symbol: '⚧', one: 'diverse', many: 'diverse' },
];

/**
 * The known flatmates as symbol + count, like WG-Gesucht shows them: only genders with at least one person (the
 * unspecified count is not shown: what it stands for is not verified). Empty when there is no data or nobody is known.
 */
export function flatmateParts(flatmates) {
  if (!flatmates) return [];
  return GENDERS.filter(({ key }) => flatmates[key] > 0).map(({ key, symbol, one, many }) => ({
    key,
    symbol,
    count: flatmates[key],
    label: flatmates[key] === 1 ? one : many,
  }));
}

/** "3er WG" (null when the size is unknown). */
export function flatLabel({ wgSize }) {
  return has(wgSize) ? `${wgSize}er WG` : null;
}

/** "3-person flat: 1 woman, 1 man" for assistive technology; just "4-person flat" when nobody is known. */
export function describeFlat({ wgSize, flatmates }) {
  const size = has(wgSize) ? wgSize : flatmates?.wgSize;
  if (!has(size)) return null;
  const who = flatmateParts(flatmates).map((p) => `${p.count} ${p.label}`);
  return `${size}-person flat${who.length > 0 ? `: ${who.join(', ')}` : ''}`;
}

/**
 * The "Why not 10?" list of an AI result: deductions sorted by points (largest first) as "−2 reason", and whether
 * the answer is a perfect 10 without any deduction. Older answers (no `deductions`) give an empty list.
 * @returns {{perfect: boolean, rows: {points: number, text: string}[]}}
 */
export function deductionRows(result) {
  const list = Array.isArray(result?.deductions) ? result.deductions : [];
  const rows = list
    .filter((d) => typeof d?.points === 'number' && typeof d?.reason === 'string')
    .map((d) => {
      const label = `\u2212${d.points}`;
      return { points: d.points, label, reason: d.reason, text: `${label} ${d.reason}` };
    })
    .sort((a, b) => b.points - a.points);
  return { perfect: result?.fitScore === 10 && rows.length === 0, rows };
}

/** Closed-state summary of the "Why not 10?" list: "3 points, −4.5" (empty when there is nothing to summarise). */
export function deductionSummary(rows) {
  if (!rows?.length) return '';
  const total = Math.round(rows.reduce((sum, r) => sum + r.points, 0) * 10) / 10;
  return `${rows.length} ${rows.length === 1 ? 'point' : 'points'}, −${total}`;
}
