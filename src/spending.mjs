// How much of the account's usage the crew spends, chosen in the app's Usage section: the session (the plan's 5-hour
// window, "current session" on claude.ai) and the plan's week (the autopilot's pace, src/autopilot.mjs).
// The session has two settings: how many runs go on at once ("max_parallel", 1 to 4 from the app) and the share of the
// window at which the crew pauses ("limits.pause_at_5h_window"; off: only the safety margin, SAFETY, which leaves the
// owner room to work live). Its modes fill both (SESSION_MODES): "save" (1 at a time, no early pause), "normal" (the
// settings' defaults: 3 at a time, 85%) and "all" (4 at a time, 97%); any other pair is "custom". Saving means going
// slower, not stopping.
// The safety margin only makes sense far from the window's renewal. forecast() estimates, roughly, how much will be left
// unused when it renews (the usage, its pace over the last hour, the time left and what the crew could spend with more
// runs at once). When spending it is worth it, checkSpending() puts the session in "all" until the renewal by itself
// while the owner is away (told in their summary when back), or offers it once per window (the app's notice with
// "Spend all until HH:MM" and "Not now", and the manager's news). The boost never changes the settings: once the window
// renews, the mode before it holds again. The week's pause never changes.
import path from 'node:path';
import { loadConfig, saveConfig } from './config.mjs';
import { formatPercent, locale, t } from './i18n.mjs';
import { reportEvent } from './news.mjs';
import { CLOSED, planItems } from './planning.mjs';
import { holdReason, readSteer } from './steer.mjs';
import { listRuns, readState, readUsage, saveState } from './store.mjs';
import { clip, DATA, now, readJson, writeJson } from './util.mjs';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const WINDOW = 5 * HOUR; // the session: 5 hours from its first use

/** The safety margin: with no early pause, the crew still pauses at this share of the window. */
export const SAFETY = 0.85;
/** "Spend all" pauses at this share of the window. */
export const SPEND_TO = 0.97;
/** The most runs at once the app sets (the settings may hold more). */
export const MAX_AT_ONCE = 4;
/** "max_parallel" when the settings have none. */
export const DEFAULT_AT_ONCE = 3;
/** The session's modes: runs at once and the pause (null: off, only the safety margin). */
export const SESSION_MODES = {
  save: { parallel: 1, pause: null },
  normal: { parallel: DEFAULT_AT_ONCE, pause: SAFETY },
  all: { parallel: MAX_AT_ONCE, pause: SPEND_TO },
};

// When spending all is worth it, in minutes before the renewal and shares of the window.
export const NEAR_MAX = 120; // never earlier: until then the margin is the owner's
export const NEAR_LEAD = 60; // within this whenever worth it; earlier only when spending it all takes longer
export const NEAR_MIN = 15; // with less left, nothing would start in time
export const SPARE_MIN = 0.15; // at least this would be left unused...
export const GAIN_MIN = 0.05; // ...and spending all would use at least this much more of it
export const RUN_PACE = 0.1; // a run's pace (a share of the window per hour) until one is measured
const SPAN_MIN = 10 * MINUTE; // a pace measured over less than this is not trusted
const KEEP = 2 * HOUR; // the samples kept
const MAX_CHANGES = 50;

const spendingFile = () => path.join(DATA, 'spending.json');
/** What the spending keeps in data/spending.json: { samples, boost, offer, warned, dismissed, run_pace }. */
export const readSpending = (file = spendingFile()) => readJson(file, {});

const iso = at => new Date(at).toISOString();
const clock = when => new Date(when).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
const pct = formatPercent;
/** A window still running (its value is not from before a reset). */
const current = (w, at = Date.now()) => typeof w?.used === 'number' && (!w.resets || Date.parse(w.resets) > at);

/** "max_parallel": how many runs (of different projects) may go on at once. 3 by default, at least 1. */
export const configuredParallel = (config = loadConfig()) => Math.max(1, Math.floor(Number(config.max_parallel) || DEFAULT_AT_ONCE));

/** "limits.pause_at_5h_window": a share from 0.05 to 1, or null (off: only the safety margin). */
export function configuredPause(config = loadConfig()) {
  const v = config.limits?.pause_at_5h_window;
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.min(1, Math.max(0.05, n)) : null;
}

/** The mode a pair stands for: "save", "normal", "all" or "custom" (no early pause and one at the margin alike). */
export const sessionMode = (parallel, pause) =>
  Object.keys(SESSION_MODES).find(m => SESSION_MODES[m].parallel === parallel && (SESSION_MODES[m].pause ?? SAFETY) === (pause ?? SAFETY)) ?? 'custom';

