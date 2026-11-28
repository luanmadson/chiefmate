// The tools a crew member's steps may run on: Claude Code (src/claude.mjs, the default), the Codex CLI and the Grok
// CLI, each headless, in the run's working copy, with the same rules: the agent's and the project's instructions, the
// time limit, the step's log, the refusal of anything that publishes and the final report. The tool is the member's
// ("tool" in its settings) or the one chosen for a task (--tool). The manager, the team leads, the final review and the
// projects marked "sensitive" always run on Claude Code.
import { execFile, spawn, spawnSync } from 'node:child_process';
import { appendFileSync, createWriteStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { describeAction, describeDoing, environment, executable as claudeExecutable, writtenFile } from './claude.mjs';
import { t } from './i18n.mjs';
import { clip, DATA, ensureDir, now, ROOT } from './util.mjs';

export const TOOLS = ['claude', 'codex', 'grok'];
export const TOOL_NAMES = { claude: 'Claude Code', codex: 'Codex', grok: 'Grok' };

// ---------- Which tool a member uses ----------

/** A day as "YYYY-MM-DD", in this computer's time zone. */
export const localDay = (date = new Date()) => {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** The last day a tool may be chosen ("tools.<tool>.available_until": "YYYY-MM-DD"), or null when it has none. */
export function toolUntil(config, tool) {
  const until = config?.tools?.[tool]?.available_until;
  return typeof until === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(until) ? until : null;
}

/**
 * Whether a tool may be chosen on that day: Claude Code always; Codex and Grok unless "tools.<tool>.enabled" is false
 * or their "available_until" day has passed.
 */
export function toolAvailable(config, tool, date = new Date()) {
  if (tool === 'claude') return true;
  if (!TOOLS.includes(tool) || config?.tools?.[tool]?.enabled === false) return false;
  const until = toolUntil(config, tool);
  return !until || localDay(date) <= until;
}

/** The tools that may be chosen on that day. */
export const availableTools = (config, date = new Date()) => TOOLS.filter(x => toolAvailable(config, x, date));

/**
 * The tool a member's steps run on: { tool, asked, until, reason }. asked: its "tool" setting (claude by default);
 * reason, when the tool is not the one asked: "lead" (the manager and the team leads stay on Claude Code), "unknown"
 * (not a tool Chiefmate knows), "off" or "expired" (its "available_until" day passed: back to Claude Code by itself).
 */
export function agentTool(config, agent, date = new Date()) {
  const asked = String(agent?.tool ?? 'claude').toLowerCase();
  const until = toolUntil(config, asked);
  const back = reason => ({ tool: 'claude', asked, until, reason });
  if (asked === 'claude') return { tool: 'claude', asked, until: null, reason: null };
  if (agent?.id === 'manager' || agent?.lead) return back('lead');
  if (!TOOLS.includes(asked)) return back('unknown');
  if (config?.tools?.[asked]?.enabled === false) return back('off');
  if (!toolAvailable(config, asked, date)) return back('expired');
  return { tool: asked, asked, until, reason: null };
}

/** A tool given for a task (--tool): claude, codex or grok; empty: none (null). Anything else is refused. */
export function parseTool(value) {
  const tool = String(value ?? '').trim().toLowerCase();
  if (!tool) return null;
  if (!TOOLS.includes(tool)) throw new Error(t('Unknown tool "{tool}". Use: {list}.', { tool, list: TOOLS.join(', ') }));
  return tool;
}

/**
 * The tool a step runs on: { tool, asked, until, reason, task }. The final review always on Claude Code; a project
 * marked "sensitive" always on Claude Code (reason "sensitive"); else the tool chosen for the task (task: true), if
 * any, else the member's own (agentTool).
 */
export function chooseTool(config, agent, { finalReview = false, asked = null, project = null, date = new Date() } = {}) {
  if (finalReview) return { tool: 'claude', asked: 'claude', until: null, reason: null, task: false };
  const task = !!asked;
  const choice = agentTool(config, task ? { ...agent, tool: asked } : agent, date);
  if (project?.sensitive === true && choice.tool !== 'claude') return { tool: 'claude', asked: choice.asked, until: null, reason: 'sensitive', task };
  return { ...choice, task };
}

/** The model for a tool: the member's own, unless it names a Claude model and the tool is another (its default then). */
export const toolModel = (tool, model) => (tool !== 'claude' && /^(claude|opus|sonnet|haiku|fable)\b/i.test(String(model ?? '')) ? null : model || null);

/**
 * The tools other than Claude Code a run's crew steps ran on, or were chosen to run on while still to come (--tool, a
 * mission step's "tool"), for the app. The manager and the team lead are always on Claude Code.
 */
export function runTools(run) {
  const found = new Set();
  const crew = (run.steps ?? []).filter(s => s.agent !== 'manager' && s.agent !== 'lead');
  for (const s of crew) {
    const tool = s.tool ?? (s.status === 'pending' ? s.toolAsked ?? run.tool : null);
    if (tool && tool !== 'claude') found.add(tool);
  }
  // A request not planned yet: its tasks will take the run's tool.
  if (run.kind === 'ask' && !run.lead?.plan && run.tool && run.tool !== 'claude') found.add(run.tool);
  return [...found];
}

// ---------- How each step did, by tool and by agent: data/manager/tools-quality.jsonl ----------

export const QUALITY_FILE = () => path.join(DATA, 'manager', 'tools-quality.jsonl');

/** The one line the final review wrote on what it had to fix ("Corrections: ..."), or null. */
export function correctionLine(report) {
  const m = String(report ?? '').match(/^[\s>*_-]*Corrections?\**:\**\s*(.+)$/im);
  return m ? clip(m[1].replace(/[*_`]+/g, '').trim(), 300) : null;
}

const NONE = /^(none|nothing|no|nenhum|nenhuma|nada|n[aã]o)\b/i;

/**
 * What the "Corrections:" line says of each member it names ("writer: two claims without a source; curator: none"):
 * Map of member id to what was fixed ('' for none). Empty when it names no member: then it is about the whole work.
 * members: the run's crew, { id: name }.
 */
export function namedCorrections(said, members = {}) {
  const found = new Map();
  const ids = Object.fromEntries(Object.entries(members).flatMap(([id, name]) => [[id.toLowerCase(), id], ...(name ? [[String(name).toLowerCase(), id]] : [])]));
  for (const part of String(said ?? '').split(/;\s*/)) {
    const m = part.match(/^\s*([^:]{1,40}?)\s*:\s*(.*)$/);
    const id = m && ids[m[1].replace(/[`"']/g, '').trim().toLowerCase()];
    if (id) found.set(id, NONE.test(m[2].trim()) || !m[2].trim() ? '' : clip(m[2].trim(), 200));
  }
  return found;
}

/**
 * The records of a run that ended, one per crew step due (stepDue: never the manager's nor the team lead's; in a
 * failed run, only the step that failed): the tool, the kind of task, how long it took, whether the checks passed
 * (null: none ran) and whether the final review had to correct the step's work (null: no review), with one line on what. The review's "Corrections:"
 * line decides, for each member it names; else its commits or a line about the whole work count for every step.
 * reviewCommits: the subjects of the commits the final review made. who: the agent behind a member id (src/agents.mjs,
 * agentKey); names: { member id: name }, to read the line; only: which of the steps that ran (the ones not recorded
 * yet). Each record has v: 2 (every crew step of its run is recorded).
 */
export function stepRecords(run, reviewCommits = [], { who = () => null, names = {}, only = () => true } = {}) {
  const ran = (run.steps ?? []).filter(s => stepDue(run, s) && only(s));
  if (!ran.length) return [];
  const at = now();
  const checks = run.checks?.length ? run.checks.every(c => c.ok) : null;
  const review = run.review && ['done', 'failed'].includes(run.review.status) ? run.review : null;
  const said = review ? correctionLine(review.report) : null;
  const saidNone = !said || NONE.test(said);
  // Every member of the run may be named, the ones recorded before too: a line that names any member is read by member.
  const crew = (run.steps ?? []).filter(s => s.agent !== 'manager' && s.agent !== 'lead');
  const named = said && !saidNone ? namedCorrections(said, Object.fromEntries(crew.map(s => [s.agent, names[s.agent] ?? null]))) : new Map();
  const whole = { corrected: review ? reviewCommits.length > 0 || !saidNone : null, note: !review ? '' : said && !saidNone ? said : reviewCommits.length ? clip(reviewCommits.join('; '), 200) : '' };
  const verdict = s => (!review || !named.size ? whole : named.has(s.agent) ? { corrected: !!named.get(s.agent), note: named.get(s.agent) } : { corrected: false, note: '' });
  return ran.map(s => ({
    v: 2, at, ended: s.ended ?? null, run: run.id, project: run.project, tool: s.tool ?? 'claude', agent: s.agent, who: who(s.agent) ?? null,
    kind: run.kind, mission: run.mission ?? null, task: clip(run.title, 100), chosen: (s.toolAsked ?? run.tool) ? 'task' : 'member', status: s.status,
    durationMs: s.durationMs ?? null, checks, run_status: run.status, ...verdict(s),
  }));
}

/**
 * Whether a step of a run that ended is recorded now: a crew step (never the manager's nor the team lead's) that
 * failed, or that was done in a run done. In a failed run the steps done wait for its end after a retry or resume,
 * with its checks and review: a failure after them (another member's step, the review, the delivery) is not theirs.
 */
export const stepDue = (run, s) => s.agent !== 'manager' && s.agent !== 'lead' && (s.status === 'failed' || (s.status === 'done' && run.status === 'done'));

/** The records of a run's steps that ran on Codex or Grok (how each tool does: node src/cli.mjs tools). */
export const qualityRecords = (run, reviewCommits = [], options = {}) => stepRecords(run, reviewCommits, options).filter(r => r.tool !== 'claude');

/** Appends the records (src/runs.mjs calls it once per run, when it ends). */
export function recordQuality(records) {
  if (!records.length) return;
  const file = QUALITY_FILE();
  ensureDir(path.dirname(file));
  appendFileSync(file, records.map(r => `${JSON.stringify(r)}\n`).join(''));
}

// Read again only when the file changes: the app's state reads it every few seconds (the agents' records). Not to be changed.
let qualityRead = { key: null, list: [] };

export function readQuality() {
  try {
    const file = QUALITY_FILE();
    const { size, mtimeMs } = statSync(file);
    const key = `${file}|${size}|${mtimeMs}`;
    if (qualityRead.key !== key) {
      const list = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      }).filter(Boolean);
      qualityRead = { key, list };
    }
    return qualityRead.list;
  } catch {
    return [];
  }
}

/** Whether a record's step was approved with no correction: done, no check failed, the run done and the review fixed nothing. */
export const cleanRecord = r => r.status === 'done' && r.checks !== false && r.run_status === 'done' && r.corrected !== true;

/** Records summed up: how many, approved with no correction, corrected by the review, failed, and a step's mean time. */
export function sumRecords(list) {
  const timed = list.filter(r => Number(r.durationMs) > 0);
  return {
    count: list.length, clean: list.filter(cleanRecord).length, corrected: list.filter(r => r.corrected === true).length,
    failed: list.filter(r => r.status === 'failed' || r.run_status === 'failed').length,
    meanMs: timed.length ? Math.round(timed.reduce((n, r) => n + r.durationMs, 0) / timed.length) : null,
  };
}

/**
 * The records summed up by tool, and by tool and kind of task: how many, how many approved with no correction (the
 * step done, no check failed, the run done and the review fixed nothing), and the mean time of a step.
 */
export function qualitySummary(records = readQuality()) {
  const sum = sumRecords;
  return TOOLS.filter(x => x !== 'claude').map(tool => {
    const mine = records.filter(r => r.tool === tool);
    const kinds = [...new Set(mine.map(r => r.mission ? `mission ${r.mission}` : r.kind))];
    return { tool, ...sum(mine), kinds: kinds.map(kind => ({ kind, ...sum(mine.filter(r => (r.mission ? `mission ${r.mission}` : r.kind) === kind)) })), last: mine.at(-1)?.at ?? null };
  });
}

// ---------- Finding and starting the programs ----------

/** Every path Windows finds for a command, through where.exe. */
export function where(name) {
  const r = spawnSync('where.exe', [name], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean) : [];
}

// The script behind each tool's npm shim (codex.cmd, claude.cmd), run with Node directly so the message reaches it whole.
const NPM_SCRIPTS = { claude: ['@anthropic-ai', 'claude-code', 'cli.js'], codex: ['@openai', 'codex', 'bin', 'codex.js'] };
const VARIABLES = { claude: 'CHIEFMATE_CLAUDE', codex: 'CHIEFMATE_CODEX', grok: 'CHIEFMATE_GROK' };

/** Grok's home folder (GROK_HOME, else ~/.grok): its installer puts the program in bin/, its sign-in in auth.json. */
const grokHome = () => process.env.GROK_HOME || path.join(os.homedir(), '.grok');

/** How to start a tool: { command, prefix } (prefix: the script, when it is an npm install run by Node). */
export function toolCommand(tool) {
  const variable = VARIABLES[tool] ?? 'CHIEFMATE_CLAUDE';
  if (process.env[variable]) return { command: process.env[variable], prefix: [] };
  if (tool === 'claude' && claudeExecutable() !== 'claude') return { command: claudeExecutable(), prefix: [] };
  if (tool === 'grok') {
    const installed = path.join(grokHome(), 'bin', process.platform === 'win32' ? 'grok.exe' : 'grok');
    if (existsSync(installed)) return { command: installed, prefix: [] };
  }
  if (process.platform !== 'win32') return { command: tool, prefix: [] };
  const found = where(tool);
  const exe = found.find(f => /\.exe$/i.test(f));
  if (exe) return { command: exe, prefix: [] };
  for (const shim of found.filter(f => /\.cmd$/i.test(f))) {
    const script = path.join(path.dirname(shim), 'node_modules', ...(NPM_SCRIPTS[tool] ?? []));
    if (NPM_SCRIPTS[tool] && existsSync(script)) return { command: process.execPath, prefix: [script] };
  }
  throw new Error(t("Couldn't find {tool} on this computer. Install it, or set {variable} to its program.", { tool, variable }));
}

/** How to run a tool from here: an npm script or a stand-in .mjs (tests) goes through this Node.js. */
export function spawnable(tool) {
  const { command, prefix } = toolCommand(tool);
  return /\.m?js$/i.test(command) ? { command: process.execPath, prefix: [command, ...prefix] } : { command, prefix };
}

/**
 * Codex's environment: this computer's, without the folders of Windows' app aliases (…\Microsoft\WindowsApps) on the
 * PATH. Codex's sandbox runs each command with a restricted token, which may not start an app alias: with PowerShell 7
 * installed from the Store, its pwsh.exe there failed every command with "CreateProcessAsUserW failed: 5 (Access is
 * denied)". Without that folder, Codex uses Windows PowerShell (System32), which the sandbox starts.
 */
export function codexEnvironment(extra = {}) {
  const env = environment(extra);
  if (process.platform !== 'win32') return env;
  for (const key of Object.keys(env).filter(k => k.toLowerCase() === 'path')) {
    env[key] = String(env[key]).split(';').filter(p => p && !/[\\/]Microsoft[\\/]WindowsApps[\\/]?$/i.test(p)).join(';');
  }
  return env;
}

/**
 * Whether a tool is signed in: Claude Code is assumed (its own checks tell); Codex when "codex login status" succeeds;
 * Grok when it keeps a sign-in (auth.json in its home folder) or XAI_API_KEY is set.
 */
export function signedIn(tool) {
  if (tool === 'grok') return Promise.resolve(!!process.env.XAI_API_KEY || existsSync(path.join(grokHome(), 'auth.json')) || !!process.env.CHIEFMATE_GROK);
  if (tool !== 'codex') return Promise.resolve(true);
  return new Promise(resolve => {
    let program;
    try {
      program = spawnable('codex');
    } catch {
      return resolve(false);
    }
    execFile(program.command, [...program.prefix, 'login', 'status'], { windowsHide: true, timeout: 30_000, env: codexEnvironment() }, error => resolve(!error));
  });
}

/** What the owner runs to sign a tool in, in a terminal. */
export const LOGIN_COMMAND = { codex: 'codex login', grok: 'grok login' };

// ---------- The guard, for each tool ----------

const GUARD = path.join(ROOT, 'src', 'guard.mjs');
const psQuote = s => `'${String(s).replace(/'/g, "''")}'`;
const shQuote = s => `'${String(s).replace(/'/g, "'\\''")}'`;

/**
 * Codex runs Chiefmate's guard (src/guard.mjs) before each shell command, as Claude Code does: a PreToolUse hook
 * given on the command line (-c), with the same input and answer. Codex runs a hook's command through PowerShell on
 * Windows (sh elsewhere), so the words go in single quotes. Returns the value of "-c".
 */
export function codexGuard(log) {
  const words = [process.execPath, GUARD, '--log', log];
  const command = process.platform === 'win32' ? `& ${words.map(psQuote).join(' ')}` : words.map(shQuote).join(' ');
  return `hooks.PreToolUse=[{matcher="Bash",hooks=[{type="command",command=${JSON.stringify(command)},timeout=30}]}]`;
}

/**
 * Grok takes no hook from the command line, so its steps get deny rules instead (--deny), checked by Grok on every
 * part of a command (split at &&, ;, |), inside "bash -c" and on the whole line. They are wider than the guard on
 * purpose: they refuse every git push and change of remotes, any gh pr, gh repo, gh api, gh gist, gh release, gh workflow or gh secret, and any web request to
 * GitHub's API, however written; a refusal comes back to the agent as a failed action.
 */
export const GROK_DENY = [
  'Bash(*git *push*)', 'Bash(*send-pack*)', 'Bash(*git *remote*)', 'Bash(*gh *pr*)', 'Bash(*gh *repo*)', 'Bash(*gh *api*)',
  'Bash(*gh *gist*)', 'Bash(*gh *release*)', 'Bash(*gh *workflow*)', 'Bash(*gh *secret*)', 'Bash(*api.github.com*)', 'Bash(*uploads.github.com*)',
];

// What Grok would otherwise read of the owner's own Claude Code and Cursor configuration: hooks, MCP servers, skills,
// rules and instructions. A step gets none of it, as on Claude Code (the project's own CLAUDE.md still applies).
const GROK_NO_COMPAT = Object.fromEntries(['CLAUDE', 'CURSOR'].flatMap(v => ['HOOKS', 'MCPS', 'SKILLS', 'RULES', 'AGENTS'].map(k => [`GROK_${v}_${k}_ENABLED`, '0'])));

// ---------- The command lines ----------

const CODEX_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'];
const GROK_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
/** The effort a step's tool is given: the member's level, or null when that tool doesn't take it (its own default). */
export function toolEffort(tool, effort) {
  const known = { codex: CODEX_EFFORTS, grok: GROK_EFFORTS }[tool];
  return (known ? known.includes(effort) : !!effort) ? effort : null;
}

/**
 * Codex's arguments for a step: "codex exec" the first time, "codex exec resume <thread>" to go on, the events as JSON
 * lines and the prompt through standard input. Without the owner's own configuration (--ignore-user-config; the sign-in
 * stays), in its workspace-write sandbox (it writes only the working copy, keeps .git read-only and has no network),
 * never asking (no one is there to answer), with Chiefmate's guard as a hook (trusted for this run only, as Claude
 * Code's hooks are given in --settings).
 */
export function codexStepArgs({ dir, model, effort, session, guardLog, readOnly = false }) {
  const common = [
    // readOnly: the emergency watch's analyst (src/sentinel.mjs), which only reads what it is given and answers.
    '--json', '--skip-git-repo-check', '--ignore-user-config', '-c', `sandbox_mode="${readOnly ? 'read-only' : 'workspace-write'}"`, '-c', 'approval_policy="never"',
    '-c', 'windows.sandbox="unelevated"', '-c', codexGuard(guardLog), '--dangerously-bypass-hook-trust',
    ...(toolModel('codex', model) ? ['-m', toolModel('codex', model)] : []),
    ...(CODEX_EFFORTS.includes(effort) ? ['-c', `model_reasoning_effort="${effort}"`] : []),
  ];
  return session?.resume ? ['exec', 'resume', ...common, session.id, '-'] : ['exec', ...common, '-C', dir, '-'];
}

/**
 * Grok's arguments for a step: headless with the prompt from a file, its events as JSON lines, approving its own
 * actions (no one is there to answer) except what the deny rules refuse, a session of its own (-s) or the same one
 * resumed (-r), no memory across sessions and no update while it works.
 */
export function grokStepArgs({ dir, model, effort, session, promptFile }) {
  return [
    '--prompt-file', promptFile, '--output-format', 'streaming-json', '--always-approve', '--no-auto-update', '--no-memory', '--cwd', dir,
    ...GROK_DENY.flatMap(rule => ['--deny', rule]),
    ...(toolModel('grok', model) ? ['-m', toolModel('grok', model)] : []),
    ...(GROK_EFFORTS.includes(effort) ? ['--effort', effort] : []),
    ...(session?.resume ? ['-r', session.id] : session?.id ? ['-s', session.id] : []),
  ];
}

// ---------- Running a step ----------

/** Ends the process and everything it started (on Windows, the whole tree). */
function stop(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  else child.kill('SIGTERM');
}

/** A shell command as Codex reports it, without the shell around it ("pwsh.exe -Command '...'"). */
export const bareCommand = command => String(command ?? '')
  .replace(/^"?[^"\s]*?(pwsh|powershell|cmd|bash|sh)(\.exe)?"?\s+(-NoProfile\s+|-NoLogo\s+)*(-Command|-lc|-c|\/d \/c|\/c)\s+/i, '')
  .replace(/^(["'])([\s\S]*)\1$/, '$2');

/**
 * One event of Codex as what a step does: [{ kind: 'start' | 'say' | 'call' | 'done' | 'action' | 'end' | 'fail' |
 * 'usage', ... }]. call/done: an action that starts and ends (an interruption waits for it); action: one already over.
 */
export function codexEvents(event) {
  const item = event?.item ?? {};
  const started = event?.type === 'item.started';
  const done = event?.type === 'item.completed';
  switch (event?.type) {
    case 'thread.started':
      return [{ kind: 'start', session: event.thread_id }];
    case 'turn.completed':
      return [{ kind: 'usage', usage: { input: event.usage?.input_tokens ?? 0, cacheRead: event.usage?.cached_input_tokens ?? 0, output: event.usage?.output_tokens ?? 0 } }, { kind: 'end' }];
    case 'turn.failed':
      return [{ kind: 'fail', error: event.error?.message ?? 'turn failed' }];
    case 'error':
      return [{ kind: 'fail', error: event.message ?? 'error' }];
    default:
  }
  switch (item.type) {
    case 'agent_message':
      return done && String(item.text ?? '').trim() ? [{ kind: 'say', text: item.text }] : [];
    case 'command_execution': {
      const command = bareCommand(item.command);
      if (started) return [{ kind: 'call', id: item.id, tool: 'Bash', input: { command } }];
      if (!done) return [];
      const failed = item.status === 'failed' || (item.exit_code != null && item.exit_code !== 0);
      return [{ kind: 'done', id: item.id, failed, text: failed ? t('Failed: {command} ({output})', { command: clip(command, 100), output: clip(String(item.aggregated_output ?? '').trim() || `exit ${item.exit_code}`, 160) }) : null }];
    }
    case 'file_change':
      return done ? (item.changes ?? []).map(c => ({ kind: 'action', tool: c.kind === 'add' ? 'Write' : 'Edit', input: { file_path: c.path } })) : [];
    case 'web_search':
      return started ? [{ kind: 'action', tool: 'WebSearch', input: { query: item.query } }] : [];
    case 'mcp_tool_call':
      return started ? [{ kind: 'action', tool: `mcp__${item.server}__${item.tool}`, input: {} }] : [];
    case 'todo_list':
      return started ? [{ kind: 'action', tool: 'TodoWrite', input: {} }] : [];
    case 'error':
      // Codex's own notice that the guard's hook is trusted for this run only: not a failure of the agent.
      return /bypass-hook-trust/.test(item.message ?? '') ? [] : [{ kind: 'action', failed: true, text: clip(item.message, 300) }];
    default:
      return [];
  }
}

// Grok's tools as Claude Code's, so the logbook and the app describe them the same way.
const GROK_TOOL = {
  run_terminal_command: 'Bash', run_terminal_cmd: 'Bash', read_file: 'Read', hashline_read: 'Read', search_replace: 'Edit', hashline_edit: 'Edit',
  write: 'Write', grep: 'Grep', hashline_grep: 'Grep', list_dir: 'Glob', web_search: 'WebSearch', web_fetch: 'WebFetch', spawn_subagent: 'Agent',
  task: 'Agent', todo_write: 'TodoWrite',
};

/** A Grok tool call's input, in Claude Code's words (command, file_path, pattern, query, url). */
function grokInput(raw = {}) {
  const r = raw ?? {};
  return {
    command: r.command, file_path: r.file_path ?? r.path ?? r.target_file ?? r.filePath, pattern: r.pattern ?? r.query ?? r.glob,
    query: r.query ?? r.search_term, url: r.url, description: r.description, prompt: r.prompt,
  };
}

/** One event of Grok (streaming-json) as what a step does, in the same kinds as codexEvents; "text" is a piece of text. */
export function grokEvents(event) {
  switch (event?.type) {
    case 'text':
      return typeof event.data === 'string' ? [{ kind: 'text', text: event.data }] : [];
    case 'tool_call': {
      const tool = GROK_TOOL[event.toolName] ?? event.toolName ?? event.title ?? 'tool';
      return [{ kind: 'call', id: event.toolCallId, tool, input: grokInput(event.rawInput) }];
    }
    case 'tool_call_update': {
      if (event.status !== 'completed' && event.status !== 'failed') return [];
      const said = (event.content ?? []).map(c => c?.content?.text ?? '').join(' ').trim();
      const denied = event.status === 'failed' && /denied by permission policy/i.test(said);
      return [{ kind: 'done', id: event.toolCallId, failed: event.status === 'failed', denied, text: event.status === 'failed' ? clip(said || t('The action failed'), 300) : null }];
    }
    case 'usage': {
      const u = event.usage ?? {};
      return [{ kind: 'context', used: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) }];
    }
    case 'end': {
      const u = event.usage ?? {};
      return [
        { kind: 'start', session: event.sessionId },
        { kind: 'usage', usage: { input: u.input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, output: u.output_tokens ?? 0 }, turns: event.num_turns ?? 0 },
        event.stopReason === 'end_turn' ? { kind: 'end' } : { kind: 'fail', error: event.error ?? t('Grok stopped: {reason}', { reason: event.stopReason ?? '?' }) },
      ];
    }
    case 'error':
      return [{ kind: 'fail', error: clip(event.message ?? 'error', 600), text: event.text }];
    default:
      return [];
  }
}

/**
 * Runs one step on Codex or Grok, as runClaude does on Claude Code (same options, same result): { promise, cancel,
 * interrupt, pid, args }. The agent's instructions go at the top of the first prompt (neither tool takes a system
 * prompt to add to its own). The step's log (.jsonl) gets the agent's text and actions in Claude Code's shape, so the
 * agent's panel and the logbook read every tool alike; the tool's own output goes to <log>.raw.jsonl.
 * interrupt() waits for the actions under way, then stops the tool: the same session goes on with session.resume.
 */
export function runTool(tool, options) {
  const { dir, prompt, system, model, effort, env = {}, maxMinutes = 60, isHeld = () => false, log, onEvent = () => {}, spentMs = 0, session = {}, guardLog, readOnly = false } = options;
  const first = session.resume || !system ? prompt : `## Your role (the agent's instructions)\n\n${system}\n\n---\n\n${prompt}`;
  let promptFile = null;
  if (tool === 'grok') {
    promptFile = `${log}.prompt.md`;
    writeFileSync(promptFile, first);
  }
  const args = tool === 'codex' ? codexStepArgs({ dir, model, effort, session, guardLog, readOnly }) : grokStepArgs({ dir, model, effort, session, promptFile });
  const childEnv = tool === 'codex' ? codexEnvironment(env) : environment({ ...GROK_NO_COMPAT, ...env });
  let program;
  try {
    program = spawnable(tool);
  } catch (error) {
    return { promise: Promise.resolve({ ok: false, error: error.message, tokens: {}, turns: 0 }), cancel() {}, interrupt: () => false, pid: null, args };
  }
  const child = spawn(program.command, [...program.prefix, ...args], { cwd: dir, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const logStream = log ? createWriteStream(log, { flags: 'a' }) : null;
  const raw = log ? createWriteStream(`${log.replace(/\.jsonl$/, '')}.raw.jsonl`, { flags: 'a' }) : null;
  const write = event => logStream?.write(`${JSON.stringify(event)}\n`);
  const name = TOOL_NAMES[tool];
  let cancelReason = null;
  let failure = null;
  let finished = false;
  let thread = session.id ?? null;
  let stderr = '';
  let text = '';
  let lastText = '';
  let turns = 0;
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const context = { used: 0, window: 0, compactions: 0 };
  const started = Date.now();

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
  const inFlight = new Map();
  let interrupting = null;
  function interrupt() {
    if (cancelReason || interrupting || child.exitCode !== null) return false;
    interrupting = setTimeout(() => stop(child), 120_000);
    if (!inFlight.size) stop(child);
    return true;
  }

  // Grok streams its text in pieces: what came since the last action is one message.
  const flush = () => {
    const said = text.trim();
    text = '';
    if (!said) return;
    lastText = said;
    write({ type: 'assistant', message: { content: [{ type: 'text', text: said }] } });
    onEvent({ type: 'say', text: said });
  };
  const handle = e => {
    switch (e.kind) {
      case 'start':
        if (e.session && e.session !== thread) {
          thread = e.session;
          onEvent({ type: 'start', session: thread, model: toolModel(tool, model) });
        }
        break;
      case 'text':
        text += e.text;
        break;
      case 'say':
        flush();
        lastText = e.text.trim();
        write({ type: 'assistant', message: { content: [{ type: 'text', text: e.text }] } });
        onEvent({ type: 'say', text: e.text });
        break;
      case 'call':
      case 'action':
        flush();
        if (e.kind === 'call') inFlight.set(e.id, e.input);
        if (e.failed) {
          onEvent({ type: 'action', tool, text: e.text, failed: true });
          break;
        }
        write({ type: 'assistant', message: { content: [{ type: 'tool_use', id: e.id ?? `a${Date.now()}`, name: e.tool, input: e.input }] } });
        onEvent({ type: 'action', tool: e.tool, text: describeAction(e.tool, e.input, dir), doing: describeDoing(e.tool, e.input, dir), file: writtenFile(e.tool, e.input) });
        break;
      case 'done':
        // Grok's deny rules refused a command: noted as the guard notes its refusals.
        if (e.denied && guardLog) {
          try {
            appendFileSync(guardLog, `${JSON.stringify({ tool_name: 'Bash', tool_use_id: e.id, tool_input: { command: inFlight.get(e.id)?.command ?? '' }, cwd: dir })}
`);
          } catch {
            // the note is a record only: the refusal stands
          }
        }
        inFlight.delete(e.id);
        if (e.failed && e.text) onEvent({ type: 'action', failed: true, text: e.denied ? t("Refused by Chiefmate's guard: {reason}", { reason: e.text }) : e.text });
        if (interrupting && !inFlight.size) stop(child);
        break;
      case 'context':
        if (e.used) {
          context.used = e.used;
          onEvent({ type: 'context', used: e.used, window: context.window || null });
        }
        break;
      case 'usage':
        for (const k of Object.keys(tokens)) tokens[k] += e.usage[k] ?? 0;
        turns += e.turns ?? 1;
        break;
      case 'end':
        flush();
        finished = true;
        break;
      case 'fail':
        flush();
        failure = e.error;
        if (e.text) lastText = String(e.text).trim();
        break;
      default:
    }
  };

  child.stdin.on('error', () => {});
  child.stdin.end(tool === 'codex' ? first : '');
  child.stderr.on('data', d => (stderr = (stderr + d).slice(-4000)));
  createInterface({ input: child.stdout }).on('line', line => {
    raw?.write(`${line}\n`);
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    for (const e of tool === 'codex' ? codexEvents(event) : grokEvents(event)) handle(e);
  });

  const promise = new Promise(resolve => {
    child.on('error', error => {
      clearInterval(timer);
      clearTimeout(interrupting);
      resolve({ ok: false, error: t("Couldn't start {tool}: {error}", { tool: name, error: error.message }), tokens, turns: 0 });
    });
    child.on('close', code => {
      clearInterval(timer);
      clearTimeout(interrupting);
      flush();
      logStream?.end();
      raw?.end();
      const interrupted = !!interrupting && !cancelReason;
      const ok = finished && !failure && !cancelReason && !interrupted;
      const result = {
        ok, canceled: !!cancelReason, interrupted, spentMs: spent + (isHeld() ? 0 : Date.now() - last),
        text: lastText, turns, durationMs: Date.now() - started, session: thread, tokens, context: { ...context }, subagents: 0, end: finished ? 'success' : null, denials: [],
      };
      if (cancelReason) result.error = cancelReason;
      else if (interrupted) result.error = null;
      else if (failure) result.error = t('Ended with an error ({kind}). {output}', { kind: name, output: clip(failure, 600) });
      else if (!ok) result.error = t('{tool} ended without finishing its turn (exit code {code}). {output}', { tool: name, code, output: clip(stderr.trim(), 600) });
      resolve(result);
    });
  });
  return { promise, cancel, interrupt, pid: child.pid, args };
}
