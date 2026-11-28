// The queue: runs of different projects go on at the same time, up to the session's runs at once ("max_parallel", 3 by
// default; src/spending.mjs); within one project, one run at a time, in the order requested. This is what keeps agents
// from setting off other agents. When there is less room than projects waiting, the turn is fair: the room goes to the
// project that has gone longest without running.
// The owner orders it from the app (move, hold and release, "Do now", cancel), and so may the manager (cli.mjs queue,
// through the same functions), which never undoes the owner's changes; each change is kept with who made it
// (data/state.json, "queue"). A move keeps the order shown with the change: the fair turn arranges only the runs no one
// placed.
import { loadConfig } from './config.mjs';
import { formatDateTime, t } from './i18n.mjs';
import { activeRun, cancelLive, doingNow, editRun, execute, holdsCopy, limitWaitCleared, live, liveRuns } from './runs.mjs';
import { held } from './power.mjs';
import { effectiveLimits, sessionNow } from './spending.mjs';
import { listRuns, readRun, readState, readUsage, runEnded, saveRun, saveState, stepsOf } from './store.mjs';
import { isLocked } from './lockdown.mjs';
import { parkWaitingWhileAway } from './needs.mjs';
import { checkQuarantine, quarantineHold } from './quarantine.mjs';
import { holdReason, readSteer } from './steer.mjs';
import { updating } from './update.mjs';
import { clip, now } from './util.mjs';

/** How many runs (of different projects) may go on at once now: the session's (src/spending.mjs), a boost included. */
export const maxParallel = (config = loadConfig()) => sessionNow(config).parallel;

// Runs being started (between the queue's choice and execute() registering them), so a tick never picks one twice.
const starting = new Set();

/**
 * If Chiefmate was shut down in the middle of a step, that step goes back to the queue and starts over. A run that had
 * prepared its working copy keeps it (holdsCopy in src/runs.mjs): what its step left uncommitted is still there.
 */
function recoverInterrupted() {
  for (const run of listRuns().filter(r => r.status === 'running')) {
    for (const step of stepsOf(run)) if (step.status === 'running') step.status = 'pending';
    Object.assign(run, { status: 'queued', resumeFirst: run.resumeFirst || !!run.prepared, note: t('Chiefmate was shut down in the middle of the work. The run continues where it stopped.') });
    saveRun(run);
  }
}

/**
 * Runs waiting their turn: queued, or waiting for the account's limit to reset, in the queue's order (the order they
 * run, with the turns among projects, is queueInTurn). The runs paused for an update of Chiefmate come first: their
 * working copy is as their step left it. runs: the records already read.
 */
export function queued(runs = listRuns()) {
  return runs
    .filter(r => r.status === 'queued' || r.status === 'waiting')
    .sort((a, b) => (b.resumeFirst ? 1 : 0) - (a.resumeFirst ? 1 : 0) || rankOf(a) - rankOf(b) || a.created.localeCompare(b.created));
}

// A run's place in the queue: the one a move gave it (the owner's or the manager's), else its creation time, so new runs go last.
const rankOf = run => (Number.isFinite(run.rank) ? run.rank : Date.parse(run.created) || 0);

// A run on hold keeps its place but does not start until it is released (holdRun).
const ready = (run, at = Date.now()) => !run.onHold && (!run.notBefore || new Date(run.notBefore).getTime() <= at);

// ---------- The owner's (and the manager's) changes to the queue ----------

const MAX_CHANGES = 30;
const REASON_MAX = 200;
const ownerName = (config = loadConfig()) => config.owner || t('the owner');

/** What the queue keeps in data/state.json: the "Do now" in force (one at a time) and the latest changes, oldest first. */
export function queueState() {
  const q = readState().queue ?? {};
  return { doNow: q.doNow?.run ? q.doNow : null, changes: Array.isArray(q.changes) ? q.changes : [] };
}

