// Runs Claude Code headless (claude -p) and follows what it does, step by step.
import { execFile, spawn, spawnSync } from 'node:child_process';
import { closeSync, createWriteStream, existsSync, fstatSync, openSync, readSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { userClaudeExcludes } from './access.mjs';
import { formatDateTime, t } from './i18n.mjs';
import { recordUsage } from './store.mjs';
import { clip, now } from './util.mjs';

/** The Claude Code executable: CHIEFMATE_CLAUDE, the one from the official installer, or whatever is on the PATH. */
export function executable() {
  if (process.env.CHIEFMATE_CLAUDE) return process.env.CHIEFMATE_CLAUDE;
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  const installed = path.join(home, '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
  return existsSync(installed) ? installed : 'claude';
}

/**
 * The agent's environment: this computer's, minus the variables of any Claude session that started Chiefmate
 * (with them, Claude Code thinks it is running inside another session).
 */
export function environment(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^CLAUDE/i.test(key)) delete env[key];
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  return { ...env, ...extra };
}

/**
 * How to start Claude Code: its executable and the arguments that come first. A CHIEFMATE_CLAUDE ending in .mjs or .js
 * is a stand-in script run with this Node.js (the smoke test uses one, so nothing real starts).
 */
function command() {
  const file = executable();
  return /\.(m?js)$/i.test(file) ? [process.execPath, [file]] : [file, []];
}

/** Whether Claude Code is installed, and which version. Checked when Chiefmate starts and every 10 minutes. */
export const claudeInfo = { found: null, version: null, checked: null };

export function checkClaude() {
  execFile(executable(), ['--version'], { timeout: 30_000, windowsHide: true, env: environment() }, (error, stdout) => {
    Object.assign(claudeInfo, {
      found: !error,
      version: error ? null : String(stdout).trim().split(/\s+/)[0] || null,
      checked: now(),
    });
  });
}

// ---------- Claude Code's sign-in on this computer ----------

const DAY = 86400_000;
// Claude Code itself says a sign-in ends between 3 days before the expiry it reports and that expiry. The owner is
// warned 3 days before that earliest end, and strongly from the day before it.
export const LOGIN_EARLY = 3 * DAY;
export const LOGIN_WARN = 3 * DAY;
export const LOGIN_URGENT = DAY;
export const LOGIN_RENEW = 'claude auth login';

/** When the sign-in expires, as Claude Code itself reports it. Checked when Chiefmate starts and once a day. */
export const loginInfo = { expires: null, checked: null, error: null };

/**
 * The expiry in the output of `claude auth status --json`, and nothing else: the account's details (e-mail,
 * organization, plan) are never kept. An expiry missing or unreadable is null.
 */
export function parseLoginStatus(text) {
  let status;
  try {
    status = JSON.parse(String(text ?? ''));
  } catch {
    return null;
  }
  const at = Date.parse(status?.loginExpiresAt ?? '');
  return Number.isNaN(at) ? null : new Date(at).toISOString();
}

/**
 * Whether to ask Claude Code again: never asked or the last read failed, a day since, or hourly within the warning
 * (a renewal shows soon). Five minutes of slack: the hourly timer may tick just before a full hour since the last read.
 */
export function loginDue(info = loginInfo, at = Date.now()) {
  if (!info.checked || info.error) return true;
  const since = at - Date.parse(info.checked) + 5 * 60_000;
  return since >= DAY || (!!loginWarning(info, at) && since >= DAY / 24);
}

/**
 * The sign-in's facts after a read. The command ends with an error when signed out, with its JSON still on stdout.
 * A read that fails or finds no sign-in keeps the last expiry known, so the warning stays until a new sign-in shows its own.
 */
export function loginRead(info, error, stdout, at = now()) {
  const expires = parseLoginStatus(stdout);
  return { expires: expires ?? (error ? info.expires : null), checked: at, error: expires || !error ? null : error.message };
}

/** Asks Claude Code when its sign-in expires (`claude auth status --json`; it reads only, nothing changes). */
export function checkLogin({ force = false } = {}) {
  if (!force && !loginDue()) return;
  const [file, first] = command();
  execFile(file, [...first, 'auth', 'status', '--json'], { timeout: 30_000, windowsHide: true, env: environment() }, (error, stdout) => {
    Object.assign(loginInfo, loginRead(loginInfo, error, stdout));
  });
}

/** The earliest end of a sign-in, LOGIN_EARLY before the expiry Claude Code reports. */
export const loginFrom = expires => new Date(Date.parse(expires) - LOGIN_EARLY).toISOString();

/**
 * The warning the sign-in calls for now: null until 3 days before its earliest end (or with no expiry known);
 * else { expires, left (ms to the expiry), step: "3d" | "1d" (from the day before the earliest end) | "expired" }.
 */
export function loginWarning(info = loginInfo, at = Date.now()) {
  if (!info?.expires) return null;
  const left = Date.parse(info.expires) - at;
  if (left - LOGIN_EARLY > LOGIN_WARN) return null;
  return { expires: info.expires, left, step: left <= 0 ? 'expired' : left - LOGIN_EARLY <= LOGIN_URGENT ? '1d' : '3d' };
}

/** One line for the manager's situation while the warning lasts, else null. */
export function loginLine(owner = 'the owner', info = loginInfo, at = Date.now()) {
  const w = loginWarning(info, at);
  if (!w) return null;
  const when = w.step === 'expired' ? `expired ${formatDateTime(w.expires)}` : `may end from ${formatDateTime(loginFrom(w.expires))} on, by ${formatDateTime(w.expires)} at the latest`;
  return `Claude Code's sign-in on this computer ${when}: without it the crew and you stop. Only ${owner} can renew it, by running "${LOGIN_RENEW}" in a terminal; remind them${w.step === '3d' ? '' : ' now'}.`;
}

/** The file a file tool writes (Write, Edit, MultiEdit, NotebookEdit), or null. */
export const writtenFile = (name, input = {}) => (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(name) ? input?.file_path ?? input?.notebook_path ?? null : null);

/** The whole command a shell tool runs (Bash, PowerShell), or null: the logbook's line keeps only its start. */
export const shellCommand = (name, input = {}) => (/^(Bash|PowerShell)$/.test(name) && input?.command ? String(input.command) : null);

/** One line saying what the agent did, for the logbook. */
export function describeAction(name, input = {}, dir) {
  const file = p => (p ? path.relative(dir, p) || p : '');
  switch (name) {
    case 'Bash':
      return t('Ran: {command}', { command: clip(input.command, 140) });
    case 'Read':
      return t('Read {file}', { file: file(input.file_path) });
    case 'Edit':
    case 'MultiEdit':
      return t('Edited {file}', { file: file(input.file_path) });
    case 'Write':
      return t('Wrote {file}', { file: file(input.file_path) });
    case 'Delete':
      return t('Deleted {file}', { file: file(input.file_path) });
    case 'Glob':
      return t('Looked for files: {pattern}', { pattern: clip(input.pattern, 80) });
    case 'Grep':
      return t('Searched the text: {pattern}', { pattern: clip(input.pattern, 80) });
    case 'WebSearch':
      return t('Searched the web: {query}', { query: clip(input.query, 120) });
    case 'WebFetch':
      return t('Opened {url}', { url: clip(input.url, 120) });
    case 'Agent':
    case 'Task':
      return t('Started a subagent: {task}', { task: clip(input.description ?? input.prompt, 100) });
    case 'TodoWrite':
      return t('Updated the to-do list');
    default:
      return t('Used {tool}', { tool: name });
  }
}

const CODE_FILE = /\.(m?[jt]sx?|c[jt]s|py|rb|go|rs|java|kt|cs|php|swift|c|cc|cpp|h|css|scss|html?|vue|svelte|sh|ps1|vbs|sql)$/i;
const TEST_COMMAND = /\b(test|tests|smoke|check|lint|pytest|jest|vitest|mocha|tsc|eslint|phpunit)\b/i;

/** What the agent is doing now, in plain words and one short line, for the owner (Operations, focus, the manager); null: no change. */
export function describeDoing(name, input = {}, dir) {
  const file = input.file_path ? path.basename(input.file_path) : '';
  const kind = f => (CODE_FILE.test(f) ? 'code' : /\.(md|txt|rst|adoc)$/i.test(f) ? 'docs' : 'file');
  switch (name) {
    case 'Bash': {
      const command = String(input.command ?? '').trim();
      if (/needs-you/.test(command)) return t('waiting for you');
      // A line for its speech bubble (cli.mjs say) leaves what it was doing as it was.
      if (/cli\.mjs"?\s+say\s/.test(command)) return null;
      if (/^git\s+commit\b/.test(command)) return t('saving the work (commit)');
      if (/^git\s+(diff|log|status|show)\b/.test(command)) return t('reviewing the changes');
      if (/^git\b/.test(command)) return t('working with git');
      if (/\b(npm|pnpm|yarn)\s+(install|ci|add)\b|\bpip\s+install\b/.test(command)) return t('installing dependencies');
      if (TEST_COMMAND.test(command)) return t('running the tests');
      if (/\bbuild\b/.test(command)) return t('building the project');
      if (/^gh\b/.test(command)) return t('looking at GitHub');
      if (/^(ls|dir|tree|find|Get-ChildItem)\b/i.test(command)) return t('looking at the files');
      if (/^(cat|head|tail|type|less|grep|rg|sed -n|Get-Content|Select-String)\b/i.test(command)) return t('reading files');
      return t('running a command');
    }
    case 'Read':
      return { code: t('reading the code ({file})', { file }), docs: t('reading the documentation ({file})', { file }), file: t('reading {file}', { file }) }[kind(file)];
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
    case 'Delete':
      return t('changing {file}', { file: file || path.basename(input.notebook_path ?? '') });
    case 'Write':
      return t('writing {file}', { file });
    case 'Glob':
    case 'Grep':
      return t('searching the project');
    case 'WebSearch':
      return t('searching the web');
    case 'WebFetch':
      return t('reading a web page');
    case 'Agent':
    case 'Task':
      return t('working with a helper agent');
    case 'TodoWrite':
      return t('planning the next steps');
    default:
      return t('using {tool}', { tool: String(name).replace(/^mcp__/, '').replace(/__/g, ': ') });
  }
}

// The context window of each model, as Claude Code reports it at the end of every call ("contextWindow").
// Until a model has been seen: 1 million tokens for the "[1m]" variants, 200,000 for the others.
const windows = {};
export const contextWindow = model => windows[model] ?? (/\[1m\]/i.test(model ?? '') ? 1_000_000 : 200_000);

/** The context a turn filled: the input it read, fresh or from the cache. */
const contextOf = usage => (usage?.input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0);

/** Ends the process and everything it started (on Windows, the whole tree). */
function stop(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  else child.kill('SIGTERM');
}

/** The command line of a step (see runClaude below). */
export function claudeArgs({ model, effort, tools = [], disallowed = [], addDirs = [], mcpServers = {}, attribution = true, systemFile, session, noTools = false, hooks = null }) {
  const args = [
    '-p', '--output-format', 'stream-json', '--verbose', '--model', model, '--permission-mode', 'dontAsk',
    '--setting-sources', 'project,local', '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers }),
  ];
  if (effort) args.push('--effort', String(effort));
  const settings = { claudeMdExcludes: userClaudeExcludes() };
  if (!attribution) Object.assign(settings, { includeCoAuthoredBy: false, attribution: { commit: '', pr: '' } });
  if (hooks) settings.hooks = hooks;
  args.push('--settings', JSON.stringify(settings));
  if (systemFile) args.push('--append-system-prompt-file', systemFile);
  if (session?.resume) args.push('--resume', session.id);
  else if (session?.id) args.push('--session-id', session.id);
  else args.push('--no-session-persistence');
  for (const extra of addDirs) args.push('--add-dir', extra);
  // The lists go last: each one runs until the next "--", and the prompt goes through standard input.
  if (disallowed.length) args.push('--disallowedTools', ...disallowed);
  if (tools.length) args.push('--allowedTools', ...tools);
  // No tool at all (a short call that only writes text, such as a run's title and summary).
  if (noTools) args.push('--tools', '');
  return args;
}

/**
 * Runs one step. Returns { promise, cancel }. The time limit is the only cap: there is no spending cap.
 * options: dir, prompt, system (the agent's instructions), model, effort, tools, disallowed, addDirs (more folders
 * the agent may read), mcpServers (the external tools from Chiefmate's settings, by name), hooks (Chiefmate's own, such
 * as the guard of a live session: see guard.mjs), env (more environment
 * variables), attribution (false: commits and pull requests don't credit Claude), maxMinutes, isHeld() (true while
 * the agent waits for the owner: that time doesn't count against maxMinutes), session ({ id, resume }),
 * log (a .jsonl file), onEvent(event).
 *
 * Nothing of the user's own Claude Code configuration reaches the agent, by the owner's decision and with no option to
 * turn it on: no user settings, hooks, plugins or skills (--setting-sources project,local), no ~/.claude/CLAUDE.md or
 * rules (claudeMdExcludes), and no MCP server other than those given here (--strict-mcp-config).
 * spentMs: the time the step already worked before this call (a step resumed for the owner's message keeps its clock).
 * Returns { promise, cancel, interrupt, pid, args }. interrupt() stops the agent at a safe point, as soon as the
 * actions under way finish (at most 2 minutes later), so the same session can be resumed with --resume: the result
 * then has "interrupted" and no error.
 * "start" carries what Claude Code loaded ({ init: tools, mcp_servers, skills, plugins, ... }). Besides "start", "say", "action" and "usage", onEvent gets "context" ({ used, window }: the tokens the last turn
 * filled) and "compact" (Claude Code compacted the conversation: { trigger, before }).
 */
export function runClaude(options) {
  const {
    dir, prompt, system, model, env = {}, maxMinutes = 60, isHeld = () => false, log, onEvent = () => {}, spentMs = 0,
  } = options;
  let systemFile = null;
  if (system) {
    systemFile = `${log}.instructions.md`;
    writeFileSync(systemFile, system);
  }
  const args = claudeArgs({ ...options, systemFile });

  const [file, before] = command();
  const child = spawn(file, [...before, ...args], { cwd: dir, env: environment(env), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const logStream = log ? createWriteStream(log, { flags: 'a' }) : null;
  let cancelReason = null;
  let final = null;
  let stderr = '';
  let mainModel = model;
  const context = { used: 0, window: contextWindow(model), compactions: 0 };

  // The time limit counts only the time the agent works: while it waits for the owner, the clock stops.
  let spent = spentMs;
  let last = Date.now();
  const timer = setInterval(() => {
    const at = Date.now();
    if (!isHeld()) spent += at - last;
    last = at;
    if (spent >= maxMinutes * 60_000) cancel(t('went over the time limit ({minutes} min)', { minutes: maxMinutes }));
  }, 5000);
  function cancel(reason = t('canceled')) {
    cancelReason = reason;
    stop(child);
  }

  // The actions under way (tool calls without their result yet): an interruption waits for them, so no command or
  // edit is cut in the middle and the session resumes cleanly.
  const inFlight = new Set();
  let interrupting = null;
  function interrupt() {
    if (cancelReason || interrupting || child.exitCode !== null) return false;
    interrupting = setTimeout(() => stop(child), 120_000);
    if (!inFlight.size) stop(child);
    return true;
  }

  child.stdin.end(prompt);
  child.stderr.on('data', d => (stderr = (stderr + d).slice(-4000)));
  createInterface({ input: child.stdout }).on('line', line => {
    logStream?.write(`${line}\n`);
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (event.type === 'system' && event.subtype === 'init') {
      if (event.model) [mainModel, context.window] = [event.model, contextWindow(event.model)];
      const { tools: loaded, mcp_servers, skills, plugins, agents, memory_paths, additional_directories } = event;
      onEvent({ type: 'start', model: event.model, session: event.session_id, init: { tools: loaded, mcp_servers, skills, plugins, agents, memory_paths, additional_directories } });
    } else if (event.type === 'system' && event.subtype === 'compact_boundary') {
      context.compactions++;
      onEvent({ type: 'compact', trigger: event.compact_metadata?.trigger ?? 'auto', before: event.compact_metadata?.pre_tokens ?? null });
    } else if (event.type === 'assistant') {
      for (const block of event.message?.content ?? []) {
        if (block.type === 'text' && block.text.trim()) onEvent({ type: 'say', text: block.text });
        if (block.type === 'tool_use') {
          inFlight.add(block.id);
          onEvent({
            type: 'action', tool: block.name, text: describeAction(block.name, block.input, dir), doing: describeDoing(block.name, block.input, dir), file: writtenFile(block.name, block.input),
            command: shellCommand(block.name, block.input),
          });
        }
      }
      // A subagent's turns fill its own context, not this one.
      const used = event.parent_tool_use_id ? 0 : contextOf(event.message?.usage);
      if (used && used !== context.used) {
        context.used = used;
        onEvent({ type: 'context', used, window: context.window });
      }
    } else if (event.type === 'user') {
      for (const block of event.message?.content ?? []) if (block?.type === 'tool_result') inFlight.delete(block.tool_use_id);
      if (interrupting && !inFlight.size) stop(child);
    } else if (event.type === 'rate_limit_event') {
      recordUsage(event.rate_limit_info);
      onEvent({ type: 'usage', info: event.rate_limit_info });
    } else if (event.type === 'result') {
      final = event;
      const models = event.modelUsage ?? {};
      const reported = models[mainModel]?.contextWindow ?? Math.max(0, ...Object.values(models).map(m => m?.contextWindow || 0));
      if (reported > 0) context.window = windows[mainModel] = reported;
    }
  });

  const promise = new Promise(resolve => {
    child.on('error', error => {
      clearInterval(timer);
      clearTimeout(interrupting);
      resolve({ ok: false, error: t("Couldn't start Claude Code: {error}", { error: error.message }) });
    });
    child.on('close', code => {
      clearInterval(timer);
      clearTimeout(interrupting);
      logStream?.end();
      const interrupted = !!interrupting && !cancelReason;
      const usage = final?.usage ?? {};
      const result = {
        ok: !!final && !final.is_error && !cancelReason && !interrupted,
        canceled: !!cancelReason,
        interrupted,
        spentMs: spent + (isHeld() ? 0 : Date.now() - last),
        text: typeof final?.result === 'string' ? final.result : '',
        turns: final?.num_turns ?? 0,
        durationMs: final?.duration_ms ?? 0,
        session: final?.session_id,
        tokens: {
          input: usage.input_tokens ?? 0,
          output: usage.output_tokens ?? 0,
          cacheRead: usage.cache_read_input_tokens ?? 0,
          cacheWrite: usage.cache_creation_input_tokens ?? 0,
        },
        context: { ...context },
        subagents: final?.subagent_stats?.spawned ?? 0,
        end: final?.subtype ?? null,
        // The tool uses refused for lack of permission: { tool_name, tool_use_id, tool_input }.
        denials: Array.isArray(final?.permission_denials) ? final.permission_denials : [],
      };
      if (cancelReason) result.error = cancelReason;
      else if (interrupted) result.error = null;
      else if (!final) result.error = t('Claude Code ended without a result (exit code {code}). {output}', { code, output: clip(stderr, 600) });
      else if (final.is_error) result.error = t('Ended with an error ({kind}). {output}', { kind: final.subtype ?? '?', output: clip(final.result ?? '', 600) });
      resolve(result);
    });
  });

  return { promise, cancel, interrupt, pid: child.pid, args };
}

/**
 * What an agent did, read from its step's log (the .jsonl Claude Code writes, as runClaude saves it), from a byte
 * offset on: only whole lines. Returns { items, next } (the offset to read from next time). Each item:
 * { type: 'action', tool, text } or { type: 'say', text }. With no offset and a long log, only its end is read.
 */
export function readFeed(file, dir, from = null, tail = 1_000_000) {
  if (!existsSync(file)) return { items: [], next: 0 };
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = from == null ? Math.max(0, size - tail) : Math.min(Math.max(0, Number(from) || 0), size);
    const length = Math.min(size - start, 4_000_000);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, start);
    const end = buffer.lastIndexOf(10) + 1; // only whole lines: the last one may still be being written
    let first = 0;
    if (from == null && start > 0) first = buffer.indexOf(10) + 1; // started in the middle of a line
    const items = [];
    for (const line of buffer.subarray(first, end).toString('utf8').split('\n')) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type === 'chiefmate_action' && typeof event.text === 'string') {
        items.push({ type: 'action', text: event.text });
        continue;
      }
      if (event.type !== 'assistant' || event.parent_tool_use_id) continue;
      for (const block of event.message?.content ?? []) {
        if (block.type === 'text' && block.text.trim()) items.push({ type: 'say', text: clip(block.text, 4000) });
        if (block.type === 'tool_use') items.push({ type: 'action', tool: block.name, text: describeAction(block.name, block.input, dir) });
      }
    }
    return { items, next: start + end };
  } finally {
    closeSync(fd);
  }
}
