/**
 * Pure scoring helpers. Every scorer returns `{score: 1-10, detail: string}` or `null` when the
 * input is missing/unusable (the caller lists it under `missing`).
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

const round1 = (n) => Math.round(n * 10) / 10;

/** Linear 1..10 between worst (1) and best (10), clamped; works for both directions. */
export function linearScore(value, { best, worst }) {
  const t = (value - worst) / (best - worst);
  return round1(1 + 9 * Math.min(1, Math.max(0, t)));
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export function scoreRent(price, { best, worst }) {
  if (!isNum(price)) return null;
  return { score: linearScore(price, { best, worst }), detail: `${price} € (best ${best}, worst ${worst})` };
}

export function scoreDistance(distanceKm, geoPrecision, { best, worst }) {
  if (!isNum(distanceKm)) return null;
  const km = round1(distanceKm);
  const precision = geoPrecision === 'district' ? ', district centroid only' : '';
  return { score: linearScore(distanceKm, { best, worst }), detail: `${km} km straight line${precision}` };
}

export function scoreSize(size, { best, worst }) {
  if (!isNum(size)) return null;
  return { score: linearScore(size, { best, worst }), detail: `${size} m² (worst ${worst}, best ${best})` };
}

/**
 * @param {number|null|undefined} publishedAt Epoch ms when the ad went online.
 * @param {number|null|undefined} firstSeenAt Fallback when the age is unknown.
 * @param {number} now
 */
export function scoreRecency(publishedAt, firstSeenAt, now, { best, worst }) {
  const fallback = !isNum(publishedAt);
  const at = fallback ? firstSeenAt : publishedAt;
  if (!isNum(at)) return null;
  const hours = Math.max(0, (now - at) / HOUR_MS);
  const label = hours < 1 ? 'under 1 h' : hours < 48 ? `${round1(hours)} h` : `${round1(hours / 24)} days`;
  return {
    score: linearScore(hours, { best, worst }),
    detail: `online ${label}${fallback ? ' (first seen, publish age unknown)' : ''}`,
  };
}

function parseIsoDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ''));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : null;
}

const startOfDay = (now) => new Date(new Date(now).getFullYear(), new Date(now).getMonth(), new Date(now).getDate());

/**
 * The stay of a temporary listing in days, from max(availableFrom, today) to availableUntil; null without a usable end
 * date (open-ended or unreadable). The date of `from` and `until` are returned for calendar-month arithmetic.
 */
export function stayOf(availableFrom, availableUntil, now) {
  const until = parseIsoDate(availableUntil);
  if (until === null) return null;
  const today = startOfDay(now).getTime();
  const from = Math.max(parseIsoDate(availableFrom) ?? today, today);
  return { from, until, days: Math.max(0, Math.round((until - from) / DAY_MS)) };
}

/** "5 days", "5 weeks" (up to two months), "4 months". */
export function formatDuration(days) {
  if (days < 14) return `${days} ${days === 1 ? 'day' : 'days'}`;
  if (days <= 60) return `${Math.round(days / 7)} weeks`;
  const months = Math.floor(days / 30.4375);
  return `${months} ${months === 1 ? 'month' : 'months'}`;
}

/**
 * The "short-term" auto-reject: the reason when the stay is known (end date given) and ends before `minMonths`
 * calendar months after its start (max(availableFrom, today)); null for open-ended offers or long enough stays.
 */
export function shortTermReason(availableFrom, availableUntil, now, minMonths) {
  const stay = stayOf(availableFrom, availableUntil, now);
  if (!stay) return null;
  const minimum = new Date(stay.from);
  minimum.setMonth(minimum.getMonth() + minMonths);
  if (stay.until >= minimum.getTime()) return null;
  return `Short-term: ${formatDuration(stay.days)} (< ${minMonths} ${minMonths === 1 ? 'month' : 'months'})`;
}

/**
 * Temporary (befristet) listings: stay length vs minStayDays. Open-ended listings (no end date) score
 * 10. The move-in date itself is not scored; a start in the past or unknown counts from today.
 */
export function scoreStayLength(availableFrom, availableUntil, now, { minStayDays, minimumDays }) {
  if (availableUntil === null || availableUntil === undefined || availableUntil === '') {
    return { score: 10, detail: 'open-ended' };
  }
  const stay = stayOf(availableFrom, availableUntil, now);
  if (stay === null) return null;
  const { days } = stay;
  const score = days < minimumDays ? 1 : linearScore(days, { best: minStayDays, worst: minimumDays });
  return { score, detail: `temporary, ${days} days (full score from ${minStayDays}, 1 below ${minimumDays})` };
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** First keyword found as a whole word (case-insensitive, unicode aware) in any of the texts. */
export function findKeyword(texts, keywords) {
  const haystack = texts.filter(Boolean).join('\n');
  for (const keyword of keywords) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(keyword)}(?![\\p{L}\\p{N}])`, 'iu');
    if (re.test(haystack)) return keyword;
  }
  return null;
}
