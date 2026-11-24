// Live sessions: a conversation with an agent (Claude Code or Codex) in a window of its own, for work done together
// with the owner while the crew works in the background. Each profile in "sessions" says which tool, where (a
// project, a library folder or a "cwd") and which blocks of the prompt builder open the conversation. Opening one
// puts the first message together (data/sessions/<id>.md), records the session (data/sessions/<id>.json) and opens
// Windows Terminal (or PowerShell) in the right folder, running "node src/cli.mjs session-run <id>", which starts the
// tool with that message. The app finds the session's processes by that command line: whether it is alive, its
// memory and since when. Ending it stops that process and everything under it.
import { execFile, spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { userClaudeExcludes } from './access.mjs';
import { environment, executable as claudeExecutable } from './claude.mjs';
import { loadConfig } from './config.mjs';
import { formatDateTime, t } from './i18n.mjs';
import { computer, formatBytes, processes, refreshProcesses } from './machine.mjs';
import { reportEvent } from './news.mjs';
import { notify } from './notify.mjs';
import { assembleBlocks, builderSettings, parseBlocks } from './prompts.mjs';
import { DATA, ensureDir, languageName, now, readJson, ROOT, slug, stamp, WORKSPACES, writeJson } from './util.mjs';

const SESSIONS = path.join(DATA, 'sessions');
const TOOLS = ['claude', 'codex'];
// The longest first message passed whole on the command line (Windows allows about 32,000 characters in all).
// Past it, the agent is asked to read the file instead.
const MAX_PROMPT_ARG = 24_000;
const OPEN = ['login', 'starting', 'open'];

const recordFile = id => path.join(SESSIONS, `${id}.json`);
export const promptFile = id => path.join(SESSIONS, `${id}.md`);
const validId = id => /^[\w.-]+$/.test(String(id ?? '')) && !String(id).includes('..');
export const readSession = id => (validId(id) ? readJson(recordFile(id), null) : null);
const saveSession = record => (writeJson(recordFile(record.id), { ...record, updated: now() }), record);

export function listSessions() {
  ensureDir(SESSIONS);
  return readdirSync(SESSIONS)
    .filter(f => f.endsWith('.json'))
    .map(f => readJson(path.join(SESSIONS, f), null))
    .filter(Boolean)
    .sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''));
}

