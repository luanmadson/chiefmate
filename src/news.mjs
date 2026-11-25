// The manager's news: when something the owner should know happens (a run ends, fails or pauses, a pull request
// waits for approval, a step needs the owner, an update is installed or blocked, a memory or usage alert, a live
// session ends, the crew proposes items for the planning board), Chiefmate tells the manager in a short system
// message, and the manager writes the owner a notice in the conversation (and triages the proposals). Events close together (within WINDOW_MS) go as one message; while the manager answers, they wait
// in the conversation's queue. The setting "manager_updates" turns this off or picks the events.
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { DATA, ensureDir, now, readJson, writeJson } from './util.mjs';

/** The events Chiefmate tells the manager about, by name (as in "manager_updates"). */
export const NEWS_EVENTS = [
  'run_finished', 'run_failed', 'run_paused', 'pr_ready', 'needs_you',
  'update_installed', 'update_blocked', 'memory_alert', 'usage_alert', 'session_ended', 'plan_proposed',
];

// Events within a minute of the first one go to the manager together.
export const WINDOW_MS = 60_000;
const MAX_EVENTS = 30;
// Kept on disk: an update is installed right before Chiefmate restarts, and the news must survive it.
const newsFile = () => path.join(ensureDir(path.join(DATA, 'manager')), 'news.json');
const readNews = () => readJson(newsFile(), []);

/**
 * Which events wake the manager: "manager_updates" is true (the default: all), false (none), a list of event names,
 * or { "enabled": true, "events": [...] }.
 */
export function newsSettings(config = loadConfig()) {
  const value = config.manager_updates;
  const pick = list => new Set(list.filter(e => NEWS_EVENTS.includes(e)));
  if (value === false) return { enabled: false, events: new Set() };
  if (Array.isArray(value)) return { enabled: value.length > 0, events: pick(value) };
  if (value && typeof value === 'object') {
    const events = Array.isArray(value.events) ? pick(value.events) : new Set(NEWS_EVENTS);
    return { enabled: value.enabled !== false && events.size > 0, events };
  }
  return { enabled: true, events: new Set(NEWS_EVENTS) };
}

let timer = null;
function schedule(first) {
  if (timer) return;
  const wait = Math.max(0, WINDOW_MS - (Date.now() - Date.parse(first ?? now())));
  timer = setTimeout(() => flushNews().catch(error => console.error('News:', error.message)), wait);
  timer.unref?.();
}

/**
 * Records an event for the manager. "text" describes it for the manager, in English, with the run or session it is
 * about. Returns the event, or null when the settings leave it out. The smoke test's server never tells the manager.
 */
export function reportEvent(kind, text, { config } = {}) {
  if (process.env.CHIEFMATE_SMOKE || !NEWS_EVENTS.includes(kind)) return null;
  try {
    const settings = newsSettings(config ?? loadConfig());
    if (!settings.enabled || !settings.events.has(kind)) return null;
    const list = readNews();
    const event = { kind, text: String(text ?? '').trim(), at: now() };
    list.push(event);
    writeJson(newsFile(), list.slice(-MAX_EVENTS));
    schedule(list[0].at);
    return event;
  } catch (error) {
    console.error('News:', error.message); // the news never gets in the way of what happened
    return null;
  }
}

/** Hands the events gathered so far to the manager (as one message, or into its queue). Returns the queued item. */
export async function flushNews() {
  clearTimeout(timer);
  timer = null;
  const events = readNews();
  if (!events.length) return null;
  writeJson(newsFile(), []);
  const { deliverNews } = await import('./manager.mjs'); // here, not at the top: manager.mjs imports runs.mjs
  return deliverNews(events);
}

/** At start: the news left when Chiefmate stopped (such as "update installed") goes once its minute is up. */
export function startNews() {
  // Older than an hour (Chiefmate was off for long): no longer news.
  const all = readNews();
  const events = all.filter(e => Date.now() - Date.parse(e.at) < 3600_000);
  if (events.length !== all.length) writeJson(newsFile(), events);
  if (events.length) schedule(events[0].at);
}
