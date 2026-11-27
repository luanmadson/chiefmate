// Live sessions: a conversation with an agent (Claude Code or Codex), for work done together with the owner while the
// crew works in the background. Each profile in "sessions" says which tool, where (a project, a library folder or a
// "cwd") and which blocks of the prompt builder open the conversation. Opening one puts the first message together
// (data/sessions/<id>.md) and records the session (data/sessions/<id>.json). Then, by default, the conversation goes
// on inside the app ("mode": "app"): every message of the owner is one turn of the tool run headless in the session's
// folder (claude -p, or codex exec), resuming the same session of the tool each time, with its text and actions kept
// in data/sessions/<id>.jsonl as they happen. With "window", it opens Windows Terminal (or PowerShell) in the folder,
// running "node src/cli.mjs session-run <id>", which starts the tool with that message; the app finds that window's
// processes by its command line. Ending a session stops its processes and everything under it.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, createWriteStream, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { stepMcp, userClaudeExcludes } from './access.mjs';
import { browserServers } from './browsers.mjs';
import { addRequest, chargeFolder, chargeProfile, chargeProject, chargeTurn, takeRequest } from './charge.mjs';
import { describeAction, environment, runClaude } from './claude.mjs';
import { loadConfig } from './config.mjs';
import { API, guardHooks, publishing } from './guard.mjs';
import { formatDateTime, t } from './i18n.mjs';
import { computer, formatBytes, processes, refreshProcesses } from './machine.mjs';
import { reportEvent } from './news.mjs';
import { notify } from './notify.mjs';
import { assembleBlocks, builderSettings, parseBlocks } from './prompts.mjs';
import { codexEnvironment, signedIn, spawnable, toolCommand, where } from './tools.mjs';
import { isLocked, refuseWhileLocked } from './lockdown.mjs';
import { updating } from './update.mjs';
import { stopping } from './power.mjs';
import { clip, DATA, ensureDir, languageName, now, readJson, ROOT, slug, stamp, WORKSPACES, writeJson } from './util.mjs';
import { closeWork, findWorkProfile, IDLE_MINUTES, isCommit, milestone, workContext, workSystem } from './worknow.mjs';

// No new answer or turn starts while an update is installed or Chiefmate stops for the owner (src/power.mjs).
const held = () => updating() || stopping();

export { toolCommand, where };

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
 * ("<library>/<folder>"), "prompt_blocks": ["..."], "model", "cwd", "mcp": ["..."] } }. Then the automatic ones: for
 * each project, one per tool the settings have no profile of for that project (see autoProfiles).
 */
export function sessionProfiles(config = loadConfig()) {
  const configured = Object.entries(config.sessions ?? {}).map(([id, p]) => ({
    id, name: p?.name ?? id, tool: String(p?.tool ?? 'claude').toLowerCase(), project: p?.project ?? null, library_folder: p?.library_folder ?? null,
    prompt_blocks: (Array.isArray(p?.prompt_blocks) ? p.prompt_blocks : String(p?.prompt_blocks ?? '').split(',')).map(b => String(b).trim()).filter(Boolean),
    model: p?.model ?? null, cwd: p?.cwd ?? null, mcp: Array.isArray(p?.mcp) ? p.mcp.map(String) : [], auto: false,
  }));
  return [...configured, ...autoProfiles(config, configured)];
}

/**
 * The automatic profiles, never written to the settings: "project-<id>-claude" and "project-<id>-codex", opened from
 * the project's page. They open in your own clone of the project and start with the project's block of the prompt
 * builder ("prompt_block") and the environment ("prompt_builder.environment"), when there is a copy of the builder.
 */
function autoProfiles(config, configured) {
  return Object.entries(config.projects ?? {}).flatMap(([id, p]) => TOOLS
    .filter(tool => !configured.some(x => (x.project === id && x.tool === tool) || x.id === `project-${id}-${tool}`))
    .map(tool => ({
      id: `project-${id}-${tool}`, name: `${p?.name ?? id} (${tool === 'codex' ? 'Codex' : 'Claude Code'})`, tool, project: id, library_folder: null,
      prompt_blocks: projectBlocks(config, p), model: tool === 'claude' ? config.default_model ?? null : null, cwd: null, mcp: [], auto: true,
    })));
}

/** A project's usual blocks of the prompt builder (its block and the environment), when there is a copy of the builder. */
function projectBlocks(config, project) {
  const { file, environment } = builderSettings(config);
  return file && existsSync(file) && project?.prompt_block ? [project.prompt_block, environment].filter(Boolean) : [];
}

/**
 * The external tools (MCP servers) of a session, as a step gets them: only those in "mcp_servers", released to its
 * project ("projects.<id>.mcp") or to its profile ("mcp"). session: a session's record, or a profile.
 */
export function sessionMcp(config, session) {
  const profileId = session.profile ?? session.id;
  const profile = sessionProfiles(config).find(p => p.id === profileId);
  return stepMcp(config, config.projects?.[session.project] ?? {}, { mcp: profile?.mcp ?? [] });
}

/** Whose a session's browser is (src/browsers.mjs): its project, or its own name for a folder outside the projects. */
const sessionBrowser = session => ({ project: session.project ?? null, owner: `session:${session.id}`, task: session.name, name: session.name });

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
  // The agent in charge only reads: without your clone, the crew's working copy will do.
  if (profile.charge) return { dir: chargeFolder(profile.project, projectClone(config.projects?.[profile.project])), copy: false };
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
    // The automatic blocks the project turned off ("prompt_exclude") stay out of its sessions too.
    const off = config.projects?.[profile.project]?.prompt_exclude ?? [];
    built = assembleBlocks(parseBlocks(readFileSync(file, 'utf8')), profile.prompt_blocks, { language: config.language, off });
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
  return { text: lines.join('\n'), blocks: built?.blocks ?? [], details: built?.details ?? [], missing: built?.missing ?? [], unresolved: built?.unresolved ?? [], blocksGiven: !!built || !!project };
}

/** Chiefmate's command line, with the installation's full path: it works from any folder. */
export function cliCommand() {
  const cli = path.join(ROOT, 'src', 'cli.mjs').replaceAll('\\', '/');
  return `node ${/\s/.test(cli) ? `"${cli}"` : cli}`;
}

/** What the agent's commands get: the session they come from, so a message to the manager is marked as its own. */
export const sessionEnv = id => ({ CHIEFMATE_SESSION: id });

/**
 * The manager's fixed address, for the first message of every live session: the command (with the session's id) and
 * when to use it, and the rule to report any defect of Chiefmate on its own. Nothing of it is written in the project's
 * folder: the command talks to Chiefmate on this computer, and its records stay in Chiefmate's data folder.
 */
export function managerAddress(config, id) {
  const owner = config.owner || 'the owner';
  const cli = cliCommand();
  return [
    `Chiefmate's manager (the agent that coordinates the crew and answers to ${owner}) is reached only with \`${cli} chat say --from ${id} "<message>"\` (it works from this folder): to report a problem, ask something of the crew or tell it what ${owner} asked. It never appears in Claude Code's session list (the "chiefmate-…" sessions there are short-lived turns, not the manager): don't look for it there. Your message reaches it marked as this session's, not ${owner}'s, and it is never taken as an order from ${owner}.`,
    `When you notice an error or failure of Chiefmate or of the communication between agents (a notice that never came, outdated information, a Chiefmate command that failed, a missing instruction), report it on your own at once, without waiting for ${owner} to ask: \`${cli} defect report --from ${id} "<what happened>. Expected: <what should have happened>."\` One report per defect, then go on with your work.`,
  ].join('\n');
}

/** The first message, with the manager's address at its end. */
export const withManager = (text, config, id) => `${String(text ?? '').trimEnd()}\n\n${managerAddress(config, id)}`;

/**
 * The tool's arguments, the first message last. Claude Code starts without the user's own configuration, as the
 * crew's steps do (no user settings, hooks, plugins, skills, ~/.claude/CLAUDE.md or MCP servers of their own), with
 * the external tools released to the session (see sessionMcp).
 * Codex has no option to skip its own configuration (~/.codex): it gets the folder (-C) and the model.
 */
