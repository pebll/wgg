import Db from '../storage/Db.js';
import { computePublishedAt } from '../../provider/onlineAge.js';

/**
 * @typedef {import('../../provider/wgGesucht.js').Listing} Listing
 */

// ---- the two halves of a listing ----
// `listings` holds what is the same for everybody (scraped card, detail page, geocoding). What a person decides or
// computes about a listing lives in `user_listings` (evaluation, distance to their target, AI assessment, hidden /
// messaged, alert state). Every per-user function takes the user id first and only ever touches that user's rows.
// The old per-listing user columns of `listings` are an untouched backup of the single-user data (migration 14).

/** The columns of `listings` that are global. The legacy per-user columns are deliberately not selected. */
const GLOBAL_COLUMNS = [
  'id',
  'provider_id',
  'search_url',
  'link',
  'title',
  'image',
  'price',
  'price_raw',
  'size',
  'size_raw',
  'wg_size',
  'flatmates_raw',
  'flatmates_json',
  'district',
  'street',
  'details_raw',
  'available_from',
  'available_until',
  'availability_raw',
  'online_raw',
  'online_minutes',
  'first_seen_at',
  'published_at',
  'lat',
  'lng',
  'geo_precision',
  'geocode_query',
  'details_status',
  'details_attempts',
  'details_error',
  'details_fetched_at',
  'description_text',
  'detail_page_json',
]
  .map((c) => `l.${c}`)
  .join(', ');

/** The per-user columns under the names the rest of the code always used (`dismissed_at` = `hidden_at`). */
const USER_COLUMNS = `
  ul.overall_score AS overall_score, ul.scores_json AS scores_json, ul.details_json AS details_json,
  ul.missing_json AS missing_json, ul.excluded_reason AS excluded_reason, ul.evaluated_at AS evaluated_at,
  ul.distance_km AS distance_km,
  COALESCE(ul.llm_status, 'pending') AS llm_status, ul.llm_json AS llm_json, ul.llm_model AS llm_model,
  ul.llm_evaluated_at AS llm_evaluated_at, ul.llm_error AS llm_error, COALESCE(ul.llm_attempts, 0) AS llm_attempts,
  ul.llm_prompt_version AS llm_prompt_version, ul.llm_settings_hash AS llm_settings_hash,
  ul.hidden_at AS dismissed_at, ul.hidden_by AS hidden_by, ul.hidden_reason AS hidden_reason,
  COALESCE(ul.hide_override, 0) AS hide_override, ul.messaged_at AS messaged_at,
  ul.notified_at AS notified_at, ul.notified_kind AS notified_kind, ul.notify_error AS notify_error,
  COALESCE(ul.notify_attempts, 0) AS notify_attempts, ul.tier AS tier`;

/** What `@userId` may see: listings found by one of their enabled queries, plus the ones they hid or messaged. */
const VISIBLE_SQL = `(EXISTS (SELECT 1 FROM listing_queries lq
    JOIN user_queries uq ON uq.url = lq.query_url AND uq.user_id = @userId AND uq.enabled = 1
    WHERE lq.listing_id = l.id) OR ul.hidden_by = 'user' OR ul.messaged_at IS NOT NULL)`;

/**
 * A row source (use it as `FROM ${userRows()} AS v`): the listings of `@userId` with their per-user state in the shape of
 * the old single-user row. Every statement using it must bind `userId`. `visibleOnly: false` includes listings the
 * user cannot see (workers look a row up by id).
 */
export function userRows({ visibleOnly = true } = {}) {
  return `(SELECT ${GLOBAL_COLUMNS}, ${USER_COLUMNS}
    FROM listings l LEFT JOIN user_listings ul ON ul.listing_id = l.id AND ul.user_id = @userId
    ${visibleOnly ? `WHERE ${VISIBLE_SQL}` : ''})`;
}

/** A listing whose description will never come (details skipped or failed) or came empty. SQL on `listings`. */
const NO_TEXT_SQL = `(details_status IN ('failed', 'skipped')
    OR (details_status = 'fetched' AND (description_text IS NULL OR description_text = '')))`;

/** The `llm_error` of rows skipped for lack of a description (the marker to re-queue them when details arrive). */
export const NO_DESCRIPTION = 'no description';

/**
 * Marks pending AI rows whose listing has no description as skipped ("no description"), so they never count as
 * pending and the queue does not wait for text that does not come. `listingId` limits it to one listing.
 * @returns {number} Rows changed.
 */
function skipLlmWithoutDescription(db, { userId, listingId } = {}) {
  const userSql = userId === undefined ? '' : ' AND user_id = @userId';
  const listingSql = listingId === undefined ? '' : ' AND listing_id = @listingId';
  return db
    .prepare(
      `UPDATE user_listings SET llm_status = 'skipped', llm_error = @reason
       WHERE llm_status = 'pending'${userSql}${listingSql}
         AND listing_id IN (SELECT id FROM listings WHERE ${NO_TEXT_SQL})`,
    )
    .run({
      reason: NO_DESCRIPTION,
      ...(userId === undefined ? {} : { userId }),
      ...(listingId === undefined ? {} : { listingId }),
    }).changes;
}

/** Creates the (empty) per-user row of a listing when there is none yet; born skipped when no text will come. */
function ensureUserListing(db, userId, listingId) {
  const { changes } = db
    .prepare('INSERT OR IGNORE INTO user_listings (user_id, listing_id) VALUES (@userId, @listingId)')
    .run({ userId, listingId });
  if (changes === 1) skipLlmWithoutDescription(db, { userId, listingId });
}

