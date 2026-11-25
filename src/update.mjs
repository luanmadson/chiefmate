// Self-update: when a pull request to Chiefmate is merged on GitHub, this installation updates itself.
// "auto_update_mode" decides how: "pause" (the default) pauses the work going on at a safe point, installs and resumes
// it right after the restart; "wait" installs only once the crew and the manager are free. The owner can also update
// now ("update now" in the app, or "node src/cli.mjs update-now"), which pauses the same way. The new version is
// checked first and, if anything fails, Chiefmate stays on the current one and resumes the work paused for it.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { t } from './i18n.mjs';
import { reportEvent } from './news.mjs';
import { notify } from './notify.mjs';
import { readState, saveState } from './store.mjs';
import { now, ROOT } from './util.mjs';
import { run } from './workspace.mjs';

/**
 * What the app shows about updates. waiting: the approved changes not installed yet; blocked: why they were not
 * ("changes", "merge", "checks" or "timeout"); installing: the update going on now ({ since, by: "owner" or "auto",
 * stage: "pausing", "manager" or "installing", paused: the runs paused for it, interruptManager }), else null.
 */
export const updateInfo = { checked: null, waiting: 0, blocked: null, mode: 'pause', installing: null };

/** "auto_update_mode": "pause" (the default) or "wait". */
export const updateMode = (config = loadConfig()) => (config.auto_update_mode === 'wait' ? 'wait' : 'pause');

/** Whether an update is being installed: no run starts and the manager starts no answer meanwhile. */
export const updating = () => !!updateInfo.installing;

// The longest the update waits for the work going on to pause and for the manager's answer to end.
const MAX_WAIT_MS = 60 * 60_000;

const git = (...args) => run('git', args, ROOT, { maxMinutes: 5 });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// What this Chiefmate does around an update, given by startUpdates (none in the smoke test: updates are off).
let hooks = null;
// The approved version that failed its checks: it is not tried again on its own, only a newer one (or "update now").
let failedTarget = null;
let checking = null;

/** What GitHub has: the branch, how many approved changes are not installed and the last of them. Null when unknown. */
async function look() {
  if (!existsSync(path.join(ROOT, '.git'))) return null;
  if ((await git('fetch', 'origin', '--quiet')).code !== 0) return null;
  const branch = (await git('rev-parse', '--abbrev-ref', 'HEAD')).output.trim();
  const behind = Number((await git('rev-list', '--count', `HEAD..origin/${branch}`)).output.trim()) || 0;
  const target = (await git('rev-parse', `origin/${branch}`)).output.trim();
  Object.assign(updateInfo, { checked: now(), waiting: behind });
  if (!behind) Object.assign(updateInfo, { blocked: null });
  return { branch, behind, target };
}

/** Whether the update can go in at all, before anything is paused for it. Reports why not, once. */
async function installable({ branch, behind }) {
  // Files of Chiefmate changed by hand in this installation: don't overwrite them.
  if ((await git('status', '--porcelain', '--untracked-files=no')).output.trim()) {
    if (updateInfo.blocked !== 'changes') {
      notify(t('Update waiting'), t("Chiefmate's files were changed by hand in this installation, so the new version was not installed."));
      reportEvent('update_blocked', `An approved update of Chiefmate (${behind} change(s)) was not installed: Chiefmate's tracked files were changed by hand in this installation. Someone has to undo or commit those changes.`);
    }
    updateInfo.blocked = 'changes';
    return false;
  }
  // The installation's branch has commits of its own: git could not fast-forward it.
  if ((await git('merge-base', '--is-ancestor', 'HEAD', `origin/${branch}`)).code !== 0) {
    if (updateInfo.blocked !== 'merge') reportEvent('update_blocked', `An approved update of Chiefmate (${behind} change(s)) could not be installed: the installation's branch has commits of its own, so git could not fast-forward it.`);
    updateInfo.blocked = 'merge';
    return false;
  }
  return true;
}

