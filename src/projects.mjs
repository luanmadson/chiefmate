// A project's page in the app: what it is (about it, your own clone, the branch checked out there, how its work is
// delivered) and what you can do from it besides queuing work: open its folder or VS Code, and start or stop its
// development environment ("dev_start" in its settings). The environment runs in a window of its own, through
// "node src/cli.mjs dev-run <project>": the app finds it by that command line (src/machine.mjs), counts its memory in
// the project's and stops it with everything it started. Started from another device, it runs in the background with
// no window, its output kept in data/projects/<id>/dev.log. Every action takes "dryRun", which says what it would do
// and does nothing (the smoke test uses it).
import { execFile, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, readdirSync, rmSync } from 'node:fs';
import { connect, isIP } from 'node:net';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { stripVTControlCharacters } from 'node:util';
import { loadConfig } from './config.mjs';
import { t } from './i18n.mjs';
import { computer, devIdOf, processes, refreshProcesses, SUPPORTED } from './machine.mjs';
import { openConsole, projectClone, tellProjectSessions, where } from './sessions.mjs';
import { clip, DATA, ensureDir, now, readJson, ROOT, writeJson } from './util.mjs';

const validId = id => /^[\w.-]+$/.test(String(id ?? '')) && !String(id).includes('..');

/** The project's settings, or an error for an id that is not a project. */
export function projectOf(config, id) {
  const project = validId(id) ? config.projects?.[id] : null;
  if (!project) throw new Error(t('Unknown project: {id}', { id }));
  return project;
}

/** Your own clone of the project, where its folder, VS Code, its sessions and its environment open. */
function cloneOf(project, id) {
  const dir = projectClone(project);
  if (!dir) throw new Error(t('{name} has no clone of yours on this computer: set "local_clone" in its settings.', { name: project.name ?? id }));
  return dir;
}

// The branch checked out in each clone, read at most every 15 seconds.
const branches = new Map();
function currentBranch(dir) {
  const known = branches.get(dir);
  if (known && Date.now() - known.at < 15_000) return Promise.resolve(known.branch);
  return new Promise(resolve => {
    execFile('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { windowsHide: true, timeout: 10_000 }, (error, stdout) => {
      const branch = error ? null : String(stdout).trim() || null; // "HEAD" when no branch is checked out
      branches.set(dir, { at: Date.now(), branch });
      resolve(branch);
    });
  });
}

// VS Code's program, looked up at most every 10 minutes: Code.exe next to the "code" command, else the command itself.
let vscodeFound = null;
export function vscode() {
  if (vscodeFound && Date.now() - vscodeFound.at < 600_000) return vscodeFound.command;
  let command = null;
  if (process.env.CHIEFMATE_VSCODE) command = { exe: process.env.CHIEFMATE_VSCODE };
  else if (process.platform === 'win32') {
    const found = where('code');
    const cmd = found.find(f => /\.cmd$/i.test(f)) ?? found[0];
    const exe = cmd ? path.resolve(path.dirname(cmd), '..', 'Code.exe') : null;
    if (exe && existsSync(exe)) command = { exe };
    else if (cmd) command = { cmd };
  } else if (spawnSync('which', ['code'], { encoding: 'utf8' }).status === 0) command = { exe: 'code' };
  vscodeFound = { at: Date.now(), command };
  return command;
}

