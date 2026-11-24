// The queue: one run at a time, in the order requested. This is what keeps agents from setting off other agents.
import { t } from './i18n.mjs';
import { cancelCurrent, execute } from './runs.mjs';
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

async function tick() {
  if (busy) return;
  const next = queued().find(r => !r.notBefore || new Date(r.notBefore).getTime() <= Date.now());
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