/** Looks for an approved update and, when there is one, installs it as "auto_update_mode" says. */
async function check() {
  if (!hooks || updateInfo.installing) return;
  const found = await look();
  updateInfo.mode = updateMode();
  if (!found?.behind || found.target === failedTarget || !(await installable(found))) return;
  if (updateInfo.mode === 'wait' && hooks.isBusy()) return;
  begin('auto', false, found);
}

/** One check at a time: a check asked while another goes on waits for it. */
function checkOnce() {
  checking ??= check().finally(() => (checking = null));
  return checking;
}

function begin(by, interruptManager, found) {
  updateInfo.installing = { since: now(), by, stage: 'pausing', paused: [], interruptManager, target: found.target };
  install(updateInfo.installing, hooks).catch(error => {
    console.error('Update:', error);
    release(updateInfo.installing, hooks);
  });
}

const resumeNote = job => (job.paused.length ? ` The ${job.paused.length} run(s) paused for it resume now.` : '');

/** Ends an update that did not go in: the runs paused for it and the manager's queue go on. */
function release(job, h) {
  if (updateInfo.installing === job) updateInfo.installing = null;
  h.resume();
}

/**
 * Installs the approved update: pauses the runs going on at a safe point (their step resumes the same Claude Code
 * session after the restart), waits for the manager's answer to end (or interrupts it, when the owner asked), then
 * fast-forwards, checks the new version and restarts. If the checks fail, it goes back to the version it had and the
 * paused work resumes the same way. h: the hooks (see startUpdates); exported, with them, for the smoke test.
 */
export async function install(job, h = hooks) {
  const deadline = Date.now() + MAX_WAIT_MS;
  const late = () => {
    if (Date.now() < deadline) return false;
    updateInfo.blocked = 'timeout';
    notify(t('Update not installed'), t("The work going on didn't pause in time, so Chiefmate stayed on the current version and carries on."));
    reportEvent('update_blocked', `An approved update of Chiefmate was not installed: the work going on did not pause within ${MAX_WAIT_MS / 60_000} minutes. Chiefmate tries again later.${resumeNote(job)}`);
    release(job, h);
    return true;
  };
  // A run being started when the update began goes on for a moment: it is paused as soon as it is going on.
  do {
    for (const id of h.pauseRuns()) if (!job.paused.includes(id)) job.paused.push(id);
    await sleep(h.pollMs ?? 1000);
    if (late()) return false;
  } while (h.crewBusy());
  job.stage = 'manager';
  while (h.managerAnswering()) {
    if (job.interruptManager && !job.interrupted) job.interrupted = h.interruptManager();
    await sleep(h.pollMs ?? 1000);
    if (late()) return false;
  }
  job.stage = 'installing';
  if (!(await h.apply(job))) {
    release(job, h);
    return false;
  }
  return true;
}

/** The installation itself: fast-forward, checks and restart. Returns false when the new version did not go in. */
async function apply(job) {
  const found = await look();
  if (!found?.behind || !(await installable(found))) return false;
  const { branch, behind } = found;
  const before = (await git('rev-parse', 'HEAD')).output.trim();
  if ((await git('merge', '--ff-only', `origin/${branch}`)).code !== 0) {
    if (updateInfo.blocked !== 'merge') reportEvent('update_blocked', `An approved update of Chiefmate (${behind} change(s)) could not be installed: the installation's branch has commits of its own, so git could not fast-forward it.${resumeNote(job)}`);
    updateInfo.blocked = 'merge';
    return false;
  }
  const checked = await run(process.execPath, [path.join('scripts', 'check.mjs')], ROOT, { maxMinutes: 5 });
  if (checked.code !== 0) {
    await git('reset', '--hard', before);
    failedTarget = found.target;
    if (updateInfo.blocked !== 'checks' || job.by === 'owner') reportEvent('update_blocked', `An approved update of Chiefmate (${behind} change(s)) failed its checks (scripts/check.mjs), so Chiefmate stayed on the current version.${resumeNote(job)}`);
    updateInfo.blocked = 'checks';
    notify(t('Update not installed'), t('The new version failed its checks, so Chiefmate stayed on the current one.'));
    return false;
  }
  updateInfo.blocked = null;
  notify(t('Chiefmate updated'), t('The improvements you approved are installed. Chiefmate restarts by itself.'));
  const changes = (await git('log', '--format=%s', '--no-merges', `${before}..HEAD`)).output.trim().split(/\r?\n/).filter(Boolean).slice(0, 5);
  // For the app's info notice "Update installed", after the restart.
  saveState({ ...readState(), last_update: { at: now(), changes } });
  const paused = job.paused.length ? ` The ${job.paused.length} run(s) paused for it resume by themselves after the restart, each step in its own session.` : '';
  reportEvent('update_installed', `Chiefmate installed an approved update (${behind} change(s)${changes.length ? `: ${changes.join('; ')}` : ''}) and restarts by itself.${paused}`);
  await restart(hooks.beforeRestart);
  return true;
}