/** Saves the "Do now" (undefined: unchanged) and adds a change: { by, action, run, title, project, ... }. */
function keep(change, doNow) {
  const q = queueState();
  const next = {
    doNow: doNow === undefined ? q.doNow : doNow,
    changes: change ? [...q.changes, { at: now(), ...change }].slice(-MAX_CHANGES) : q.changes,
  };
  saveState({ ...readState(), queue: next });
  return next;
}

const runRef = run => ({ run: run.id, title: run.title, project: run.project });

/** The owner's "Do now" still in force: null once its run ended (done, failed or canceled) or is gone. */
export function activeDoNow(runs = listRuns(), d = queueState().doNow) {
  if (!d) return null;
  const run = runs.find(r => r.id === d.run);
  return run && !runEnded(run) ? d : null;
}

/**
 * Whether the owner's "Do now" keeps a run waiting: the other runs of its project (scope "project") or every other run
 * ("all"). Never the run it is for, nor a run that keeps that project's working copy: it must resume first anyway.
 */
export function heldByDoNow(run, d) {
  if (!d || run.id === d.run) return false;
  if (run.project === d.project) return !holdsCopy(run);
  return d.scope === 'all';
}

/**
 * Why a run of the queue waits for a person, for the app and the manager: held by the owner or the manager, with the
 * reason given, or by the owner's "Do now" of another run (doNow). Null when nothing holds it.
 */
export function holdOf(run, d) {
  if (run.onHold) return { by: run.onHold.by === 'owner' ? 'owner' : 'manager', at: run.onHold.at ?? null, reason: run.onHold.reason ?? null, doNow: null };
  if (heldByDoNow(run, d)) return { by: d.by ?? 'owner', at: d.at ?? null, reason: null, doNow: { run: d.run, title: d.title, project: d.project, scope: d.scope } };
  return null;
}

/**
 * What the app shows of a run in the queue beyond its summary: its hold, who placed it, whether it is the one to do now,
 * and whether it resumes first (first: it stays ahead of the others; keepsCopy: it keeps its project's working copy).
 */
export const queueMarks = (run, d) => ({
  hold: holdOf(run, d), movedBy: run.movedBy ?? null, doNow: !!d && d.run === run.id, first: !!run.resumeFirst, keepsCopy: holdsCopy(run),
});

/** The queue's controls for the app: the "Do now" in force and the latest changes, newest first. */
export function queueControl(runs = listRuns()) {
  const q = queueState();
  return { doNow: activeDoNow(runs, q.doNow), changes: q.changes.slice(-10).reverse() };
}

/** A run of the queue, for changing it: refused when it is not there, or already starting. */
function inQueue(id) {
  const run = readRun(String(id ?? ''));
  if (!run) throw new Error(t('Run not found.'));
  if (!['queued', 'waiting'].includes(run.status) || live.has(run.id) || starting.has(run.id)) {
    throw new Error(t('This run is not waiting in the queue (it is {status}).', { status: live.has(run.id) || starting.has(run.id) ? 'running' : run.status }));
  }
  return run;
}

/**
 * Where a move puts a run (where: "top", "up", "down", "before" or "after" another run) in the queue without it
 * (order), from its place (from). The runs that resume first (resumeFirst) stay ahead of the others. A move by the
 * manager never undoes the owner's order: it may not move a run the owner placed or held, nor carry a run past one the
 * owner placed. Returns the new place.
 */
