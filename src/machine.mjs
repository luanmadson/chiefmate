// This computer: which projects are running on it (development servers, node, python, IDEs and so on, started by you
// or by the crew) and how much memory each one uses. Windows only: the processes come from Win32_Process.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { t } from './i18n.mjs';
import { queued } from './queue.mjs';
import { liveRuns } from './runs.mjs';
import { appSessionPids, readSession, sessionIdOf } from './sessions.mjs';
import { clip, WORKSPACES } from './util.mjs';

export const SUPPORTED = process.platform === 'win32';
const MAX_AGE = 15_000;

const LIST_SCRIPT =
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8; ' +
  'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,WorkingSetSize | ConvertTo-Json -Compress';

function powershell(script, timeout = 30_000) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) =>
      error ? reject(error) : resolve(String(stdout)),
    );
  });
}

async function listProcesses() {
  const raw = JSON.parse((await powershell(LIST_SCRIPT)) || '[]');
  return (Array.isArray(raw) ? raw : [raw])
    .filter(p => !String(p.CommandLine ?? '').includes('Get-CimInstance Win32_Process')) // this reading itself
    .map(p => ({
      pid: p.ProcessId, parent: p.ParentProcessId, name: p.Name ?? '', exe: p.ExecutablePath ?? '', cmd: p.CommandLine ?? '', ram: Number(p.WorkingSetSize) || 0,
    }));
}

// The list of processes is read at most every 15 seconds, and only while someone looks (the app, the manager, an alert).
let cache = null;
let pending = null;

export function refreshProcesses() {
  if (!SUPPORTED) return Promise.resolve((cache = { at: Date.now(), list: [] }));
  pending ??= listProcesses()
    .then(list => (cache = { at: Date.now(), list }))
    .catch(error => (cache = { at: Date.now(), list: cache?.list ?? [], error: error.message }))
    .finally(() => (pending = null));
  return pending;
}

/** The processes, read again when older than maxAge. */
export async function processes(maxAge = MAX_AGE) {
  if (!cache || Date.now() - cache.at > maxAge) await refreshProcesses();
  return cache;
}

