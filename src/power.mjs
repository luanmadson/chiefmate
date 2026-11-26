// Power modes, the owner's to choose (the app's power panel, "node src/cli.mjs power"):
// - standby: nothing new starts (the queue, the missions, the autopilot); the runs going on pause at a safe point, the
//   live sessions go on. Back on, the paused runs resume first and each mission missed meanwhile runs once.
// - stop: everything pauses at a safe point (as for an update), the state is saved, the crew's browsers and processes
//   close and Chiefmate ends; the watchdog leaves it off. The next start resumes what was paused.
// - shutdown: the same, then Windows shuts down after a countdown the owner can cancel in the app.
// Standby and "off" are kept in data/state.json ("power"); the stop going on lives in memory.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { loadConfig } from './config.mjs';
import { formatDateTime, t } from './i18n.mjs';
import { reportEvent } from './news.mjs';
import { notify } from './notify.mjs';
import { readState, saveState } from './store.mjs';
import { now } from './util.mjs';
import { run } from './workspace.mjs';

/** The seconds the owner has to cancel before Windows shuts down. */
export const COUNTDOWN_S = 60;
// The longest the stop waits for the work going on to pause, and then for the manager's answer to end: past that, it
// goes on (a run not paused yet starts its step over at the next start, as after any stop).
const MAX_WAIT_MS = 15 * 60_000;
const MANAGER_WAIT_MS = 2 * 60_000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const owner = (config = loadConfig()) => config.owner || 'the owner';

// What this Chiefmate does around a stop, given by startPower (none in the smoke test).
let hooks = null;
// The stop going on: { target: "stop" or "shutdown", since, stage, paused, sessions, waitingFor, countdownUntil }.
let job = null;
// Standby, as kept in data/state.json: { mode: "standby", since, paused }, or null. Read once, then kept here.
let standby;

const standbyNow = () => {
  if (standby === undefined) standby = readState().power?.mode === 'standby' ? readState().power : null;
  return standby;
};

/** Whether nothing new may start now: on standby, or while Chiefmate stops. */
export const held = () => !!job || !!standbyNow();

/** Whether Chiefmate is stopping (or shutting the computer down): no update begins meanwhile. */
export const stopping = () => !!job;

/**
 * What the app shows at the top: mode "on", "standby" or "stopping"; since; for a stop, target ("stop" or
 * "shutdown"), stage ("pausing", "manager", "countdown" or "closing"), countdownUntil, the runs and live sessions
 * paused for it and the runs it still waits for ({ run, title, project, doing }).
 */
export function powerInfo() {
  if (job) {
    return {
      mode: 'stopping', since: job.since, target: job.target, stage: job.stage, countdownUntil: job.countdownUntil ?? null,
      paused: job.paused.length, sessions: job.sessions.length, waitingFor: job.waitingFor,
    };
  }
  const s = standbyNow();
  return s ? { mode: 'standby', since: s.since, paused: s.paused?.length ?? 0 } : { mode: 'on', since: null };
}

/**
 * Turns standby on or off. On: the runs going on pause at a safe point (back to the front of the queue); the queue, the
 * schedule and the autopilot start nothing. Off: the queue goes on, the paused runs first, and each mission whose time
 * came meanwhile runs once (src/schedule.mjs). The manager hears of both. Returns powerInfo().
 */
export function setStandby(on, config = loadConfig()) {
  if (job) throw new Error(t('Chiefmate is shutting down: cancel that first.'));
  if (!!on === !!standbyNow()) return powerInfo();
  if (on) {
    const paused = hooks?.pauseRuns('standby') ?? [];
    standby = { mode: 'standby', since: now(), paused };
    saveState({ ...readState(), power: standby });
    reportEvent('power', `${owner(config)} put Chiefmate on standby from the app: nothing new starts (the queue, the missions, the autopilot) until they turn it back on.${paused.length ? ` ${paused.length} run(s) going on pause at a safe point and resume then.` : ''} The live sessions go on.`, { config });
  } else {
    const since = standby.since;
    standby = null;
    const { power, ...rest } = readState();
    saveState(rest);
    reportEvent('power', `${owner(config)} turned Chiefmate back on, after standby since ${formatDateTime(since)}: the queue goes on, the paused runs first, and each mission missed meanwhile runs once now.`, { config });
    hooks?.resume();
  }
  return powerInfo();
}

/**
 * Stops Chiefmate ("stop") or shuts the computer down ("shutdown"), at a safe point: see shutDown. Refused while an
 * update is installed. Returns powerInfo().
 */
export function stopSystem(target = 'stop') {
  if (!hooks) throw new Error(t('Shutting down is off in this Chiefmate.'));
  if (!['stop', 'shutdown'].includes(target)) throw new Error(t('Unknown power mode.'));
  if (target === 'shutdown' && process.platform !== 'win32') throw new Error(t('Shutting the computer down works on Windows only.'));
  if (job) return powerInfo();
  if (hooks.updating?.()) throw new Error(t('An update of Chiefmate is being installed: shut down once it is over.'));
  job = { target, since: now(), stage: 'pausing', paused: [], sessions: [], waitingFor: [], countdownUntil: null, canceled: false };
  const mine = job;
  shutDown(mine, hooks).catch(error => {
    console.error('Power:', error);
    if (job === mine) release(mine, hooks);
  });
  return powerInfo();
}

/** Cancels the stop going on (before Chiefmate starts closing): the work paused for it resumes. Returns powerInfo(). */
export function cancelStop() {
  if (!job) return powerInfo();
  if (job.stage === 'closing') throw new Error(t('Too late to cancel: Chiefmate is closing.'));
  release(job, hooks);
  return powerInfo();
}