export function placeFor(run, from, order, { before = null, after = null, top = false, up = false, down = false } = {}, by = 'manager', owner = t('the owner')) {
  let at;
  if (top) at = 0;
  else if (up) at = from - 1;
  else if (down) at = from + 1;
  else if (before || after) {
    const other = String(before ?? after);
    const i = order.findIndex(r => r.id === other);
    if (i < 0) throw new Error(t('{id} is not in the queue.', { id: other }));
    at = before ? i : i + 1;
  } else throw new Error(t('Say where: --before <run> or --top.'));
  const firsts = order.filter(r => r.resumeFirst).length;
  at = run.resumeFirst ? Math.min(Math.max(at, 0), firsts) : Math.min(Math.max(at, firsts), order.length);
  if (by !== 'owner') {
    if (run.movedBy === 'owner' || run.onHold?.by === 'owner') throw new Error(t('{owner} placed or held this run: only they move it.', { owner }));
    const passed = at < from ? order.slice(at, from) : order.slice(from, at);
    const theirs = passed.find(r => r.movedBy === 'owner');
    if (theirs) throw new Error(t('{owner} placed "{title}" where it is: no run moves past it without them.', { owner, title: theirs.title }));
  }
  return at;
}

/**
 * Moves a run in the queue as it is shown, in the order the turns go (where: see placeFor). The queue keeps that order
 * with the change from then on: every run in it gets its place (rank), so the fair turn no longer rearranges them, and
 * new runs go after them, in turn among themselves (turnOrder). One run per project still goes at a time. by: "owner"
 * or "manager"; record: false leaves the change to the caller. Returns the queue, in order.
 */
export function moveInQueue(id, where = {}, by = 'manager', { record = true } = {}) {
  const run = inQueue(id);
  const all = queueInTurn();
  const from = all.findIndex(r => r.id === run.id);
  const order = all.filter(r => r.id !== run.id);
  const at = placeFor(run, from, order, where, by, ownerName());
  // where it is already: nothing to change once that place is kept (shown there by the fair turn alone, it may lose it)
  if (at === from && (placed(run) || goesFirst(run))) return all;
  order.splice(at, 0, run);
  order.forEach((r, i) => {
    if (r === run) Object.assign(r, { movedBy: by, movedAt: now() });
    else if (r.rank === i) return;
    r.rank = i;
    saveRun(r);
  });
  const to = where.top ? 'top' : where.up ? 'up' : where.down ? 'down' : 'place';
  if (record) keep({ by, action: 'move', ...runRef(run), to, place: at + 1 });
  nudgeQueue();
  return queueInTurn();
}

/**
 * Holds a run of the queue without canceling it (hold true), with the reason given, or lets it go again (false). The
 * manager never releases (nor holds again) a run the owner held. A run that keeps its project's working copy is never
 * held: its whole project would stop behind it; nor the run of the "Do now" in force: the runs it holds would wait for
 * nothing. Returns the run.
 */
export function holdRun(id, hold = true, by = 'manager', reason = null) {
  const run = inQueue(id);
  if (by !== 'owner' && run.onHold?.by === 'owner') throw new Error(t('{owner} held this run: only they release it.', { owner: ownerName() }));
  if (hold && holdsCopy(run)) throw new Error(t("This run resumes first: it keeps its project's working copy, so holding it would stop the whole project. Cancel it instead, or pause the project in Focus."));
  if (hold && activeDoNow()?.run === run.id) throw new Error(t('This is the run to do now: end its "Do now" first (Release the others), then hold it.'));
  if (!hold && !run.onHold) return run;
  const why = clip(reason, REASON_MAX) || null;
  if (hold) run.onHold = { at: now(), by, reason: why };
  else delete run.onHold;
  saveRun(run);
  keep({ by, action: hold ? 'hold' : 'release', ...runRef(run), ...(hold && why ? { reason: why } : {}) });
  if (!hold) nudgeQueue();
  return run;
}

/**
 * The owner's "Do now": the run goes to the top of the queue and, until it ends, the other runs wait: those of its
 * project (scope "project") or every other one ("all"). It takes the place of an earlier "Do now", and the queue lets
 * the others go by itself once the run ends (settleDoNow). Returns the queue's controls.
 */
