// The owner's focus (the Focus panel at the top of Operations, "node src/cli.mjs focus"): which projects may start new
// work. Three modes: "free" (the default: every project), "focus" (only the chosen projects; the others wait, and their
// missions run once after the focus) and "paused-all" (none). A project may also be paused alone, in any mode.
// The queue, the schedule, the autopilot and the board's approved items obey it (holdReason); the owner's live sessions,
// the agents in charge and the manager's conversation never wait for it. A change may last until a time ("until"),
// then the state before it comes back by itself. Kept in data/state.json ("steer"), each change with who made it.
import { loadConfig } from './config.mjs';
import { formatDateTime, locale, t } from './i18n.mjs';
import { reportEvent } from './news.mjs';
import { readState, saveState } from './store.mjs';
import { clip } from './util.mjs';

export const MODES = ['free', 'focus', 'paused-all'];
const MAX_CHANGES = 30;
// The longest a timed change may last.
const MAX_UNTIL_MS = 31 * 24 * 3600_000;

const FREE = { mode: 'free', only: [], paused: [] };
const unique = list => [...new Set((Array.isArray(list) ? list : []).map(String).filter(Boolean))];
const core = s => ({ mode: MODES.includes(s?.mode) ? s.mode : 'free', only: unique(s?.only), paused: unique(s?.paused) });
const same = (a, b) => JSON.stringify(core(a)) === JSON.stringify(core(b));

// Called after each change, the automatic return included: the server nudges the queue and the board's approved items.
const listeners = new Set();
export const onSteerChange = fn => listeners.add(fn);
const changed = s => {
  for (const fn of listeners) {
    try {
      fn(s);
    } catch (error) {
      console.error('Focus:', error);
    }
  }
};

/** The kept state, with its pending return applied once its time came. */
export function readSteer(at = Date.now()) {
  const state = readState();
  const s = { ...FREE, since: null, by: null, until: null, previous: null, changes: [], ...state.steer };
  if (s.until && new Date(s.until).getTime() <= at) {
    const back = { ...core(s.previous ?? FREE), since: new Date(at).toISOString(), by: 'time', until: null, previous: null };
    const next = { ...back, changes: [...(s.changes ?? []), { at: back.since, by: 'time', ...core(back) }].slice(-MAX_CHANGES) };
    saveState({ ...readState(), steer: next });
    reportEvent('focus', `The owner's timed focus ended at ${formatDateTime(s.until)}: back to ${managerHead(core(back))}.`);
    changed(next);
    return next;
  }
  return { ...s, ...core(s) };
}

/**
 * Why a project may not start new work now: "paused" (paused alone), "all" (everything paused), "focus" (out of the
 * focus) or null (it may).
 */
export function holdReason(project, s = readSteer()) {
  if (s.paused.includes(project)) return 'paused';
  if (s.mode === 'paused-all') return 'all';
  if (s.mode === 'focus' && !s.only.includes(project)) return 'focus';
  return null;
}

/** Each project's own control: "focus", "paused" or "active". */
export const controlOf = (project, s) => (s.paused.includes(project) ? 'paused' : s.mode === 'focus' && s.only.includes(project) ? 'focus' : 'active');

/** "2h", "90m", "1h30m" in milliseconds; null when it is none of these. */
export function parseFor(text) {
  const m = /^\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m(?:in)?)?\s*$/i.exec(String(text ?? ''));
  if (!m || (!m[1] && !m[2])) return null;
  return ((Number(m[1]) || 0) * 60 + (Number(m[2]) || 0)) * 60_000 || null;
}

