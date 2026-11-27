// The countdowns to the account's usage resets, shown in the status bar beside each window's share, and the spare
// notice: little time left in the 5-hour window and much of it unused. Pure: the unit tests load it in Node.

/** The spare notice shows with less than this left before the 5-hour window resets… */
export const SPARE_WITHIN_MS = 60 * 60_000;
/** …and more than this share of it unused. */
export const SPARE_MIN_FREE = 0.3;

// English templates filled like i18n.js's t(), for when no translator is passed (the tests).
const fill = (text, values = {}) => text.replace(/\{(\w+)\}/g, (m, key) => (key in values ? String(values[key]) : m));

/** What is left until iso, rounded up to the minute: { days, hours, minutes }; null when unknown or past. */
export function timeLeft(iso, now = Date.now()) {
  const ms = Date.parse(iso ?? '') - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const total = Math.ceil(ms / 60_000);
  return { days: Math.floor(total / 1440), hours: Math.floor(total / 60) % 24, minutes: total % 60, total };
}

/** The time left in short: "45 min", "2h54", "2d14h"; null when unknown or past. */
export function countdown(iso, now = Date.now(), t = fill) {
  const left = timeLeft(iso, now);
  if (!left) return null;
  if (left.total < 60) return t('{minutes} min', { minutes: left.total });
  if (!left.days) return t('{hours}h{minutes}', { hours: left.hours, minutes: String(left.minutes).padStart(2, '0') });
  return t('{days}d{hours}h', { days: left.days, hours: left.hours });
}

/**
 * When a window resets, for the status bar: "renews in 2h54" within a day, "renews Sun 08:00" beyond it,
 * "renewed" once past (its share is then an old reading). Empty when the reset is unknown.
 */
export function resetLabel(iso, now = Date.now(), { t = fill, locale = 'en-US' } = {}) {
  if (!iso || !Number.isFinite(Date.parse(iso))) return '';
  const left = timeLeft(iso, now);
  if (!left) return t('renewed');
  if (!left.days) return t('renews in {left}', { left: countdown(iso, now, t) });
  const date = new Date(iso);
  const day = date.toLocaleDateString(locale, { weekday: 'short' }).replace(/\.$/, '');
  return t('renews {when}', { when: `${day} ${date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}` });
}

/**
 * The spare in a window about to reset: { free, left } (the unused share, the time left in short) when less than
 * SPARE_WITHIN_MS is left and more than SPARE_MIN_FREE unused; null otherwise.
 */
export function spare(w, now = Date.now(), t = fill) {
  if (typeof w?.used !== 'number') return null;
  const left = timeLeft(w.resets, now);
  const free = Math.round((1 - w.used) * 100) / 100; // in whole percents, as shown (1 - 0.7 is not 0.3 in floats)
  if (!left || left.total * 60_000 > SPARE_WITHIN_MS || free <= SPARE_MIN_FREE) return null;
  return { free, left: countdown(w.resets, now, t) };
}
