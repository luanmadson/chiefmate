// The queue: runs of different projects go on at the same time, up to "max_parallel" (3 by default); within one
// project, one run at a time, in the order requested. This is what keeps agents from setting off other agents.
import { loadConfig } from './config.mjs';
import { t } from './i18n.mjs';
import { activeRun, cancelLive, doingNow, execute, holdsCopy, limitWaitCleared, live, liveRuns } from './runs.mjs';
import { held } from './power.mjs';
import { listRuns, readRun, readUsage, saveRun, stepsOf } from './store.mjs';
import { isLocked } from './lockdown.mjs';
import { parkWaitingWhileAway } from './needs.mjs';
import { checkQuarantine, quarantineHold } from './quarantine.mjs';
import { holdReason, readSteer } from './steer.mjs';
import { updating } from './update.mjs';
import { now } from './util.mjs';

/** "max_parallel": how many runs (of different projects) may go on at once. 3 by default, at least 1. */
export const maxParallel = (config = loadConfig()) => Math.max(1, Math.floor(Number(config.max_parallel) || 3));

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
 * Runs waiting their turn: queued, or waiting for the account's limit to reset. The runs paused for an update of
 * Chiefmate come first: their working copy is as their step left it. runs: the records already read, if any.
 */
export function queued(runs = listRuns()) {
  return runs
    .filter(r => r.status === 'queued' || r.status === 'waiting')
    .sort((a, b) => (b.resumeFirst ? 1 : 0) - (a.resumeFirst ? 1 : 0) || a.created.localeCompare(b.created));
}

const ready = (run, at = Date.now()) => !run.notBefore || new Date(run.notBefore).getTime() <= at;

/**
 * Which runs of the queue start now: the oldest ready run of each project that has nothing going on, while there is
 * room under the limit. queue: oldest first; busy: the projects with a run going on (or starting); free: the room left;
 * holders: by project, the runs paused in the middle of their work, which keep its working copy (copyHolders).
 */
export function pickNext(queue, busy, free, at = Date.now(), holders = new Map()) {
  const taken = new Set(busy);
  const chosen = [];
  for (const run of queue) {
    if (chosen.length >= free) break;
    // One run per project at a time: the others wait in order. A run not ready yet (waiting for a limit or a start
    // time) doesn't hold up the ones behind it, as before.
    if (!ready(run, at) || taken.has(run.project)) continue;
    // A run paused in the middle of its work keeps the project's working copy: only such a run may start there, so no
    // other one prepares the copy (checkout, reset, clean) under it.
    if (waitsForCopy(run, holders)) continue;
    taken.add(run.project);
    chosen.push(run);
  }
  return chosen;
}

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
  // that waits for a paused run of its project (copyHolders), nor one of a project waiting for a quarantined file
  const steer = readSteer();
  const runs = listRuns();
  const holders = copyHolders(runs);
  const queue = queued(runs).filter(r => !holdReason(r.project, steer) && !waitsForCopy(r, holders) && !quarantineHold(r.project));
  const next = queue.find(r => ready(r)) ?? [...queue].sort((a, b) => a.notBefore.localeCompare(b.notBefore))[0];
  if (!next) return null;
  const agent = stepsOf(next).find(s => s.status === 'pending')?.agent ?? null;
  return { state: 'next', ...about(next), agent, status: next.status, notBefore: next.notBefore ?? null, others: [] };
}

function tick() {
  // While an update of Chiefmate is being installed, on standby or while Chiefmate stops, nothing starts: the queue
  // goes on after it. Nor in an emergency lockdown (src/lockdown.mjs), until the owner releases it.
  if (updating() || held() || isLocked()) return;
  // In away mode, a run left waiting for the owner too long is parked: its project's next run takes the turn.
  parkWaitingWhileAway();
  // A project waiting for a file the antivirus probably took goes on once the file can be read (checked every few minutes).
  checkQuarantine();
  const config = loadConfig();
  const runs = listRuns();
  const queue = queued(runs).filter(r => !live.has(r.id) && !starting.has(r.id));
  const waiting = queue.filter(run => run.status === 'waiting' && !ready(run));
  if (waiting.length) {
    const usage = readUsage();
    for (const run of waiting) {
      if (!limitWaitCleared(run, config.limits ?? {}, usage)) continue;
      Object.assign(run, { status: 'queued', notBefore: null, note: null });
      delete run.limitWait;
      saveRun(run);
    }
  }
  const free = maxParallel(config) - live.size - starting.size;
  if (free <= 0) return;
  // The owner's focus (src/steer.mjs): a paused project, or one out of the focus, starts nothing; its runs wait in order.
  // Nor a project waiting for a quarantined file (src/quarantine.mjs): its runs wait instead of failing.
  const steer = readSteer();
  for (const next of pickNext(queue.filter(r => !holdReason(r.project, steer) && !quarantineHold(r.project)), busyProjects(), free, Date.now(), copyHolders(runs))) {
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

export function startQueue() {
  recoverInterrupted();
  setInterval(nudgeQueue, 5000);
  nudgeQueue();
}

export function cancel(id) {
  const run = readRun(id);
  if (!run) throw new Error(t('Run not found.'));
  if (cancelLive(id, t('canceled by you'))) return 'canceling';
  if (['queued', 'waiting', 'paused'].includes(run.status)) {
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