export function doNow(id, scope = 'project', by = 'owner') {
  if (by !== 'owner') throw new Error(t('"Do now" is only for {owner}.', { owner: ownerName() }));
  if (!['project', 'all'].includes(scope)) throw new Error(t('Choose which runs wait: those of its project, or all the others.'));
  const run = inQueue(id);
  moveInQueue(run.id, { top: true }, by, { record: false });
  // the run to do now is the owner's: released if held, and marked as placed by them even when it was first already
  const fresh = readRun(run.id);
  delete fresh.onHold;
  saveRun(Object.assign(fresh, { movedBy: by, movedAt: now() }));
  const d = { ...runRef(run), scope, at: now(), by };
  keep({ by, action: 'do-now', ...runRef(run), scope }, d);
  nudgeQueue();
  return queueControl();
}

/** Ends the owner's "Do now" before its run ends: the other runs go on at once. Returns the queue's controls. */
export function endDoNow(by = 'owner') {
  const d = queueState().doNow;
  if (!d) return queueControl();
  if (by !== 'owner') throw new Error(t('{owner} chose "Do now": only they end it.', { owner: ownerName() }));
  keep({ by, action: 'do-now-end', run: d.run, title: d.title, project: d.project }, null);
  nudgeQueue();
  return queueControl();
}

/** Cancels a run of the queue from the queue's own controls, recorded with who did it. */
export function cancelQueued(id, by = 'manager') {
  const run = inQueue(id);
  const d = activeDoNow();
  if (by !== 'owner' && (run.onHold?.by === 'owner' || run.movedBy === 'owner' || d?.run === run.id)) {
    throw new Error(t('{owner} placed or held this run: only they cancel it.', { owner: ownerName() }));
  }
  const status = cancel(run.id);
  keep({ by, action: 'cancel', ...runRef(run) });
  return status;
}

/** Ends a "Do now" whose run ended, once, so the others go on. Returns the "Do now" still in force, or null. */
function settleDoNow(runs) {
  const d = queueState().doNow;
  if (!d || activeDoNow(runs, d)) return d;
  keep({ by: 'auto', action: 'do-now-ended', run: d.run, title: d.title, project: d.project, status: runs.find(r => r.id === d.run)?.status ?? null }, null);
  return null;
}

/** A change, for the manager, in a few words. */
function changeText(c, owner) {
  const who = c.by === 'owner' ? owner : c.by === 'auto' ? 'Chiefmate' : 'you';
  const what = {
    move: `moved "${c.title}" ${c.to === 'top' ? 'to the top' : c.to === 'up' ? 'up one place' : c.to === 'down' ? 'down one place' : `to place ${c.place}`}`,
    hold: `held "${c.title}"${c.reason ? ` (why: ${c.reason})` : ''}`,
    release: `released "${c.title}"`,
    'do-now': `put "${c.title}" on "Do now" (${c.scope === 'all' ? 'every other run waits' : `the other runs of ${c.project} wait`} until it ends)`,
    'do-now-end': `ended the "Do now" of "${c.title}"`,
    'do-now-ended': `ended the "Do now" of "${c.title}", as its run ended${c.status ? ` (${c.status})` : ''}`,
    cancel: `canceled "${c.title}" in the queue`,
  }[c.action] ?? `${c.action} "${c.title}"`;
  return `${formatDateTime(c.at)}, ${who} ${what}`;
}

/**
 * The manager's lines about the queue: its order, with what holds each run and why, the owner's "Do now", and the
 * latest changes, the owner's being theirs to keep.
 */