/** The boost going on ("all" until the window renews): { until, by, at, from }, or null. */
export const activeBoost = (data = readSpending(), at = Date.now()) => (data.boost && Date.parse(data.boost.until) > at ? data.boost : null);

/**
 * The session now: { parallel, pause (null: off), limit (the share the crew pauses at), mode, configured (the same,
 * from the settings), boost }. A boost is "all" until the renewal, never less than the settings.
 */
export function sessionNow(config = loadConfig(), data = readSpending(), at = Date.now()) {
  const parallel = configuredParallel(config);
  const pause = configuredPause(config);
  const configured = { parallel, pause, limit: pause ?? SAFETY, mode: sessionMode(parallel, pause) };
  const boost = activeBoost(data, at);
  if (!boost) return { ...configured, configured, boost: null };
  return { parallel: Math.max(parallel, MAX_AT_ONCE), pause: Math.max(configured.limit, SPEND_TO), limit: Math.max(configured.limit, SPEND_TO), mode: 'all', configured, boost };
}

/** The queue's limits now (src/runs.mjs): the settings', with the session's pause in place of the 5-hour one. */
export const effectiveLimits = (config = loadConfig(), data = readSpending(), at = Date.now()) =>
  ({ ...(config.limits ?? {}), pause_at_5h_window: sessionNow(config, data, at).limit });

/**
 * The window's pace over the last hour (a share of it per hour), from the samples of the same window, and the runs
 * going on meanwhile, on average: { pace, runs }, or null with too little measured. The usage when the hour began is
 * the last sample by then, else the first one after it, else the window's start (nothing used).
 */
export function windowPace(usage, samples = [], at = Date.now(), running = 0) {
  const w = usage?.five_hour;
  if (!current(w, at) || !w.resets) return null;
  const start = Date.parse(w.resets) - WINDOW;
  const from = Math.max(at - HOUR, start);
  const same = samples.filter(s => s.resets === w.resets && typeof s.used === 'number').sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const before = same.filter(s => Date.parse(s.at) <= from).at(-1);
  const after = same.find(s => Date.parse(s.at) > from);
  const bases = from === start ? [{ at: start, used: 0 }]
    : [before && { at: from, used: before.used }, after && { at: Date.parse(after.at), used: after.used }, { at: start, used: 0 }];
  const base = bases.find(b => b && at - b.at >= SPAN_MIN);
  if (!base) return null;
  const counts = [...same.filter(s => Date.parse(s.at) >= base.at).map(s => s.running ?? 0), running];
  return { pace: Math.max(0, (w.used - base.used) / ((at - base.at) / HOUR)), runs: counts.reduce((a, b) => a + b, 0) / counts.length };
}

/**
 * Roughly what will be left of the window when it renews: { used, resets, minutes (to the renewal), pace (a share per
 * hour over the last hour; null, unmeasured), limit (where the crew pauses now), left (unused at the renewal at this
 * pace), all: { runs, pace, left } (spending all: the runs that could go on at once, their pace and what would be left),
 * gain, needed (minutes to reach SPEND_TO spending all), near, worth (spending all now is worth it) }, or null with the
 * window unmeasured. session: sessionNow(); running: the runs going on; capacity: the projects the crew has work for
 * (projectsWithWork); runPace: a run's pace measured before.
 */
export function forecast({ usage, samples = [], session, running = 0, capacity = 0, runPace = null, at = Date.now() }) {
  const w = usage?.five_hour;
  if (!current(w, at) || !w.resets) return null;
  const minutes = Math.max(0, (Date.parse(w.resets) - at) / MINUTE);
  const measured = windowPace(usage, samples, at, running);
  const pace = measured?.pace ?? 0;
  // a run's pace: the window's over the runs that went on meanwhile (the manager and live sessions count in it)
  const ownRunPace = measured && measured.runs >= 0.5 ? measured.pace / measured.runs : null;
  const perRun = ownRunPace ?? runPace ?? RUN_PACE;
  const until = (rate, ceiling) => (w.used >= ceiling ? w.used : Math.min(ceiling, w.used + (rate * minutes) / 60));
  const runs = Math.max(running, Math.min(Math.max(session.parallel, MAX_AT_ONCE), capacity));
  const allPace = pace + perRun * Math.max(0, runs - running);
  const end = until(pace, session.limit);
  const endAll = until(allPace, Math.max(session.limit, SPEND_TO));
  const needed = allPace > 0 ? (Math.max(0, SPEND_TO - w.used) / allPace) * 60 : Infinity;
  const near = minutes >= NEAR_MIN && minutes <= NEAR_MAX && minutes <= Math.max(NEAR_LEAD, needed);
  const left = Math.max(0, 1 - end);
  const gain = endAll - end;
  return {
    used: w.used, resets: w.resets, minutes: Math.round(minutes), pace: measured ? measured.pace : null, runPace: ownRunPace,
    limit: session.limit, left, all: { runs, pace: allPace, left: Math.max(0, 1 - endAll) }, gain,
    needed: Number.isFinite(needed) ? Math.round(needed) : null, near, worth: near && left >= SPARE_MIN && gain >= GAIN_MIN,
  };
}