function release(j, h) {
  j.canceled = true;
  if (job === j) job = null;
  if (!standbyNow()) h?.resume();
}

/**
 * The stop itself: asks the runs and the live sessions' turns going on to pause at a safe point (as an update does)
 * and waits for them, interrupts the manager's answer, counts down when the computer is to shut down, then saves the
 * mode "off" (the watchdog leaves Chiefmate off), closes the crew's browsers and processes, shuts Windows down if
 * asked and ends Chiefmate. Returns false when it was canceled. h: the hooks (see startPower); exported for the tests.
 */
export async function shutDown(j, h = hooks) {
  const config = loadConfig();
  const deadline = Date.now() + MAX_WAIT_MS;
  do {
    for (const id of h.pauseRuns('stop')) if (!j.paused.includes(id)) j.paused.push(id);
    for (const id of h.pauseSessions?.('stop') ?? []) if (!j.sessions.includes(id)) j.sessions.push(id);
    await sleep(h.pollMs ?? 1000);
    if (j.canceled) return false;
    j.waitingFor = h.crewWaiting?.() ?? [];
  } while ((h.crewBusy() || h.sessionsBusy?.()) && Date.now() < deadline);
  j.waitingFor = [];
  j.stage = 'manager';
  const managerDeadline = Date.now() + MANAGER_WAIT_MS;
  while (h.managerAnswering() && Date.now() < managerDeadline) {
    if (!j.interrupted) j.interrupted = h.interruptManager();
    await sleep(h.pollMs ?? 1000);
    if (j.canceled) return false;
  }
  if (j.target === 'shutdown') {
    j.stage = 'countdown';
    const ms = h.countdownMs ?? COUNTDOWN_S * 1000;
    j.countdownUntil = new Date(Date.now() + ms).toISOString();
    notify(t('The computer shuts down'), t('In {seconds} seconds, once Chiefmate has closed. To cancel, open Chiefmate.', { seconds: Math.round(ms / 1000) }), 'chiefmate:operations', { urgent: true });
    while (Date.now() < Date.parse(j.countdownUntil)) {
      await sleep(Math.min(500, h.pollMs ?? 500));
      if (j.canceled) return false;
    }
  }
  j.stage = 'closing';
  const { power, ...rest } = readState();
  saveState({ ...rest, power: { mode: 'off', since: now(), target: j.target, paused: j.paused, sessions: j.sessions } });
  const what = j.target === 'shutdown' ? 'shut the computer down' : 'stopped Chiefmate';
  reportEvent('power', `${owner(config)} ${what} from the app at ${formatDateTime(new Date())}.${j.paused.length ? ` ${j.paused.length} run(s) paused at a safe point resume at the next start.` : ''}${j.sessions.length ? ` ${j.sessions.length} live session(s) paused carry on then.` : ''}`, { config, later: true });
  await h.closeBrowsers?.().catch(error => console.error('Power:', error.message));
  await h.stopCrew?.().catch(error => console.error('Power:', error.message));
  if (j.target === 'shutdown') await h.powerOff();
  await h.finish();
  return true;
}

/**
 * Windows' own shutdown, right away and without forcing: a program with unsaved work can still hold it (Windows then
 * asks the owner). dryRun: only the command.
 */
export function powerOffCommand({ dryRun = false } = {}) {
  const exe = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\shutdown.exe`;
  const args = ['/s', '/t', '0'];
  if (dryRun) return { command: exe, args };
  return new Promise((resolve, reject) => {
    const child = spawn(existsSync(exe) ? exe : 'shutdown', args, { windowsHide: true, detached: true, stdio: 'ignore' });
    child.once('error', reject).once('spawn', () => {
      child.unref();
      resolve({ command: exe, args });
    });
  });
}

/**
 * What the owner should know before a stop: the runs going on (they pause), the live sessions open and the folders of
 * those sessions with changes not committed (git). runs: [{ title, project }]; sessions: [{ name, cwd, mode }].
 */
export async function powerPreview({ runs = [], sessions = [] } = {}) {
  const folders = [...new Set(sessions.map(s => s.cwd).filter(Boolean))];
  const unsaved = [];
  for (const dir of folders) {
    if (!existsSync(dir)) continue;
    const r = await run('git', ['status', '--porcelain', '--untracked-files=normal'], dir, { maxMinutes: 1 }).catch(() => null);
    const files = r?.code === 0 ? r.output.split(/\r?\n/).filter(Boolean).length : 0;
    if (files) unsaved.push({ folder: dir, files });
  }
  return { ...powerInfo(), runs, sessions, unsaved };
}

/**
 * Starts the power modes. options: those of startUpdates (pauseRuns(why), crewBusy, crewWaiting, pauseSessions,
 * sessionsBusy, managerAnswering, interruptManager, resume), with updating(), closeBrowsers(), stopCrew(), powerOff()
 * and finish() (closes the server and ends the process). A Chiefmate stopped from the app is "on" again here, and the
 * manager hears of what resumes.
 */
export function startPower(options) {
  hooks = options;
  const state = readState();
  if (state.power?.mode !== 'off') return;
  const { power, ...rest } = state;
  saveState(rest);
  standby = null;
  const paused = power.paused?.length ?? 0;
  reportEvent('power', `Chiefmate started again after the owner ${power.target === 'shutdown' ? 'shut the computer down' : 'stopped it'} at ${formatDateTime(power.since)}.${paused ? ` The ${paused} run(s) paused then resume now.` : ''} Each mission missed meanwhile runs once now.`);
}