export function queueManagerLines(config = loadConfig(), runs = listRuns(), at = Date.now()) {
  const owner = ownerName(config);
  const d = activeDoNow(runs);
  const entry = (r, i) => {
    const h = holdOf(r, d);
    const hold = !h ? '' : h.doNow ? `, waits for ${owner}'s "Do now"` : `, ON HOLD by ${h.by === 'owner' ? owner : 'you'}${h.reason ? ` (why: ${h.reason})` : ''} until released`;
    const placed = r.movedBy === 'owner' ? `, placed here by ${owner}` : '';
    return `${i + 1}. ${r.title} [${r.id}] (project ${r.project}${hold}${placed}${r.notBefore ? `, not before ${formatDateTime(r.notBefore)}` : ''})`;
  };
  // in the order the turns go (turnOrder): the runs placed by a move as given, the others in turn among projects
  const queue = queueInTurn(runs);
  const lines = [queue.length ? `Queue, in the order the turns go (one run per project at a time): ${queue.map(entry).join('; ')}.` : 'Queue: empty.'];
  if (d) lines.push(`${owner}'s "Do now": "${d.title}" [${d.run}] goes first, and until it ends ${d.scope === 'all' ? 'no other run starts' : `no other run of ${d.project} starts`}; then the others go on by themselves.`);
  const recent = queueState().changes.filter(c => at - Date.parse(c.at) < 24 * 3600_000).slice(-8);
  if (recent.some(c => c.by === 'owner')) {
    lines.push(`Changes to the queue in the last 24 hours: ${recent.map(c => changeText(c, owner)).join('; ')}. ${owner}'s changes (order, holds, "Do now", cancellations) are theirs: never undo them (move, release, hold again, cancel or queue again against them) unless ${owner} asks.`);
  }
  return lines;
}

/** Changes a run still in the queue (src/runs.mjs, editRun), never one starting now. */
export function editQueued(id, changes, options) {
  inQueue(id);
  return editRun(id, changes, options);
}

/** A run marked to go before the others: paused for an update or a shutdown (resumeFirst). A new mark joins here. */
export const goesFirst = run => !!run.resumeFirst;

/** By project, when it last ran: its latest run's end, or start while it hasn't ended. A project never run has none. */
export function lastRan(runs = listRuns()) {
  const ran = new Map();
  for (const r of runs) {
    const at = r.started ? r.ended ?? r.started : null;
    if (at && at > (ran.get(r.project) ?? '')) ran.set(r.project, at);
  }
  return ran;
}

// A run placed by a move (the owner's or the manager's: moveInQueue gives every run then in the queue its rank): it keeps
// the order given, which the fair turn never rearranges.
const placed = run => !goesFirst(run) && Number.isFinite(run.rank);

// The turn among projects: the runs marked to go first, then the runs placed by a move in the order given, then the
// project that has gone longest without running (one never run first), then the queue's order.
const byTurn = ran => (a, b) => (goesFirst(b.run) ? 1 : 0) - (goesFirst(a.run) ? 1 : 0)
  || (placed(b.run) ? 1 : 0) - (placed(a.run) ? 1 : 0) || (placed(a.run) ? a.run.rank - b.run.rank : 0)
  || (ran.get(a.run.project) ?? '').localeCompare(ran.get(b.run.project) ?? '') || a.order - b.order;

/**
 * Which runs of the queue start now: the first ready run of each project that has nothing going on, while there is
 * room under the limit; with less room than such projects, the turn decides (byTurn), so a long queue of one project
 * doesn't hold up the others. queue: in the queue's order; busy: the projects with a run going on (or starting); free:
 * the room left; holders: by project, the runs paused in the middle of their work, which keep its working copy
 * (copyHolders); ran: lastRan.
 */
export function pickNext(queue, busy, free, at = Date.now(), holders = new Map(), ran = new Map()) {
  const taken = new Set(busy);
  const firsts = [];
  for (const run of queue) {
    // One run per project at a time: the others wait in order. A run not ready yet (waiting for a limit or a start
    // time) doesn't hold up the ones behind it, as before.
    if (!ready(run, at) || taken.has(run.project)) continue;
    // A run paused in the middle of its work keeps the project's working copy: only such a run may start there, so no
    // other one prepares the copy (checkout, reset, clean) under it.
    if (waitsForCopy(run, holders)) continue;
    taken.add(run.project);
    firsts.push({ run, order: firsts.length });
  }
  return firsts.sort(byTurn(ran)).slice(0, Math.max(0, free)).map(x => x.run);
}