const normalize = p => path.resolve(p).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
const flatten = text => String(text ?? '').toLowerCase().replace(/\//g, '\\').replace(/\\{2,}/g, '\\');

/**
 * A project's folders on this computer: its working copy in workspaces/, your clone (local_clone), the repository
 * itself when it is a folder, ~/Documents/GitHub/<repository name> when it exists, and any "local_dirs" in its settings.
 */
export function projectFolders(id, project) {
  const list = [path.join(WORKSPACES, id), project.local_clone, ...(project.local_dirs ?? [])];
  const repository = String(project.repository ?? '');
  if (repository && !/^[a-z][\w+.-]*:\/\//i.test(repository) && !/^[\w.-]+@/.test(repository) && existsSync(repository)) list.push(repository);
  const name = path.basename(repository.replace(/[\\/]+$/, '')).replace(/\.git$/, '');
  if (name) {
    const guess = path.join(os.homedir(), 'Documents', 'GitHub', name);
    if (existsSync(guess)) list.push(guess);
  }
  return [...new Set(list.filter(Boolean).map(normalize))];
}

/** Whether a command line names the folder (and not just a folder whose name starts the same way). */
function mentions(text, folder) {
  for (let i = text.indexOf(folder); i >= 0; i = text.indexOf(folder, i + 1)) {
    const next = text[i + folder.length];
    if (next === undefined || /[\\"'\s;,]/.test(next)) return true;
  }
  return false;
}

/** Everything under a process, following ParentProcessId (Windows reuses ids, so cycles are guarded against). */
function subtree(pid, children, into = new Set()) {
  const stack = [pid];
  while (stack.length) {
    const p = stack.pop();
    if (into.has(p)) continue;
    into.add(p);
    for (const c of children.get(p) ?? []) stack.push(c.pid);
  }
  return into;
}

const isChiefmateServer = p => /cli\.mjs["']?\s+server\b/i.test(p.cmd);

/** The project whose development environment a command line runs ("cli.mjs dev-run <id>", see src/projects.mjs), else null. */
export function devIdOf(command) {
  const m = String(command ?? '').match(/cli\.mjs["']?\s+dev-run\s+"?([\w.-]+)/i);
  return m ? m[1] : null;
}

/**
 * Groups the processes by project. Chiefmate itself, the crew at work and the live sessions are told apart and never
 * offered for stopping (a session ends from its own button).
 */
function group(config, list) {
  const byPid = new Map(list.map(p => [p.pid, p]));
  const children = new Map();
  for (const p of list) if (p.parent !== p.pid) children.set(p.parent, [...(children.get(p.parent) ?? []), p]);
  // The crew at work: each run's agent, with what it started, belongs to that run's project.
  const crew = new Set();
  const crewProject = new Map();
  for (const l of liveRuns()) {
    if (!l.pid || !byPid.has(l.pid)) continue;
    for (const pid of subtree(l.pid, children)) {
      crew.add(pid);
      crewProject.set(pid, l.project);
    }
  }
  // The live sessions in a window: each one's window process ("cli.mjs session-run <id>") and everything under it.
  const sessionOf = new Map();
  for (const p of list) {
    const id = sessionIdOf(p.cmd);
    if (id) for (const pid of subtree(p.pid, children)) sessionOf.set(pid, id);
  }
  // The sessions in the app: the tool of each turn going on (started by Chiefmate) and everything under it.
  for (const [root, id] of appSessionPids()) if (byPid.has(root)) for (const pid of subtree(root, children)) sessionOf.set(pid, id);
  // The projects' development environments started from the app: each one's window process and everything under it.
  const devOf = new Map();
  for (const p of list) {
    const id = devIdOf(p.cmd);
    if (id && config.projects?.[id]) for (const pid of subtree(p.pid, children)) devOf.set(pid, id);
  }
  const mine = subtree(process.pid, children);
  for (const pid of [...crew, ...sessionOf.keys(), ...devOf.keys()]) mine.delete(pid);
  const guarded = new Set([...mine, ...crew, ...sessionOf.keys()]);
  for (let p = byPid.get(process.pid)?.parent; p && byPid.has(p) && !guarded.has(p); p = byPid.get(p).parent) guarded.add(p); // who started Chiefmate
  for (const p of list) if (isChiefmateServer(p)) guarded.add(p.pid);

  const folders = Object.entries(config.projects ?? {}).flatMap(([id, project]) => projectFolders(id, project).map(folder => ({ id, folder })));
  const owner = new Map();
  for (const p of list) {
    if (mine.has(p.pid) || crew.has(p.pid)) continue;
    const text = flatten(`${p.exe}\n${p.cmd}`);
    let best = null;
    for (const f of folders) if (mentions(text, f.folder) && (!best || f.folder.length > best.folder.length)) best = f;
    if (best) owner.set(p.pid, best.id);
  }
  // What a project's process started belongs to the project too, unless it names another project.
  for (const [pid, id] of [...owner]) {
    for (const c of subtree(pid, children)) if (!owner.has(c) && !mine.has(c) && !crew.has(c)) owner.set(c, id);
  }
  for (const [pid, id] of crewProject) if (config.projects?.[id]) owner.set(pid, id);
  for (const [pid, id] of devOf) if (!crew.has(pid)) owner.set(pid, id);
  // A session's processes count for its project; a session of a library folder (or a folder of its own) has a row of its own.
  const sessions = new Map();
  for (const [pid, id] of sessionOf) {
    if (!sessions.has(id)) sessions.set(id, { id, record: readSession(id), pids: [] });
    const s = sessions.get(id);
    s.pids.push(pid);
    if (s.record?.project && config.projects?.[s.record.project]) owner.set(pid, s.record.project);
    else owner.delete(pid);
  }

  const describe = p => ({
    pid: p.pid, name: p.name, ram: p.ram, command: clip(p.cmd || p.exe || p.name, 220), crew: crew.has(p.pid), guarded: guarded.has(p.pid),
    session: sessionOf.get(p.pid) ?? null, dev: devOf.has(p.pid),
  });
  const byProject = new Map();
  for (const [pid, id] of owner) byProject.set(id, [...(byProject.get(id) ?? []), describe(byPid.get(pid))]);
  for (const items of byProject.values()) items.sort((a, b) => b.ram - a.ram);
  const chiefmate = [...mine].map(pid => byPid.get(pid)?.ram ?? 0).reduce((a, b) => a + b, 0);
  const sessionList = [...sessions.values()].map(s => {
    const items = s.pids.map(pid => describe(byPid.get(pid))).sort((a, b) => b.ram - a.ram);
    const roots = new Set(appSessionPids().filter(([, id]) => id === s.id).map(([pid]) => pid));
    const window = s.pids.find(pid => sessionIdOf(byPid.get(pid)?.cmd) === s.id || roots.has(pid));
    return { id: s.id, name: s.record?.name ?? s.id, project: s.record?.project ?? null, pid: window ?? null, ram: sum(items), processes: items };
  });
  // Each development environment: its window process and its memory, all it started included.
  const dev = [...new Set(devOf.values())].map(id => {
    const pids = [...devOf].filter(([, x]) => x === id).map(([pid]) => pid);
    return { project: id, pids: pids.filter(pid => devIdOf(byPid.get(pid)?.cmd) === id), ram: pids.reduce((total, pid) => total + (byPid.get(pid)?.ram ?? 0), 0) };
  });
  return { byProject, chiefmate, sessions: sessionList, dev };
}

const sum = items => items.reduce((total, p) => total + p.ram, 0);

/** The computer's memory, the projects running on it and their state, from the latest reading (it never waits). */
export function computer(config = loadConfig(), queue = queued()) {
  if (SUPPORTED && (!cache || Date.now() - cache.at > MAX_AGE)) refreshProcesses();
  const { byProject, chiefmate, sessions, dev } = cache ? group(config, cache.list) : { byProject: new Map(), chiefmate: process.memoryUsage().rss, sessions: [], dev: [] };
  const waiting = new Set(queue.map(r => r.project));
  const working = new Set(liveRuns().map(l => l.project));
  const projects = Object.entries(config.projects ?? {}).map(([id, p]) => {
    const items = byProject.get(id) ?? [];
    const agent = working.has(id);
    const running = items.some(x => !x.crew && !x.session);
    const session = sessions.some(s => s.project === id);
    const state = agent ? 'agent' : running ? 'running' : session ? 'session' : waiting.has(id) ? 'queued' : 'stopped';
    return { id, name: p.name ?? id, state, running, agent, session, queued: waiting.has(id), ram: sum(items), processes: items };
  });
  // The sessions outside the projects (a library folder, a folder of their own), each in a row of its own.
  for (const s of sessions.filter(x => !x.project || !config.projects?.[x.project])) {
    projects.push({ id: `session:${s.id}`, name: s.name, state: 'session', running: false, agent: false, session: true, queued: false, ram: s.ram, processes: s.processes });
  }
  projects.sort((a, b) => b.ram - a.ram || a.name.localeCompare(b.name));
  return {
    supported: SUPPORTED,
    measured: cache?.at && SUPPORTED ? new Date(cache.at).toISOString() : null,
    error: cache?.error ?? null,
    memory: { total: os.totalmem(), free: os.freemem() },
    chiefmate: { ram: chiefmate },
    projects,
    sessions,
    dev,
  };
}

export const freeShare = () => os.freemem() / os.totalmem();

/** 1.5 GB, 820 MB. */
export function formatBytes(bytes) {
  const mb = (bytes ?? 0) / 1024 ** 2;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

/** The processes of a project that may be stopped: never Chiefmate, whoever started it, or the crew at work. */
export async function stoppable(id, config = loadConfig()) {
  if (!SUPPORTED) throw new Error(t('Stopping processes is available on Windows only.'));
  if (!config.projects?.[id]) throw new Error(t('Unknown project: {id}', { id }));
  const { list, error } = await processes(0);
  if (error) throw new Error(t("Couldn't read the processes: {error}", { error }));
  return (group(config, list).byProject.get(id) ?? []).filter(p => !p.crew && !p.guarded);
}

/**
 * Stops a project's processes. With pids, only those that still belong to the project now (what you confirmed);
 * a process that is gone or changed hands is left alone.
 */
export async function stopProject(id, pids = null) {
  let targets = await stoppable(id);
  if (pids) targets = targets.filter(p => pids.map(Number).includes(p.pid));
  if (targets.length) await powershell(`Stop-Process -Id ${targets.map(p => Number(p.pid)).join(',')} -Force -ErrorAction SilentlyContinue`);
  refreshProcesses();
  return targets.map(({ pid, name, ram }) => ({ pid, name, ram }));
}