/**
 * How many projects the crew could work on at once now: with a run going on, queued or waiting, and, with the
 * autopilot on, with an item it may start (approved, or triaged "now"); none held by the owner's focus.
 */
export function projectsWithWork(config = loadConfig(), runs = listRuns(), items = null, steer = readSteer()) {
  const free = id => !holdReason(id, steer);
  const projects = new Set(runs.filter(r => ['running', 'queued', 'waiting'].includes(r.status) && free(r.project)).map(r => r.project));
  if (config.autopilot?.enabled === true) {
    for (const i of items ?? planItems()) {
      const startable = i.status === 'approved' || (i.status === 'triaged' && i.recommend === 'now');
      if (startable && i.agent && !i.archived && !CLOSED.includes(i.status) && config.projects?.[i.project] && free(i.project)) projects.add(i.project);
    }
  }
  return projects.size;
}

/**
 * Whether the plan's week holds the crew now: at its pause (as checkLimits in src/runs.mjs reads it) or used up, with
 * a reset ahead. The session's spare can't be spent then, and the week's pause never changes here.
 */
export function weekHolds(config = loadConfig(), usage = readUsage(), at = Date.now()) {
  const w = usage?.seven_day;
  return current(w, at) && !!w.resets && w.used >= Math.min(1, Number(config.limits?.pause_at_plan_week) || 1);
}

/** The offer still standing: once per window, until "not now", a boost or "all", and while something would be left. */
const offerNow = (data, session, f) =>
  f && data.offer?.window === f.resets && !session.boost && session.configured.mode !== 'all' && data.dismissed !== f.resets && f.left >= GAIN_MIN
    ? { window: f.resets, until: f.resets, left: f.left, all: f.all.left, at: data.offer.at }
    : null;

// Who changed what and when, in the list the app shows under "Latest changes" (as the autopilot's, recordChange).
function noteChange(by, changes) {
  const state = readState();
  const a = (state.autopilot ??= { woken: {}, log: [], wakes: [] });
  a.changes = [...(a.changes ?? []), { at: now(), by: clip(String(by), 120), changes }].slice(-MAX_CHANGES);
  saveState(state);
}

/** The words for a session's settings, for the manager: "mode "save": 1 run(s) at a time, pausing only at ...". */
const sessionWords = s => `mode "${s.mode}": ${s.parallel} run(s) at a time, ${s.pause == null ? `pausing only at the ${pct(SAFETY)} safety margin` : `pausing at ${pct(s.pause)}`}`;

/**
 * Every minute: keeps the latest usage measured (the pace's samples), ends a boost whose window renewed and, when
 * spending all is worth it, puts the session in "all" until the renewal by itself while the owner is away (told in
 * their summary when back: "session_spare" waits with the news held while away) or offers it to them, once per window
 * (the app's notice and the manager's news). Never after "not now" in the same window. Returns what it did, with the
 * forecast, for the tests (capacity, items, away, file, report and note stand in for the real ones there).
 */
