// Runs Claude Code headless (claude -p) and follows what it does, step by step.
import { execFile, spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { t } from './i18n.mjs';
import { recordUsage } from './store.mjs';
import { clip, now } from './util.mjs';

/** The Claude Code executable: CHIEFMATE_CLAUDE, the one from the official installer, or whatever is on the PATH. */
function executable() {
  if (process.env.CHIEFMATE_CLAUDE) return process.env.CHIEFMATE_CLAUDE;
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  const installed = path.join(home, '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
  return existsSync(installed) ? installed : 'claude';
}

/**
 * The agent's environment: this computer's, minus the variables of any Claude session that started Chiefmate
 * (with them, Claude Code thinks it is running inside another session).
 */
function environment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^CLAUDE/i.test(key)) delete env[key];
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  return env;
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

/** One line saying what the agent did, for the logbook. */
function describeAction(name, input = {}, dir) {
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

/** Ends the process and everything it started (on Windows, the whole tree). */
function stop(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  else child.kill('SIGTERM');
}

/**
 * Runs one step. Returns { promise, cancel }. The time limit is the only cap: there is no spending cap.
 * options: dir, prompt, system (the agent's instructions), model, effort, tools, disallowed,
 * maxMinutes, session ({ id, resume }), log (a .jsonl file), onEvent(event).
 */
export function runClaude(options) {
  const { dir, prompt, system, model, effort, tools = [], disallowed = [], maxMinutes = 60, session, log, onEvent = () => {} } = options;
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--model', model, '--permission-mode', 'dontAsk', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'];
  if (effort) args.push('--effort', String(effort));
  if (system) {
    const systemFile = `${log}.instructions.md`;
    writeFileSync(systemFile, system);
    args.push('--append-system-prompt-file', systemFile);
  }
  if (session?.resume) args.push('--resume', session.id);
  else if (session?.id) args.push('--session-id', session.id);
  else args.push('--no-session-persistence');
  // The lists go last: each one runs until the next "--", and the prompt goes through standard input.
  if (disallowed.length) args.push('--disallowedTools', ...disallowed);
  if (tools.length) args.push('--allowedTools', ...tools);

  const child = spawn(executable(), args, { cwd: dir, env: environment(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const logStream = log ? createWriteStream(log, { flags: 'a' }) : null;
  let cancelReason = null;
  let final = null;
  let stderr = '';

  const timer = setTimeout(() => cancel(t('went over the time limit ({minutes} min)', { minutes: maxMinutes })), maxMinutes * 60_000);
  function cancel(reason = t('canceled')) {
    cancelReason = reason;
    stop(child);
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
      onEvent({ type: 'start', model: event.model, session: event.session_id });
    } else if (event.type === 'assistant') {
      for (const block of event.message?.content ?? []) {
        if (block.type === 'text' && block.text.trim()) onEvent({ type: 'say', text: block.text });
        if (block.type === 'tool_use') onEvent({ type: 'action', tool: block.name, text: describeAction(block.name, block.input, dir) });
      }
    } else if (event.type === 'rate_limit_event') {
      recordUsage(event.rate_limit_info);
      onEvent({ type: 'usage', info: event.rate_limit_info });
    } else if (event.type === 'result') {
      final = event;
    }
  });

  const promise = new Promise(resolve => {
    child.on('error', error => {
      clearTimeout(timer);
      resolve({ ok: false, error: t("Couldn't start Claude Code: {error}", { error: error.message }) });
    });
    child.on('close', code => {
      clearTimeout(timer);
      logStream?.end();
      const usage = final?.usage ?? {};
      const result = {
        ok: !!final && !final.is_error && !cancelReason,
        canceled: !!cancelReason,
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
        subagents: final?.subagent_stats?.spawned ?? 0,
        end: final?.subtype ?? null,
      };
      if (cancelReason) result.error = cancelReason;
      else if (!final) result.error = t('Claude Code ended without a result (exit code {code}). {output}', { code, output: clip(stderr, 600) });
      else if (final.is_error) result.error = t('Ended with an error ({kind}). {output}', { kind: final.subtype ?? '?', output: clip(final.result ?? '', 600) });
      resolve(result);
    });
  });

  return { promise, cancel };
}