/**
 * Returns the listings whose provider id is not stored yet (read-only).
 * @param {Listing[]} listings
 * @returns {Listing[]}
 */
export function findNewListings(listings) {
  const db = Db.getConnection();
  const exists = db.prepare('SELECT 1 FROM listings WHERE provider_id = ?');
  const seen = new Set();
  return listings.filter((l) => {
    if (seen.has(l.providerId) || exists.get(l.providerId)) return false;
    seen.add(l.providerId);
    return true;
  });
}

/**
 * Stores listings that are not known yet and returns exactly those, so each listing is processed
 * once. Uses INSERT OR IGNORE on the UNIQUE provider_id inside one transaction. Every returned-by-the-search listing
 * (new or already stored) is recorded in `listing_queries` for this search URL.
 *
 * @param {Listing[]} listings
 * @param {string} searchUrl The configured search these listings were found by.
 * @param {number} [now] first_seen_at in ms (injectable for tests).
 * @returns {Listing[]} The newly stored listings.
 */
export function storeNewListings(listings, searchUrl, now = Date.now()) {
  return Db.withTransaction((db) => {
    const found = db.prepare('SELECT id FROM listings WHERE provider_id = ?');
    const link = db.prepare(
      'INSERT OR IGNORE INTO listing_queries (listing_id, query_url, first_seen_at) VALUES (?, ?, ?)',
    );
    const fillFlatmates = db.prepare(
      'UPDATE listings SET flatmates_json = @json WHERE id = @id AND flatmates_json IS NULL',
    );
    const insert = db.prepare(`
      INSERT OR IGNORE INTO listings (
        provider_id, search_url, link, title, image, price, price_raw, size, size_raw, wg_size,
        flatmates_raw, flatmates_json, district, street, details_raw, available_from, available_until,
        availability_raw, online_raw, online_minutes, first_seen_at, published_at
      ) VALUES (
        @providerId, @searchUrl, @link, @title, @image, @price, @priceRaw, @size, @sizeRaw, @wgSize,
        @flatmatesRaw, @flatmatesJson, @district, @street, @detailsRaw, @availableFrom, @availableUntil,
        @availabilityRaw, @onlineRaw, @onlineMinutes, @now, @publishedAt
      )
    `);
    const stored = [];
    for (const l of listings) {
      const info = insert.run({
        providerId: l.providerId,
        searchUrl,
        link: l.link,
        title: l.title ?? null,
        image: l.image ?? null,
        price: l.price ?? null,
        priceRaw: l.priceRaw ?? null,
        size: l.size ?? null,
        sizeRaw: l.sizeRaw ?? null,
        wgSize: l.wgSize ?? null,
        flatmatesRaw: l.flatmatesRaw ?? null,
        flatmatesJson: l.flatmates ? JSON.stringify(l.flatmates) : null,
        district: l.district ?? null,
        street: l.street ?? null,
        detailsRaw: l.detailsRaw ?? null,
        availableFrom: l.availableFrom ?? null,
        availableUntil: l.availableUntil ?? null,
        availabilityRaw: l.availabilityRaw ?? null,
        onlineRaw: l.onlineRaw ?? null,
        onlineMinutes: l.onlineMinutes ?? null,
        now,
        publishedAt: computePublishedAt(l.onlineRaw, now, l.onlineMinutes),
      });
      if (info.changes === 1) stored.push(l);
      // Every listing the search returned is linked to it, new or not: another user's query may have stored it first.
      const row = found.get(l.providerId);
      if (row) link.run(row.id, searchUrl, now);
      // A listing stored before the flatmates were read gets them when a card shows them (never overwritten).
      if (row && l.flatmates && info.changes === 0)
        fillFlatmates.run({ id: row.id, json: JSON.stringify(l.flatmates) });
    }
    return stored;
  });
}

/**
 * @param {string} providerId
 * @returns {object|undefined} The global part of the stored row (no per-user state).
 */
export function getListingByProviderId(providerId) {
  return Db.getConnection()
    .prepare(`SELECT ${GLOBAL_COLUMNS} FROM listings l WHERE l.provider_id = ?`)
    .get(String(providerId));
}

/**
 * The listing with one user's state (evaluation, AI assessment, hidden, alert), whether or not it is in their view.
 * @param {string} userId
 * @param {string} providerId
 * @returns {object|undefined}
 */
export function getUserListing(userId, providerId) {
  return Db.getConnection()
    .prepare(`SELECT * FROM ${userRows({ visibleOnly: false })} AS v WHERE v.provider_id = @providerId`)
    .get({ userId, providerId: String(providerId) });
}

const SORT_COLUMNS = { overall: 'overall_score', first_seen: 'first_seen_at', price: 'price' };
/** `sort=ai`: the LLM fit score of a finished assessment (always descending; unassessed rows last, then overall). */
export const AI_SCORE_SQL = `CASE WHEN llm_status = 'done' THEN json_extract(llm_json, '$.fitScore') END`;
const SORTS = [...Object.keys(SORT_COLUMNS), 'ai'];
const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