/**
 * Starts a fresh Chiefmate in the background and ends this one.
 * The new one is started first: if it can't start, this one carries on. It opens its own log ("--log") once this one
 * is gone, because the command that started this one may keep the log locked while this one runs.
 */
async function restart(beforeRestart) {
  const child = spawn(process.execPath, [path.join('src', 'cli.mjs'), 'server', '--log'], {
    cwd: ROOT,
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    env: { ...process.env, CHIEFMATE_RESTART_DELAY: '2000' },
  });
  await new Promise((resolve, reject) => child.once('spawn', resolve).once('error', reject));
  child.unref();
  // A connection slow to close must not keep this one alive: two Chiefmates would share the queue and the schedule.
  await Promise.race([beforeRestart(), new Promise(resolve => setTimeout(resolve, 10_000))]);
  process.exit(0);
}

/**
 * The owner's "update now": installs the approved update at once, pausing the work going on (see install).
 * interruptManager: the manager's answer going on is interrupted instead of awaited; asked again while an update is
 * already going on, it only does that. Returns what the app shows about updates.
 */
export async function updateNow({ interruptManager = false } = {}) {
  if (!hooks) throw new Error(t('Updates are off in this Chiefmate.'));
  const job = updateInfo.installing;
  if (job) {
    if (interruptManager) job.interruptManager = true;
    return { ...updateInfo };
  }
  await checking;
  if (updateInfo.installing) return updateNow({ interruptManager });
  const found = await look();
  if (!found?.behind) throw new Error(t('No approved update is waiting: Chiefmate is up to date.'));
  if (!(await installable(found))) {
    throw new Error(updateInfo.blocked === 'changes'
      ? t("Chiefmate's files were changed by hand in this installation, so the new version can't be installed.")
      : t("This installation's branch has commits of its own, so the update can't be installed."));
  }
  begin('owner', !!interruptManager, found);
  return { ...updateInfo };
}

/** Looks for an approved update now, without waiting for the next check (after a merge, for instance). */
export async function checkNow() {
  if (!hooks) throw new Error(t('Updates are off in this Chiefmate.'));
  await checkOnce();
  return { ...updateInfo };
}

/**
 * Checks GitHub a minute after starting and every 10 minutes after that.
 * options: isBusy() (runs going on, or the manager answering or with messages waiting: "wait" mode waits for none),
 * crewBusy() (runs going on), pauseRuns() (asks every run going on to pause; returns the ids it asked), managerAnswering(),
 * interruptManager(), resume() (the queue and the manager's messages go on) and beforeRestart().
 */
export function startUpdates(options) {
  hooks = { ...options, apply };
  updateInfo.mode = updateMode();
  const tick = () => checkOnce().catch(error => console.error('Update:', error));
  setTimeout(tick, 60_000);
  setInterval(tick, 10 * 60_000);
}
