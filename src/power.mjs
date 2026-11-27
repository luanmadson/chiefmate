// Power modes, the owner's to choose (the app's power panel, "node src/cli.mjs power"):
// - standby: nothing new starts (the queue, the missions, the autopilot); the runs going on pause at a safe point, the
//   live sessions go on. Back on, the paused runs resume first and each mission missed meanwhile runs once.
// - stop: everything pauses at a safe point (as for an update), the state is saved, the crew's browsers and processes
//   close and Chiefmate ends; the watchdog leaves it off. The next start resumes what was paused.
// - shutdown: the same, then Windows shuts down after a countdown the owner can cancel in the app.
// - reboot: the same, then Windows restarts after a longer countdown; the manager may ask for it ("cli.mjs reboot").
//   Back after the restart, the paused runs resume first and the live sessions' windows open again.
// A computer that went down without a stop (a power cut, a crash) is found at the next start (startPower): the runs it
// cut off go back to the front of the queue, never counted as failed.
// The first start since the computer started (the sign-in after a restart, a power cut or a full shutdown) opens the
// app's window once; the scheduled task that starts Chiefmate at sign-in starts only the server.
// Standby and "off" are kept in data/state.json ("power"); the stop going on lives in memory.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { formatDateTime, t } from './i18n.mjs';
import { reportEvent } from './news.mjs';
import { notify } from './notify.mjs';
import { listRuns, readState, saveRun, saveState, stepsOf } from './store.mjs';
import { clip, DATA, now, readJson, writeJson } from './util.mjs';
import { run } from './workspace.mjs';

/** The seconds the owner has to cancel before Windows shuts down. */
export const COUNTDOWN_S = 60;
/** The seconds of warning before Windows restarts. */
export const REBOOT_COUNTDOWN_S = 120;
/** How long the owner's confirmation of a restart the manager asked for stays valid. */
export const REBOOT_CONFIRM_MINUTES = 30;
// How often Chiefmate notes it is alive (data/alive.json), and how long before its last note a run that failed counts
// as cut off by the computer going down: its tool was killed a moment before Chiefmate itself.
const BEAT_MS = 60_000;
const CUT_WINDOW_MS = 3 * 60_000;
// How long a restart keeps Chiefmate off on purpose while the computer has not started again: past that, Windows did
// not restart (a program held it, or it was canceled on its screen), and the watchdog brings Chiefmate back.
const REBOOT_GRACE_MS = 15 * 60_000;
const LOG_MAX = 50;
// The longest the stop waits for the work going on to pause, and then for the manager's answer to end: past that, it
// goes on (a run not paused yet starts its step over at the next start, as after any stop).
const MAX_WAIT_MS = 15 * 60_000;
const MANAGER_WAIT_MS = 2 * 60_000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const owner = (config = loadConfig()) => config.owner || 'the owner';

// What this Chiefmate does around a stop, given by startPower (none in the smoke test).
let hooks = null;
// The stop going on: { target: "stop", "shutdown" or "reboot", since, by, reason, stage, paused, sessions, waitingFor,
// countdownUntil }.
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
 * What the app shows at the top: mode "on", "standby" or "stopping"; since; for a stop, target ("stop", "shutdown" or
 * "reboot"), who asked for it and why, stage ("pausing", "manager", "countdown" or "closing"), countdownUntil, the
 * runs and live sessions paused for it and the runs it still waits for ({ run, title, project, doing }).
 */
