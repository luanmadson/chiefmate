// Translation of what you see: notifications, run notes, the logbook and pull request texts.
// English is the source. The dictionaries live in ui/locales/<language>.json and are shared with the app.
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { readJson, ROOT } from './util.mjs';

const dictionaries = {};

export function language() {
  try {
    return loadConfig().language || 'en';
  } catch {
    return 'en';
  }
}

function dictionary(code) {
  if (code.startsWith('en')) return {};
  dictionaries[code] ??= readJson(path.join(ROOT, 'ui', 'locales', `${code}.json`), {});
  return dictionaries[code];
}

/** t('Ready for your review'), with values t('{title}: {result}', { title, result }), or in a given language. */
export function t(text, values = {}, lang = language()) {
  const template = dictionary(lang)[text] ?? text;
  return template.replace(/\{(\w+)\}/g, (match, key) => (key in values ? String(values[key]) : match));
}

export const locale = () => (language() === 'en' ? 'en-US' : language());

export function formatDateTime(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat(locale(), { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
}

export function formatDate(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat(locale(), { dateStyle: 'short' }).format(new Date(value));
}

export const formatMoney = value => new Intl.NumberFormat(locale(), { style: 'currency', currency: 'USD' }).format(value ?? 0);

export const formatPercent = value => (typeof value === 'number' ? `${Math.round(value * 100)}%` : '—');

export function formatDuration(ms) {
  if (!ms && ms !== 0) return '';
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return t('less than 1 min');
  if (minutes < 60) return t('{minutes} min', { minutes });
  return t('{hours} h {minutes} min', { hours: Math.floor(minutes / 60), minutes: String(minutes % 60).padStart(2, '0') });
}
