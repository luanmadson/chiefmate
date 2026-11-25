// The manager's news: when something the owner should know happens (a run ends, fails or pauses, a pull request
// waits for approval or the owner merges a run's work from the app, a step needs the owner, an update is installed or
// blocked, a memory or usage alert, a live session ends, the crew proposes items for the planning board, the autopilot
// finds a project's queue empty or sends its daily report, the watchdog finds Chiefmate stuck, the owner decides a card
// in the app, the agent in charge of a project sends a request from its talk with the owner), Chiefmate tells the manager in a short system message, and
// the manager writes the owner a notice in the conversation (and triages the proposals). Events close together (within
// WINDOW_MS) go as one message; while the manager answers, they wait in the conversation's queue. The setting
// "manager_updates" turns this off or picks the events.
//
// Away mode: the owner tells the manager from the app that they stepped out or went to sleep ("away"). The work goes on
// alone; the events that only inform (HELD_WHILE_AWAY) wait in data/state.json ("away") and go together when the owner
// is back ("back"), for the manager's summary. The others still wake the manager, which does its own part and asks
// nothing that can wait. The Windows notifications that aren't urgent wait too (src/notify.mjs).
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { formatDateTime, formatDuration } from './i18n.mjs';
import { readState, saveState } from './store.mjs';
import { DATA, ensureDir, now, readJson, writeJson } from './util.mjs';

/** The events Chiefmate tells the manager about, by name (as in "manager_updates"). */
export const NEWS_EVENTS = [
  'run_finished', 'run_failed', 'run_paused', 'pr_ready', 'merged', 'needs_you',
  'update_installed', 'update_blocked', 'memory_alert', 'usage_alert', 'session_ended', 'plan_proposed',
  'idle', 'autopilot_report', 'watchdog', 'away', 'back', 'owner_decided', 'owner_request',
];

// The owner's own switch: always told to the manager, whatever "manager_updates" says.
const OWNER_EVENTS = ['away', 'back'];

/**
 * While the owner is away, these events wait for the summary when they are back. The rest still go at once: the
 * proposals to triage, the autopilot's empty queues, a step that needs the owner and the watchdog.
 */
export const HELD_WHILE_AWAY = [
  'run_finished', 'run_failed', 'run_paused', 'pr_ready', 'merged', 'update_installed', 'update_blocked',
  'memory_alert', 'usage_alert', 'session_ended', 'autopilot_report',
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
 * later: only kept on disk, for the next Chiefmate to start (the watchdog, when Chiefmate doesn't answer).
 */
export function reportEvent(kind, text, { config, later = false } = {}) {
  if (process.env.CHIEFMATE_SMOKE || !NEWS_EVENTS.includes(kind)) return null;
  try {
    const settings = newsSettings(config ?? loadConfig());
    if (!OWNER_EVENTS.includes(kind) && (!settings.enabled || !settings.events.has(kind))) return null;
    const event = { kind, text: String(text ?? '').trim(), at: now() };
    const state = readState();
    if (state.away && HELD_WHILE_AWAY.includes(kind)) {
      saveState({ ...state, away: { ...state.away, held: [...(state.away.held ?? []), event].slice(-MAX_EVENTS) } });
      return event;
    }
    const list = readNews();
    list.push(event);
    writeJson(newsFile(), list.slice(-MAX_EVENTS));
    if (!later) schedule(list[0].at);
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

// ---------- Away mode ----------

/** The away mode, for the app and the manager: { since, held } (held: the events waiting for the owner), or null. */
export function awayInfo(state = readState()) {
  return state.away ? { since: state.away.since, held: state.away.held?.length ?? 0 } : null;
}

/** The manager's line while the owner is away, or null. */
export function awayLine(owner = 'the owner', away = awayInfo()) {
  if (!away) return null;
  return `Away mode: on since ${formatDateTime(away.since)}: ${owner} stepped out or is asleep. The work goes on alone; the news that only informs waits for your summary when ${owner} is back (${away.held} event(s) so far). Do your own part (the triage, the autopilot) and ask ${owner} nothing that can wait. If ${owner} writes to you meanwhile, answer as usual.`;
}

/**
 * Turns the away mode on or off (the app's button) and tells the manager at once. Turning it off hands the manager
 * the events held meanwhile, with "back", for its summary. Returns awayInfo().
 */
export function setAway(on, config = loadConfig()) {
  const state = readState();
  if (!!on === !!state.away) return awayInfo(state);
  const owner = config.owner || 'the owner';
  if (on) {
    saveState({ ...state, away: { since: now(), held: [] } });
    reportEvent('away', `${owner} turned on away mode in the app: they stepped out or went to sleep.`, { config });
  } else {
    const { away, ...rest } = state;
    saveState(rest);
    const held = away.held ?? [];
    // The held events go first, then "back", all in one message: the summary.
    if (held.length && !process.env.CHIEFMATE_SMOKE) writeJson(newsFile(), [...readNews(), ...held].slice(-MAX_EVENTS));
    const gone = formatDuration(Date.now() - Date.parse(away.since));
    reportEvent('back', `${owner} is back: away mode off, after ${gone} away (since ${formatDateTime(away.since)}), ${held.length} event(s) held meanwhile.`, { config });
  }
  // The smoke test's server never wakes the manager.
  if (!process.env.CHIEFMATE_SMOKE) flushNews().catch(error => console.error('News:', error.message));
  return awayInfo(readState());
}
