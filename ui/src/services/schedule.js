/**
 * When alert emails may go out (per user, local wall-clock time of the server). Pure helpers shared by the notifier
 * (lib/notify) and the Options page, so both always agree on the slots.
 *
 *  - Fantastic (`notify.priority.window`): instant inside the window; outside it the offers wait and go out as ONE
 *    email when the window opens.
 *  - Good (`notify.bulk.window` + `notify.bulk.intervalHours`): a digest only at a slot, i.e. window.from + k * interval
 *    (the last slot is at most window.to); outside the window the offers wait for the first slot of the next day.
 *
 * Hours are whole numbers 0..24 (24 = midnight at the end of the day, never a slot itself).
 */

export const DEFAULT_WINDOW = Object.freeze({ from: 7, to: 23 });
export const DEFAULT_INTERVAL_HOURS = 1;

const whole = (v) => typeof v === 'number' && Number.isInteger(v);

export function isValidWindow(w) {
  return (
    w != null &&
    typeof w === 'object' &&
    !Array.isArray(w) &&
    whole(w.from) &&
    whole(w.to) &&
    w.from >= 0 &&
    w.to <= 24 &&
    w.from < w.to
  );
}

export function isValidInterval(n) {
  return whole(n) && n >= 1 && n <= 24;
}

/** The local hour of an instant as a fraction (07:30 -> 7.5). */
function hourOf(ms) {
  const d = new Date(ms);
  return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
}

/** Local midnight at the start of the day of `ms`, shifted by `days`. */
function dayAt(ms, hour, days = 0) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, hour, 0, 0, 0).getTime();
}

export function inWindow(window, ms) {
  const h = hourOf(ms);
  return h >= window.from && h < window.to;
}

/** The hours of day (0..23) at which a digest may go out. */
export function slotHours(window, intervalHours) {
  const hours = [];
  for (let h = window.from; h <= window.to && h < 24; h += intervalHours) hours.push(h);
  return hours;
}

/** The latest slot of today (epoch ms) that `ms` has reached, or null before today's first slot. */
export function dueSlot(window, intervalHours, ms) {
  const reached = slotHours(window, intervalHours).filter((h) => dayAt(ms, h) <= ms);
  return reached.length === 0 ? null : dayAt(ms, reached.at(-1));
}

/** The first slot strictly after `ms`: later today, else the first slot tomorrow. */
export function nextSlot(window, intervalHours, ms) {
  const hours = slotHours(window, intervalHours);
  const later = hours.find((h) => dayAt(ms, h) > ms);
  return later === undefined ? dayAt(ms, hours[0], 1) : dayAt(ms, later);
}

/** The next time the window opens, strictly after `ms`. */
export function nextWindowStart(window, ms) {
  const today = dayAt(ms, window.from);
  return today > ms ? today : dayAt(ms, window.from, 1);
}

/** Hours per day outside the window: the longest an offer can wait for it to open. */
export function closedHours(window) {
  return 24 - (window.to - window.from);
}

export const formatHour = (h) => `${String(h).padStart(2, '0')}:00`;

export function formatTime(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const allDay = (window) => window.from === 0 && window.to === 24;

export function summarizePriority(window) {
  if (allDay(window)) return 'Instant, at any time of day.';
  return `Instant between ${formatHour(window.from)} and ${formatHour(window.to)}; otherwise one morning email at ${formatHour(window.from)}.`;
}

export function summarizeBulk(window, intervalHours) {
  const n = slotHours(window, intervalHours).length;
  const slots = `(${n} ${n === 1 ? 'slot' : 'slots'})`;
  if (allDay(window)) return `Every ${intervalHours} h, at any time of day ${slots}.`;
  return `Every ${intervalHours} h between ${formatHour(window.from)} and ${formatHour(window.to)} ${slots}; otherwise one morning email.`;
}

/** The hour labels under a window slider (the 24 h day). */
export const LABEL_MARKS = Object.freeze({ 0: '00', 6: '06', 12: '12', 18: '18', 24: '24' });

/**
 * The ticks (a "Strich") of the Good window slider: one per send slot, as a share of the 24 h track. They are drawn on
 * top of the slider, so the hour labels keep Semi's default look on both sliders. None for an impossible window.
 */
export function slotTicks(window, intervalHours) {
  if (!isValidWindow(window) || !isValidInterval(intervalHours)) return [];
  return slotHours(window, intervalHours).map((hour) => ({ hour, left: (hour / 24) * 100 }));
}