/** The session a command line belongs to: the launcher's own ("cli.mjs session-run <id>"), else null. */
export function sessionIdOf(command) {
  const m = String(command ?? '').match(/cli\.mjs["']?\s+session-run\s+"?([\w.-]+)/i);
  return m ? m[1] : null;
}

/**
 * The profiles: "sessions": { "<id>": { "name", "tool": "claude" | "codex", "project" or "library_folder"
 * ("<library>/<folder>"), "prompt_blocks": ["..."], "model", "cwd" } }. Then the automatic ones: for each project,
 * one per tool the settings have no profile of for that project (see autoProfiles).
 */
export function sessionProfiles(config = loadConfig()) {
  const configured = Object.entries(config.sessions ?? {}).map(([id, p]) => ({
    id, name: p?.name ?? id, tool: String(p?.tool ?? 'claude').toLowerCase(), project: p?.project ?? null, library_folder: p?.library_folder ?? null,
    prompt_blocks: (Array.isArray(p?.prompt_blocks) ? p.prompt_blocks : String(p?.prompt_blocks ?? '').split(',')).map(b => String(b).trim()).filter(Boolean),
    model: p?.model ?? null, cwd: p?.cwd ?? null, auto: false,
  }));
  return [...configured, ...autoProfiles(config, configured)];
}

/**
 * The automatic profiles, never written to the settings: "project-<id>-claude" and "project-<id>-codex", opened from
 * the project's page. They open in your own clone of the project and start with the project's block of the prompt
 * builder ("prompt_block") and the environment ("prompt_builder.environment"), when there is a copy of the builder.
 */
function autoProfiles(config, configured) {
  const { file, environment } = builderSettings(config);
  const builder = !!file && existsSync(file);
  return Object.entries(config.projects ?? {}).flatMap(([id, p]) => TOOLS
    .filter(tool => !configured.some(x => (x.project === id && x.tool === tool) || x.id === `project-${id}-${tool}`))
    .map(tool => ({
      id: `project-${id}-${tool}`, name: `${p?.name ?? id} (${tool === 'codex' ? 'Codex' : 'Claude Code'})`, tool, project: id, library_folder: null,
      prompt_blocks: builder && p?.prompt_block ? [p.prompt_block, environment].filter(Boolean) : [],
      model: tool === 'claude' ? config.default_model ?? null : null, cwd: null, auto: true,
    })));
}

/** Your own copy of a repository on this computer: the folder itself, or ~/Documents/GitHub/<repository name>. */
function ownCopy(repository) {
  const text = String(repository ?? '');
  if (!text) return null;
  if (!/^[a-z][\w+.-]*:\/\//i.test(text) && !/^[\w.-]+@/.test(text) && existsSync(text)) return text;
  const name = path.basename(text.replace(/[\\/]+$/, '')).replace(/\.git$/, '');
  const guess = name ? path.join(os.homedir(), 'Documents', 'GitHub', name) : null;
  return guess && existsSync(guess) ? guess : null;
}

/** Your own clone of a project (local_clone, or the repository's folder in Documents/GitHub), or null. */
export function projectClone(project) {
  const own = [project?.local_clone, ownCopy(project?.repository)].find(d => d && existsSync(d));
  return own ? path.resolve(own) : null;
}

/**
 * Where the session opens: "cwd" when given; for a project, your own clone (local_clone, or the repository's folder
 * in Documents/GitHub), never the crew's working copy, which is reset before every run; for a library folder, that
 * folder in your own clone of the library or, failing that, in Chiefmate's copy (read only: it is reset from GitHub).
 */
export function sessionFolder(config, profile) {
  const must = dir => {
    if (!existsSync(dir)) throw new Error(t('The folder of session "{name}" does not exist: {path}', { name: profile.name, path: dir }));
    return dir;
  };
  if (profile.cwd) return { dir: must(path.resolve(ROOT, profile.cwd)), copy: false };
  if (profile.project) {
    const project = config.projects?.[profile.project];
    if (!project) throw new Error(t('Unknown project: {id}', { id: profile.project }));
    const own = projectClone(project);
    if (!own) throw new Error(t('Session "{name}": set "cwd" to your own clone of the project. The working copy in workspaces/ belongs to the crew and is reset before every run.', { name: profile.name }));
    return { dir: own, copy: false };
  }
  if (profile.library_folder) {
    const [id, ...rest] = String(profile.library_folder).split(/[\\/]/).filter(Boolean);
    const library = config.library?.[id];
    if (!library) throw new Error(t('Unknown library: {id}', { id }));
    const own = [library.local_clone, ownCopy(library.repository)].find(d => d && existsSync(d));
    const base = own ?? path.join(WORKSPACES, '.library', id);
    return { dir: must(path.join(base, ...rest)), copy: !own };
  }
  throw new Error(t('Session "{name}" needs "project", "library_folder" or "cwd".', { name: profile.name }));
}

/**
 * The first message: a short header and the blocks of the prompt builder the profile names, variables filled in. An
 * automatic profile always has one: the header, the project's sentence "about" it and the blocks found.
 */
export function sessionPrompt(config, profile, folder) {
  let built = null;
  if (profile.prompt_blocks.length) {
    const { file } = builderSettings(config);
    if (!file || !existsSync(file)) throw new Error(t('Session "{name}" uses blocks of the prompt builder, but there is no copy of it on this computer ("prompt_builder.file").', { name: profile.name }));
    built = assembleBlocks(parseBlocks(readFileSync(file, 'utf8')), profile.prompt_blocks);
    if (!built.blocks.length && !profile.auto) throw new Error(t('None of the blocks of session "{name}" is in the prompt builder: {list}', { name: profile.name, list: profile.prompt_blocks.join(', ') }));
  }
  const lines = [
    `# ${profile.name}`,
    `A live session with ${config.owner || 'the owner'}, opened by Chiefmate on ${formatDateTime(new Date())}. Working folder: ${folder.dir}. Talk to ${config.owner || 'the owner'} in ${languageName(config.language || 'en')}.`,
  ];
  const project = profile.auto ? config.projects?.[profile.project] : null;
  if (project) lines.push(`Project: ${project.name ?? profile.project}${project.site ? ` (${project.site})` : ''}. ${project.about ?? ''}`.trim());
  if (folder.copy) lines.push("This folder is Chiefmate's read-only copy of a library: it is reset from GitHub, so anything changed here is lost. Read it; write only where the owner tells you.");
  if (built?.text) lines.push('', built.text);
  return { text: lines.join('\n'), blocks: built?.blocks ?? [], missing: built?.missing ?? [], blocksGiven: !!built || !!project };
}

/** Every path Windows finds for a command, through where.exe. */
export function where(name) {
  const r = spawnSync('where.exe', [name], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean) : [];
}

// The script behind each tool's npm shim (codex.cmd, claude.cmd), run with Node directly so the message reaches it whole.
const NPM_SCRIPTS = { claude: ['@anthropic-ai', 'claude-code', 'cli.js'], codex: ['@openai', 'codex', 'bin', 'codex.js'] };

/** How to start a tool: { command, prefix } (prefix: the script, when it is an npm install run by Node). */
export function toolCommand(tool) {
  const variable = tool === 'codex' ? 'CHIEFMATE_CODEX' : 'CHIEFMATE_CLAUDE';
  if (process.env[variable]) return { command: process.env[variable], prefix: [] };
  if (tool === 'claude' && claudeExecutable() !== 'claude') return { command: claudeExecutable(), prefix: [] };
  if (process.platform !== 'win32') return { command: tool, prefix: [] };
  const found = where(tool);
  const exe = found.find(f => /\.exe$/i.test(f));
  if (exe) return { command: exe, prefix: [] };
  for (const shim of found.filter(f => /\.cmd$/i.test(f))) {
    const script = path.join(path.dirname(shim), 'node_modules', ...NPM_SCRIPTS[tool]);
    if (existsSync(script)) return { command: process.execPath, prefix: [script] };
  }
  throw new Error(t("Couldn't find {tool} on this computer. Install it, or set {variable} to its program.", { tool, variable }));
}

/**
 * The tool's arguments, the first message last. Claude Code starts without the user's own configuration, as the
 * crew's steps do (no user settings, hooks, plugins, skills, ~/.claude/CLAUDE.md or MCP servers of their own).
 * Codex has no option to skip its own configuration (~/.codex): it gets the folder (-C) and the model.
 */
export function sessionArgs(session, config, prompt) {
  const first = prompt ? [prompt] : [];
  if (session.tool === 'codex') return [...(session.model ? ['-m', session.model] : []), '-C', session.cwd, ...first];
  const settings = { claudeMdExcludes: userClaudeExcludes() };
  if (config.attribution === false) Object.assign(settings, { includeCoAuthoredBy: false, attribution: { commit: '', pr: '' } });
  // --mcp-config takes a list: the options after it end it, so the message is not read as one more file.
  return [
    '--setting-sources', 'project,local', '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: {} }),
    ...(session.model ? ['--model', session.model] : []), '--settings', JSON.stringify(settings), ...first,
  ];
}

/** What a profile would open, without opening anything: { profile, folder, prompt }. */
export function planSession(config, profileId) {
  const profile = sessionProfiles(config).find(p => p.id === profileId);
  if (!profile) throw new Error(t('Unknown session profile: {id}', { id: profileId }));
  if (!TOOLS.includes(profile.tool)) throw new Error(t('Session "{name}": "tool" must be "claude" or "codex".', { name: profile.name }));
  const folder = sessionFolder(config, profile);
  return { profile, folder, prompt: sessionPrompt(config, profile, folder) };
}

/** Whether Codex is signed in ("codex login status" succeeds). */
function codexSignedIn() {
  return new Promise(resolve => {
    let tool;
    try {
      tool = toolCommand('codex');
    } catch {
      return resolve(false);
    }
    execFile(tool.command, [...tool.prefix, 'login', 'status'], { windowsHide: true, timeout: 30_000 }, error => resolve(!error));
  });
}

/**
 * Opens a window of its own running "node src/cli.mjs <args>" in a folder: Windows Terminal when there is one, else
 * PowerShell. Returns which. The arguments are ids (letters, digits, "_", "." and "-"): they need no quoting.
 */
export function openConsole(name, cwd, args) {
  const cli = path.join(ROOT, 'src', 'cli.mjs');
  const title = `Chiefmate: ${name}`.replace(/[^\p{L}\p{N} .:_()-]/gu, '').slice(0, 60);
  const options = { cwd, detached: true, stdio: 'ignore' };
  const terminal = process.platform === 'win32' ? where('wt')[0] : null;
  if (terminal) {
    spawn(terminal, ['-w', 'new', 'new-tab', '--title', title, '-d', cwd, process.execPath, cli, ...args], options).unref();
    return 'terminal';
  }
  const quote = s => `'${String(s).replaceAll("'", "''")}'`;
  const command = `$Host.UI.RawUI.WindowTitle = ${quote(title)}; & ${quote(process.execPath)} ${quote(cli)} ${args.join(' ')}`;
  // "start" gives PowerShell a console window of its own. The line is written as cmd.exe reads it (no double quotes inside).
  spawn('cmd.exe', [`/d /c start "" powershell.exe -NoLogo -NoProfile -Command "${command}"`], { ...options, windowsHide: true, windowsVerbatimArguments: true }).unref();
  return 'powershell';
}

/** Opens the session's window. */
const openWindow = session => openConsole(session.name, session.cwd, ['session-run', session.id]);

function launch(session) {
  Object.assign(session, { status: 'starting', started: now(), window: openWindow(session) });
  return saveSession(session);
}

/**
 * Opens a session from a profile: writes its first message and record, and opens its window. When Codex is not signed
 * in, asks the owner to sign in (as a step's "needs-you" does) and opens the window once that is done.
 */
export async function openSession(profileId, { origin = 'app' } = {}) {
  const config = loadConfig();
  const { profile, folder, prompt } = planSession(config, profileId);
  // Resolved here and kept in the record: the window (Windows Terminal) doesn't get Chiefmate's environment.
  const command = toolCommand(profile.tool);
  ensureDir(SESSIONS);
  const base = `${stamp()}-${slug(profile.id)}`;
  let id = base;
  for (let n = 2; existsSync(recordFile(id)); n++) id = `${base}-${n}`;
  writeFileSync(promptFile(id), `${prompt.text}\n`);
  const session = {
    id, profile: profile.id, name: profile.name, tool: profile.tool, project: profile.project, library_folder: profile.library_folder,
    cwd: folder.dir, readOnlyCopy: folder.copy, model: profile.model, command, blocks: prompt.blocks, missing: prompt.missing, firstMessage: prompt.blocksGiven,
    origin, created: now(), status: 'starting', requests: [],
  };
  if (profile.tool === 'codex' && !(await codexSignedIn())) {
    const what = t('Sign in to Codex for the session "{name}": run "codex login" in a terminal (it opens your browser). The session opens by itself once you are signed in.', { name: profile.name });
    session.status = 'login';
    session.requests.push({ id: id.slice(-8), what, check: 'codex login status', status: 'open', at: now() });
    saveSession(session);
    notify(t('Needs you: {title}', { title: profile.name }), what, 'chiefmate:operations');
    reportEvent('needs_you', `The live session "${profile.name}" (Codex) waits for the owner to sign in to Codex ("codex login" in a terminal); it opens by itself afterwards.`);
    return session;
  }
  return launch(session);
}

/** In the session's window: starts the tool with the first message and waits for it to end. */
export async function runSession(id) {
  const session = readSession(id);
  if (!session) throw new Error(t('Session not found.'));
  const config = loadConfig();
  const tool = session.command?.command ? session.command : toolCommand(session.tool);
  let prompt = null;
  if (session.firstMessage) {
    const text = readFileSync(promptFile(id), 'utf8').trim();
    prompt = text.length <= MAX_PROMPT_ARG ? text : `Read the file ${promptFile(id)} whole and follow it: it opens this session.`;
  }
  saveSession({ ...session, status: 'open', pid: process.pid, opened: now() });
  console.log(`Chiefmate: ${session.name} (${session.tool}) in ${session.cwd}\n`);
  process.on('SIGINT', () => {}); // Ctrl+C belongs to the agent
  const child = spawn(tool.command, [...tool.prefix, ...sessionArgs(session, config, prompt)], {
    cwd: session.cwd, stdio: 'inherit', env: session.tool === 'claude' ? environment() : process.env,
  });
  const code = await new Promise(resolve => {
    child.on('error', error => {
      console.error(error.message);
      resolve(-1);
    });
    child.on('exit', c => resolve(c ?? 0));
  });
  const latest = readSession(id) ?? session;
  if (latest.status !== 'ended') saveSession({ ...latest, status: 'ended', ended: now(), exitCode: code });
  if (code !== 0) {
    // Leave the window open long enough to read what went wrong.
    console.log(`\n${session.tool} ended with code ${code}. Press Enter to close.`);
    await new Promise(resolve => process.stdin.once('data', resolve));
  }
  process.exit(0);
}

/** Ends a session: stops its window's process and everything it started. */
export async function endSession(id) {
  const session = readSession(id);
  if (!session) throw new Error(t('Session not found.'));
  if (OPEN.includes(session.status) && process.platform === 'win32') {
    const { list } = await processes(0);
    for (const p of list.filter(x => sessionIdOf(x.cmd) === id)) spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true });
    refreshProcesses();
  }
  for (const r of session.requests ?? []) if (r.status === 'open') Object.assign(r, { status: 'canceled', done: now() });
  return saveSession({ ...session, status: 'ended', ended: session.ended ?? now(), endedBy: 'owner' });
}

