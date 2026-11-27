// The autopilot ("autopilot" in the settings, off by default): when a project's queue empties, Chiefmate wakes the
// manager (the "idle" news) to put the project's next item on the queue, the first one it triaged "now", which it then
// approves for the owner, marked as the autopilot's. Approved items waiting their turn start at once, with no manager.
// Only within limits: the 5-hour window (with the session in "all", src/spending.mjs, never below its pause), the
// week's pace (a target share of the plan's week by its end) and optional quiet hours. Once a day, the manager gets
// what was done alone ("autopilot_report") and tells the owner in a few lines.
// The week's pace comes as a spending mode: "save" (ends the week at 90%), "normal" (100%) or "all" (no pace: only the
// 5-hour window and a used-up week stop it); any other share, above 1 too, is kept as a custom pace.
import { loadConfig, saveConfig } from './config.mjs';
import { formatDateTime, formatPercent, t } from './i18n.mjs';
import { newsSettings, reportEvent } from './news.mjs';
import { availableResets, current, weekPace } from './plan.mjs';
import { byRank, CLOSED, decideItem, planItem, planItems, startApproved } from './planning.mjs';
import { listRuns, readState, readUsage, saveState } from './store.mjs';
import { isLocked } from './lockdown.mjs';
import { held } from './power.mjs';
import { effectiveLimits, sessionNow } from './spending.mjs';
import { holdReason, readSteer } from './steer.mjs';
import { updating } from './update.mjs';
import { clip, now } from './util.mjs';

const DAY = 86400_000;
// A project's queue is empty when none of its runs is in one of these.
const BUSY = ['queued', 'waiting', 'running', 'paused'];
const MAX_LOG = 100;
const MAX_CHANGES = 50;

/** The spending modes and their week's pace ("all": none). */
export const MODES = { save: 0.9, normal: 1, all: null };
const NO_PACE = ['all', 'none', 'unlimited'];

const number = value => (typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN);
const share = (value, fallback) => {
  const n = number(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0.05, n)) : fallback;
};
// the week's pace: a share from 0.05, above 1 too (never cut down), or null for none ("all")
const pace = (value, fallback) => {
  if (value === null || NO_PACE.includes(String(value).trim().toLowerCase())) return null;
  const n = number(value);
  return Number.isFinite(n) ? Math.max(0.05, n) : fallback;
};
/** The mode a week's pace stands for: "save", "normal", "all" or "custom". */
export const paceMode = weekPace => Object.keys(MODES).find(m => MODES[m] === weekPace) ?? 'custom';
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
 * The settings, with their defaults: { enabled (false), week_pace (1, "normal": the share of the plan's week to reach by
 * its end; null, "all": no pace), mode, stop_at_5h_window (0.85), window_stop (where it stops now: with the session in
 * "all", src/spending.mjs, a boost included, never below the session's pause), quiet_hours ("23:00-07:00", none by
 * default), daily_report ("08:00"; false: none) }.
 */
export function autopilotSettings(config = loadConfig()) {
  const a = config.autopilot ?? {};
  const week = pace(a.week_pace, MODES.normal);
  const stop = share(a.stop_at_5h_window, 0.85);
  const session = sessionNow(config);
  return {
    enabled: a.enabled === true,
    week_pace: week,
    mode: paceMode(week),
    stop_at_5h_window: stop,
    window_stop: session.mode === 'all' ? Math.max(stop, session.limit) : stop,
    quiet_hours: parseQuietHours(a.quiet_hours),
    daily_report: a.daily_report === false ? null : minutesOf(a.daily_report) != null ? String(a.daily_report).trim() : '08:00',
  };
}

/**
 * Why the autopilot can't put anything on the queue now, for the app: { reason: "off" | "standby" | "lockdown" |
 * "updating" | "quiet" | "window" | "week_full" | "week", and its values }, or null when it can.
 */