/** How to open a folder with an app ("folder": the file manager; "vscode"): { command, args, verbatim }. */
function opener(app, dir) {
  if (app === 'folder') return { command: process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open', args: [dir] };
  if (app !== 'vscode') throw new Error(t('Unknown app: {app}', { app }));
  const code = vscode();
  if (!code) throw new Error(t('VS Code was not found on this computer (the "code" command).'));
  // code.cmd runs through cmd.exe, written as cmd.exe reads it.
  if (code.cmd) return { command: 'cmd.exe', args: [`/d /s /c ""${code.cmd}" "${dir}""`], verbatim: true };
  return { command: code.exe, args: [dir] };
}

/** Opens the project's clone in the file manager or in VS Code. */
export function openProjectApp(id, app, { dryRun = false, config = loadConfig() } = {}) {
  const project = projectOf(config, id);
  const dir = cloneOf(project, id);
  const how = opener(app, dir);
  if (dryRun) return { dryRun: true, app, dir, command: how.command, args: how.args };
  const child = spawn(how.command, how.args, { cwd: dir, detached: true, stdio: 'ignore', windowsHide: !!how.verbatim, windowsVerbatimArguments: !!how.verbatim });
  child.on('error', error => console.error(`Opening ${app}:`, error.message));
  child.unref();
  return { app, dir };
}

/** The project's development environment: its command ("dev_start") and where it runs (your clone). */
export function devPlan(config, id) {
  const project = projectOf(config, id);
  const command = String(project.dev_start ?? '').trim();
  if (!command) throw new Error(t('{name} has no "dev_start" in its settings.', { name: project.name ?? id }));
  return { name: project.name ?? id, command, cwd: cloneOf(project, id) };
}

const DEV = path.join(DATA, 'dev');
const devFile = id => path.join(DEV, `${id}.json`);
const readDev = id => readJson(devFile(id), null);
const LAUNCH_TIMEOUT = 60_000;
const QUIET_STARTUP = 12_000;

function devNotice(project, text, error = false) {
  const id = randomUUID();
  writeJson(path.join(DEV, `${id}.notice.json`), { project, id, at: now(), text, error });
}

/** The launcher lives in its own window, so its results go through Chiefmate's records to the server. */
export function deliverDevNotices() {
  if (!existsSync(DEV)) return;
  const notices = [];
  for (const name of readdirSync(DEV)) {
    if (name.endsWith('.notice.json')) {
      const file = path.join(DEV, name);
      const notice = readJson(file, null);
      if (notice) notices.push({ ...notice, file });
    } else if (name.endsWith('.json')) {
      const id = name.slice(0, -5);
      const state = readDev(id);
      if (state?.status === 'starting' && !state.pid && Date.now() - state.at >= LAUNCH_TIMEOUT) {
        failLaunch(id, state.token, state.name, t('The environment window did not start.'));
      }
    }
  }
  for (const { project, file, ...notice } of notices.sort((a, b) => a.at.localeCompare(b.at))) {
    tellProjectSessions(project, notice);
    rmSync(file, { force: true });
  }
}

function failLaunch(id, token, name, error) {
  if (readDev(id)?.token !== token) return;
  rmSync(devFile(id), { force: true });
  devNotice(id, t('The development environment for {name} failed to start: {error}', { name, error: clip(error, 300) }), true);
}

/** The processes of the environment's window ("cli.mjs dev-run <id>"), from a reading at most maxAge old. */
async function devWindows(id, maxAge) {
  const { list, error } = await processes(maxAge);
  if (error) throw new Error(error);
  return list.filter(p => devIdOf(p.cmd) === id);
}

/** Where a development environment run in the background keeps its output. */
export const devLog = id => path.join(DATA, 'projects', id, 'dev.log');

/** Runs "cli.mjs <args>" with no window, its output in the log (started afresh). */
function runDetached(cwd, args, log, onError) {
  rmSync(log, { force: true });
  ensureDir(path.dirname(log));
  const out = openSync(log, 'a');
  try {
    spawn(process.execPath, [path.join(ROOT, 'src', 'cli.mjs'), ...args], { cwd, detached: true, stdio: ['ignore', out, out], windowsHide: true }).once('error', onError).unref();
  } finally {
    closeSync(out);
  }
  return null;
}

/** Starts the project's development environment in a window of its own, or with "background" in no window. */
export async function startDev(id, { dryRun = false, background = false, config = loadConfig(), open = openConsole, detach = runDetached, readWindows = devWindows } = {}) {
  const project = projectOf(config, id);
  const name = project.name ?? id;
  let plan;
  let windows;
  try {
    plan = devPlan(config, id);
    if (dryRun) return background ? { dryRun: true, ...plan, background: true, log: devLog(id), run: ['dev-run', id, '--background'] } : { dryRun: true, ...plan, window: ['dev-run', id] };
    windows = await readWindows(id, 5000);
  } catch (error) {
    if (!dryRun) devNotice(id, t('The development environment for {name} failed to start: {error}', { name, error: clip(error.message, 300) }), true);
    throw error;
  }
  const state = readDev(id);
  // A launch of the last minute may not be in the reading yet; past that, the reading decides (Windows reuses process ids).
  const launching = state && Date.now() - state.at < LAUNCH_TIMEOUT && (state.pid ? devAlive(state.pid) : state.status === 'starting');
  if (windows.length || launching || (!SUPPORTED && devAlive(state?.pid))) {
    throw new Error(t('The development environment of {name} is already running.', { name: plan.name }));
  }
  const token = randomUUID();
  writeJson(devFile(id), { token, at: Date.now(), name: plan.name, status: 'starting' });
  const failed = error => failLaunch(id, token, plan.name, error.message);
  try {
    const window = background ? detach(plan.cwd, ['dev-run', id, token, '--background'], devLog(id), failed) : open(`${plan.name} (dev)`, plan.cwd, ['dev-run', id, token], failed);
    return { started: true, window, background, ...plan };
  } catch (error) {
    failed(error);
    throw error;
  }
}

function stopDevTree(pid) {
  if (process.platform !== 'win32') return process.kill(pid);
  const killed = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true });
  if (killed.error) throw killed.error;
  if (killed.status !== 0) throw new Error(killed.stderr?.trim() || `taskkill exited with code ${killed.status}`);
}

