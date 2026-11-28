// The kind of each message in the conversation with the manager, for its color, icon and badge: done (green), info
// (blue), needs the owner (orange), failure and alarm (red), a summary (purple) and Chiefmate's own lines (gray). A
// notice takes its kind from the events it is about (src/news.mjs); the manager may begin any message with a mark
// ("[done]", "[needs-you]"...), which wins and is not shown. Nothing here reads the state or the page: ui/app.js passes
// the message; scripts/unit.mjs tests it.

/** The kinds, in the order that picks one among several: a summary first (it tells the rest), then what matters most. */
export const RANK = ['report', 'alarm', 'failure', 'needs', 'done', 'info', 'system'];

/** The manager's marks, as written at the start of a message (agents/manager.md), and their kinds. */
export const MARKS = { report: 'report', alarm: 'alarm', failure: 'failure', 'needs-you': 'needs', done: 'done', info: 'info' };

/** Each event's kind: every one of NEWS_EVENTS (src/news.mjs), and an agent's message. */
export const EVENT_TONES = {
  back: 'report', autopilot_report: 'report',
  lockdown: 'alarm', security_warning: 'alarm', memory_alert: 'alarm',
  run_failed: 'failure', merge_failed: 'failure', update_blocked: 'failure', watchdog: 'failure',
  needs_you: 'needs', pr_ready: 'needs', run_parked: 'needs', quarantine: 'needs',
  run_finished: 'done', merged: 'done', update_installed: 'done',
  run_paused: 'info', usage_alert: 'info', session_ended: 'info', plan_proposed: 'info', idle: 'info', away: 'info',
  owner_decided: 'info', push_allowed: 'info', repo_allowed: 'info', owner_request: 'info', power: 'info',
  owner_working: 'info', defect: 'info', focus: 'info', session_spare: 'info', agent_message: 'info',
};

/** The one that comes first in RANK, or null. */
export const strongest = tones => RANK.find(x => tones.includes(x)) ?? null;

/** An event's kind; one not listed yet only informs. */
export const eventTone = kind => (Object.hasOwn(EVENT_TONES, kind) ? EVENT_TONES[kind] : 'info');

/**
 * The manager's mark at the very start of a text, and the text without it: { tone, text }, tone null with none.
 * Lenient on case, spaces and underscores ("[Needs you]"); any other bracket at the start stays text ("[PR #34]").
 */
export function takeMark(text) {
  const s = String(text ?? '');
  const m = s.match(/^\s*\[([a-z][a-z _-]{1,14})\]\s*/i);
  const mark = m?.[1].toLowerCase().replace(/[ _]+/g, '-');
  return mark && Object.hasOwn(MARKS, mark) ? { tone: MARKS[mark], text: s.slice(m[0].length) } : { tone: null, text: s };
}

/**
 * A message's kind, or null for a plain one: the owner's, an agent's, or the manager's answer with no mark and no news.
 * The manager's answer that failed is a failure; its mark comes next, then its events.
 */
export function toneOf(m) {
  if (m?.who === 'system') return 'system';
  if (m?.who !== 'manager') return null;
  if (m.error) return 'failure';
  return takeMark(m.text).tone ?? (m.news?.length ? strongest(m.news.map(eventTone)) : null);
}

// Line icons in the app's look (a 16-unit grid, thin strokes, square ends), each a shape of its own.
const ICONS = {
  report: 'M2.5 3.5h11M2.5 8h11M2.5 12.5h7',
  alarm: 'M8 1.8l6.5 12H1.5zM8 6.3v3.2M8 11.3v1',
  failure: 'M3.5 3.5l9 9M12.5 3.5l-9 9',
  needs: 'M8 2v7.5M8 12.5V14',
  done: 'M2.5 8.5l3.5 3.5 7.5-8.5',
  info: 'M8 2.6v1.4M5.8 6.8H8v6.4M5.3 13.2h5.4',
  system: 'M2.5 4l4 4-4 4M8.5 12.5h5',
};

/** A kind's icon, for the eyes only: the badge's word says the same. */
export const toneIcon = tone => (Object.hasOwn(ICONS, tone)
  ? `<svg class="tone-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="${ICONS[tone]}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square"/></svg>`
  : '');

/** A kind's badge: its icon and a short word, so it reads without color too. t and esc: the app's. */
export function toneBadge(tone, { t, esc }) {
  const words = {
    report: t('Summary'), alarm: t('Alarm'), failure: t('Failure'), needs: t('Action needed'), done: t('Completed'), info: t('Info'), system: t('System'),
  };
  return Object.hasOwn(words, tone) ? `<span class="tone-badge">${toneIcon(tone)}${esc(words[tone])}</span>` : '';
}