export function blockInfo(settings, usage = readUsage(), at = new Date()) {
  if (!settings.enabled) return { reason: 'off' };
  if (held()) return { reason: 'standby' };
  if (isLocked()) return { reason: 'lockdown' };
  if (updating()) return { reason: 'updating' };
  if (inQuietHours(settings.quiet_hours, at)) return { reason: 'quiet', quiet: settings.quiet_hours.text };
  const w = usage.five_hour;
  const stop = settings.window_stop ?? settings.stop_at_5h_window;
  if (current(w) && w.used >= stop) return { reason: 'window', used: w.used, limit: stop };
  // A used-up week stops it in every mode, "all" included.
  const week = usage.seven_day;
  if (current(week) && week.used >= 1) return { reason: 'week_full', used: week.used, resets: week.resets ?? null };
  // The week's pace: a straight line from 0 to week_pace at the end of the week; above it, the autopilot waits.
  const p = settings.week_pace == null ? null : weekPace(usage);
  if (p && p.used > settings.week_pace * p.elapsed) return { reason: 'week', used: p.used, elapsed: p.elapsed, target: settings.week_pace };
  return null;
}

/** The same, in words for the manager, or null when it can. */
export function blockReason(settings, usage = readUsage(), at = new Date()) {
  const b = blockInfo(settings, usage, at);
  switch (b?.reason) {
    case 'off': return 'the autopilot is off';
    case 'standby': return 'Chiefmate is on standby (or shutting down): nothing new starts';
    case 'lockdown': return 'Chiefmate is in emergency lockdown';
    case 'updating': return 'Chiefmate is installing an update';
    case 'quiet': return `quiet hours (${b.quiet})`;
    case 'window': return `the 5-hour window is at ${formatPercent(b.used)} (the autopilot stops at ${formatPercent(b.limit)})`;
    case 'week_full': return `the plan's week is used up (${formatPercent(b.used)})`;
    case 'week': return `the plan's week is at ${formatPercent(b.used)} with ${formatPercent(b.elapsed)} of it gone, ahead of the pace that ends it at ${formatPercent(b.target)}`;
    default: return null;
  }
}

/**
 * Changes the settings (the app's card and "cli.mjs autopilot"): any of { enabled, mode ("save", "normal", "all"),
 * week_pace (a share from 0.05, above 1 too, or "all": no pace), stop_at_5h_window (a share from 0.05 to 1), quiet_hours
 * ("23:00-07:00"; "" or "off": none), daily_report ("08:00"; false or "off": none) }. Saved at once and read again on
 * every check: no restart (with dryRun, only validated). Each change is kept with who made it ("by") and when, in
 * "autopilot.changes" of data/state.json. Returns the new "autopilot".
 */
export function changeAutopilot(body, { config = loadConfig(), dryRun = false, by = 'owner', save = saveConfig } = {}) {
  const before = config.autopilot ?? {};
  const changes = { ...before };
  if (body.enabled !== undefined) changes.enabled = body.enabled === true;
  if (body.mode !== undefined) {
    if (!Object.hasOwn(MODES, body.mode)) throw new Error(t('The spending mode is save, normal or all.'));
    changes.week_pace = MODES[body.mode] ?? 'all';
  }
  if (body.week_pace !== undefined) {
    const value = body.week_pace === '' ? NaN : pace(body.week_pace, NaN);
    if (Number.isNaN(value)) throw new Error(t("The week's pace is a share such as 0.9, 1 or 1.2, or all (no pace)."));
    changes.week_pace = value ?? 'all';
  }
  if (body.stop_at_5h_window !== undefined) {
    const n = Number(body.stop_at_5h_window);
    if (body.stop_at_5h_window === '' || body.stop_at_5h_window === null || !Number.isFinite(n)) throw new Error(t('The limits are shares from 0.05 to 1, such as 0.85.'));
    changes.stop_at_5h_window = Math.min(1, Math.max(0.05, n));
  }
  if (body.quiet_hours !== undefined) {
    const quiet = String(body.quiet_hours ?? '').trim();
    if (quiet && quiet !== 'off' && !parseQuietHours(quiet)) throw new Error(t('Quiet hours as HH:MM-HH:MM, such as 23:00-07:00, or off.'));
    changes.quiet_hours = quiet === 'off' ? '' : quiet;
  }
  if (body.daily_report !== undefined) {
    const report = body.daily_report === false ? 'off' : String(body.daily_report ?? '').trim();
    if (report && report !== 'off' && minutesOf(report) == null) throw new Error(t('The daily report as HH:MM, such as 08:00, or off.'));
    changes.daily_report = !report || report === 'off' ? false : report;
  }
  if (JSON.stringify(changes) !== JSON.stringify(before)) {
    config.autopilot = changes;
    if (!dryRun) {
      save(config);
      recordChange(before, changes, by);
    }
  }
  return config.autopilot ?? {};
}