/** The open requests of the sessions (Codex to sign in), as the app shows the steps' ones. */
export function sessionRequests() {
  return listSessions().flatMap(s => (s.requests ?? []).filter(r => r.status === 'open').map(r => ({
    ...r, run: null, session: s.id, title: s.name, project: s.project, agent: null, runStatus: s.status,
  })));
}

/** "Done" on a session's request: the window opens now. */
export function finishSessionRequest(id, requestId, by = 'owner') {
  const session = readSession(id);
  const request = session?.requests?.find(r => r.id === requestId);
  if (!request) throw new Error(t('Request not found.'));
  if (request.status === 'open') Object.assign(request, { status: 'done', done: now(), by });
  saveSession(session);
  if (session.status === 'login') launch(session);
  return request;
}

let checking = false;
/** Every 15 seconds: the sessions waiting for Codex to be signed in open once it is. */
async function checkLogins() {
  if (checking) return;
  checking = true;
  try {
    for (const s of listSessions().filter(x => x.status === 'login')) {
      if (!(await codexSignedIn())) continue;
      const open = (s.requests ?? []).find(r => r.status === 'open');
      if (open) finishSessionRequest(s.id, open.id, 'check');
      else launch(s);
    }
  } finally {
    checking = false;
  }
}

// The sessions seen open, so the manager hears when one ends: its window closed, or the tool exited (recorded by the
// window itself, or by sessionsState once its process is gone). Not when the owner ended it from Chiefmate.
let seenOpen = null;
export function watchEnded(records = listSessions()) {
  const ended = seenOpen ? records.filter(s => seenOpen.has(s.id) && s.status === 'ended' && s.endedBy !== 'owner') : [];
  for (const s of ended) {
    const exit = s.exitCode != null && s.exitCode !== 0 ? `, the tool exited with code ${s.exitCode}` : '';
    reportEvent('session_ended', `The live session "${s.name}" (${s.tool}${s.project ? `, project ${s.project}` : ''}, session ${s.id}) ended at ${formatDateTime(s.ended ?? now())}${exit}.`);
  }
  seenOpen = new Set(records.filter(s => OPEN.includes(s.status)).map(s => s.id));
  return ended;
}