export function checkSpending({ config = loadConfig(), usage = readUsage(), at = Date.now(), runs = listRuns(), items = null, capacity, away = !!readState().away, file = spendingFile(), report = reportEvent, note = noteChange } = {}) {
  const data = readSpending(file);
  const before = JSON.stringify(data);
  const done = { boosted: false, offered: false, ended: null };
  const running = runs.filter(r => r.status === 'running').length;
  const w = usage.five_hour;
  // the latest measure, once (Claude Code reports it on every run, with the time it was taken)
  const samples = (data.samples ?? []).filter(s => at - Date.parse(s.at) <= KEEP);
  if (current(w, at) && usage.updated && samples.at(-1)?.at !== usage.updated && at - Date.parse(usage.updated) <= KEEP) {
    samples.push({ at: usage.updated, used: w.used, resets: w.resets ?? null, running });
  }
  data.samples = samples.slice(-240);
  // a boost ends with its window: the mode before it holds again (the settings never changed)
  if (data.boost && !activeBoost(data, at)) {
    done.ended = data.boost;
    delete data.boost;
  }
  const session = sessionNow(config, data, at);
  // while the plan's week holds the crew, there is nothing more to spend: no offer, no boost
  const week = weekHolds(config, usage, at);
  const f = forecast({ usage, samples: data.samples, session, running, capacity: week ? 0 : (capacity ?? projectsWithWork(config, runs, items)), runPace: data.run_pace ?? null, at });
  if (f?.runPace != null) data.run_pace = Math.round(f.runPace * 1000) / 1000;
  const window = f?.resets ?? null;
  // a window gone takes its offer and its "not now" with it
  if (data.offer && data.offer.window !== window) delete data.offer;
  if (data.dismissed && data.dismissed !== window) delete data.dismissed;
  if (f?.worth && !session.boost && session.configured.mode !== 'all' && data.dismissed !== window) {
    const owner = config.owner || 'the owner';
    const facts = `The session (the 5-hour window) is at ${pct(f.used)} and renews at ${clock(window)} (in ${f.minutes} min): at this pace about ${pct(f.left)} of it would go unused (the crew pauses at ${pct(f.limit)}). Spending all (up to ${f.all.runs} run(s) at once, pausing at ${pct(SPEND_TO)}) would leave about ${pct(f.all.left)}.`;
    if (away) {
      data.boost = { until: window, by: 'away', at: iso(at), from: session.configured.mode };
      delete data.offer;
      data.warned = window;
      done.boosted = true;
      note('away', { session_boost: [null, window] });
      report('session_spare', `${facts} ${owner} is away, so Chiefmate put the session in "Spend all" until ${clock(window)}, the safety margin included; after the renewal it goes back to ${sessionWords(session.configured)} by itself. Tell ${owner} in your summary when they are back.`, { config });
    } else if (data.warned !== window) {
      data.offer = { window, at: iso(at) };
      data.warned = window;
      done.offered = true;
      report('session_spare', `${facts} ${owner} is here: the app offers "Spend all until ${clock(window)}" (it goes back to ${sessionWords(session.configured)} by itself after the renewal) and "Not now". Recommended when the queue has work worth doing; tell ${owner} in one line if it helps.`, { config });
    }
  }
  if (JSON.stringify(data) !== before) writeJson(file, data);
  return { ...done, forecast: f };
}

/**
 * Changes the session (the app's Usage section, "cli.mjs autopilot --session"): any of { mode ("save", "normal",
 * "all"), parallel (1 to 4), pause (a share from 0.05 to 1, or null/"off": only the safety margin) }, saved in
 * "max_parallel" and "limits.pause_at_5h_window" and read again on every check (no restart). { boost: true } spends
 * all until the window renews, { boost: false } ends it now; { dismiss: true } is "not now" until the renewal. The
 * owner's own settings end a boost. Each change is kept with who made it ("by"). Returns sessionNow().
 */