/** "08:00" (the next time it comes, today or tomorrow) or a full date and time, as ISO; null when unreadable. */
export function parseUntil(text, at = new Date()) {
  const hm = /^\s*(\d{1,2})(?::(\d{2}))?\s*h?\s*$/i.exec(String(text ?? ''));
  if (hm && Number(hm[1]) < 24 && Number(hm[2] ?? 0) < 60) {
    const d = new Date(at);
    d.setHours(Number(hm[1]), Number(hm[2] ?? 0), 0, 0);
    if (d <= at) d.setDate(d.getDate() + 1);
    return d.toISOString();
  }
  const d = new Date(String(text ?? ''));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Changes the focus. body: { action, projects, project, to, until, running }:
 * - action "free": no restriction (every pause and the focus end);
 * - "focus" with projects: only those may start new work;
 * - "pause-all": nothing new starts;
 * - "project" with project and to ("active", "paused" or "focus"): that project alone. "focus" adds it to the focus
 *   (starting one if there was none); "active" takes it out of its pause and of the focus.
 * until: an ISO time when the state before this change comes back by itself (over a return still pending, the state
 * before that one; none: the change stays and a pending return is dropped). running: "pause" pauses at a safe point the runs going on of the projects now held (pause(id), given by
 * the caller), "finish" (the default) lets them finish. live: the runs going on ({ run, project }).
 * Returns { steer, paused } with the runs asked to pause; with dryRun (or body.preview), nothing is saved and "held"
 * lists the runs going on whose project the change would hold, for the owner's choice.
 */
export function changeSteer(body = {}, { config = loadConfig(), by = 'owner', at = new Date(), live = [], pause = null, dryRun = !!body.preview } = {}) {
  const projects = Object.keys(config.projects ?? {});
  const known = id => {
    if (!projects.includes(id)) throw new Error(t('Unknown project: {id}.', { id }));
    return id;
  };
  const s = readSteer(at.getTime());
  const before = core(s);
  let next;
  const action = String(body.action ?? '');
  if (action === 'free') next = { ...FREE };
  else if (action === 'focus') {
    const only = unique(body.projects).map(known);
    if (!only.length) throw new Error(t('Choose at least one project for the focus.'));
    next = { mode: 'focus', only, paused: before.paused.filter(id => !only.includes(id)) };
  } else if (action === 'pause-all') next = { ...before, mode: 'paused-all' };
  else if (action === 'project') {
    const id = known(String(body.project ?? ''));
    const to = String(body.to ?? '');
    if (!['active', 'paused', 'focus'].includes(to)) throw new Error(t('A project is active, paused or in focus.'));
    const paused = before.paused.filter(x => x !== id);
    const only = before.only.filter(x => x !== id);
    if (to === 'paused') next = { ...before, only, paused: [...paused, id] };
    else if (to === 'focus') next = { mode: 'focus', only: [...(before.mode === 'focus' ? only : []), id], paused };
    else next = { ...before, only, paused };
  } else throw new Error(t('Unknown focus action.'));
  next = core(next);
  let until = null;
  if (body.until) {
    until = parseUntil(body.until, at);
    const ms = until ? new Date(until).getTime() - at.getTime() : NaN;
    if (!(ms > 0) || ms > MAX_UNTIL_MS) throw new Error(t('The end of the focus must be a time ahead, within a month.'));
  }
  if (dryRun) return { steer: { ...next, until }, held: live.filter(l => holdReason(l.project, next)) };
  // what a timed change comes back to: the state before it or, over a return still pending, the state before that one
  const back = until ? (s.until ? core(s.previous ?? FREE) : before) : null;
  const who = clip(String(by || 'owner'), 120);
  const stamp = at.toISOString();
  const saved = {
    ...next, since: same(before, next) ? s.since ?? stamp : stamp, by: who, until,
    previous: back,
    changes: [...(s.changes ?? []), { at: stamp, by: who, ...next, until }].slice(-MAX_CHANGES),
  };
  saveState({ ...readState(), steer: saved });
  // The runs going on of the projects now held: they finish, or pause at a safe point (back to the queue, waiting).
  const asked = body.running === 'pause' && pause
    ? live.filter(l => holdReason(l.project, saved)).map(l => l.run).filter(id => pause(id))
    : [];
  const name = id => config.projects?.[id]?.name ?? id;
  const actor = who === 'cli' ? 'A command in a terminal' : config.owner || 'The owner';
  // the manager knows its own change: the others reach it as news
  if (who !== 'manager') reportEvent('focus', `${actor} changed the focus: ${managerHead(next, name)}${until ? `, until ${formatDateTime(until)} (then back to ${managerHead(back, name)})` : ''}.${asked.length ? ` ${asked.length} run(s) going on pause at a safe point and resume when their project is free.` : ''}`, { config });
  changed(saved);
  return { steer: saved, paused: asked };
}

const list = names => (names.length > 1 ? t('{list} and {last}', { list: names.slice(0, -1).join(', '), last: names.at(-1) }) : names[0] ?? '');

/** The time of a change: its hour today, else its date and hour. */
function when(iso, at = new Date()) {
  const d = new Date(iso);
  return d.toDateString() === at.toDateString()
    ? d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })
    : formatDateTime(iso);
}