/** Stops the development environment: its window's process and everything under it. */
export async function stopDev(id, { dryRun = false, config = loadConfig(), readWindows = devWindows, stopTree = stopDevTree } = {}) {
  const project = projectOf(config, id);
  const name = project.name ?? id;
  let stopped;
  try {
    const windows = await readWindows(id, 0);
    if (dryRun) return { dryRun: true, pids: windows.map(p => p.pid) };
    const pending = readDev(id)?.status === 'starting';
    // A launch can make its way to the console while the process list is being read.
    if (pending && !windows.length) {
      windows.push(...await readWindows(id, 0));
    }
    // The fresh reading decides: with no window in it nothing runs, whatever the record's process id belongs to now.
    for (const { pid } of windows) stopTree(pid);
    stopped = windows.length || Number(pending);
  } catch (error) {
    if (dryRun) throw error;
    const message = t('The development environment for {name} could not be stopped: {error}', { name, error: clip(error.message, 300) });
    devNotice(id, message, true);
    throw new Error(message);
  }
  rmSync(devFile(id), { force: true });
  // Without the services: what the command left running on its own (containers started with "-d") may still be up.
  devNotice(id, stopped
    ? t('The development environment for {name} stopped.', { name })
    : t('The development environment for {name} was already stopped.', { name }));
  await refreshProcesses();
  return { stopped };
}

function devAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function webAddress(value) {
  if (typeof value !== 'string' || value.length > 500) return null;
  try {
    const url = new URL(value.trim());
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

const localAddress = url => url.hostname === 'localhost' || url.hostname === '[::1]' || (isIP(url.hostname) === 4 && url.hostname.startsWith('127.'));

function listening(url) {
  return new Promise(resolve => {
    const socket = connect({ host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80) });
    const done = ready => {
      socket.destroy();
      resolve(ready);
    };
    socket.on('error', () => done(false));
    socket.once('connect', () => done(true));
    socket.setTimeout(800, () => done(false));
  });
}

/** The environment's state and address for the app, including environments opened before notices existed. */
export function devState(id, project, machine) {
  if (!validId(id) || !project.dev_start) return null;
  const found = (machine.dev ?? []).find(d => d.project === id);
  const state = readDev(id);
  // Windows reuses process ids: once a reading of the processes is a minute newer than the launch, it must show the window.
  const settled = machine.supported && Date.parse(machine.measured ?? '') - (state?.at ?? 0) >= LAUNCH_TIMEOUT;
  if (state && devAlive(state.pid) && (!settled || found?.pids.includes(state.pid))) {
    return { status: state.status, ram: found?.ram ?? 0, pid: state.pid, url: state.status === 'running' ? webAddress(state.url)?.href ?? null : null };
  }
  if (state?.status === 'starting' && !state.pid && Date.now() - state.at < LAUNCH_TIMEOUT) return { status: 'starting', ram: 0, pid: null };
  if (found) return { status: 'running', ram: found.ram, pid: found.pids[0] ?? null, url: webAddress(project.dev_url)?.href ?? null };
  return { status: 'stopped', ram: 0, pid: null };
}

function devFacts(state) {
  const { services = [], addresses = [] } = state ?? {};
  return [
    services.length ? t('Services: {services}.', { services: services.join(', ') }) : '',
    addresses.length ? t('Addresses: {addresses}', { addresses: addresses.join(', ') }) : '',
  ].filter(Boolean);
}

/** In the environment's window (or in the background): runs "dev_start" in the project's clone and waits for it to end. */
export async function runDev(id, token, { background = false, config = loadConfig(), spawnCommand = spawn, probe = listening, keepFailedWindow = !background && process.stdin.isTTY } = {}) {
  const state = validId(id) ? readDev(id) : null;
  if (!state || state.token !== token) return;
  let plan;
  try {
    plan = devPlan(config, id);
  } catch (error) {
    failLaunch(id, token, state.name, error.message);
    throw error;
  }
  const configured = webAddress(config.projects[id].dev_url);
  const addresses = new Set(configured ? [configured.href] : []);
  const services = new Set();
  let lastOutput = Date.now();
  let lastError = '';
  let lastLine = '';
  let started = false;
  let reportedUnconfirmed = false;
  let shownUrl = null;
  let finished = false;
  let interrupted = false;
  let failure;
  const current = () => readDev(id)?.token === token;
  const facts = () => ({ services: [...services], addresses: [...addresses].map(address => {
    const url = new URL(address);
    url.search = '';
    url.hash = '';
    return url.href;
  }) });
  const save = (status, url = null) => {
    if (current()) writeJson(devFile(id), { ...state, pid: process.pid, status, url, ...facts() });
  };
  const ready = (url, message) => {
    if (started || !current()) return;
    started = true;
    shownUrl = url;
    save('running', url);
    devNotice(id, [message, ...devFacts(facts())].join(' '));
  };
  // The record goes when the window is done with it; a stop is told once.
  const forget = () => current() && rmSync(devFile(id), { force: true });
  const stopped = () => {
    if (!current()) return;
    forget();
    devNotice(id, t('The development environment for {name} stopped.', { name: plan.name }));
  };
  function observe(text, stderr) {
    const line = stripVTControlCharacters(text).trim();
    if (!line) return;
    lastOutput = Date.now();
    lastLine = clip(line, 300);
    if (stderr) lastError = lastLine;
    const service = line.match(/\b(?:Container|Service)\s+([\w.-]+)\s+(?:Started|Running|Healthy)\b/i)?.[1];
    if (service && services.size < 8) services.add(service);
    for (const match of line.matchAll(/https?:\/\/(?:\[::1\]|[^\s<>"'()[\]])+/gi)) {
      const url = webAddress(match[0].replace(/[.,;]+$/, ''));
      if (url && localAddress(url) && addresses.size < 8) addresses.add(url.href);
    }
  }

  save('starting');
  if (!current()) return;
  console.log(`Chiefmate: ${plan.name}, development environment\n> ${plan.command}\n  (in ${plan.cwd})\n`);
  // Ctrl+C belongs to the command: whatever its exit code then, the environment stopped (Windows reports no signal).
  const onInterrupt = () => (interrupted = true);
  // The window closed: the environment ends with it.
  const onClose = () => {
    if (failure) forget();
    else stopped();
    process.exit(0);
  };
  process.on('SIGINT', onInterrupt);
  process.on('SIGHUP', onClose);
  let timer;
  async function checkReady() {
    if (finished || !current()) return;
    const quiet = Date.now() - lastOutput >= QUIET_STARTUP;
    const local = configured && localAddress(configured) ? [configured] : [...addresses].map(webAddress).filter(localAddress);
    const open = await Promise.all(local.map(probe));
    if (finished || !current()) return;
    const confirmedUrl = local[open.indexOf(true)]?.href ?? null;
    const url = configured?.href ?? confirmedUrl;
    if (confirmedUrl || (!local.length && quiet && services.size)) {
      if (!started) ready(url, t('The development environment for {name} started.', { name: plan.name }));
      else if (url && url !== shownUrl) {
        shownUrl = url;
        save('running', url);
      }
    } else if (!started && !local.length && quiet && !reportedUnconfirmed) {
      reportedUnconfirmed = true;
      save('running', url);
      devNotice(id, t('The development command for {name} is running and has not reported readiness.', { name: plan.name }));
    }
    if (!shownUrl) timer = setTimeout(checkReady, 1000);
  }
  let wasRunning = false;
  try {
    const child = spawnCommand(plan.command, { cwd: plan.cwd, shell: true, stdio: ['inherit', 'pipe', 'pipe'] });
    const output = [
      [child.stdout, process.stdout, false],
      [child.stderr, process.stderr, true],
    ];
    for (const [source, target, stderr] of output) {
      source.pipe(target, { end: false });
      createInterface({ input: source }).on('line', line => observe(line, stderr));
    }
    timer = setTimeout(checkReady, 1000);
    const { code, signal } = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    wasRunning = started;
    if (signal === 'SIGINT') interrupted = true;
    // A command that only starts things (such as "docker compose up -d") ends well once they are up.
    if (!interrupted && code === 0) ready(null, t('The development command for {name} completed successfully.', { name: plan.name }));
    else if (!interrupted) failure = [t('Exit: {code}', { code: code ?? signal }), lastError || lastLine].filter(Boolean).join(' — ');
  } catch (error) {
    failure = error.message;
  } finally {
    finished = true;
    clearTimeout(timer);
    process.off('SIGINT', onInterrupt);
  }
  try {
    if (!current()) return;
    if (failure) {
      save('failed');
      const message = started ? t('The development environment for {name} failed: {error}', { name: plan.name, error: clip(failure, 300) })
        : t('The development environment for {name} failed to start: {error}', { name: plan.name, error: clip(failure, 300) });
      devNotice(id, message, true);
      console.error(message);
      if (keepFailedWindow) {
        console.log(t('Press Enter to close.'));
        await new Promise(resolve => process.stdin.once('data', resolve));
        process.stdin.pause();
      }
      forget();
    } else if (wasRunning || interrupted) stopped();
    else forget();
  } finally {
    process.off('SIGHUP', onClose);
  }
}

/** What the project's page shows besides the state: the project's facts, your clone and its branch, the environment. */
export async function projectInfo(id, config = loadConfig(), machine = computer(config)) {
  const project = projectOf(config, id);
  const clone = projectClone(project);
  return {
    id, name: project.name ?? id, about: project.about ?? '', site: project.site ?? null, repository: project.repository ?? null,
    deliver: project.deliver === 'local' ? 'local' : 'pull_request', mainBranch: project.main_branch ?? null, docs: project.docs ?? null,
    clone, branch: clone ? await currentBranch(clone) : null,
    devStart: project.dev_start ?? null, dev: devState(id, project, machine),
    vscode: !!vscode(),
  };
}