export function sessionArgs(session, config, prompt, servers = sessionMcp(config, session).servers) {
  const first = prompt ? [prompt] : [];
  if (session.tool === 'codex') return [...(session.model ? ['-m', session.model] : []), '-C', session.cwd, ...first];
  const settings = { claudeMdExcludes: userClaudeExcludes() };
  if (config.attribution === false) Object.assign(settings, { includeCoAuthoredBy: false, attribution: { commit: '', pr: '' } });
  // --mcp-config takes a list: the options after it end it, so the message is not read as one more file.
  return [
    '--setting-sources', 'project,local', '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: servers }),
    ...(session.model ? ['--model', session.model] : []), '--settings', JSON.stringify(settings), ...first,
  ];
}

/** A profile by id: one of sessionProfiles, or a project's conversation with its agent in charge (src/charge.mjs). */
function findProfile(config, profileId) {
  const project = chargeProject(profileId);
  if (project && config.projects?.[project]) return chargeProfile(config, project);
  const work = findWorkProfile(config, profileId);
  if (work) return { ...work, prompt_blocks: projectBlocks(config, config.projects[work.project]) };
  return sessionProfiles(config).find(p => p.id === profileId);
}

/** A project's profile for a tool: its own in "sessions", else the automatic one. */
export function profileFor(config, projectId, tool) {
  if (!config.projects?.[projectId]) throw new Error(t('Unknown project: {id}', { id: projectId }));
  if (!TOOLS.includes(tool)) throw new Error(t('Choose Claude Code or Codex.'));
  const all = sessionProfiles(config);
  const profile = all.find(p => p.project === projectId && p.tool === tool && !p.auto) ?? all.find(p => p.id === `project-${projectId}-${tool}`);
  if (!profile) throw new Error(t('Unknown session profile: {id}', { id: `project-${projectId}-${tool}` }));
  return profile.id;
}

/**
 * What a profile would open, without opening anything: { profile, folder, prompt }. With "prompt" (written in the
 * app's prompt builder), that text is the first message, as it is.
 */
export function planSession(config, profileId, { prompt: written = null } = {}) {
  const profile = findProfile(config, profileId);
  if (!profile) throw new Error(t('Unknown session profile: {id}', { id: profileId }));
  if (!TOOLS.includes(profile.tool)) throw new Error(t('Session "{name}": "tool" must be "claude" or "codex".', { name: profile.name }));
  if (profile.work) throw new Error(t('"Work now" opens only from the button on the project\'s page.'));
  const folder = sessionFolder(config, profile);
  const text = String(written ?? '').trim();
  // The conversation with the agent in charge starts with the owner's first message: its role comes every turn.
  if (profile.charge) return { profile, folder, prompt: { text: `# ${profile.name}`, blocks: [], missing: [], unresolved: [], blocksGiven: false } };
  const prompt = text ? { text, blocks: [], missing: [], unresolved: [], blocksGiven: true, written: true } : sessionPrompt(config, profile, folder);
  return { profile, folder, prompt };
}

/**
 * What a "Work now" session would open (src/worknow.mjs): its profile, the folder chosen (the owner's clone or a
 * separate copy) and the first message, the project's blocks followed by its context. where: { dir, copy, crew }.
 */
export function planWork(config, profileId, where) {
  const profile = findProfile(config, profileId);
  if (!profile?.work) throw new Error(t('Unknown session profile: {id}', { id: profileId }));
  const folder = { dir: where.dir, copy: false };
  const base = sessionPrompt(config, profile, folder);
  const context = workContext(config, profile.project, profile, where, { cloneOf: projectClone, sessions: listSessions() });
  return { profile, folder, prompt: { ...base, text: `${base.text}\n\n${context}`, blocksGiven: true } };
}

/** Whether Codex is signed in ("codex login status" succeeds). */
const codexSignedIn = () => signedIn('codex');

/**
 * Opens a window of its own running "node src/cli.mjs <args>" in a folder: Windows Terminal when there is one, else
 * PowerShell. Returns which. The arguments are ids (letters, digits, "_", "." and "-"): they need no quoting.
 */
export function openConsole(name, cwd, args, onError = error => console.error(error.message)) {
  const cli = path.join(ROOT, 'src', 'cli.mjs');
  const title = `Chiefmate: ${name}`.replace(/[^\p{L}\p{N} .:_()-]/gu, '').slice(0, 60);
  const options = { cwd, detached: true, stdio: 'ignore' };
  const terminal = process.platform === 'win32' ? where('wt')[0] : null;
  if (terminal) {
    spawn(terminal, ['-w', 'new', 'new-tab', '--title', title, '-d', cwd, process.execPath, cli, ...args], options).once('error', onError).unref();
    return 'terminal';
  }
  const quote = s => `'${String(s).replaceAll("'", "''")}'`;
  const command = `$Host.UI.RawUI.WindowTitle = ${quote(title)}; & ${quote(process.execPath)} ${quote(cli)} ${args.join(' ')}`;
  // "start" gives PowerShell a console window of its own. The line is written as cmd.exe reads it (no double quotes inside).
  spawn('cmd.exe', [`/d /c start "" powershell.exe -NoLogo -NoProfile -Command "${command}"`], { ...options, windowsHide: true, windowsVerbatimArguments: true }).once('error', onError).unref();
  return 'powershell';
}

/** Opens the session's window. */
const openWindow = session => openConsole(session.name, session.cwd, ['session-run', session.id]);

function launch(session) {
  if (session.mode === 'app') {
    // In the app: the first message is the first turn; without one, the session waits for the owner's.
    Object.assign(session, { status: 'open', started: now(), queue: [
      ...(session.firstMessage ? [{ id: 'first', first: true, text: readFileSync(promptFile(session.id), 'utf8').trim(), at: now() }] : []),
      ...(session.queue ?? []),
    ] });
    saveSession(session);
    deliverSession(session.id);
    return readSession(session.id) ?? session;
  }
  Object.assign(session, { status: 'starting', started: now(), window: openWindow(session) });
  return saveSession(session);
}

/**
 * Opens a session from a profile: writes its first message and record, and starts it, in the app (the default) or,
 * with "window", in a window of its own. A profile has one session open in the app at a time: opening it again gives
 * that one ("existing"). When Codex is not signed in, asks the owner to sign in (as a step's "needs-you" does) and
 * starts the session once that is done.
 */
