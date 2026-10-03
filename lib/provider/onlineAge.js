const MINUTES_PER_UNIT = {
  sekunde: 0,
  sekunden: 0,
  minute: 1,
  minuten: 1,
  stunde: 60,
  stunden: 60,
  tag: 1440,
  tage: 1440,
  tagen: 1440,
};

/**
 * "Online: 3 Minuten" / "Online: 1 Stunde" / "Online: 2 Tage" / "Online: 24.08.2026" -> minutes.
 * Seconds count as 0 minutes ("just now").
 * @param {string|null|undefined} raw
 * @param {number} [now] Reference time in ms (for the date form).
 * @returns {number|null}
 */
export function parseOnlineAge(raw, now = Date.now()) {
  // Older listings show the publish date instead ("Online: 24.08.2026"); count from local midnight.
  const date = String(raw ?? '').match(/(\d{2})\.(\d{2})\.(\d{4})/);
  if (date) {
    const since = new Date(Number(date[3]), Number(date[2]) - 1, Number(date[1])).getTime();
    return Math.max(0, Math.floor((now - since) / 60000));
  }
  const m = String(raw ?? '').match(/(\d+)\s*([A-Za-zäöüÄÖÜ]+)/);
  if (!m) return null;
  const factor = MINUTES_PER_UNIT[m[2].toLowerCase()];
  return factor !== undefined ? Number(m[1]) * factor : null;
}

/**
 * When the ad went online (epoch ms): first_seen_at minus the "Online: ..." age, or local midnight
 * of an explicit "Online: dd.mm.yyyy" date. Returns null when the age is unknown, never a guess.
 *
 * @param {string|null|undefined} onlineRaw
 * @param {number} firstSeenAt Epoch ms.
 * @param {number|null} [onlineMinutes] Stored parsed age, used when the text is not understood.
 * @returns {number|null}
 */
export function computePublishedAt(onlineRaw, firstSeenAt, onlineMinutes = null) {
  const date = String(onlineRaw ?? '').match(/(\d{2})\.(\d{2})\.(\d{4})/);
  if (date) return new Date(Number(date[3]), Number(date[2]) - 1, Number(date[1])).getTime();
  const minutes = parseOnlineAge(onlineRaw) ?? onlineMinutes;
  return minutes === null || minutes === undefined ? null : firstSeenAt - minutes * 60_000;
}