// Who changed what and when: { at, by, changes: { key: [before, after] } }, the latest last.
function recordChange(before, after, by) {
  const changes = Object.fromEntries([...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(k => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
    .map(k => [k, [before[k] ?? null, after[k] ?? null]]));
  const state = readState();
  const a = (state.autopilot ??= { woken: {}, log: [], wakes: [] });
  a.changes = [...(a.changes ?? []), { at: now(), by: clip(String(by), 120), changes }].slice(-MAX_CHANGES);
  saveState(state);
}

/**
 * What the autopilot does now, for the card's "Now" line: { state: "working" | "ready" | "stopped", running (the runs
 * going on), and when stopped, reason: a blockInfo reason, "limits" (the queue's own limits pause every run), "nothing"
 * (no item triaged "now" nor approved) or "news_off" (the "idle" news never wakes the manager), with its values }.
 */
export function autopilotNow(settings, { config = loadConfig(), usage = readUsage(), at = new Date(), runs = listRuns(), items = planItems() } = {}) {
  const running = runs.filter(r => r.status === 'running').length;
  const blocked = blockInfo(settings, usage, at);
  if (blocked) return { state: 'stopped', running, ...blocked };
  // the queue's own limits, read as checkLimits in src/runs.mjs reads them (only with a known reset ahead)
  const limits = effectiveLimits(config);
  for (const [which, w, ceiling] of [['5h', usage.five_hour, limits.pause_at_5h_window], ['week', usage.seven_day, limits.pause_at_plan_week]]) {
    if (ceiling && current(w) && w.resets && w.used >= ceiling) return { state: 'stopped', running, reason: 'limits', which, used: w.used, limit: ceiling };
  }
  if (running) return { state: 'working', running };
  const projects = Object.keys(config.projects ?? {});
  // approved items start by themselves; the ones triaged "now" need the manager, woken by the "idle" news
  const approved = items.some(i => open(i) && i.status === 'approved' && projects.includes(i.project));
  if (!approved && !projects.some(p => candidates(p, items).length)) return { state: 'stopped', running, reason: 'nothing' };
  const news = newsSettings(config);
  if (!approved && !(news.enabled && news.events.has('idle'))) return { state: 'stopped', running, reason: 'news_off' };
  return { state: 'ready', running };
}

/**
 * For the app's Usage section: the settings, whether it may act now (blocked: blockInfo, or null), whether the "idle"
 * news reaches the manager, and what it did today (since midnight): the items it queued, with where each is now, and
 * the empty queues it woke the manager for.
 */
export function autopilotStatus(config = loadConfig(), usage = readUsage(), at = new Date(), runs = listRuns()) {
  const s = autopilotSettings(config);
  const news = newsSettings(config);
  const a = readState().autopilot ?? {};
  const midnight = new Date(at);
  midnight.setHours(0, 0, 0, 0);
  const today = list => (list ?? []).filter(e => Date.parse(e.at) >= midnight.getTime());
  const where = e => {
    try {
      const i = planItem(e.item);
      return { status: i.archived ? 'archived' : i.status, pr: i.pr ?? null };
    } catch {
      return { status: 'removed', pr: null };
    }
  };
  const reset = availableResets(config)[0];
  return {
    enabled: s.enabled,
    mode: s.mode,
    week_pace: s.week_pace,
    stop_at_5h_window: s.stop_at_5h_window,
    window_stop: s.window_stop,
    quiet_hours: s.quiet_hours?.text ?? '',
    daily_report: s.daily_report,
    idle_news: news.enabled && news.events.has('idle'),
    blocked: blockInfo(s, usage, at),
    now: autopilotNow(s, { config, usage, at, runs }),
    // a free reset of the plan still unused: the card suggests "spend all"
    reset: reset ? { expires: reset.expires ?? null, note: reset.note ?? '' } : null,
    // the latest changes of the settings, newest first
    changes: (a.changes ?? []).slice(-5).reverse(),
    queued: today(a.log).map(e => ({ at: e.at, item: e.item, project: e.project, title: e.title, agent: e.agent, ...where(e) })),
    wakes: today(a.wakes).map(e => ({ at: e.at, project: e.project, items: e.items ?? [] })),
  };
}

/** The projects in the settings with nothing queued, waiting, going on or paused, and not held by the owner's focus. */
export function idleProjects(config = loadConfig(), runs = listRuns()) {
  const busy = new Set(runs.filter(r => BUSY.includes(r.status)).map(r => r.project));
  const steer = readSteer();
  return new Set(Object.keys(config.projects ?? {}).filter(id => !busy.has(id) && !holdReason(id, steer)));
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
  if (settings.enabled && !updating() && !held() && !isLocked()) {
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
  // read again: others may have saved the state meanwhile (startApproved is awaited); the log and the changes are
  // written only by autopilotApprove and recordChange, so theirs are kept
  if (JSON.stringify(a) !== before) {
    const fresh = readState();
    saveState({ ...fresh, autopilot: { ...a, log: fresh.autopilot?.log ?? a.log, changes: fresh.autopilot?.changes ?? a.changes } });
  }
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
  if (holdReason(item.project)) throw new Error(`${item.project} is held by the owner's focus (paused, or out of the focus): the autopilot starts nothing there until it is free.`);
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
    `Autopilot: on. When a project's queue empties, you are woken ("idle") to put its next item triaged "now" on the queue (plan approve <n> --autopilot), while the 5-hour window is under ${formatPercent(s.window_stop)}${s.window_stop > s.stop_at_5h_window ? ` (its own ${formatPercent(s.stop_at_5h_window)} raised to the session's pause while the session spends all)` : ''} and ${s.week_pace == null ? 'the plan\'s week is not used up (mode "all": no week\'s pace)' : `the plan's week within the pace that ends it at ${formatPercent(s.week_pace)} (mode "${s.mode}")`}${s.quiet_hours ? `, outside the quiet hours ${s.quiet_hours.text}` : ''}${s.daily_report ? `; daily report at ${s.daily_report}` : ''}.`,
    news.enabled && news.events.has('idle') ? '' : 'The "idle" news is off in manager_updates, so it never wakes you.',
    blocked ? `Now it waits: ${blocked}.` : 'Now it may act.',
    `In the last day it queued: ${day.map(e => `#${e.item} ${e.project}: ${clip(e.title, 60)}`).join('; ') || 'nothing'}.`,
  ].filter(Boolean).join(' ');
}

/** The week's line for the manager's situation and "cli.mjs autopilot": its mode (the autopilot's pace) and the queue's pause. */
export function weekLine(config = loadConfig()) {
  const s = autopilotSettings(config);
  const pause = effectiveLimits(config).pause_at_plan_week;
  const mode = s.week_pace == null ? 'mode "all": no week\'s pace' : `mode "${s.mode}": the autopilot paces the week to end it at ${formatPercent(s.week_pace)}`;
  return `Week (the plan's week): ${mode}${s.enabled ? '' : ' (with the autopilot on)'}; ${pause ? `runs pause at ${formatPercent(pause)} of it` : 'no pause of runs set for it'}.`;
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