function toNumberOrNull(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toPositiveNumberOrNull(value) {
  const n = toNumberOrNull(value);
  return n !== null && n > 0 ? n : null;
}

/**
 * `show=not_interested,messaged,auto`: which hidden listings are listed too (the user's own, and the ones the program
 * removed automatically). Unknown values are ignored.
 */
function parseShow(value) {
  const parts = String(value ?? '')
    .split(',')
    .map((p) => p.trim());
  return {
    notInterested: parts.includes('not_interested'),
    messaged: parts.includes('messaged'),
    auto: parts.includes('auto'),
  };
}

/** The range filters of the distribution charts: `<key>Min` / `<key>Max` query parameters (see RANGE_SQL). */
export const RANGE_KEYS = ['score', 'ai', 'rent', 'dist'];

function parseRanges(raw) {
  return Object.fromEntries(
    RANGE_KEYS.map((key) => [key, { min: toNumberOrNull(raw[`${key}Min`]), max: toNumberOrNull(raw[`${key}Max`]) }]),
  );
}

/** `tier=good|fantastic`: only listings with that alert tier (see lib/notify/tier.js); anything else means no filter. */
export const TIER_VALUES = ['good', 'fantastic'];

function toPositiveInt(value, fallback) {
  const n = toNumberOrNull(value);
  return n !== null && Number.isInteger(n) && n >= 1 ? n : fallback;
}

/**
 * Turns untrusted query values (strings from the URL) into a safe query: sort/dir are whitelisted,
 * numbers are coerced (garbage becomes "no filter"), pageSize is capped.
 * @param {Record<string, unknown>} [raw]
 */
export function normalizeListingQuery(raw = {}) {
  return {
    sort: SORTS.includes(raw.sort) ? raw.sort : 'first_seen',
    dir: raw.dir === 'asc' ? 'asc' : 'desc',
    minScore: toNumberOrNull(raw.minScore),
    maxRent: toNumberOrNull(raw.maxRent),
    maxAgeDays: toNumberOrNull(raw.maxAgeDays),
    maxAgeHours: toPositiveNumberOrNull(raw.maxAgeHours),
    show: parseShow(raw.show),
    ranges: parseRanges(raw),
    tier: TIER_VALUES.includes(raw.tier) ? raw.tier : null,
    includeHidden: [raw.includeHidden, raw.includeDismissed].some((v) => v === '1' || v === 'true' || v === true),
    page: toPositiveInt(raw.page, 1),
    pageSize: Math.min(toPositiveInt(raw.pageSize, DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE),
  };
}

function parseJson(text, fallback) {
  if (text == null) return fallback;
  try {
    const value = JSON.parse(text);
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

/** The stored flatmates (JSON) of a row, or null when unknown. */
export function parseFlatmatesJson(text) {
  return parseJson(text, null);
}

function toApiDetails(row) {
  const page = parseJson(row.detail_page_json, {});
  return {
    status: row.details_status,
    attempts: row.details_attempts,
    error: row.details_error,
    fetchedAt: row.details_fetched_at,
    description: row.description_text,
    sections: page.sections ?? [],
    costs: page.costs ?? [],
    address: page.address ?? null,
    availabilityRaw: page.availabilityRaw ?? null,
    onlineRaw: page.onlineRaw ?? null,
    wgFacts: page.wgFacts ?? [],
    objectFacts: page.objectFacts ?? [],
  };
}

function toApiLlm(row) {
  return {
    status: row.llm_status,
    model: row.llm_model,
    evaluatedAt: row.llm_evaluated_at,
    error: row.llm_error,
    attempts: row.llm_attempts,
    result: parseJson(row.llm_json, null),
  };
}

export function toApiListing(row) {
  const evaluated = row.evaluated_at !== null || row.overall_score !== null;
  return {
    id: row.id,
    providerId: row.provider_id,
    link: row.link,
    title: row.title,
    image: row.image,
    price: row.price,
    size: row.size,
    wgSize: row.wg_size,
    flatmates: parseFlatmatesJson(row.flatmates_json),
    district: row.district,
    street: row.street,
    availableFrom: row.available_from,
    availableUntil: row.available_until,
    onlineRaw: row.online_raw,
    onlineMinutes: row.online_minutes,
    firstSeenAt: row.first_seen_at,
    publishedAt: row.published_at,
    lat: row.lat,
    lng: row.lng,
    geoPrecision: row.geo_precision,
    distanceKm: row.distance_km,
    dismissed: row.dismissed_at !== null,
    dismissedAt: row.dismissed_at,
    messagedAt: row.messaged_at ?? null,
    hidden:
      row.dismissed_at === null
        ? null
        : { by: row.hidden_by ?? 'user', reason: row.hidden_reason ?? 'Not interested', at: row.dismissed_at },
    details: toApiDetails(row),
    llm: toApiLlm(row),
    notified: row.notified_at !== null,
    notifiedAt: row.notified_at,
    notifiedKind: row.notified_kind ?? null,
    tier: row.tier ?? null,
    evaluation: evaluated
      ? {
          overall: row.overall_score,
          scores: parseJson(row.scores_json, {}),
          details: parseJson(row.details_json, {}),
          missing: parseJson(row.missing_json, []),
          excludedReason: row.excluded_reason,
          evaluatedAt: row.evaluated_at,
        }
      : null,
  };
}

/** The expression each range filter bounds (columns of the per-user row source). */
const RANGE_SQL = { score: 'overall_score', ai: `(${AI_SCORE_SQL})`, rent: 'price', dist: 'distance_km' };

const USER_MESSAGED_SQL = `(COALESCE(hidden_by, 'user') = 'user' AND hidden_reason = 'Messaged')`;
const PROGRAM_HIDDEN_SQL = `(hidden_by = 'program' AND dismissed_at IS NOT NULL)`;
const USER_NOT_INTERESTED_SQL = `(COALESCE(hidden_by, 'user') = 'user' AND COALESCE(hidden_reason, '') <> 'Messaged')`;

/**
 * The WHERE clause shared by the listing list and the distribution stats, so both always describe the same
 * set of rows. It applies to a per-user row source (`userRows()`, alias `v`). Only fixed SQL fragments reach the text;
 * every value is a bound parameter.
 *
 * Hidden rows (by the user or by the program, see migration 9) are excluded unless `includeHidden` is set (the old
 * name `includeDismissed` is an alias; it shows everything). `show` lists hidden rows by kind: the user's own
 * (not interested / messaged) and the ones the program removed (`auto`).
 * Phase-5 notifier hook: anything that selects listings to notify about must go through this filter (or
 * check `dismissed_at IS NULL` itself), so a hidden offer (either kind) is never announced.
 *
 * @param {ReturnType<typeof normalizeListingQuery>} q
 * @param {number} now Reference time in ms.
 * @param {{omitRanges?: string[]}} [options] Range filters to leave out (see RANGE_KEYS).
 * @returns {{whereSql: string, params: Record<string, number>}}
 */
export function buildListingFilter(q, now, { omitRanges = [] } = {}) {
  const where = [];
  const params = {};
  if (!q.includeHidden) {
    // Visible rows, plus the hidden rows (user's own or program-removed) whose switch is on.
    const shown = ['dismissed_at IS NULL'];
    if (q.show?.messaged) shown.push(USER_MESSAGED_SQL);
    if (q.show?.notInterested) shown.push(USER_NOT_INTERESTED_SQL);
    if (q.show?.auto) shown.push(PROGRAM_HIDDEN_SQL);
    where.push(`(${shown.join(' OR ')})`);
  }
  if (q.maxRent !== null) {
    where.push('price <= @maxRent');
    params.maxRent = q.maxRent;
  }
  if (q.maxAgeDays !== null) {
    where.push('COALESCE(published_at, first_seen_at) >= @cutoff');
    params.cutoff = now - q.maxAgeDays * 86_400_000;
  }
  if (q.maxAgeHours !== null) {
    where.push('COALESCE(published_at, first_seen_at) >= @cutoffHours');
    params.cutoffHours = now - q.maxAgeHours * 3_600_000;
  }
  if (q.minScore !== null) {
    where.push('overall_score >= @minScore');
    params.minScore = q.minScore;
  }
  if (q.tier) {
    where.push('tier = @tier');
    params.tier = q.tier;
  }
  // Range filters (scoreMin/scoreMax, ...): half-open [min, max) like the histogram bins, AND-combined. A row without
  // the value never matches an active bound. The stats leave out a chart's own range (`omitRanges`) so its other bars
  // stay visible.
  for (const key of RANGE_KEYS) {
    if (omitRanges.includes(key)) continue;
    const { min, max } = q.ranges?.[key] ?? {};
    if (min !== null && min !== undefined) {
      where.push(`${RANGE_SQL[key]} >= @${key}Min`);
      params[`${key}Min`] = min;
    }
    if (max !== null && max !== undefined) {
      where.push(`${RANGE_SQL[key]} < @${key}Max`);
      params[`${key}Max`] = max;
    }
  }
  return { whereSql: where.length > 0 ? `WHERE ${where.join(' AND ')}` : '', params };
}

/** Reasons the user can hide a listing for: hidden_reason text and whether it also sets `messaged_at`. */
export const HIDE_REASONS = {
  not_interested: { text: 'Not interested', messaged: false },
  messaged: { text: 'Messaged', messaged: true },
};

/**
 * Hides a listing for the user (never deleted): "not interested" (default) or "messaged" (already contacted; also
 * records `messaged_at`, kept even after a restore). Keeps the first hide timestamp and the first `messaged_at` when
 * repeated; it also takes over a listing the program hid (the user's decision wins from now on). Only listings the user
 * can see are affected (other users' state is never touched).
 * @param {string} userId
 * @param {number} id
 * @param {number} [now]
 * @param {'not_interested'|'messaged'} [reason]
 * @returns {boolean} false when the user has no such listing.
 */
export function dismissListing(userId, id, now = Date.now(), reason = 'not_interested') {
  const { text, messaged } = HIDE_REASONS[reason] ?? HIDE_REASONS.not_interested;
  return Db.withTransaction((db) => {
    if (!db.prepare(`SELECT 1 FROM ${userRows()} AS v WHERE v.id = @id`).get({ userId, id })) return false;
    ensureUserListing(db, userId, id);
    db.prepare(
      `UPDATE user_listings SET hidden_at = COALESCE(hidden_at, @now), hidden_by = 'user',
         hidden_reason = @text,
         messaged_at = CASE WHEN @messaged = 1 THEN COALESCE(messaged_at, @now) ELSE messaged_at END
       WHERE user_id = @userId AND listing_id = @id`,
    ).run({ userId, id, now, text, messaged: messaged ? 1 : 0 });
    return true;
  });
}

/**
 * Undo of dismissListing, for both kinds of hiding. The restore is remembered (`hide_override`): the program never
 * hides this listing again, whatever a later evaluation says. @returns {boolean} false when the user has no such listing.
 */
export function restoreListing(userId, id) {
  return Db.withTransaction((db) => {
    if (!db.prepare(`SELECT 1 FROM ${userRows()} AS v WHERE v.id = @id`).get({ userId, id })) return false;
    ensureUserListing(db, userId, id);
    db.prepare(
      `UPDATE user_listings SET hidden_at = NULL, hidden_by = NULL, hidden_reason = NULL, hide_override = 1
       WHERE user_id = @userId AND listing_id = @id`,
    ).run({ userId, id });
    return true;
  });
}

/**
 * Lists one user's listings for the UI. Only whitelisted column names reach the SQL text; every value
 * is a bound parameter. NULLs (unevaluated / unknown rent) always sort last.
 *
 * @param {string} userId
 * @param {Record<string, unknown>} [rawQuery] See normalizeListingQuery. `maxAgeDays` / `maxAgeHours` (positive,
 *   fractions allowed) keep listings whose published_at (fallback first_seen_at) is at most that long before `now`;
 *   unset = no age filter. `sort`: overall, price, first_seen, or ai (LLM fit score desc, unassessed last).
 * @param {number} [now] Reference time in ms (injectable for tests).
 * @returns {{items: object[], total: number, page: number, pageSize: number, hiddenAutomatically: number}}
 */
export function queryListings(userId, rawQuery = {}, now = Date.now()) {
  const q = normalizeListingQuery(rawQuery);
  const db = Db.getConnection();
  const source = `${userRows()} AS v`;

  const { whereSql, params } = buildListingFilter(q, now);

  let orderSql;
  if (q.sort === 'ai') {
    orderSql = `ORDER BY (${AI_SCORE_SQL} IS NULL), ${AI_SCORE_SQL} DESC, (overall_score IS NULL), overall_score DESC, first_seen_at DESC, id DESC`;
  } else {
    const column = SORT_COLUMNS[q.sort];
    const direction = q.dir === 'asc' ? 'ASC' : 'DESC';
    orderSql = `ORDER BY (${column} IS NULL), ${column} ${direction}, first_seen_at DESC, id DESC`;
  }

  const bound = { ...params, userId };
  const total = db.prepare(`SELECT COUNT(*) AS n FROM ${source} ${whereSql}`).get(bound).n;
  const rows = db
    .prepare(`SELECT * FROM ${source} ${whereSql} ${orderSql} LIMIT @limit OFFSET @offset`)
    .all({ ...bound, limit: q.pageSize, offset: (q.page - 1) * q.pageSize });

  // Listings the program hid (exclusions), within the same recency window: the UI mentions them in the toolbar.
  const auto = buildListingFilter({ ...q, includeHidden: true }, now);
  const programWhere = `${auto.whereSql === '' ? 'WHERE' : `${auto.whereSql} AND`} hidden_by = 'program' AND dismissed_at IS NOT NULL`;
  const hiddenAutomatically = db
    .prepare(`SELECT COUNT(*) AS n FROM ${source} ${programWhere}`)
    .get({ ...auto.params, userId }).n;

  return { items: rows.map(toApiListing), total, page: q.page, pageSize: q.pageSize, hiddenAutomatically };
}

/**
 * One user's rows that the evaluation pipeline works on (their view of the listings, with their own state).
 * @param {{userId: string, onlyUnevaluated?: boolean, providerIds?: string[]}} options
 * @returns {object[]} Raw rows, oldest first.
 */
export function selectRowsForEvaluation({ userId, onlyUnevaluated = false, providerIds }) {
  const db = Db.getConnection();
  let rows = db
    .prepare(`SELECT * FROM ${userRows()} AS v ${onlyUnevaluated ? 'WHERE evaluated_at IS NULL' : ''} ORDER BY id ASC`)
    .all({ userId });
  if (providerIds) {
    const wanted = new Set(providerIds);
    rows = rows.filter((r) => wanted.has(r.provider_id));
  }
  return rows;
}

/**
 * Stores geocoding results for a listing (global: the same place for everybody). `geo` null records "unknown" (all
 * geo columns NULL). The distance to a user's target is per user (see updateListingEvaluation).
 * @param {number} id
 * @param {{lat: number, lng: number, precision: string, query: string}|null} geo
 */
export function updateListingGeo(id, geo) {
  Db.execute(
    `UPDATE listings SET lat = @lat, lng = @lng, geo_precision = @precision, geocode_query = @query WHERE id = @id`,
    { id, lat: geo?.lat ?? null, lng: geo?.lng ?? null, precision: geo?.precision ?? null, query: geo?.query ?? null },
  );
}

/**
 * Stores an evaluation result for one user's row and applies the program's hiding rule: an exclusion (or, with
 * `autoHideBelow`, a score below that value) hides the listing with the reason; a later result without a reason
 * un-hides a program-hidden listing. Listings the user hid or restored are never touched (the user wins).
 *
 * @param {string} userId
 * @param {number} id
 * @param {import('../../evaluation/ruleBasedEvaluator.js').EvaluationResult} result
 * @param {number} [now] evaluated_at in ms.
 * @param {{autoHideBelow?: number|null, distanceKm?: number|null}} [options] `distanceKm`: distance to this user's
 *   target (null = unknown); left unchanged when not given.
 */
export function updateListingEvaluation(
  userId,
  id,
  result,
  now = Date.now(),
  { autoHideBelow = null, distanceKm } = {},
) {
  const db = Db.getConnection();
  db.transaction(() => {
    ensureUserListing(db, userId, id);
    db.prepare(
      `UPDATE user_listings SET overall_score = @overall, scores_json = @scores, details_json = @details,
         missing_json = @missing, excluded_reason = @excluded, evaluated_at = @now,
         distance_km = CASE WHEN @setDistance = 1 THEN @distanceKm ELSE distance_km END
       WHERE user_id = @userId AND listing_id = @id`,
    ).run({
      userId,
      id,
      overall: result.overall,
      scores: JSON.stringify(result.scores),
      details: JSON.stringify(result.details),
      missing: JSON.stringify(result.missing),
      excluded: result.excluded ?? null,
      now,
      setDistance: distanceKm === undefined ? 0 : 1,
      distanceKm: distanceKm ?? null,
    });

    const reason =
      result.excluded ??
      (autoHideBelow !== null &&
      autoHideBelow !== undefined &&
      typeof result.overall === 'number' &&
      result.overall < autoHideBelow
        ? `Score ${result.overall} below ${autoHideBelow}`
        : null);
    const row = db
      .prepare('SELECT hidden_by, hide_override FROM user_listings WHERE user_id = @userId AND listing_id = @id')
      .get({ userId, id });
    if (!row || row.hidden_by === 'user') return;
    if (reason && !row.hide_override) {
      db.prepare(
        `UPDATE user_listings SET hidden_at = COALESCE(hidden_at, @now), hidden_by = 'program', hidden_reason = @reason
         WHERE user_id = @userId AND listing_id = @id`,
      ).run({ userId, id, now, reason });
    } else if (!reason && row.hidden_by === 'program') {
      db.prepare(
        `UPDATE user_listings SET hidden_at = NULL, hidden_by = NULL, hidden_reason = NULL
         WHERE user_id = @userId AND listing_id = @id`,
      ).run({ userId, id });
    }
  })();
  return undefined;
}

// ---- detail pages (fetched in the background by the detail worker; one fetch serves every user) ----

const AGE_SQL = 'COALESCE(published_at, first_seen_at)';

/** SQL fragment + named parameters matching rows by provider id or row id (`wgg details|llm --ids`). */
function idsClause(ids) {
  const params = {};
  const marks = ids.map((id, i) => {
    params[`i${i}`] = String(id);
    return `@i${i}`;
  });
  const list = marks.join(', ');
  return { sql: `(provider_id IN (${list}) OR CAST(id AS TEXT) IN (${list}))`, params };
}

/**
 * Puts the named listings whose detail fetch was skipped (too old) or failed back to pending, so an explicit
 * `wgg details --ids` retries them.
 * @param {(string|number)[]} ids Provider ids or row ids.
 * @returns {number} How many listings were re-queued.
 */
export function requeueDetails(ids) {
  if (ids.length === 0) return 0;
  const { sql, params } = idsClause(ids);
  return Db.getConnection()
    .prepare(
      `UPDATE listings SET details_status = 'pending', details_attempts = 0, details_error = NULL
       WHERE ${sql} AND details_status IN ('skipped', 'failed')`,
    )
    .run(params).changes;
}

/**
 * A listing somebody still wants: found by an enabled query of a user who has not hidden it. A listing every
 * interested user hid (or no enabled query finds) is not worth a request to WG-Gesucht.
 */
const WANTED_SQL = `EXISTS (SELECT 1 FROM listing_queries lq JOIN user_queries uq ON uq.url = lq.query_url AND uq.enabled = 1
    WHERE lq.listing_id = l.id AND NOT EXISTS (SELECT 1 FROM user_listings h
      WHERE h.listing_id = l.id AND h.user_id = uq.user_id AND h.hidden_at IS NOT NULL))`;
/** The best rule score any user gave the listing: the detail queue fetches the most promising offers first. */
const BEST_SCORE_SQL = '(SELECT MAX(ul.overall_score) FROM user_listings ul WHERE ul.listing_id = l.id)';

/**
 * Next listing whose detail page should be fetched: pending and still wanted by at least one user; fresh listings
 * before retries, then the highest score any user gave it first (unscored last), then the newest. High-scoring offers
 * get their details (and so their LLM check) first, so a Studentenverbindung among them is excluded quickly. Pending
 * listings older than `maxAgeDays` are marked skipped on the way and never returned.
 *
 * With `ids` only those listings are considered (provider or row ids): no age limit, hidden ones included
 * (an explicit request), nothing else is touched.
 *
 * @param {{now?: number, maxAgeDays: number, ids?: (string|number)[]}} options
 * @returns {object|undefined} The global part of the stored row.
 */
export function selectNextPendingDetail({ now = Date.now(), maxAgeDays, ids }) {
  const db = Db.getConnection();
  if (ids) {
    const { sql, params } = idsClause(ids);
    return db
      .prepare(
        `SELECT ${GLOBAL_COLUMNS} FROM listings l WHERE ${sql} AND details_status = 'pending'
         ORDER BY details_attempts ASC, ${AGE_SQL} DESC, id DESC LIMIT 1`,
      )
      .get(params);
  }
  const skipped = db
    .prepare(`UPDATE listings SET details_status = 'skipped' WHERE details_status = 'pending' AND ${AGE_SQL} < @cutoff`)
    .run({ cutoff: now - maxAgeDays * 86_400_000 }).changes;
  if (skipped > 0) skipLlmWithoutDescription(db);
  return db
    .prepare(
      `SELECT ${GLOBAL_COLUMNS} FROM listings l WHERE l.details_status = 'pending' AND ${WANTED_SQL}
       ORDER BY l.details_attempts ASC, (${BEST_SCORE_SQL} IS NULL), ${BEST_SCORE_SQL} DESC,
         COALESCE(l.published_at, l.first_seen_at) DESC, l.id DESC LIMIT 1`,
    )
    .get();
}

/**
 * Stores a parsed detail page: full description in `description_text`, the rest as JSON; status fetched.
 * @param {number} id
 * @param {import('../../provider/wgGesuchtDetail.js').DetailPage} page
 * @param {number} [now]
 */
export function storeListingDetails(id, page, now = Date.now()) {
  const { description, ...rest } = page;
  Db.withTransaction((db) => {
    db.prepare(
      `UPDATE listings SET details_status = 'fetched', details_error = NULL, details_fetched_at = @now,
         details_attempts = details_attempts + 1, description_text = @description, detail_page_json = @json
       WHERE id = @id`,
    ).run({ id, now, description: description || null, json: JSON.stringify(rest) });
    // The card did not say who lives in the flat: take it from the detail page (a card's value wins).
    if (page.flatmates) {
      db.prepare('UPDATE listings SET flatmates_json = @json WHERE id = @id AND flatmates_json IS NULL').run({
        id,
        json: JSON.stringify(page.flatmates),
      });
    }
    // The text arrived late (a retry after "skipped"/"failed"): the AI check is due again.
    if (description) {
      db.prepare(
        `UPDATE user_listings SET llm_status = 'pending', llm_error = NULL
         WHERE listing_id = @id AND llm_status = 'skipped' AND llm_error = @reason`,
      ).run({ id, reason: NO_DESCRIPTION });
    }
  });
}

/**
 * Records a failed detail fetch: attempts + 1; the listing stays pending (retried later) until `maxAttempts`
 * attempts are used up, then it is failed.
 * @returns {'pending'|'failed'} The new status.
 */
export function recordDetailFailure(id, message, { maxAttempts }) {
  const db = Db.getConnection();
  db.prepare(
    `UPDATE listings SET details_attempts = details_attempts + 1, details_error = @message,
       details_status = CASE WHEN details_attempts + 1 >= @maxAttempts THEN 'failed' ELSE 'pending' END
     WHERE id = @id`,
  ).run({ id, message, maxAttempts });
  const status = db.prepare('SELECT details_status FROM listings WHERE id = ?').get(id).details_status;
  if (status === 'failed') skipLlmWithoutDescription(db, { listingId: id });
  return status;
}

/**
 * Counts for one user's header: pending listings that the worker would still fetch (in the user's view, not hidden,
 * not too old), fetched and failed ones.
 * @returns {{pending: number, fetched: number, failed: number}}
 */
export function getDetailCounts({ userId, now = Date.now(), maxAgeDays }) {
  const row = Db.getConnection()
    .prepare(
      `SELECT
         COALESCE(SUM(details_status = 'pending' AND dismissed_at IS NULL AND ${AGE_SQL} >= @cutoff), 0) AS pending,
         COALESCE(SUM(details_status = 'fetched'), 0) AS fetched,
         COALESCE(SUM(details_status = 'failed'), 0) AS failed
       FROM ${userRows()} AS v`,
    )
    .get({ userId, cutoff: now - maxAgeDays * 86_400_000 });
  return { pending: row.pending, fetched: row.fetched, failed: row.failed };
}

// ---- LLM assessment (per user and listing, processed by the LLM worker after the details are fetched) ----

/** The `llm_error` of pending rows skipped because the listing is older than the details window (`details.maxAgeDays`). */
export const TOO_OLD = 'too old';

/** Marks the user's pending AI rows of listings published before `cutoff` as skipped ("too old"); creates missing rows. */
function skipLlmTooOld(db, { userId, cutoff }) {
  db.prepare(
    `INSERT OR IGNORE INTO user_listings (user_id, listing_id)
     SELECT @userId, id FROM ${userRows()} AS v WHERE ${AGE_SQL} < @cutoff AND details_status = 'fetched'`,
  ).run({ userId, cutoff });
  db.prepare(
    `UPDATE user_listings SET llm_status = 'skipped', llm_error = @reason
     WHERE user_id = @userId AND llm_status = 'pending'
       AND listing_id IN (SELECT id FROM listings WHERE ${AGE_SQL} < @cutoff)`,
  ).run({ userId, cutoff, reason: TOO_OLD });
}

/** Highest overall score first, unscored rows last. */
const SCORE_FIRST_SQL = '(overall_score IS NULL), overall_score DESC';

/**
 * One user's listings the LLM worker should assess now: highest rule score first (unscored last), then newest.
 * Listings without usable details are marked skipped ("no description") on the way. Normally: fetched details, not
 * hidden, LLM pending or failed with fewer than `maxAttempts` attempts. With `ids` (provider or row ids) only those
 * listings; `force` also takes finished ones (done / skipped / failed regardless of attempts) and re-assesses them.
 *
 * With `settingsHash`, listings that are `done` with a different stored settings hash (prompt version, the user's
 * profile, model) or none are queued again.
 *
 * With `maxAgeDays` (the details window; not with `ids` / `force`), only listings published within that many days of
 * `now` are queued: older pending ones are marked skipped ("too old"), older failed or outdated ones are left alone and
 * not queued. A new user's query covers a lot of old listings whose details others fetched long ago; assessing those
 * is wasted LLM time.
 *
 * @param {{userId: string, ids?: (string|number)[], force?: boolean, limit?: number, maxAttempts?: number,
 *   settingsHash?: string, maxAgeDays?: number, now?: number}} options
 * @returns {object[]} Stored rows (the user's view).
 */
export function selectLlmQueue({
  userId,
  ids,
  force = false,
  limit,
  maxAttempts = 3,
  settingsHash,
  maxAgeDays,
  now = Date.now(),
} = {}) {
  const db = Db.getConnection();
  // Listings without a usable description are skipped for this user (their row is created for it when missing).
  db.prepare(
    `INSERT OR IGNORE INTO user_listings (user_id, listing_id)
     SELECT @userId, id FROM ${userRows()} AS v WHERE ${NO_TEXT_SQL}`,
  ).run({ userId });
  skipLlmWithoutDescription(db, { userId });
  const where = [`details_status = 'fetched'`, `description_text IS NOT NULL`, `description_text <> ''`];
  let params = { userId };
  if (maxAgeDays !== undefined && !ids && !force) {
    params.cutoff = now - maxAgeDays * 86_400_000;
    skipLlmTooOld(db, { userId, cutoff: params.cutoff });
    where.push(`${AGE_SQL} >= @cutoff`);
  }
  if (ids) {
    const clause = idsClause(ids);
    where.push(clause.sql);
    params = { ...params, ...clause.params };
  } else {
    where.push('dismissed_at IS NULL');
  }
  if (!force) {
    const outdated =
      settingsHash === undefined ? '' : ` OR (llm_status = 'done' AND llm_settings_hash IS NOT @settingsHash)`;
    where.push(`(llm_status = 'pending' OR (llm_status = 'failed' AND llm_attempts < @maxAttempts)${outdated})`);
    params.maxAttempts = maxAttempts;
    if (settingsHash !== undefined) params.settingsHash = settingsHash;
  }
  return db
    .prepare(
      `SELECT * FROM ${userRows()} AS v WHERE ${where.join(' AND ')}
       ORDER BY ${SCORE_FIRST_SQL}, ${AGE_SQL} DESC, id DESC ${limit ? `LIMIT ${Number(limit)}` : ''}`,
    )
    .all(params);
}

/**
 * Stores a successful assessment for one user.
 * @param {string} userId
 * @param {number} id
 * @param {object} result Validated answer plus `model`, `truncated`, `descriptionChars`, `promptVersion` and
 *   `settingsHash` (what the assessment was made with).
 * @param {number} [now]
 */
export function recordLlmResult(userId, id, result, now = Date.now()) {
  const db = Db.getConnection();
  db.transaction(() => {
    ensureUserListing(db, userId, id);
    db.prepare(
      `UPDATE user_listings SET llm_status = 'done', llm_json = @json, llm_model = @model, llm_evaluated_at = @now,
         llm_error = NULL, llm_attempts = llm_attempts + 1, llm_prompt_version = @promptVersion,
         llm_settings_hash = @settingsHash
       WHERE user_id = @userId AND listing_id = @id`,
    ).run({
      userId,
      id,
      json: JSON.stringify(result),
      model: result.model ?? null,
      now,
      promptVersion: result.promptVersion ?? null,
      settingsHash: result.settingsHash ?? null,
    });
  })();
}

/** Records a failed attempt. The message must already be free of secrets (see redact in llm/client.js). */
export function recordLlmFailure(userId, id, message) {
  const db = Db.getConnection();
  db.transaction(() => {
    ensureUserListing(db, userId, id);
    db.prepare(
      `UPDATE user_listings SET llm_status = 'failed', llm_error = @message, llm_attempts = llm_attempts + 1
       WHERE user_id = @userId AND listing_id = @id`,
    ).run({ userId, id, message });
  })();
}

/** Marks a listing as not sent to the LLM for this user, with the reason. */
export function markLlmSkipped(userId, id, reason) {
  const db = Db.getConnection();
  db.transaction(() => {
    ensureUserListing(db, userId, id);
    db.prepare(
      `UPDATE user_listings SET llm_status = 'skipped', llm_error = @reason WHERE user_id = @userId AND listing_id = @id`,
    ).run({ userId, id, reason });
  })();
}

/**
 * Counts for one user's header: pending (what the worker will send: fetched details, not hidden, not excluded by the
 * user's rules, not yet assessed), done and failed (the last
 * attempt failed; the queue retries them until `maxAttempts`). With `settingsHash`, `done` listings made with other
 * settings count as pending too (the worker re-assesses them). With `maxAgeDays` listings published before the details
 * window do not count (the worker skips them).
 * @param {string} userId
 * @param {string} [settingsHash]
 * @param {{maxAgeDays?: number, now?: number}} [window]
 * @returns {{pending: number, done: number, failed: number}}
 */
export function getLlmCounts(userId, settingsHash, { maxAgeDays, now = Date.now() } = {}) {
  const row = Db.getConnection()
    .prepare(
      `SELECT
         COALESCE(SUM((llm_status = 'pending' OR (@settingsHash IS NOT NULL AND llm_status = 'done'
           AND llm_settings_hash IS NOT @settingsHash)) AND details_status = 'fetched' AND dismissed_at IS NULL
           AND description_text IS NOT NULL AND description_text <> ''
           AND excluded_reason IS NULL AND (@cutoff IS NULL OR ${AGE_SQL} >= @cutoff)), 0) AS pending,
         COALESCE(SUM(llm_status = 'done'), 0) AS done,
         COALESCE(SUM(llm_status = 'failed'), 0) AS failed
       FROM ${userRows()} AS v`,
    )
    .get({
      userId,
      settingsHash: settingsHash ?? null,
      cutoff: maxAgeDays === undefined ? null : now - maxAgeDays * 86_400_000,
    });
  return { pending: row.pending, done: row.done, failed: row.failed };
}