export async function openSession(profileId, { origin = 'app', prompt: written = null, window = false, work = null, config = loadConfig() } = {}) {
  refuseWhileLocked(t('live session'));
  // "Work now" opens only from the owner's click on the project's page (openWork in src/worknow.mjs), in the app.
  if (findProfile(config, profileId)?.work && (!work || window || written)) throw new Error(t('"Work now" opens only from the button on the project\'s page.'));
  const { profile, folder, prompt } = work ? planWork(config, profileId, work) : planSession(config, profileId, { prompt: written });
  if (profile.charge && (window || written)) throw new Error(t('The conversation with the agent in charge happens only here in the app.'));
  const mode = window ? 'window' : 'app';
  const open = mode === 'app' ? listSessions().find(s => s.profile === profile.id && s.mode === 'app' && OPEN.includes(s.status)) : null;
  if (open && written) throw new Error(t('"{name}" already has a session open in the app. Write to it, or end it before opening another one with this prompt.', { name: profile.name }));
  if (open) return { ...open, existing: true };
  // Resolved here and kept in the record: the window (Windows Terminal) doesn't get Chiefmate's environment.
  const command = toolCommand(profile.tool);
  ensureDir(SESSIONS);
  const base = `${stamp()}-${slug(profile.id)}`;
  let id = base;
  for (let n = 2; existsSync(recordFile(id)); n++) id = `${base}-${n}`;
  // The agent in charge has no command line: it reaches the manager with its requests (src/charge.mjs).
  writeFileSync(promptFile(id), `${profile.charge ? prompt.text : withManager(prompt.text, config, id)}\n`);
  const session = {
    id, profile: profile.id, name: profile.name, tool: profile.tool, project: profile.project, library_folder: profile.library_folder,
    cwd: folder.dir, readOnlyCopy: folder.copy, model: profile.model ?? (profile.tool === 'claude' ? config.default_model ?? null : null), command, blocks: prompt.written ? ['(written in the prompt builder)'] : prompt.blocks, missing: prompt.missing,
    // In a window, the first message always goes: it carries the manager's address (in the app, it goes with the owner's first message).
    firstMessage: prompt.blocksGiven || (mode === 'window' && !profile.charge),
    origin, created: now(), status: 'starting', requests: [], mode, ...(profile.charge ? { charge: true, member: profile.member } : {}),
    ...(profile.work ? { member: profile.member, memberName: profile.memberName, memberRole: profile.memberRole, work: { copy: !!work.copy, held: [], crew: (work.crew ?? []).map(c => c.run) } } : {}),
    // The tool's own session: Claude Code's is chosen here (--session-id), Codex gives its thread id on the first turn.
    ...(mode === 'app' ? { toolSession: profile.tool === 'claude' ? randomUUID() : null, turns: 0, queue: [], allowed: [] } : {}),
  };
  if (profile.tool === 'codex' && !(await codexSignedIn())) {
    const what = t('Sign in to Codex for the session "{name}": run "codex login" in a terminal (it opens your browser). The session opens by itself once you are signed in.', { name: profile.name });
    session.status = 'login';
    session.requests.push({ id: id.slice(-8), what, check: 'codex login status', status: 'open', at: now() });
    saveSession(session);
    notify(t('Needs you: {title}', { title: profile.name }), what, 'chiefmate:operations', { urgent: true });
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
  const child = spawn(tool.command, [...tool.prefix, ...sessionArgs(session, config, prompt, browserServers(config, sessionMcp(config, session).servers, sessionBrowser(session)))], {
    cwd: session.cwd, stdio: 'inherit', env: session.tool === 'claude' ? environment(sessionEnv(id)) : codexEnvironment(sessionEnv(id)),
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

/** Ends a session: stops its turn going on (in the app) or its window's process, and everything they started. */
export async function endSession(id) {
  const session = readSession(id);
  if (!session) throw new Error(t('Session not found.'));
  if (session.mode === 'app') {
    const turn = live.get(id);
    if (turn) {
      turn.ending = true;
      turn.cancel();
    }
    for (const r of session.requests ?? []) if (r.status === 'open') Object.assign(r, { status: 'canceled', done: now() });
    if (OPEN.includes(session.status)) note(id, t('You ended the session. Its history stays here; Resume carries on in the same conversation.'));
    const ended = saveSession({ ...session, status: 'ended', ended: now(), endedBy: 'owner', queue: [], working: null, paused: null });
    // "Work now": the summary for the next conversation, the manager told and the crew's paused runs back in the queue.
    if (session.work && OPEN.includes(session.status)) closeWork(id).catch(error => console.error('Work now:', error.message));
    return ended;
  }
  if (OPEN.includes(session.status) && process.platform === 'win32') {
    const { list } = await processes(0);
    for (const p of list.filter(x => sessionIdOf(x.cmd) === id)) spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true });
    refreshProcesses();
  }
  for (const r of session.requests ?? []) if (r.status === 'open') Object.assign(r, { status: 'canceled', done: now() });
  return saveSession({ ...session, status: 'ended', ended: session.ended ?? now(), endedBy: 'owner' });
}

// ---------- In the app: the conversation, turn by turn ----------

// Claude Code's tools in a session in the app: reading, editing and the terminal, with no prompt to ask first.
const APP_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Bash', 'TodoWrite', 'WebSearch', 'WebFetch', 'Agent', 'Task'];
// What leaves this computer or changes where it goes: refused until the owner allows it in the app (a permission request).
// These rules catch the commands that start with them; the guard (guard.mjs) catches the rest, however they are written
// (git -C dir push, bash -c "git push", a pull request opened through GitHub's API), and refuses them the same way.
export const ASK_FIRST = ['Bash(git push:*)', 'Bash(gh pr:*)', 'Bash(gh repo:*)', 'Bash(git remote:*)'];
// The longest a turn may work before it is stopped.
const TURN_MINUTES = 180;

export const historyFile = id => path.join(SESSIONS, `${id}.jsonl`);
const rawLog = id => path.join(SESSIONS, `${id}.raw.jsonl`);
// What the guard refused in the turn going on, one tool call a line, read when the turn ends.
const guardLog = id => path.join(SESSIONS, `${id}.guard.jsonl`);

// The turns going on: id -> { since, pid, cancel, last: { at, text }, ending }.
const live = new Map();

/** The processes of the turns going on, as [pid, session id], so the reading of this computer counts their memory. */
export const appSessionPids = () => [...live].filter(([, l]) => l.pid).map(([id, l]) => [l.pid, id]);

/** Adds an entry to a session's history: { at, kind: owner | say | action | note | permission, text, ... }. */
function remember(id, entry) {
  appendFileSync(historyFile(id), `${JSON.stringify({ at: now(), ...entry })}\n`);
}
const note = (id, text, extra = {}) => remember(id, { kind: 'note', text, ...extra });
/** Merges facts into a "Work now" session's record (src/worknow.mjs). */
export function updateWork(id, fields) {
  const session = readSession(id);
  if (session?.work) saveSession({ ...session, work: { ...session.work, ...fields } });
}

/** A note in a session's history from elsewhere in Chiefmate (the manager's answer to a request of the agent in charge). */
export function noteSession(id, text, extra = {}) {
  if (readSession(id)) note(id, text, extra);
}

/**
 * A session's history from entry "from" on (each entry with its number "n"); with no "from", the last "limit".
 * Returns { items, next } (the number to read from next time).
 */
export function sessionHistory(id, from = null, limit = 400) {
  if (!validId(id) || !existsSync(historyFile(id))) return { items: [], next: 0 };
  const lines = readFileSync(historyFile(id), 'utf8').split('\n').filter(Boolean);
  const start = from == null ? Math.max(0, lines.length - limit) : Math.min(Math.max(0, Number(from) || 0), lines.length);
  const items = [];
  for (let n = start; n < lines.length; n++) {
    try {
      items.push({ n, ...JSON.parse(lines[n]) });
    } catch {
      // a line cut by a crash: skipped
    }
  }
  return { items, next: lines.length };
}

/** What the app shows of a turn going on. */
export const turnOf = id => {
  const l = live.get(id);
  return l ? { since: l.since, last: l.last } : null;
};

function appSession(id) {
  const session = readSession(id);
  if (!session) throw new Error(t('Session not found.'));
  if (session.mode !== 'app') throw new Error(t('This session runs in a window of its own: write to it there.'));
  return session;
}

/**
 * The owner's message to a session in the app. It goes at once when the agent is free; while it works, the message
 * waits in the session's queue and goes with the others, in order, when the turn ends. A message to a session that
 * ended resumes it, in the same conversation of the tool. by: "manager" when the manager writes it at the owner's
 * request ("session say <id> ... --owner-asked"): the agent and the app see who wrote it.
 * Returns { id, text, at, queued, position }.
 */
export function sayToSession(id, text, { by = 'owner' } = {}) {
  const message = clip(String(text ?? '').trim(), 20_000);
  if (!message) throw new Error(t('Write a message.'));
  let session = appSession(id);
  if (session.status === 'ended') session = resumeSession(id);
  const item = { id: randomUUID().slice(0, 8), text: message, at: now(), ...(by === 'manager' ? { by } : {}) };
  return enqueue(session, item);
}

function enqueue(session, item) {
  const { id } = session;
  const queued = live.has(id) || session.status !== 'open' || !!session.paused || held() || isLocked() || (session.queue ?? []).length > 0;
  saveSession({ ...session, queue: [...(session.queue ?? []), item] });
  deliverSession(id);
  return { ...item, queued, position: queued ? (readSession(id)?.queue ?? []).length : 0 };
}

/** A system event goes to the project's app sessions that were open when it happened. */
export function tellProjectSessions(project, notice) {
  for (const s of listSessions()) {
    if (s.project !== project || s.mode !== 'app' || s.status !== 'open' || (s.resumed ?? s.started) > notice.at) continue;
    if ((s.queue ?? []).some(m => m.id === notice.id) || sessionHistory(s.id, null, 60).items.some(m => m.notice === notice.id)) continue;
    enqueue(s, { ...notice, by: 'system' });
  }
}

/** Takes a message out of a session's queue. Returns the queue. */
export function removeQueued(id, itemId) {
  const session = appSession(id);
  const queue = (session.queue ?? []).filter(m => m.id !== itemId);
  saveSession({ ...session, queue });
  return queue;
}

/** Stops the turn going on at once. The conversation goes on: the next message tells the agent it was interrupted. */
export function interruptSession(id) {
  const turn = live.get(id);
  if (!turn) return false;
  turn.interrupted = true;
  turn.cancel();
  return true;
}

/** Opens again a session in the app that ended: the next message carries on in the same conversation of the tool. */
export function resumeSession(id) {
  const session = appSession(id);
  if (session.status !== 'ended') return session;
  if (!session.toolSession) throw new Error(t('This session never got to start, so there is nothing to resume: open a new one.'));
  note(id, t('Session resumed. The next message carries on in the same conversation.'));
  return saveSession({ ...session, status: 'open', ended: null, endedBy: null, resumed: now() });
}

/** The owner's answer to a permission request: allowed (the agent is told to try again) or refused. */
export function answerPermission(id, requestId, allow) {
  const session = appSession(id);
  const request = (session.requests ?? []).find(r => r.id === requestId && r.kind === 'permission');
  if (!request) throw new Error(t('Request not found.'));
  if (request.status !== 'open') return request;
  Object.assign(request, { status: allow ? 'done' : 'refused', done: now(), by: 'owner' });
  if (allow) session.allowed = [...new Set([...(session.allowed ?? []), request.rule])];
  saveSession(session);
  remember(id, { kind: 'permission', request: request.id, status: request.status, text: request.what });
  if (allow) sayToSession(id, `${loadConfig().owner || 'The owner'} allowed this in the Chiefmate app: ${request.what}. You may do it now.`);
  return request;
}

/**
 * The text of a turn: the owner's message, or the queue in order, and a word when the last turn was interrupted or
 * paused for an update of Chiefmate (then, with no message, the turn only carries on).
 */
function turnText(config, session, items) {
  const owner = config.owner || 'the owner';
  const parts = [];
  if (session.interrupted) parts.push(`${owner} interrupted your previous turn at ${formatDateTime(session.interrupted)}. What you were doing then may be half done: check it before you carry on.`);
  if (session.paused) parts.push(`Chiefmate paused your previous turn at ${formatDateTime(session.paused)}, at a safe point (once the actions under way had finished), to install an update of itself, and has restarted. Carry on where you left off.`);
  const mine = items.filter(m => !m.first);
  const first = items.find(m => m.first);
  const by = m => (m.by === 'manager' ? `, written by Chiefmate's manager at ${owner}'s request` : '');
  if (first) parts.push(first.text);
  // A session opened with no first message: the manager's address goes with the owner's first one.
  else if (!session.charge && !session.firstMessage && !(session.turns ?? 0)) parts.push(managerAddress(config, session.id));
  if (mine.length === 1 && !first && !mine[0].by) parts.push(mine[0].text);
  else if (mine.some(m => m.by === 'system')) {
    for (const m of mine) parts.push(m.by === 'system'
      ? `[Chiefmate system notice, informational, ${formatDateTime(m.at)}]\n${m.text}`
      : `[Message from ${owner}, sent ${formatDateTime(m.at)}${by(m)}]\n${m.text}`);
  } else if (mine.length) parts.push(`${mine.length === 1 ? `A message from ${owner}` : `${mine.length} messages from ${owner}, oldest first`}:\n\n${mine.map(m => `[sent ${formatDateTime(m.at)}${by(m)}]\n${m.text}`).join('\n\n')}`);
  return parts.join('\n\n');
}

// Claude Code refuses --session-id for a session it already has ("Session ID ... is already in use"), and --resume
// for one it never saved ("No conversation found"): a turn cut off by a restart may leave either behind.
const SESSION_EXISTS = /session id .* is already in use/i;
const SESSION_MISSING = /no conversation found/i;

/** Claude Code's added instructions in a session in the app. */
const appSystem = owner => [
  `You are in a live session inside the Chiefmate app, with ${owner}. ${owner} reads your messages there and sees each action you take (commands, files read and edited) as it happens.`,
  `Your turn ends when you stop: end it whenever you need ${owner}, with a clear question or what they must do, and wait for the answer.`,
  `There is no prompt to ask before acting: pushing, pull requests and changing remotes are refused until ${owner} allows them in the app. When one is refused, say what you wanted to run and why, and stop.`,
].join('\n');

/**
 * Starts the next turn of a session in the app, with its whole queue, when it is open and free; a turn paused for an
 * update carries on by itself. None starts while an update of Chiefmate is being installed, nor in an emergency
 * lockdown. Returns whether one started.
 */
export function deliverSession(id) {
  if (live.has(id) || held() || isLocked()) return false;
  const session = readSession(id);
  if (!session || session.mode !== 'app' || session.status !== 'open' || (!(session.queue ?? []).length && !session.paused)) return false;
  const items = session.queue ?? [];
  const config = loadConfig();
  const turn = { since: now(), last: null, pid: null, cancel: () => {}, interrupt: () => false, started: false, interrupted: false, ending: false, pausing: false };
  live.set(id, turn);
  for (const m of items) {
    if (m.by === 'system') note(id, m.text, { by: m.by, notice: m.id, sent: m.at, error: m.error });
    else remember(id, { kind: 'owner', text: m.text, ...(m.first ? { first: true } : {}), ...(m.by ? { by: m.by } : {}), sent: m.at });
  }
  if (session.paused && !items.length) note(id, t('The agent carries on after the update of Chiefmate.'));
  const prompt = turnText(config, session, items);
  saveSession({ ...session, queue: [], working: turn.since, interrupted: null, paused: null });
  const onEvent = event => {
    if (event.type === 'start') turn.started = true;
    if (event.type === 'say' && session.charge) return chargeSays(id, session, event.text, config);
    if (event.type === 'say') remember(id, { kind: 'say', text: event.text });
    if (event.type === 'action') {
      turn.last = { at: now(), text: event.text };
      remember(id, { kind: 'action', text: event.text, ...(event.failed ? { failed: true } : {}) });
      // "Work now": a commit is a milestone the manager hears of.
      if (session.work && !event.failed && isCommit(event.text)) {
        const latest = readSession(id);
        if (latest && milestone(config, latest, `committed (${clip(event.text, 160)})`)) saveSession(latest);
      }
    }
  };
  const mcp = sessionMcp(config, session);
  rmSync(guardLog(id), { force: true });
  // The agent in charge of a project: read only, its project alone, with no external tools (src/charge.mjs).
  let charge = null;
  if (session.charge) {
    try {
      charge = chargeTurn(config, session, { cloneOf: projectClone, sessions: listSessions() });
    } catch (error) {
      charge = { error: error.message };
    }
  }
  // One call of Claude Code; when its session is not where the turn count says (see SESSION_EXISTS), once more the other way.
  const claudeTurn = (resume, retried = false) => {
    if (charge?.error) throw new Error(charge.error);
    const run = runClaude({
      dir: session.cwd, prompt: charge ? `${charge.requests}\n\n## This turn\n\n${prompt}` : prompt,
      system: charge?.system ?? [appSystem(config.owner || 'the owner'), ...(session.work ? [workSystem(config, session)] : [])].join('\n'), model: charge?.model ?? session.model ?? config.default_model,
      tools: charge ? charge.tools : [...APP_TOOLS, ...mcp.tools, ...(session.allowed ?? []).filter(r => !ASK_FIRST.includes(r))],
      disallowed: charge ? [...charge.disallowed, ...ASK_FIRST] : ASK_FIRST.filter(r => !(session.allowed ?? []).includes(r)), mcpServers: charge ? {} : browserServers(config, mcp.servers, sessionBrowser(session)),
      addDirs: charge?.addDirs ?? [], hooks: guardHooks({ log: guardLog(id), allowed: charge ? [] : session.allowed ?? [], who: 'session', noMain: !!session.work }),
      attribution: config.attribution !== false, maxMinutes: TURN_MINUTES, env: sessionEnv(id),
      session: { id: session.toolSession, resume }, log: rawLog(id), onEvent,
    });
    Object.assign(turn, { pid: run.pid ?? null, cancel: () => run.cancel(t('interrupted by you')), interrupt: () => run.interrupt() });
    return run.promise.then(r => {
      const wrong = resume ? SESSION_MISSING : SESSION_EXISTS;
      if (r.ok || retried || turn.started || turn.interrupted || turn.ending || turn.pausing || !wrong.test(r.error ?? '')) return r;
      return claudeTurn(!resume, true);
    });
  };
  let promise;
  try {
    if (session.tool === 'codex') {
      const run = runCodex({ session, prompt, log: rawLog(id), onEvent });
      Object.assign(turn, { pid: run.pid ?? null, cancel: () => run.cancel(t('interrupted by you')) });
      promise = run.promise;
    } else {
      promise = claudeTurn((session.turns ?? 0) > 0);
    }
  } catch (error) {
    promise = Promise.resolve({ ok: false, error: error.message });
  }
  promise.then(r => finishTurn(id, turn, r)).catch(error => finishTurn(id, turn, { ok: false, error: error.message }));
  return true;
}

/**
 * What the agent in charge says: its text, without the request block, and the request it sends to the manager
 * (recorded, shown in the conversation and told to the manager).
 */
function chargeSays(id, session, text, config) {
  const said = takeRequest(text);
  if (said.text) remember(id, { kind: 'say', text: said.text });
  if (said.error) note(id, t('The agent tried to send a request to the manager, but it was not understood ({error}). Ask it to send it again.', { error: said.error }), { error: true });
  if (!said.request) return;
  try {
    const r = addRequest({ ...said.request, project: session.project, session: id }, config);
    remember(id, { kind: 'request', request: r.id, status: r.status, text: t('Request #{id} sent to the manager: {plan}', { id: r.id, plan: clip(r.plan, 300) }) });
  } catch (error) {
    note(id, t('The request could not be sent to the manager: {error}', { error: error.message }), { error: true });
  }
}

/**
 * For an update of Chiefmate: asks every turn of Claude Code going on to stop at a safe point (once the actions under
 * way finish), to carry on by itself after the restart in the same session. A turn of Codex can't stop that way: the
 * update waits for it to end. Returns the ids of the sessions asked.
 */
export function pauseSessionTurns(why = 'update') {
  const asked = [];
  for (const [id, turn] of live) {
    if (turn.pausing || turn.ending || turn.interrupted || !turn.interrupt()) continue;
    turn.pausing = true;
    note(id, why === 'stop' ? t('Pausing at a safe point: Chiefmate is shutting down, and the agent carries on by itself at the next start.') : t('Pausing at a safe point for an update of Chiefmate: the agent carries on by itself after the restart.'));
    asked.push(id);
  }
  return asked;
}

/** Whether a turn of a live session is going on. */
export const sessionTurnsGoingOn = () => live.size > 0;

/** The emergency lockdown (src/lockdown.mjs): every turn going on stops at once. Returns how many. */
export const stopSessionTurns = () => [...live.keys()].filter(interruptSession).length;

/** After an update that did not go in, or after the restart: the sessions' turns and queues go on. */
export function resumeSessions() {
  for (const s of listSessions().filter(x => x.mode === 'app' && x.status === 'open')) deliverSession(s.id);
}

function finishTurn(id, turn, r) {
  live.delete(id);
  const session = readSession(id);
  if (!session) return;
  // A turn that got to start counts: the next one resumes its session (Codex's thread, or Claude Code's own id).
  const started = session.tool === 'codex' ? r.session : turn.started || r.session ? session.toolSession : null;
  Object.assign(session, { working: null, lastTurn: { at: now(), ok: !!r.ok }, ...(started ? { toolSession: started, turns: (session.turns ?? 0) + 1 } : {}) });
  if (turn.pausing && r.interrupted && !turn.ending && !turn.interrupted) {
    // Paused for an update: the next turn carries on by itself (see deliverSession), after the restart.
    session.paused = now();
  } else if (turn.interrupted && !turn.ending) {
    session.interrupted = now();
    note(id, t('You interrupted the agent. The conversation goes on: your next message tells it.'));
  } else if (!r.ok && !turn.ending && r.error) {
    note(id, t('The turn ended with an error: {error}', { error: clip(r.error, 600) }), { error: true });
  }
  // What Claude Code or the guard refused for lack of permission: one request each, for the owner to allow or refuse.
  const guarded = existsSync(guardLog(id)) ? readFileSync(guardLog(id), 'utf8').split('\n').filter(Boolean).flatMap(line => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  }) : [];
  rmSync(guardLog(id), { force: true });
  // The agent in charge has nothing to ask permission for: it only reads, and sends requests to the manager.
  const refused = [...(r.denials ?? []), ...guarded];
  if (session.charge && refused.length) note(id, t('The agent in charge tried to change something, which it never does: what is to be done goes to the manager as a request.'));
  for (const d of session.charge ? [] : refused) {
    const ask = permissionOf(d, session.cwd);
    if ((session.requests ?? []).some(x => x.kind === 'permission' && x.status === 'open' && x.rule === ask.rule)) continue;
    const request = { id: randomUUID().slice(0, 8), kind: 'permission', ...ask, status: 'open', at: now() };
    (session.requests ??= []).push(request);
    remember(id, { kind: 'permission', request: request.id, status: 'open', text: request.what });
    // "Work now": what is about to leave the computer is a milestone the manager hears of.
    if (session.work) milestone(loadConfig(), session, `the agent asks the owner's permission to: ${clip(request.explain?.summary ?? request.what, 200)}`, { kind: `ask:${request.rule}` });
    notify(t('Needs you: {title}', { title: session.name }), t('The agent asks to: {what}', { what: request.explain?.summary ?? request.what }), 'chiefmate:operations', { urgent: true });
  }
  saveSession(session);
  deliverSession(id);
}

/** A refused tool use, as a request: what it would do and the rule that allows it. */
function permissionOf(denial, dir) {
  const tool = denial?.tool_name ?? '?';
  const input = denial?.tool_input ?? {};
  if (tool === 'Bash') {
    const command = String(input.command ?? '');
    // Any part of the command may be the one refused ("cd x && git push", "git -C x push", "bash -c '...'").
    const found = publishing(command)[0];
    const rule = found?.rule ?? `Bash(${command.trim().split(/\s+/).slice(0, 2).join(' ')}:*)`;
    const where = found?.dir && dir ? path.resolve(dir, found.dir) : dir;
    return { tool, rule, what: t('Ran: {command}', { command: clip(command, 200) }), explain: { ...explainCommand(found?.part ?? command, where), command: clip(command, 2000) } };
  }
  const what = describeAction(tool, input, dir);
  return { tool, rule: tool, what, explain: { summary: what, where: dir ?? '', ...unknownEffect(), command: clip(JSON.stringify(input), 2000) } };
}

// ---------- Permission requests, in plain words ----------
// What the owner reads before allowing: what happens, where, what changes, whether it can be undone, and the risk
// (low, medium, high or unknown). The command itself stays folded under it.

const readOnly = () => ({ change: t('Nothing: it only reads.'), undo: t('There is nothing to undo.'), risk: 'low', why: t('It only reads.') });
const unknownEffect = () => ({ change: t('It depends on the command: see it below.'), undo: t('It depends on the command.'), risk: 'unknown', why: t('Allow it only if you understand the command.') });

/** A command line's words, quotes taken off. */
const words = text => (String(text).match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(w => w.replace(/^(["'])(.*)\1$/, '$2'));

/** A git answer in a folder, or '' (no folder, not a repository, no such thing). */
function gitOut(dir, ...args) {
  if (!dir || !existsSync(dir)) return '';
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  return r.status === 0 ? String(r.stdout).trim() : '';
}

/** "owner/name" for a GitHub address, the address itself otherwise. */
const repoLabel = url => /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(url ?? '')?.[1] ?? url ?? '';

/** The command refused (git push, gh pr, gh repo, git remote or any other), explained. */
function explainCommand(command, dir) {
  const [program, group, ...args] = words(command);
  const origin = () => repoLabel(gitOut(dir, 'remote', 'get-url', 'origin')) || (dir ? path.basename(dir) : '?');
  // gh's repository: -R owner/name or --repo owner/name, else this folder's own.
  const ghRepo = () => {
    const i = args.findIndex(a => a === '-R' || a === '--repo');
    return args.find(a => a.startsWith('--repo='))?.slice(7) || (i >= 0 ? args[i + 1] : '') || origin();
  };
  const plain = args.filter(a => !a.startsWith('-'));
  if (program === 'git' && group === 'push') return explainPush(args, dir);
  if (publishing(command)[0]?.rule === API) {
    // A change on GitHub through its API: the address says where; a POST to ".../pulls" opens a pull request.
    const address = words(command).find(a => /^(https:\/\/api\.github\.com)?\/?(repos|user|orgs|gists|graphql)\b/i.test(a)) ?? '';
    const repo = /repos\/([^/\s]+\/[^/\s?]+)/.exec(address)?.[1] ?? origin();
    const opening = /repos\/[^/]+\/[^/]+\/pulls\/?$/.test(address) && !/\b(PATCH|PUT|DELETE)\b/i.test(command);
    return opening
      ? { summary: t("Open a pull request on {repo} through GitHub's API", { repo }), where: repo, change: t('A proposal of change appears there, with a title and a description, and whoever follows the repository is notified.'), undo: t('Partly: it can be closed, but it stays visible.'), risk: 'low', why: t('Nothing goes into the code until someone merges it.') }
      : { summary: t('Change something on GitHub through its API ({address})', { address: address || '?' }), where: repo, ...unknownEffect() };
  }
  if (program === 'gh' && group === 'pr') {
    const [action = 'status', ...rest] = plain;
    // The number, given alone (12, #12) or in its address (…/pull/12), wherever it comes among the options.
    const number = rest.find(a => /^#?\d+$/.test(a))?.replace('#', '') ?? rest.map(a => /\/pull\/(\d+)/.exec(a)?.[1]).find(Boolean);
    const repo = ghRepo();
    const pr = number ? t('pull request #{number}', { number }) : t('the pull request of this branch');
    const notCode = t('Nothing in the code changes.');
    const of = {
      create: () => ({ summary: t('Open a pull request on {repo}', { repo }), change: t('A proposal of change appears there, with a title and a description, and whoever follows the repository is notified.'), undo: t('Partly: it can be closed, but it stays visible.'), risk: 'low', why: t('Nothing goes into the code until someone merges it.') }),
      merge: () => ({ summary: t('Merge {pr} into the code of {repo}', { pr, repo }), change: t('Its changes go into the target branch (usually the main one).'), undo: t('Hard: only with a new change that reverts it.'), risk: 'high', why: t('It changes the code others use; whatever updates itself from it gets it straight away.') }),
      close: () => ({ summary: t('Close {pr} on {repo}, without merging', { pr, repo }), change: t('The proposal stops; its changes do not go into the code.'), undo: t('Yes: it can be reopened.'), risk: 'low', why: notCode }),
      reopen: () => ({ summary: t('Reopen {pr} on {repo}', { pr, repo }), change: t('The proposal is open for review again.'), undo: t('Yes: it can be closed again.'), risk: 'low', why: notCode }),
      comment: () => ({ summary: t('Publish a comment on {pr} on {repo}', { pr, repo }), change: t('The text appears there and notifies the people in the pull request.'), undo: t('Partly: it can be deleted, but the notifications have already gone.'), risk: 'medium', why: t('Others read it straight away.') }),
      review: () => ({ ...of.comment(), summary: t('Publish a review of {pr} on {repo}', { pr, repo }) }),
      edit: () => ({ summary: t('Change the details of {pr} on {repo} (title, description, labels)', { pr, repo }), change: t('Only the pull request changes; the code stays as it is.'), undo: t('Yes: it can be changed back.'), risk: 'low', why: notCode }),
      ready: () => ({ ...of.edit(), summary: t('Mark {pr} on {repo} as ready for review', { pr, repo }) }),
      checkout: () => ({ summary: t('Bring the code of {pr} to this folder', { pr }), change: t('This folder switches to the pull request branch; nothing changes online.'), undo: t('Yes: switching back to the previous branch.'), risk: 'low', why: t('Only this computer changes.') }),
    };
    if (['view', 'list', 'status', 'diff', 'checks'].includes(action)) return { summary: t('Only look at pull requests on {repo}', { repo }), where: repo, ...readOnly() };
    return { where: repo, ...(of[action]?.() ?? { summary: t('Act on pull requests on {repo} ({action})', { repo, action }), ...unknownEffect() }) };
  }
  if (program === 'gh' && group === 'repo') {
    const [action = 'view', name] = plain;
    const repo = name && !['view', 'list'].includes(action) ? name : ghRepo();
    if (['view', 'list'].includes(action)) return { summary: t('Only look at repositories on GitHub'), where: repo, ...readOnly() };
    if (action === 'create') {
      const created = name || (dir ? path.basename(dir) : '?');
      const visible = args.includes('--public') ? 'public' : args.some(a => a === '--private' || a === '--internal') ? 'private' : '';
      const sent = args.includes('--push') ? ` ${t('The code of this folder goes to it.')}` : '';
      return {
        summary: visible === 'public' ? t('Create the public repository {name} on GitHub', { name: created }) : t('Create the repository {name} on GitHub', { name: created }),
        where: t('Your GitHub account'),
        change: (visible === 'public' ? t('A new repository appears on your account, visible to anyone on the internet.') : t('A new repository appears on your account.')) + sent,
        undo: t('Yes: the repository can be deleted afterwards.'),
        ...(visible === 'public' ? { risk: 'high', why: t('Whatever goes to it becomes public.') }
          : visible ? { risk: 'low', why: t('Only whoever you choose sees it.') }
          : { risk: 'medium', why: t('The command does not say whether it is public or private.') }),
      };
    }
    const settings = { change: t('The repository changes for everyone who uses it.'), undo: t('Yes: the settings can be changed back.'), risk: 'medium', why: t('Others may notice the change (address, access).') };
    const of = {
      delete: () => ({ summary: t('Delete the repository {repo} from GitHub', { repo }), change: t('The repository disappears, with its issues and pull requests.'), undo: t('No: a deleted repository does not come back from here.'), risk: 'high', why: t('Everything that exists only there is lost.') }),
      fork: () => ({ summary: t('Copy {repo} to your account', { repo }), change: t('A copy appears on your account; the original does not change.'), undo: t('Yes: the copy can be deleted.'), risk: 'low', why: t('The original stays as it is.') }),
      clone: () => ({ summary: t('Download a copy of {repo} to this computer', { repo }), change: t('A new folder appears on this computer; nothing changes online.'), undo: t('Yes: deleting the folder.'), risk: 'low', why: t('Only this computer changes.') }),
      edit: () => ({ summary: t('Change the settings of {repo} on GitHub', { repo }), ...settings, ...(args.some(a => a.startsWith('--visibility')) ? { risk: 'high', why: t('It can make the repository public or private.') } : {}) }),
      rename: () => ({ summary: t('Rename {repo} on GitHub', { repo }), ...settings }),
      archive: () => ({ summary: t('Archive {repo} on GitHub (read-only from then on)', { repo }), ...settings }),
    };
    return { where: repo, ...(of[action]?.() ?? { summary: t('Act on repositories on GitHub ({action})', { action }), ...unknownEffect() }) };
  }
  if (program === 'git' && group === 'remote') {
    const [action, name = 'origin', url] = plain;
    const where = dir ?? '';
    if (!action || ['show', 'get-url'].includes(action)) return { summary: t('Only look at where this folder sends its code'), where, ...readOnly() };
    const old = gitOut(dir, 'remote', 'get-url', name) || '?';
    const local = { risk: 'low', why: t('Nothing leaves this computer now.') };
    const of = {
      add: () => ({ summary: t('Add {url} as a place where this folder can send its code ({name})', { url: url ?? '?', name }), change: t('Nothing is sent now; later sends may go there.'), undo: t('Yes: removing it again.'), ...local }),
      'set-url': () => ({ summary: t('Change where this folder sends its code ({name}): {url}', { name, url: url ?? '?' }), change: t('The next sends go to {url} instead of {old}.', { url: url ?? '?', old }), undo: t('Yes: setting the previous address back ({old}).', { old }), risk: 'medium', why: t('Code may end up in the wrong place if the address is not the one you expect.') }),
      remove: () => ({ summary: t('Remove {name} from the places this folder sends its code', { name }), change: t('This folder forgets the address {old}; nothing changes online.', { old }), undo: t('Yes: adding it again.'), ...local }),
      rename: () => ({ summary: t('Rename the destination {name} to {new}', { name, new: url ?? '?' }), change: t('Only the name changes; the address stays.'), undo: t('Yes: renaming it back.'), ...local }),
    };
    of.rm = of.remove;
    return { where, ...(of[action]?.() ?? { summary: t('Change where this folder sends its code ({action})', { action }), ...unknownEffect() }) };
  }
  return { summary: t('Run a command the agent may not run on its own'), where: dir ?? '', ...unknownEffect() };
}

/** git push: which branch goes where, how many commits, and whether it forces, deletes or reaches the main branch. */
function explainPush(args, dir) {
  const [remote = 'origin', spec = ''] = args.filter(a => !a.startsWith('-'));
  const current = gitOut(dir, 'rev-parse', '--abbrev-ref', 'HEAD');
  const repo = repoLabel(gitOut(dir, 'remote', 'get-url', remote)) || remote;
  const every = args.some(a => a === '--all' || a === '--mirror');
  const deleting = args.some(a => a === '--delete' || a === '-d') || spec.startsWith(':');
  const forcing = args.some(a => /^(-f|--force|--force-with-lease(=.*)?|--force-if-includes|--mirror)$/.test(a)) || spec.startsWith('+');
  const [source, target] = spec.replace(/^[+:]/, '').split(':');
  let branch = (target ?? source ?? '').replace(/^refs\/heads\//, '');
  if (!branch || branch === 'HEAD') branch = current || '?';
  const where = `${repo} · ${every ? t('every branch') : t('branch {branch}', { branch })}`;
  if (deleting) return { summary: t('Delete branch {branch} from {repo}', { branch, repo }), where, change: t('The branch disappears from the repository online; the copy on this computer, if there is one, stays.'), undo: t('Yes, while the branch is on this computer: sending it again brings it back.'), risk: 'medium', why: t('Whoever was using that branch loses it.') };
  const known = !every && gitOut(dir, 'rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${branch}`);
  const count = known ? gitOut(dir, 'rev-list', '--count', `${remote}/${branch}..${source && source !== 'HEAD' ? source : 'HEAD'}`) : '';
  const main = /^(main|master)$/.test(branch);
  const change = [
    every ? t('The commits saved only on this computer go there, visible to whoever has access to the repository.')
      : !known && current ? t('Branch {branch} does not exist there yet: it is created with all its commits, visible to whoever has access to the repository.', { branch })
      : Number(count) > 0 ? t('The commits saved only on this computer ({count}) go there, visible to whoever has access to the repository.', { count })
      : t('The commits saved only on this computer go there, visible to whoever has access to the repository.'),
    main ? t('It is the main branch: the change takes effect straight away, without a pull request.') : '',
    forcing ? t('It is a forced send: the branch history there is replaced, and commits that exist only there are lost.') : '',
  ].filter(Boolean).join(' ');
  return {
    summary: every ? t('Send every branch to {repo}', { repo }) : t('Send the commits of branch {branch} to {repo}', { branch, repo }),
    where, change,
    undo: forcing ? t('No: what is replaced may not come back.') : t('Partly: a new commit can undo the changes, but what was sent stays in the history.'),
    ...(forcing ? { risk: 'high', why: t('Work that exists only in the repository online can be lost.') }
      : main ? { risk: 'high', why: t('It changes the main branch, which others, and whatever updates itself from it, use straight away.') }
      : { risk: 'medium', why: t('The code becomes visible to others (to everyone, if the repository is public): check that nothing private goes with it.') }),
  };
}

// ---------- Codex, headless ----------

/**
 * Codex's arguments for a turn in the app: "codex exec" the first time, "codex exec resume <thread>" after, with the
 * events as JSON lines and the message through standard input. It may edit the session's folder and run commands
 * there (workspace-write), never asking (there is no one to ask): what its sandbox refuses comes back as a failed action.
 */
export function codexArgs(session) {
  const common = ['--json', '--skip-git-repo-check', '-c', 'sandbox_mode="workspace-write"', '-c', 'approval_policy="never"', ...(session.model ? ['-m', session.model] : [])];
  return session.toolSession && (session.turns ?? 0) > 0 ? ['exec', 'resume', ...common, session.toolSession, '-'] : ['exec', ...common, '-C', session.cwd, '-'];
}

/** A shell command as Codex reports it, without the shell around it ("pwsh.exe -Command '...'"). */
const bareCommand = command => String(command ?? '')
  .replace(/^"?[^"\s]*?(pwsh|powershell|cmd|bash|sh)(\.exe)?"?\s+(-NoProfile\s+|-NoLogo\s+)*(-Command|-lc|-c|\/d \/c|\/c)\s+/i, '')
  .replace(/^(["'])([\s\S]*)\1$/, '$2');

/** One Codex event as what the app shows: { type: 'say' | 'action', text, failed }, or null. */
export function codexItem(event, dir) {
  const item = event?.item ?? {};
  const done = event?.type === 'item.completed';
  const file = p => (p ? path.relative(dir, p) || p : '');
  switch (item.type) {
    case 'agent_message':
      return done && String(item.text ?? '').trim() ? { type: 'say', text: item.text } : null;
    case 'command_execution':
      if (!done) return { type: 'action', text: t('Ran: {command}', { command: clip(bareCommand(item.command), 140) }) };
      return item.status === 'failed' || (item.exit_code != null && item.exit_code !== 0)
        ? { type: 'action', failed: true, text: t('Failed: {command} ({output})', { command: clip(bareCommand(item.command), 100), output: clip(String(item.aggregated_output ?? '').trim() || `exit ${item.exit_code}`, 160) }) }
        : null;
    case 'file_change':
      if (!done) return null;
      return { type: 'action', text: (item.changes ?? []).map(c => (c.kind === 'add' ? t('Wrote {file}', { file: file(c.path) }) : c.kind === 'delete' ? t('Deleted {file}', { file: file(c.path) }) : t('Edited {file}', { file: file(c.path) }))).join('; ') || t('Edited files') };
    case 'web_search':
      return done ? null : { type: 'action', text: t('Searched the web: {query}', { query: clip(item.query, 120) }) };
    case 'mcp_tool_call':
      return done ? null : { type: 'action', text: t('Used {tool}', { tool: [item.server, item.tool].filter(Boolean).join('.') }) };
    case 'todo_list':
      return done ? null : { type: 'action', text: t('Updated the to-do list') };
    case 'error':
      return { type: 'action', failed: true, text: clip(item.message, 300) };
    default:
      return null;
  }
}

/** One turn of Codex, headless. Returns { promise, cancel, pid }, as runClaude does; the result has "session" (the thread). */
function runCodex({ session, prompt, log, onEvent }) {
  const tool = spawnable('codex');
  // Without Windows' app aliases on the PATH, which Codex's sandbox can't start (see codexEnvironment).
  const child = spawn(tool.command, [...tool.prefix, ...codexArgs(session)], { cwd: session.cwd, env: codexEnvironment(sessionEnv(session.id)), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const out = createWriteStream(log, { flags: 'a' });
  let thread = null;
  let failure = null;
  let finished = false;
  let canceled = null;
  let stderr = '';
  const timer = setTimeout(() => cancel(t('went over the time limit ({minutes} min)', { minutes: TURN_MINUTES })), TURN_MINUTES * 60_000);
  function cancel(reason = t('canceled')) {
    canceled = reason;
    if (!child.pid || child.exitCode !== null) return;
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    else child.kill('SIGTERM');
  }
  child.stdin.on('error', () => {});
  child.stdin.end(prompt);
  child.stderr.on('data', d => (stderr = (stderr + d).slice(-4000)));
  createInterface({ input: child.stdout }).on('line', line => {
    out.write(`${line}\n`);
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (event.type === 'thread.started') thread = event.thread_id;
    else if (event.type === 'turn.completed') finished = true;
    else if (event.type === 'turn.failed') failure = event.error?.message ?? 'turn failed';
    else if (event.type === 'error') failure = event.message ?? 'error';
    else {
      const item = codexItem(event, session.cwd);
      if (item) onEvent(item);
    }
  });
  const promise = new Promise(resolve => {
    child.on('error', error => {
      clearTimeout(timer);
      resolve({ ok: false, error: t("Couldn't start {tool}: {error}", { tool: 'Codex', error: error.message }) });
    });
    child.on('close', code => {
      clearTimeout(timer);
      out.end();
      const ok = finished && !failure && !canceled;
      const error = canceled ?? failure ?? (ok ? null : t('{tool} ended without finishing its turn (exit code {code}). {output}', { tool: 'Codex', code, output: clip(stderr.trim(), 600) }));
      resolve({ ok, canceled: !!canceled, error, session: thread ?? session.toolSession ?? null });
    });
  });
  return { promise, cancel, pid: child.pid };
}

/** The open requests of the sessions (Codex to sign in, a permission to give), as the app shows the steps' ones. */
export function sessionRequests() {
  return listSessions().flatMap(s => (s.requests ?? []).filter(r => r.status === 'open').map(r => ({
    ...r, run: null, session: s.id, title: s.name, project: s.project, agent: null, runStatus: s.status,
  })));
}

/** "Done" on a session's request: the session starts now (Codex signed in), or the permission asked is given. */
export function finishSessionRequest(id, requestId, by = 'owner') {
  const session = readSession(id);
  const request = session?.requests?.find(r => r.id === requestId);
  if (!request) throw new Error(t('Request not found.'));
  if (request.kind === 'permission') return answerPermission(id, requestId, true);
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
  // A turn cut off by a restart (Chiefmate stopped or crashed; an update pauses the turns first): the session stays
  // open, and the agent is told.
  for (const s of listSessions().filter(x => x.mode === 'app' && x.working)) {
    note(s.id, t('Chiefmate restarted while the agent was working: that turn was cut off. Your next message tells it.'));
    saveSession({ ...s, working: null, interrupted: s.working });
  }
  // The turns paused for an update carry on, and the messages left in the queues go.
  resumeSessions();
  setInterval(() => {
    checkLogins().catch(error => console.error('Sessions:', error.message));
    try {
      watchEnded();
      checkIdleWork();
    } catch (error) {
      console.error('Sessions:', error.message);
    }
  }, 15_000);
  watchEnded();
}

/**
 * The "Work now" sessions quiet for IDLE_MINUTES (no turn going on, nothing new since the last summary): their summary
 * is written for the next conversation and the manager told; they stay open. Returns the ids.
 */
export function checkIdleWork(at = Date.now(), close = closeWork) {
  const idle = listSessions().filter(s => {
    if (!s.work || s.mode !== 'app' || s.status !== 'open' || live.has(s.id) || !s.turns || !s.lastTurn?.at) return false;
    return at - Date.parse(s.lastTurn.at) >= IDLE_MINUTES * 60_000 && !(s.work.summarized && s.work.summarized >= s.lastTurn.at);
  });
  for (const s of idle) close(s.id, { ended: false }).catch(error => console.error('Work now:', error.message));
  return idle.map(s => s.id);
}

/**
 * Where a session in the app stands, for the app and the manager: "working" (a turn going on), "paused" (its turn
 * paused for an update of Chiefmate, to carry on by itself), "permission" (it asks the owner to allow something),
 * "login" (Codex to sign in), "waiting" (the owner's turn) or "ended".
 */
function appPhase(s) {
  if (s.status === 'ended') return 'ended';
  if (s.status === 'login') return 'login';
  if (live.get(s.id)?.pausing || s.paused) return 'paused';
  if (live.has(s.id)) return 'working';
  if ((s.requests ?? []).some(r => r.status === 'open' && r.kind === 'permission')) return 'permission';
  return 'waiting';
}

// The last thing said in each session, read again only when its history grows (the app asks every few seconds).
const saidCache = new Map();
/** The last thing the agent said in a session, for the summaries. */
function lastSaid(id) {
  const size = existsSync(historyFile(id)) ? statSync(historyFile(id)).size : 0;
  const cached = saidCache.get(id);
  if (cached?.size === size) return cached.said;
  const { items } = sessionHistory(id, null, 60);
  const said = [...items].reverse().find(e => e.kind === 'say')?.text ?? cached?.said ?? '';
  saidCache.set(id, { size, said });
  return said;
}

/**
 * The sessions for the app: the profiles, and the sessions open or waiting, with their process (alive, memory, since
 * when) from the latest reading of this computer. A session in a window whose process is gone, in a reading taken
 * over a minute after it opened, is recorded as ended. A session in the app has a process only while a turn goes on.
 */
export function sessionsState(config = loadConfig(), machine = computer(config)) {
  const seen = new Map((machine.sessions ?? []).map(s => [s.id, s]));
  const records = listSessions();
  const measured = machine.measured ? Date.parse(machine.measured) : 0;
  for (const s of records) {
    if (s.mode === 'app' || !['starting', 'open'].includes(s.status) || seen.has(s.id) || !machine.supported || !measured) continue;
    if (measured - Date.parse(s.started ?? s.created) > 60_000) Object.assign(s, saveSession({ ...s, status: 'ended', ended: now() }));
  }
  const brief = s => {
    const p = seen.get(s.id);
    const app = s.mode === 'app';
    return {
      id: s.id, profile: s.profile, name: s.name, tool: s.tool, project: s.project, folder: s.library_folder, cwd: s.cwd, model: s.model, charge: !!s.charge,
      ...(s.work ? { work: true, memberName: s.memberName ?? null, copy: !!s.work.copy, held: s.work.held ?? [], heldTitles: (s.work.held ?? []).map(run => s.work.titles?.[run] ?? run) } : {}),
      mode: app ? 'app' : 'window', status: s.status, started: s.started ?? s.created, ended: s.ended ?? null,
      alive: app ? live.has(s.id) : !!p, pid: p?.pid ?? (app ? live.get(s.id)?.pid : s.pid) ?? null, ram: p?.ram ?? 0,
      blocks: s.blocks ?? [], missing: s.missing ?? [], request: (s.requests ?? []).find(r => r.status === 'open') ?? null,
      ...(app ? {
        phase: appPhase(s), turn: turnOf(s.id), queued: (s.queue ?? []).length, turns: s.turns ?? 0, lastTurn: s.lastTurn ?? null,
        said: clip(lastSaid(s.id), 240), resumable: s.status === 'ended' && !!s.toolSession,
      } : {}),
    };
  };
  return {
    profiles: sessionProfiles(config).map(p => ({ id: p.id, name: p.name, tool: p.tool, project: p.project, folder: p.library_folder, blocks: p.prompt_blocks, model: p.model, auto: p.auto })),
    open: records.filter(s => OPEN.includes(s.status)).map(brief),
    recent: records.filter(s => !OPEN.includes(s.status)).slice(0, 8).map(brief),
  };
}

/**
 * One session for its conversation in the app: { session (as sessionsState gives it), queue, requests (open),
 * history: { items, next } from entry "from" on }.
 */
export function sessionView(id, from = null, config = loadConfig()) {
  const record = readSession(id);
  if (!record) throw new Error(t('Session not found.'));
  const all = sessionsState(config);
  const session = [...all.open, ...all.recent].find(s => s.id === id)
    ?? { id, name: record.name, tool: record.tool, project: record.project, folder: record.library_folder, charge: !!record.charge, mode: record.mode ?? 'window', status: record.status, started: record.started ?? record.created, ended: record.ended ?? null, phase: record.status === 'ended' ? 'ended' : 'waiting', resumable: record.mode === 'app' && record.status === 'ended' && !!record.toolSession, turns: record.turns ?? 0 };
  return {
    session: { ...session, cwd: record.cwd, model: record.model, blocks: record.blocks ?? [] },
    queue: record.queue ?? [],
    requests: (record.requests ?? []).filter(r => r.status === 'open'),
    history: sessionHistory(id, from),
  };
}

/** One session, in one line, for the manager. */
function sessionLine(s) {
  const where = s.project ? `project ${s.project}` : s.folder ? `library folder ${s.folder}` : s.cwd;
  const head = `- ${s.name} [${s.id}] (${s.tool === 'codex' ? 'Codex' : 'Claude Code'}, ${s.mode === 'app' ? 'in the app' : 'in a window'}, ${where})`;
  if (s.status === 'login') return `${head}: waiting for the owner to sign in to Codex.`;
  if (s.mode !== 'app') return `${head}: ${s.alive ? 'open' : 'starting'} since ${formatDateTime(s.started)}${s.ram ? `, ${formatBytes(s.ram)}` : ''}.`;
  const phase = {
    working: `the agent is working (turn since ${formatDateTime(s.turn?.since)}${s.turn?.last ? `, last action: ${clip(s.turn.last.text, 100)}` : ''})`,
    paused: 'its turn is paused for an update of Chiefmate and carries on by itself after the restart',
    permission: `asks the owner to allow: ${clip(s.request?.what, 120)}`,
    waiting: "the owner's turn (the agent waits for a message)",
  }[s.phase] ?? s.phase;
  const said = s.said ? ` Last said: "${clip(s.said.replace(/\s+/g, ' '), 160)}"` : '';
  return `${head}: ${phase}; open since ${formatDateTime(s.started)}, ${s.turns} turn(s)${s.queued ? `, ${s.queued} message(s) in its queue` : ''}${s.ram ? `, ${formatBytes(s.ram)}` : ''}.${said}`;
}

/** For the manager's situation: each session open, in one line. */
export function sessionsLine(config, machine = computer(config)) {
  const { open, profiles: all } = sessionsState(config, machine);
  const profiles = all.filter(p => !p.auto);
  const available = profiles.map(p => p.id).join(', ');
  const owner = config.owner || 'the owner';
  return [
    `Live sessions (${owner} working with an agent, in the app or in a window; not the crew, and not yours to end or write to unless ${owner} asks): ${open.length ? '' : 'none open.'}`,
    ...open.map(sessionLine),
    `Read a session's history with node src/cli.mjs session log <id>; when ${owner} asks you to write to a session in the app, node src/cli.mjs session say <id> "<message>" --owner-asked.${available ? ` Profiles: ${available} (node src/cli.mjs session <profile> opens one).` : ''} Each project also has project-<id>-claude and project-<id>-codex, opened in ${owner}'s own clone of the project.`,
  ].join('\n');
}