export function changeSession(body = {}, { config = loadConfig(), by = 'owner', save = saveConfig, file = spendingFile(), usage = readUsage(), at = Date.now(), note = noteChange } = {}) {
  const data = readSpending(file);
  const before = JSON.stringify(data);
  const window = current(usage.five_hour, at) ? usage.five_hour.resets ?? null : null;
  let parallel;
  let pause;
  if (body.mode !== undefined) {
    if (!Object.hasOwn(SESSION_MODES, body.mode)) throw new Error(t('The session mode is save, normal or all.'));
    ({ parallel, pause } = SESSION_MODES[body.mode]);
  }
  if (body.parallel !== undefined) {
    const n = Number(body.parallel);
    if (body.parallel === '' || !Number.isInteger(n) || n < 1 || n > MAX_AT_ONCE) throw new Error(t('Runs at a time: a whole number from 1 to {max}.', { max: MAX_AT_ONCE }));
    parallel = n;
  }
  if (body.pause !== undefined) {
    const off = body.pause === null || body.pause === false || String(body.pause).trim().toLowerCase() === 'off';
    const n = Number(body.pause);
    if (!off && (body.pause === '' || !Number.isFinite(n) || n < 0.05 || n > 1)) throw new Error(t('The session pause is a share from 0.05 to 1, such as 0.85, or off.'));
    pause = off ? null : n;
  }
  const changes = {};
  let dirty = false;
  if (parallel !== undefined && parallel !== configuredParallel(config)) {
    changes.max_parallel = [configuredParallel(config), parallel];
    config.max_parallel = parallel;
    dirty = true;
  }
  // saved as given (off is null), even when it pauses where it did: "save" shows no early pause
  if (pause !== undefined && config.limits?.pause_at_5h_window !== pause) {
    if (pause !== configuredPause(config)) changes.pause_at_5h_window = [configuredPause(config), pause];
    config.limits = { ...config.limits, pause_at_5h_window: pause };
    dirty = true;
  }
  const ending = () => {
    if (!data.boost) return;
    changes.session_boost = [data.boost.until, null];
    delete data.boost;
    // not again by itself in this window
    if (window) data.dismissed = window;
  };
  if (body.boost === true) {
    if (!window) throw new Error(t('The session is not measured yet: there is no renewal to spend until.'));
    if (!activeBoost(data, at)) {
      data.boost = { until: window, by, at: iso(at), from: sessionMode(configuredParallel(config), configuredPause(config)) };
      changes.session_boost = [null, window];
    }
    delete data.offer;
    data.warned = window;
  } else if (body.boost === false || body.mode !== undefined || changes.max_parallel || changes.pause_at_5h_window) ending();
  if (body.dismiss === true && window) {
    data.dismissed = window;
    delete data.offer;
  }
  if (dirty) save(config);
  if (JSON.stringify(data) !== before) writeJson(file, data);
  if (Object.keys(changes).length) note(by, changes);
  return sessionNow(config, data, at);
}

/** For the app's Usage section: the session now, its modes, the estimate and the offer standing, if any. */
export function spendingStatus(config = loadConfig(), { usage = readUsage(), runs = listRuns(), items = null, data = readSpending(), at = Date.now() } = {}) {
  const session = sessionNow(config, data, at);
  const running = runs.filter(r => r.status === 'running').length;
  const week = weekHolds(config, usage, at);
  const f = forecast({ usage, samples: data.samples, session, running, capacity: week ? 0 : projectsWithWork(config, runs, items), runPace: data.run_pace ?? null, at });
  return {
    session, modes: SESSION_MODES, safety: SAFETY, spend_to: SPEND_TO, max: MAX_AT_ONCE, week_holds: week,
    forecast: f && { used: f.used, resets: f.resets, minutes: f.minutes, pace: f.pace, left: f.left, all: f.all, near: f.near, worth: f.worth },
    offer: week ? null : offerNow(data, session, f),
  };
}

/** The session's line for the manager's situation and "cli.mjs autopilot": its mode, a boost and the estimate. */
export function sessionLine(config = loadConfig(), { usage = readUsage(), runs = listRuns(), items = null, data = readSpending(), at = Date.now() } = {}) {
  const owner = config.owner || 'the owner';
  const s = sessionNow(config, data, at);
  const status = spendingStatus(config, { usage, runs, items, data, at });
  const f = status.forecast;
  const mode = s.boost
    ? `"all" until it renews at ${clock(s.boost.until)} (${s.boost.by === 'away' ? `set by Chiefmate while ${owner} was away` : `${owner}'s choice`}): ${s.parallel} run(s) at a time, pausing at ${pct(s.limit)}; then back to ${sessionWords(s.configured)}`
    : sessionWords(s);
  const all = status.week_holds ? "the plan's week is at its pause, so spending all would change nothing until it resets"
    : f?.all.runs ? `spending all (${f.all.runs} run(s) at once) would leave about ${pct(f.all.left)}` : 'spending all would change nothing now: the crew has no work queued';
  const estimate = f
    ? `Estimated: at ${pct(f.used)}${f.pace != null ? `, spending ${pct(f.pace)} an hour over the last hour,` : ''} with ${f.minutes} min to its renewal at ${clock(f.resets)}, about ${pct(f.left)} of it will be left unused; ${all}.`
    : 'Estimated: not measured yet (the next run reports it).';
  const offer = status.offer ? ` Spending all until ${clock(status.offer.until)} was offered to ${owner} in the app; they haven't answered.` : '';
  return `Session (the 5-hour window): ${mode}. ${estimate}${offer}`;
}

let checking = false;
export function startSpending() {
  const tick = () => {
    if (checking) return;
    checking = true;
    try {
      checkSpending();
    } catch (error) {
      console.error('Spending:', error.message);
    } finally {
      checking = false;
    }
  };
  setInterval(tick, 60_000);
  tick();
}
