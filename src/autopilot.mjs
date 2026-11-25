// The autopilot ("autopilot" in the settings, off by default): when a project's queue empties, Chiefmate wakes the
// manager (the "idle" news) to put the project's next item on the queue, the first one it triaged "now", which it then
// approves for the owner, marked as the autopilot's. Approved items waiting their turn start at once, with no manager.
// Only within limits: the 5-hour window, the week's pace (a target share of the plan's week by its end) and optional
// quiet hours. Once a day, the manager gets what was done alone ("autopilot_report") and tells the owner in a few lines.
import { loadConfig } from './config.mjs';
import { formatDateTime, formatPercent } from './i18n.mjs';
import { newsSettings, reportEvent } from './news.mjs';
import { current, weekPace } from './plan.mjs';
import { byRank, CLOSED, decideItem, planItem, planItems, startApproved } from './planning.mjs';
import { listRuns, readState, readUsage, saveState } from './store.mjs';
import { updating } from './update.mjs';
import { clip, now } from './util.mjs';

const DAY = 86400_000;
// A project's queue is empty when none of its runs is in one of these.
const BUSY = ['queued', 'waiting', 'running', 'paused'];
const MAX_LOG = 100;

const share = (value, fallback) => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? Math.min(1, Math.max(0.05, n)) : fallback;
};
const minutesOf = text => {
  const m = String(text ?? '').trim().match(/^(\d{1,2}):(\d{2})$/);
  return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** "23:00-07:00": { from, to } in minutes of the day, or null (none, or not understood). */
export function parseQuietHours(text) {
  const [from, to] = String(text ?? '').split('-').map(minutesOf);
  return from != null && to != null && from !== to ? { from, to, text: String(text).trim() } : null;
}

export function inQuietHours(quiet, date = new Date()) {
  if (!quiet) return false;
  const m = date.getHours() * 60 + date.getMinutes();
  return quiet.from < quiet.to ? m >= quiet.from && m < quiet.to : m >= quiet.from || m < quiet.to;
}

/**
 * The settings, with their defaults: { enabled (false), week_pace (0.95: the share of the plan's week to reach by its
 * end), stop_at_5h_window (0.85), quiet_hours ("23:00-07:00", none by default), daily_report ("08:00"; false: none) }.
 */
export function autopilotSettings(config = loadConfig()) {
  const a = config.autopilot ?? {};
  return {
    enabled: a.enabled === true,
    week_pace: share(a.week_pace, 0.95),
    stop_at_5h_window: share(a.stop_at_5h_window, 0.85),
    quiet_hours: parseQuietHours(a.quiet_hours),
    daily_report: a.daily_report === false ? null : minutesOf(a.daily_report) != null ? String(a.daily_report).trim() : '08:00',
  };
}

/** Why the autopilot can't put anything on the queue now, or null when it can. */
export function blockReason(settings, usage = readUsage(), at = new Date()) {
  if (!settings.enabled) return 'the autopilot is off';
  if (inQuietHours(settings.quiet_hours, at)) return `quiet hours (${settings.quiet_hours.text})`;
  const w = usage.five_hour;
  if (current(w) && w.used >= settings.stop_at_5h_window) return `the 5-hour window is at ${formatPercent(w.used)} (the autopilot stops at ${formatPercent(settings.stop_at_5h_window)})`;
  // The week's pace: a straight line from 0 to week_pace at the end of the week; above it, the autopilot waits.
  const pace = weekPace(usage);
  if (pace && pace.used > settings.week_pace * pace.elapsed) {
    return `the plan's week is at ${formatPercent(pace.used)} with ${formatPercent(pace.elapsed)} of it gone, ahead of the pace that ends it at ${formatPercent(settings.week_pace)}`;
  }
  return null;
}

/** The projects in the settings with nothing queued, waiting, going on or paused. */
export function idleProjects(config = loadConfig(), runs = listRuns()) {
  const busy = new Set(runs.filter(r => BUSY.includes(r.status)).map(r => r.project));
  return new Set(Object.keys(config.projects ?? {}).filter(id => !busy.has(id)));
}

const open = i => !i.archived && !CLOSED.includes(i.status);
/** A project's items the autopilot may start: triaged "now" by the manager, with an agent, in the owner's order. */
export const candidates = (project, items = planItems()) => items.filter(i => open(i) && i.project === project && i.status === 'triaged' && i.recommend === 'now' && i.agent).sort(byRank);

const short = i => `#${i.id} "${clip(i.title, 90)}" (for ${i.agent})`;

function usageText(usage) {
  const pace = weekPace(usage);
  const five = current(usage.five_hour) ? formatPercent(usage.five_hour.used) : 'not measured';
  return `5-hour window ${five}; plan week ${pace ? `${formatPercent(pace.used)} with ${formatPercent(pace.elapsed)} of it gone` : 'not measured'}`;
}

/**
 * Every minute (and once a run ends): in each idle project, the approved items waiting their turn start, and the
 * manager is woken once for the items triaged "now" (again only when they or the project's last run change). Then the
 * daily report, when it is due. Returns what it did, for the tests.
 */
export async function checkAutopilot({ config = loadConfig(), usage = readUsage(), at = new Date(), runs = listRuns() } = {}) {
  const settings = autopilotSettings(config);
  const done = { started: false, woke: [], report: null };
  const state = readState();
  const a = (state.autopilot ??= { woken: {}, log: [], wakes: [] });
  a.woken ??= {};
  const before = JSON.stringify(a);
  if (settings.enabled && !updating()) {
    const items = planItems();
    const idle = idleProjects(config, runs);
    // Approved items normally start by themselves when the run before them ends; this catches any left behind.
    const waiting = new Set(items.filter(i => open(i) && i.status === 'approved' && idle.has(i.project)).map(i => i.project));
    if (waiting.size) {
      await startApproved();
      done.started = true;
    }
    if (!blockReason(settings, usage, at)) {
      for (const project of idle) {
        // a project with an approved item waiting gets that one, not the manager
        if (waiting.has(project)) continue;
        const next = candidates(project, items);
        if (!next.length) continue;
        const last = runs.find(r => r.project === project);
        const key = `${next.map(i => i.id).join(',')}|${last?.id ?? ''}`;
        if (a.woken[project] === key) continue;
        a.woken[project] = key;
        done.woke.push(project);
        a.wakes = [...(a.wakes ?? []), { at: now(), project, items: next.map(i => i.id) }].slice(-MAX_LOG);
        reportEvent('idle', `Autopilot: the queue of ${project} is empty${last ? ` (its last run, ${last.id}, ${last.status})` : ''}. Items triaged "now", in ${config.owner || 'the owner'}'s order: ${next.slice(0, 5).map(short).join('; ')}${next.length > 5 ? `; and ${next.length - 5} more` : ''}. Usage: ${usageText(usage)}, within the autopilot's limits.`, { config });
      }
    }
  }
  done.report = dailyReport(settings, a, at, config);
  // read again: others may have saved the state meanwhile (startApproved is awaited)
  if (JSON.stringify(a) !== before) saveState({ ...readState(), autopilot: a });
  return done;
}

/** At the report's time, once a day: what the autopilot did since the last report, to the manager. Nothing done, no report. */
function dailyReport(settings, a, at, config) {
  if (!settings.daily_report) return null;
  const [h, m] = settings.daily_report.split(':').map(Number);
  const due = new Date(at);
  due.setHours(h, m, 0, 0);
  const day = `${due.getFullYear()}-${due.getMonth() + 1}-${due.getDate()}`;
  if (at < due || a.reported === day) return null;
  const since = a.report_since ?? new Date(at.getTime() - DAY).toISOString();
  Object.assign(a, { reported: day, report_since: at.toISOString() });
  const started = (a.log ?? []).filter(e => e.at > since);
  const wakes = (a.wakes ?? []).filter(e => e.at > since);
  if (!started.length && !wakes.length) return null;
  const item = e => {
    let i = null;
    try {
      i = planItem(e.item);
    } catch {
      // an item removed from the board keeps the line from the log
    }
    return `#${e.item} ${e.project}: "${clip(i?.title ?? e.title, 90)}" (${i?.agent ?? e.agent}, queued ${formatDateTime(e.at)}; now ${i ? i.status.replace('_', ' ') : 'off the board'}${i?.pr ? `, ${i.pr}` : ''})`;
  };
  const text = [
    `Autopilot's daily report, since ${formatDateTime(since)}:`,
    started.length ? `it put ${started.length} item(s) on the queue by itself: ${started.map(item).join('; ')}.` : 'it put nothing on the queue.',
    `It woke you ${wakes.length} time(s) for an empty queue${wakes.length ? ` (${[...new Set(wakes.map(w => w.project))].join(', ')})` : ''}.`,
  ].join(' ');
  return reportEvent('autopilot_report', text, { config }) ?? { kind: 'autopilot_report', text, skipped: true };
}

/**
 * The manager's approval through the autopilot ("plan approve <n> --autopilot"): only an item triaged "now", of a
 * project whose queue is empty, within the limits. The item is marked as decided by the autopilot.
 */
export async function autopilotApprove(id, { config = loadConfig(), usage = readUsage() } = {}) {
  const blocked = blockReason(autopilotSettings(config), usage);
  if (blocked) throw new Error(`The autopilot can't put an item on the queue now: ${blocked}.`);
  const item = planItem(id);
  if (item.archived || item.status !== 'triaged' || item.recommend !== 'now') throw new Error(`Item #${item.id} is not triaged "now": the autopilot only starts those, the rest waits for the owner.`);
  if (!idleProjects(config).has(item.project)) throw new Error(`${item.project} has work queued or going on: the autopilot waits for its queue to empty.`);
  const approved = await decideItem(item.id, 'approve', { by: 'autopilot' });
  const state = readState();
  const a = (state.autopilot ??= { woken: {}, log: [], wakes: [] });
  a.log = [...(a.log ?? []), { at: now(), item: item.id, project: item.project, title: item.title, agent: item.agent }].slice(-MAX_LOG);
  saveState(state);
  return approved;
}

/** One line for the manager's situation: whether the autopilot is on, its limits, whether it may act now and its last day. */
export function autopilotLine(config = loadConfig(), usage = readUsage()) {
  const s = autopilotSettings(config);
  if (!s.enabled) return 'Autopilot: off ("autopilot" in the settings; node src/cli.mjs autopilot on).';
  const news = newsSettings(config);
  const blocked = blockReason(s, usage);
  const day = (readState().autopilot?.log ?? []).filter(e => Date.now() - Date.parse(e.at) < DAY);
  return [
    `Autopilot: on. When a project's queue empties, you are woken ("idle") to put its next item triaged "now" on the queue (plan approve <n> --autopilot), while the 5-hour window is under ${formatPercent(s.stop_at_5h_window)} and the plan's week within the pace that ends it at ${formatPercent(s.week_pace)}${s.quiet_hours ? `, outside the quiet hours ${s.quiet_hours.text}` : ''}${s.daily_report ? `; daily report at ${s.daily_report}` : ''}.`,
    news.enabled && news.events.has('idle') ? '' : 'The "idle" news is off in manager_updates, so it never wakes you.',
    blocked ? `Now it waits: ${blocked}.` : 'Now it may act.',
    `In the last day it queued: ${day.map(e => `#${e.item} ${e.project}: ${clip(e.title, 60)}`).join('; ') || 'nothing'}.`,
  ].filter(Boolean).join(' ');
}

let checking = false;
export function startAutopilot() {
  const tick = () => {
    if (checking) return;
    checking = true;
    checkAutopilot()
      .catch(error => console.error('Autopilot:', error.message))
      .finally(() => (checking = false));
  };
  setInterval(tick, 60_000);
  tick();
}
