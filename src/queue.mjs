// The queue: one run at a time, in the order requested. This is what keeps agents from setting off other agents.
import { loadConfig } from './config.mjs';
import { t } from './i18n.mjs';
import { cancelCurrent, execute, live } from './runs.mjs';
import { listRuns, readRun, saveRun, stepsOf } from './store.mjs';
import { now } from './util.mjs';

let busy = null;
export const currentRunId = () => busy;

/** If Chiefmate was shut down in the middle of a step, that step goes back to the queue and starts over. */
function recoverInterrupted() {
  for (const run of listRuns().filter(r => r.status === 'running')) {
    for (const step of stepsOf(run)) if (step.status === 'running') step.status = 'pending';
    Object.assign(run, { status: 'queued', note: t('Chiefmate was shut down in the middle of the work. The run continues where it stopped.') });
    saveRun(run);
  }
}

/** Runs waiting their turn: queued, or waiting for the account's limit to reset. */
export function queued() {
  return listRuns()
    .filter(r => r.status === 'queued' || r.status === 'waiting')
    .sort((a, b) => a.created.localeCompare(b.created));
}

const ready = run => !run.notBefore || new Date(run.notBefore).getTime() <= Date.now();

/**
 * The project in focus: the one of the run going on now or, when nothing runs, of the next run in the queue
 * (the first one ready to start, else the one that waits the least). Null when there is neither.
 */
export function focus(config = loadConfig()) {
  const about = run => ({
    project: run.project, projectName: config.projects?.[run.project]?.name ?? run.project,
    run: run.id, title: run.title, kind: run.kind, mission: run.mission ?? null,
  });
  const current = live.run ? readRun(live.run) : null;
  if (current) return { state: 'running', ...about(current), agent: live.agent, step: live.step, since: current.started ?? live.started };
  const queue = queued();
  const next = queue.find(ready) ?? [...queue].sort((a, b) => a.notBefore.localeCompare(b.notBefore))[0];
  if (!next) return null;
  const agent = stepsOf(next).find(s => s.status === 'pending')?.agent ?? null;
  return { state: 'next', ...about(next), agent, status: next.status, notBefore: next.notBefore ?? null };
}

async function tick() {
  if (busy) return;
  const next = queued().find(ready);
  if (!next) return;
  busy = next.id;
  try {
    await execute(next);
  } finally {
    busy = null;
  }
}

export const nudgeQueue = () => tick().catch(error => console.error('Queue:', error));

export function startQueue() {
  recoverInterrupted();
  setInterval(nudgeQueue, 5000);
  nudgeQueue();
}

export function cancel(id) {
  const run = readRun(id);
  if (!run) throw new Error(t('Run not found.'));
  if (busy === id) {
    cancelCurrent(t('canceled by you'));
    return 'canceling';
  }
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
  if (!['paused', 'waiting', 'failed', 'canceled'].includes(run.status)) return run.status;
  for (const step of stepsOf(run)) if (step.status === 'failed' || step.status === 'running') step.status = 'pending';
  Object.assign(run, { status: 'queued', notBefore: null, note: null, ended: null, ignoreLimits: ignoreLimits || run.ignoreLimits || false });
  saveRun(run);
  nudgeQueue();
  return 'queued';
}