export function powerInfo() {
  if (job) {
    return {
      mode: 'stopping', since: job.since, target: job.target, by: job.by, reason: job.reason, stage: job.stage, countdownUntil: job.countdownUntil ?? null,
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
 * Stops Chiefmate ("stop"), shuts the computer down ("shutdown") or restarts it ("reboot"), at a safe point: see
 * shutDown. by: "owner" or "manager"; reason: why (a restart needs one). Refused while an update is installed, and a
 * restart while a live session's turn goes on (rebootRefusal). Returns powerInfo().
 */
export function stopSystem(target = 'stop', { by = 'owner', reason = '', confirmedBy = null } = {}) {
  if (!hooks) throw new Error(t('Shutting down is off in this Chiefmate.'));
  if (!['stop', 'shutdown', 'reboot'].includes(target)) throw new Error(t('Unknown power mode.'));
  if (target !== 'stop' && process.platform !== 'win32' && !hooks.anyPlatform) throw new Error(t('Shutting the computer down works on Windows only.'));
  if (job) return powerInfo();
  if (hooks.updating?.()) throw new Error(t('An update of Chiefmate is being installed: shut down once it is over.'));
  const why = clip(String(reason ?? '').trim(), 300);
  if (target === 'reboot') {
    const refusal = rebootRefusal({ reason: why });
    if (refusal) throw new Error(refusal);
  }
  job = { target, since: now(), by, reason: why, confirmedBy, stage: 'pausing', paused: [], sessions: [], waitingFor: [], countdownUntil: null, canceled: false };
  const mine = job;
  if (target === 'reboot') {
    logPower({ action: 'reboot', outcome: 'started', by, reason: why, confirmedBy });
    const seconds = Math.round((hooks.countdownMs ?? REBOOT_COUNTDOWN_S * 1000) / 1000);
    notify(t('The computer restarts'), t('Chiefmate pauses the work at a safe point and restarts Windows in about {seconds} seconds ({reason}). To cancel, open Chiefmate.', { seconds, reason: why }), 'chiefmate:operations', { urgent: true });
    reportEvent('power', `${by === 'manager' ? 'You (the manager)' : owner()} asked to restart the computer${confirmedBy ? `, confirmed by ${owner()} in the app` : ''}: ${why}. The runs and the live sessions' turns pause at a safe point, then Windows restarts after a ${seconds}-second countdown. Everything resumes once Chiefmate is back.`, { urgent: true });
  }
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
  if (job.target === 'reboot') {
    logPower({ action: 'reboot', outcome: 'canceled', by: job.by, reason: job.reason });
    reportEvent('power', `${owner()} canceled the restart of the computer (${job.reason}): the work paused for it resumes now.`, { urgent: true });
  }
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
  const why = j.target === 'reboot' ? 'reboot' : 'stop';
  do {
    for (const id of h.pauseRuns(why)) if (!j.paused.includes(id)) j.paused.push(id);
    for (const id of h.pauseSessions?.(why) ?? []) if (!j.sessions.includes(id)) j.sessions.push(id);
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
  if (j.target !== 'stop') {
    j.stage = 'countdown';
    const reboot = j.target === 'reboot';
    const ms = h.countdownMs ?? (reboot ? REBOOT_COUNTDOWN_S : COUNTDOWN_S) * 1000;
    j.countdownUntil = new Date(Date.now() + ms).toISOString();
    notify(reboot ? t('The computer restarts') : t('The computer shuts down'), t('In {seconds} seconds, once Chiefmate has closed. To cancel, open Chiefmate.', { seconds: Math.round(ms / 1000) }), 'chiefmate:operations', { urgent: true });
    while (Date.now() < Date.parse(j.countdownUntil)) {
      await sleep(Math.min(500, h.pollMs ?? 500));
      if (j.canceled) return false;
    }
  }
  j.stage = 'closing';
  const { power, ...rest } = readState();
  saveState({ ...rest, power: { mode: 'off', since: now(), target: j.target, by: j.by, reason: j.reason, paused: j.paused, sessions: j.sessions } });
  const what = j.target === 'reboot' ? 'restarted the computer' : j.target === 'shutdown' ? 'shut the computer down' : 'stopped Chiefmate';
  const who = j.by === 'manager' ? `You (the manager)${j.confirmedBy ? `, with ${owner(config)}'s confirmation,` : ''}` : owner(config);
  reportEvent('power', `${who} ${what} at ${formatDateTime(new Date())}${j.reason ? ` (${j.reason})` : ''}.${j.paused.length ? ` ${j.paused.length} run(s) paused at a safe point resume at the next start.` : ''}${j.sessions.length ? ` ${j.sessions.length} live session(s) paused carry on then.` : ''}`, { config, later: true });
  if (j.target === 'reboot') logPower({ action: 'reboot', outcome: 'restarting', by: j.by, reason: j.reason, paused: j.paused.length, sessions: j.sessions.length });
  await h.closeBrowsers?.().catch(error => console.error('Power:', error.message));
  await h.stopCrew?.().catch(error => console.error('Power:', error.message));
  if (j.target !== 'stop') await h.powerOff(j.target);
  await h.finish();
  return true;
}

/**
 * Windows' own shutdown ("shutdown") or restart ("reboot"), right away and without forcing: a program with unsaved work
 * can still hold it (Windows then asks the owner). dryRun: only the command.
 */
export function powerOffCommand({ dryRun = false, target = 'shutdown' } = {}) {
  const exe = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\shutdown.exe`;
  const args = [target === 'reboot' ? '/r' : '/s', '/t', '0'];
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
 * Why the computer may not restart now, or null: no reason given, or a live session's turn going on (the owner's work
 * is never cut off in the middle).
 */
export function rebootRefusal({ reason = '' } = {}, h = hooks) {
  if (!String(reason ?? '').trim()) return t('Say why the computer should restart (--reason).');
  if (h?.sessionsBusy?.()) return t("A live session's turn is going on: the computer does not restart in the middle of it. Try again once it ends.");
  return null;
}

/**
 * Notes a step of a restart in data/state.json ("power_log", the latest LOG_MAX): { action, outcome (asked, started,
 * canceled, refused, restarting, back), by, reason, ... }. Returns the entry.
 */
export function logPower(entry) {
  const state = readState();
  const item = { at: now(), ...entry };
  saveState({ ...state, power_log: [...(state.power_log ?? []), item].slice(-LOG_MAX) });
  return item;
}

/** The restarts asked for and how each went, oldest first. */
export const powerLog = () => readState().power_log ?? [];

const aliveFile = () => path.join(DATA, 'alive.json');

/**
 * When this computer started (ms). Windows' fast startup keeps it across a shutdown from the Start menu (or the power
 * button), which resumes the saved system: only a restart, a power cut or a full shutdown ("shutdown /s") moves it.
 */
export const bootTime = () => Date.now() - os.uptime() * 1000;

/** Notes that Chiefmate is alive now (data/alive.json): the next start compares it with when the computer started. */
export const beat = (at = now()) => writeJson(aliveFile(), { at, pid: process.pid });

/** When Chiefmate last noted it was alive, or null. */
export const lastBeat = () => readJson(aliveFile(), null)?.at ?? null;

/**
 * Whether Chiefmate is off on purpose (the watchdog leaves it off): stopped or shut down by the owner. A restart is
 * not, once the computer has started again, nor when it has not within REBOOT_GRACE_MS (Windows held it): Chiefmate is
 * meant to come back. boot: when the computer started (ms); at: now (ms).
 */
export const offOnPurpose = (power, boot = bootTime(), at = Date.now()) => power?.mode === 'off'
  && !(power.target === 'reboot' && (Date.parse(power.since) < boot || at - Date.parse(power.since) > REBOOT_GRACE_MS));

/**
 * Whether this is Chiefmate's first start since the computer started (at sign-in, after a restart, a power cut or a
 * full shutdown: see bootTime): its last note of being alive is older than the computer's start. With no note at all (the first start of
 * a version that keeps them) it is not, so an update's restart never counts.
 */
export const firstSinceBoot = ({ last = lastBeat(), boot = bootTime() } = {}) => !!last && Date.parse(last) < boot;

/**
 * Whether the computer went down while Chiefmate was running, without a stop from it (a power cut, a crash, Windows
 * restarting by itself): Chiefmate's last note of being alive is older than the computer's start.
 */
export const cutOff = ({ power = readState().power, last = lastBeat(), boot = bootTime() } = {}) => power?.mode !== 'off' && firstSinceBoot({ last, boot });

/**
 * After the computer went down without a stop: the runs it cut off go back to the front of the queue, where they
 * stopped (their working copy kept). Cut off: still "running" in its record, or failed within CUT_WINDOW_MS before
 * Chiefmate's last note of being alive (its tool killed a moment before Chiefmate) and before the computer's start.
 * A run still running starts over only its steps cut off (running, or failed in that window): one that failed earlier
 * for a reason of its own, or was skipped on purpose, stays so. A run that failed then comes back as a resume does
 * (src/queue.mjs). last: that note (ISO); boot: the start (ms). Returns the ids.
 */
export function recoverCutOff({ last, boot, runs = listRuns() }) {
  const from = Date.parse(last) - CUT_WINDOW_MS;
  const cut = step => step.status === 'running' || (step.status === 'failed' && !(Date.parse(step.ended ?? '') < from));
  const ids = [];
  for (const r of runs) {
    const ended = Date.parse(r.ended ?? '');
    const failedThen = r.status === 'failed' && ended >= from && ended <= boot;
    if (r.status !== 'running' && !failedThen) continue;
    for (const step of stepsOf(r)) {
      if (failedThen ? ['failed', 'running', 'skipped'].includes(step.status) : cut(step)) Object.assign(step, { status: 'pending', error: null });
    }
    Object.assign(r, {
      status: 'queued', resumeFirst: true, ended: null, result: null, notBefore: null,
      note: t('The computer went down in the middle of the work (a power cut or a crash). The run continues where it stopped.'),
      cutOff: { at: last, boot: new Date(boot).toISOString(), was: r.status },
    });
    saveRun(r);
    ids.push(r.id);
  }
  return ids;
}

let beating = null;

/**
 * Starts the power modes. options: those of startUpdates (pauseRuns(why), crewBusy, crewWaiting, pauseSessions,
 * sessionsBusy, managerAnswering, interruptManager, resume), with updating(), closeBrowsers(), stopCrew(),
 * powerOff(target), finish() (closes the server and ends the process), reopenWindows(boot) (the live sessions'
 * windows the restart closed; returns their ids) and openApp() (the app's window). A Chiefmate stopped is "on" again
 * here; after a restart, or after the computer went down without a stop, the work it cut off resumes first and the
 * windows open again. The manager hears of what resumes. On the first start since the computer started, the app's
 * window opens once. options.boot: when the computer started (ms), for the tests.
 */
export function startPower(options) {
  hooks = options;
  const boot = options.boot ?? bootTime();
  const last = lastBeat();
  clearInterval(beating);
  beat();
  beating = setInterval(() => {
    try {
      beat();
    } catch (error) {
      console.error('Power:', error.message);
    }
  }, BEAT_MS);
  beating.unref?.();
  // Up with Windows (sign-in): the app's window opens, once. A restart for an update or by the watchdog follows a recent
  // note, and the window already open reloads by itself.
  if (firstSinceBoot({ last, boot })) options.openApp?.();
  const state = readState();
  const power = state.power;
  if (power?.mode === 'off') {
    const { power: _off, ...rest } = state;
    saveState(rest);
    standby = null;
    const paused = power.paused?.length ?? 0;
    const reboot = power.target === 'reboot';
    const restarted = reboot && Date.parse(power.since) < boot;
    const windows = restarted ? options.reopenWindows?.(boot) ?? [] : [];
    if (reboot) logPower({ action: 'reboot', outcome: restarted ? 'back' : 'not-restarted', by: power.by, reason: power.reason, paused, windows: windows.length });
    const asker = power.by === 'manager' ? 'you (the manager)' : 'the owner';
    const what = !reboot ? `the owner ${power.target === 'shutdown' ? 'shut the computer down' : 'stopped it'}` : restarted ? `${asker} restarted the computer` : `${asker} asked to restart the computer`;
    // Windows did not restart (a program held it, or it was canceled on its screen): Chiefmate started again without it.
    const held = reboot && !restarted ? ' Windows did not restart, though (a program held it, or the restart was canceled on its screen): what the restart was for may still be there.' : '';
    reportEvent('power', `Chiefmate started again after ${what} at ${formatDateTime(power.since)}${power.reason ? ` (${power.reason})` : ''}.${held}${paused ? ` The ${paused} run(s) paused then resume now, first in the queue.` : ''}${windows.length ? ` ${windows.length} live session window(s) opened again.` : ''} Each mission missed meanwhile runs once now.`, { urgent: !!held });
    return;
  }
  if (!cutOff({ power, last, boot })) return;
  const runs = recoverCutOff({ last, boot });
  const windows = options.reopenWindows?.(boot) ?? [];
  logPower({ action: 'cut-off', outcome: 'back', by: 'none', reason: `the computer went down without a stop after ${formatDateTime(last)}`, runs: runs.length, windows: windows.length });
  reportEvent('power', `The computer went down without a stop from Chiefmate (a power cut, a crash or Windows restarting by itself) after ${formatDateTime(last)}, and Chiefmate is back. ${runs.length ? `The ${runs.length} run(s) it cut off (${runs.join(', ')}) resume now, first in the queue; none counts as failed.` : 'No run was cut off.'}${windows.length ? ` ${windows.length} live session window(s) opened again.` : ''} The live sessions in the app keep their conversation. Each mission missed meanwhile runs once now.`, { urgent: true });
}