/**
 * The queue in the order its turns go, for the app and the manager: the runs marked to go first, then those placed by a
 * move in the order given, then the others round by round, one run per project, the projects in turn (byTurn); within a
 * project, the queue's order.
 */
export function turnOrder(queue, ran = new Map()) {
  const byProject = new Map();
  for (const run of queue.filter(r => !placed(r))) byProject.set(run.project, [...(byProject.get(run.project) ?? []), run]);
  const projects = [...byProject.values()].map((runs, order) => ({ run: runs[0], runs, order })).sort(byTurn(ran));
  const rounds = Math.max(0, ...projects.map(p => p.runs.length));
  const turns = Array.from({ length: rounds }, (_, i) => projects.map(p => p.runs[i]).filter(Boolean)).flat();
  return [...turns.filter(goesFirst), ...queue.filter(placed), ...turns.filter(r => !goesFirst(r))];
}

/** The queue now, in the order its turns go (turnOrder). runs: the records already read, if any. */
export const queueInTurn = (runs = listRuns()) => turnOrder(queued(runs), lastRan(runs));

/** By project, the ids of the runs that keep its working copy while they are not going on (holdsCopy in src/runs.mjs). */
export function copyHolders(runs = listRuns()) {
  const holders = new Map();
  for (const run of runs.filter(holdsCopy)) holders.set(run.project, (holders.get(run.project) ?? new Set()).add(run.id));
  return holders;
}

/** Whether a run waits for another run of its project that keeps the working copy (holders: copyHolders). */
const waitsForCopy = (run, holders) => !!holders.get(run.project)?.size && !holders.get(run.project).has(run.id);

/** The projects with a run going on (or starting). */
function busyProjects() {
  const projects = liveRuns().map(l => l.project);
  for (const id of starting) projects.push(readRun(id)?.project);
  return projects.filter(Boolean);
}

/**
 * The project in focus: the oldest run going on now (with the others in "others") or, when nothing runs, the next
 * run in the queue (the first one ready to start, else the one that waits the least). Null when there is neither.
 */
export function focus(config = loadConfig()) {
  const about = run => ({
    project: run.project, projectName: config.projects?.[run.project]?.name ?? run.project,
    run: run.id, title: run.title, summary: run.summary ?? null, kind: run.kind, mission: run.mission ?? null,
  });
  const running = liveRuns()
    .map(l => {
      const run = activeRun(l.run) ?? readRun(l.run);
      return run ? { state: 'running', ...about(run), agent: l.agent, step: l.step, doing: doingNow(l), since: run.started ?? l.started } : null;
    })
    .filter(Boolean);
  if (running.length) return { ...running[0], others: running.slice(1) };
  // a run of a project the owner's focus holds (src/steer.mjs) is never next: it waits for the focus to end; nor one
  // that waits for a paused run of its project (copyHolders), nor one held in the queue or by the owner's "Do now", nor
  // one of a project waiting for a quarantined file
  const steer = readSteer();
  const runs = listRuns();
  const holders = copyHolders(runs);
  const d = activeDoNow(runs);
  const queue = queued(runs).filter(r => !r.onHold && !heldByDoNow(r, d) && !holdReason(r.project, steer) && !waitsForCopy(r, holders) && !quarantineHold(r.project));
  const next = pickNext(queue, [], 1, Date.now(), holders, lastRan(runs))[0] ?? [...queue].sort((a, b) => a.notBefore.localeCompare(b.notBefore))[0];
  if (!next) return null;
  const agent = stepsOf(next).find(s => s.status === 'pending')?.agent ?? null;
  return { state: 'next', ...about(next), agent, status: next.status, notBefore: next.notBefore ?? null, others: [] };
}

// Only the process that started the queue (the server) runs it: never a command line, nor the smoke test's server.
let queueStarted = false;