const whoText = by => (by === 'time' ? t('back automatically') : by === 'manager' ? t('by the manager') : by === 'cli' ? t('from the command line') : t("at the owner's request"));

/** The state in a few words, in the app's language: "Focus: only Webshop", "Everything paused", "No restriction". */
export function headText(c, name = id => id) {
  c = core(c);
  if (c.mode === 'paused-all') return t('Everything paused');
  if (c.mode === 'focus') return c.only.length ? t('Focus: only {list}', { list: list(c.only.map(name)) }) : t('Focus with no project: nothing new starts');
  return c.paused.length ? t('Paused: {list}', { list: list(c.paused.map(name)) }) : t('No restriction');
}

/** One line: "Focus: only Webshop since 11:30, at the owner's request, until 13:30". */
export function steerLine(s, config = loadConfig(), at = new Date()) {
  const name = id => config.projects?.[id]?.name ?? id;
  const parts = [headText(s, name)];
  if (s.since) parts[0] += ` ${t('since {time}', { time: when(s.since, at) })}`;
  if (s.since && s.by) parts.push(whoText(s.by));
  if (s.until) parts.push(t('until {time}', { time: when(s.until, at) }));
  return parts.join(', ');
}

function managerHead(c, name = id => id) {
  c = core(c);
  const named = ids => ids.map(id => `${id} (${name(id)})`).join(', ');
  const paused = c.paused.length ? `; paused alone: ${named(c.paused)}` : '';
  if (c.mode === 'paused-all') return 'everything paused (no project starts new work)';
  if (c.mode === 'focus') return `focus on ${c.only.length ? named(c.only) : 'no project'} (only ${c.only.length ? 'these start' : 'nothing starts'} new work; the others wait)${paused}`;
  return `no restriction${paused}`;
}

/** The manager's line: the mode, its effect and the commands. */
export function steerManagerLine(config = loadConfig(), s = readSteer()) {
  const name = id => config.projects?.[id]?.name ?? id;
  const by = { time: 'by the automatic return', manager: 'by you', cli: 'from a terminal' }[s.by] ?? `by ${config.owner || 'the owner'}`;
  const since = s.since ? ` Since ${formatDateTime(s.since)}, ${by}.` : '';
  const until = s.until ? ` Until ${formatDateTime(s.until)}, then back to ${managerHead(s.previous ?? FREE, name)}.` : '';
  return `Owner's focus: ${managerHead(s, name)}.${since}${until} A held project starts no run (queued runs, missions, the autopilot and approved board items wait; a mission missed meanwhile runs once after); the owner's live sessions are never held. Change it only at ${config.owner || 'the owner'}'s request: node src/cli.mjs focus <project...> | focus off | focus pause-all | project-pause <id> | project-resume <id>, with --for 2h or --until 08:00 for a timed change and --pause-running to pause the runs going on (else they finish).`;
}

/**
 * What the app's Focus panel shows: the mode, its line, the latest changes and each project's control and hold.
 * The activity (who works, the queue, the memory) the app reads from the rest of the state.
 */
export function steerView(config = loadConfig(), at = new Date()) {
  const s = readSteer(at.getTime());
  const name = id => config.projects?.[id]?.name ?? id;
  return {
    mode: s.mode, only: s.only, paused: s.paused, since: s.since, by: s.by, until: s.until,
    line: steerLine(s, config, at),
    back: s.until ? headText(s.previous ?? FREE, name) : null,
    changes: (s.changes ?? []).slice(-8).reverse().map(c => ({ at: c.at, by: c.by, until: c.until ?? null, text: headText(c, name), who: whoText(c.by) })),
    projects: Object.keys(config.projects ?? {}).map(id => ({ id, control: controlOf(id, s), hold: holdReason(id, s) })),
  };
}
