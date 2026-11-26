// A project's page in the app: what it is (about it, your own clone, the branch checked out there, how its work is
// delivered) and what you can do from it besides queuing work: open its folder or VS Code, and start or stop its
// development environment ("dev_start" in its settings). The environment runs in a window of its own, through
// "node src/cli.mjs dev-run <project>": the app finds it by that command line (src/machine.mjs), counts its memory in
// the project's and stops it with everything it started. Started from another device, it runs in the background with
// no window, its output kept in data/projects/<id>/dev.log, where the app finds the system's address. Every action takes "dryRun", which says what it would do
// and does nothing (the smoke test uses it).
import { execFile, spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readSync, rmSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { t } from './i18n.mjs';
import { computer, devIdOf, processes, refreshProcesses } from './machine.mjs';
import { openConsole, projectClone, where } from './sessions.mjs';
import { DATA, ensureDir, ROOT } from './util.mjs';

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

// The environments whose window was just opened, until a reading of the processes finds them (at most a minute).
const starting = new Map();

/** The processes of the environment's window ("cli.mjs dev-run <id>"), from a reading at most maxAge old. */
async function devWindows(id, maxAge) {
  const { list } = await processes(maxAge);
  return list.filter(p => devIdOf(p.cmd) === id);
}

/** Starts the project's development environment in a window of its own. */
export async function startDev(id, { dryRun = false, background = false, config = loadConfig(), data = DATA } = {}) {
  const plan = devPlan(config, id);
  const log = devLog(id, data);
  if (dryRun) return background ? { dryRun: true, ...plan, background: true, log, run: ['dev-run', id, '--background'] } : { dryRun: true, ...plan, window: ['dev-run', id] };
  if ((await devWindows(id, 5000)).length) throw new Error(t('The development environment of {name} is already running.', { name: plan.name }));
  // An address from an earlier run would be taken for this one's.
  rmSync(log, { force: true });
  let window = null;
  if (background) {
    ensureDir(path.dirname(log));
    const out = openSync(log, 'a');
    const cli = path.join(ROOT, 'src', 'cli.mjs');
    spawn(process.execPath, [cli, 'dev-run', id, '--background'], { cwd: plan.cwd, detached: true, stdio: ['ignore', out, out], windowsHide: true }).unref();
    closeSync(out);
  } else window = openConsole(`${plan.name} (dev)`, plan.cwd, ['dev-run', id]);
  starting.set(id, Date.now());
  setTimeout(() => refreshProcesses(), 4000);
  return { started: true, window, background, ...plan };
}

/** Where a development environment run in the background keeps its output. */
export const devLog = (id, data = DATA) => path.join(data, 'projects', id, 'dev.log');

/**
 * The system's address in a development environment's output (such as "Local: http://localhost:5173/"), or null: the
 * first web address on this computer or with a port, so a link in a warning (to the docs, say) is not taken for it.
 */
export function devAddress(text) {
  const plain = String(text ?? '').replace(/\x1b\[[\d;]*m/g, ''); // without the terminal's colors
  for (const [found] of plain.matchAll(/https?:\/\/[^\s'"<>)\]]+/g)) {
    const address = found.replace(/[.,;:]+$/, '');
    try {
      const url = new URL(address);
      if (url.port || ['localhost', '127.0.0.1', '0.0.0.0'].includes(url.hostname)) return address;
    } catch {
      // not an address
    }
  }
  return null;
}

/** The start of the output of an environment run in the background, or '' (started in a window, or not started). */
function devOutput(id, data) {
  let fd;
  try {
    fd = openSync(devLog(id, data), 'r');
    const buffer = Buffer.alloc(64_000);
    return buffer.toString('utf8', 0, readSync(fd, buffer, 0, buffer.length, 0));
  } catch {
    return '';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Stops the development environment: its window's process and everything under it. */
export async function stopDev(id, { dryRun = false, config = loadConfig() } = {}) {
  projectOf(config, id);
  starting.delete(id);
  const windows = await devWindows(id, 0);
  if (dryRun) return { dryRun: true, pids: windows.map(p => p.pid) };
  if (process.platform === 'win32') for (const p of windows) spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true });
  else for (const p of windows) process.kill(p.pid);
  refreshProcesses();
  return { stopped: windows.length };
}

/** The environment's state for the app: running (its memory), starting, or stopped. */
function devState(id, project, machine, data = DATA) {
  if (!project.dev_start) return null;
  const found = (machine.dev ?? []).find(d => d.project === id);
  // Only the start of the output is read: the log grows for as long as the environment runs.
  const url = () => devAddress(devOutput(id, data));
  if (found) {
    starting.delete(id);
    return { status: 'running', ram: found.ram, pid: found.pids[0] ?? null, url: url() };
  }
  const since = starting.get(id);
  if (since && Date.now() - since < 60_000) return { status: 'starting', ram: 0, pid: null, url: url() };
  starting.delete(id);
  return { status: 'stopped', ram: 0, pid: null };
}

/** In the environment's window (or in the background): runs "dev_start" in the project's clone and waits for it to end. */
export async function runDev(id, { background = false } = {}) {
  const plan = devPlan(loadConfig(), id);
  console.log(`Chiefmate: ${plan.name}, development environment\n> ${plan.command}\n  (in ${plan.cwd})\n`);
  process.on('SIGINT', () => {}); // Ctrl+C belongs to the command
  const child = spawn(plan.command, { cwd: plan.cwd, shell: true, stdio: 'inherit' });
  const code = await new Promise(resolve => {
    child.on('error', error => {
      console.error(error.message);
      resolve(-1);
    });
    child.on('exit', c => resolve(c ?? 0));
  });
  if (code !== 0 && !background) {
    // Leave the window open long enough to read what went wrong.
    console.log(`\nThe development environment ended with code ${code}. Press Enter to close.`);
    await new Promise(resolve => process.stdin.once('data', resolve));
  }
  process.exit(0);
}

/** What the project's page shows besides the state: the project's facts, your clone and its branch, the environment. */
export async function projectInfo(id, config = loadConfig(), machine = computer(config), data = DATA) {
  const project = projectOf(config, id);
  const clone = projectClone(project);
  return {
    id, name: project.name ?? id, about: project.about ?? '', site: project.site ?? null, repository: project.repository ?? null,
    deliver: project.deliver === 'local' ? 'local' : 'pull_request', mainBranch: project.main_branch ?? null, docs: project.docs ?? null,
    clone, branch: clone ? await currentBranch(clone) : null,
    devStart: project.dev_start ?? null, dev: devState(id, project, machine, data),
    vscode: !!vscode(),
  };
}