export function startSessions() {
  setInterval(() => {
    checkLogins().catch(error => console.error('Sessions:', error.message));
    try {
      watchEnded();
    } catch (error) {
      console.error('Sessions:', error.message);
    }
  }, 15_000);
  watchEnded();
}

/**
 * The sessions for the app: the profiles, and the sessions open or waiting, with their process (alive, memory, since
 * when) from the latest reading of this computer. A session whose window is gone, in a reading taken over a minute
 * after it opened, is recorded as ended.
 */
export function sessionsState(config = loadConfig(), machine = computer(config)) {
  const seen = new Map((machine.sessions ?? []).map(s => [s.id, s]));
  const records = listSessions();
  const measured = machine.measured ? Date.parse(machine.measured) : 0;
  for (const s of records) {
    if (!['starting', 'open'].includes(s.status) || seen.has(s.id) || !machine.supported || !measured) continue;
    if (measured - Date.parse(s.started ?? s.created) > 60_000) Object.assign(s, saveSession({ ...s, status: 'ended', ended: now() }));
  }
  const brief = s => {
    const p = seen.get(s.id);
    return {
      id: s.id, profile: s.profile, name: s.name, tool: s.tool, project: s.project, folder: s.library_folder, cwd: s.cwd, model: s.model,
      status: s.status, started: s.started ?? s.created, ended: s.ended ?? null, alive: !!p, pid: p?.pid ?? s.pid ?? null, ram: p?.ram ?? 0,
      blocks: s.blocks ?? [], missing: s.missing ?? [], request: (s.requests ?? []).find(r => r.status === 'open') ?? null,
    };
  };
  return {
    profiles: sessionProfiles(config).map(p => ({ id: p.id, name: p.name, tool: p.tool, project: p.project, folder: p.library_folder, blocks: p.prompt_blocks, model: p.model, auto: p.auto })),
    open: records.filter(s => OPEN.includes(s.status)).map(brief),
    recent: records.filter(s => !OPEN.includes(s.status)).slice(0, 5).map(brief),
  };
}

/** For the manager's situation: the sessions open, in one line. */
export function sessionsLine(config) {
  const { open, profiles: all } = sessionsState(config);
  const profiles = all.filter(p => !p.auto);
  const list = open.map(s => `${s.name} [${s.id}] (${s.tool}, ${s.project ? `project ${s.project}` : s.folder ? `library folder ${s.folder}` : s.cwd}, ${s.status === 'login' ? 'waiting for the owner to sign in to Codex' : `${s.alive ? 'open' : 'starting'} since ${formatDateTime(s.started)}${s.ram ? `, ${formatBytes(s.ram)}` : ''}`})`);
  const available = profiles.map(p => p.id).join(', ');
  return `Live sessions (windows where ${config.owner || 'the owner'} works with an agent; not the crew, and not yours to end unless asked): ${list.join('; ') || 'none open'}.${available ? ` Profiles: ${available} (node src/cli.mjs session <profile> opens one).` : ''} Each project also has project-<id>-claude and project-<id>-codex, opened in the owner's own clone of the project.`;
}