function tick() {
  if (!queueStarted) return;
  // While an update of Chiefmate is being installed, on standby or while Chiefmate stops, nothing starts: the queue
  // goes on after it. Nor in an emergency lockdown (src/lockdown.mjs), until the owner releases it.
  if (updating() || held() || isLocked()) return;
  // In away mode, a run left waiting for the owner too long is parked: its project's next run takes the turn.
  parkWaitingWhileAway();
  // A project waiting for a file the antivirus probably took goes on once the file can be read (checked every few minutes).
  checkQuarantine();
  const config = loadConfig();
  const runs = listRuns();
  // The owner's "Do now" ends with its run: the others go on by themselves.
  const doing = settleDoNow(runs);
  const queue = queued(runs).filter(r => !live.has(r.id) && !starting.has(r.id));
  const waiting = queue.filter(run => run.status === 'waiting' && !ready(run));
  if (waiting.length) {
    const usage = readUsage();
    // the session's pause (src/spending.mjs) in place of the 5-hour limit: a boost or a new mode counts at once
    const limits = effectiveLimits(config);
    for (const run of waiting) {
      if (!limitWaitCleared(run, limits, usage)) continue;
      Object.assign(run, { status: 'queued', notBefore: null, note: null });
      delete run.limitWait;
      saveRun(run);
    }
  }
  const free = maxParallel(config) - live.size - starting.size;
  if (free <= 0) return;
  // The owner's focus (src/steer.mjs): a paused project, or one out of the focus, starts nothing; its runs wait in order.
  // Nor a project waiting for a quarantined file (src/quarantine.mjs): its runs wait instead of failing; nor a run the
  // owner's "Do now" holds (a held run is never ready: see pickNext).
  const steer = readSteer();
  for (const next of pickNext(queue.filter(r => !holdReason(r.project, steer) && !quarantineHold(r.project) && !heldByDoNow(r, doing)), busyProjects(), free, Date.now(), copyHolders(runs), lastRan(runs))) {
    starting.add(next.id);
    // Each run goes on by itself; the queue looks again as soon as one ends.
    Promise.resolve()
      .then(() => {
        starting.delete(next.id);
        return execute(next);
      })
      .catch(error => console.error('Queue:', error))
      .finally(() => {
        starting.delete(next.id);
        setImmediate(nudgeQueue);
      });
  }
}

export const nudgeQueue = () => {
  try {
    tick();
  } catch (error) {
    console.error('Queue:', error);
  }
};

/** Runs the queue in this process (the server's start). timer: false (tests) only lets nudgeQueue run it. */
export function startQueue({ timer = true } = {}) {
  queueStarted = true;
  if (!timer) return;
  recoverInterrupted();
  setInterval(nudgeQueue, 5000);
  nudgeQueue();
}

export function cancel(id) {
  const run = readRun(id);
  if (!run) throw new Error(t('Run not found.'));
  if (cancelLive(id, t('canceled by you'))) return 'canceling';
  if (['queued', 'waiting', 'paused'].includes(run.status)) {
    // a hold ends with the run: resumed later, it waits for its turn again
    delete run.onHold;
    Object.assign(run, { status: 'canceled', ended: now(), note: t('canceled before it finished') });
    saveRun(run);
    return 'canceled';
  }
  return run.status;
}

/** Resumes a paused, failed or canceled run. With ignoreLimits, it goes past the limits this one time. */
export function resume(id, ignoreLimits = false) {
  const run = readRun(id);
  if (!run) throw new Error(t('Run not found.'));
  if (live.has(id) || !['paused', 'waiting', 'failed', 'canceled'].includes(run.status)) return run.status;
  // Steps skipped after a team lead's failed planning come back too: the plan is made again.
  for (const step of stepsOf(run)) if (['failed', 'running', 'skipped'].includes(step.status)) step.status = 'pending';
  Object.assign(run, { status: 'queued', notBefore: null, note: null, ended: null, ignoreLimits: ignoreLimits || run.ignoreLimits || false });
  saveRun(run);
  nudgeQueue();
  return 'queued';
}
