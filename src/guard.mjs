// What a shell command would publish, however it is written: "git -C dir push", "bash -c 'git push'",
// "gh api ... -X POST", "curl -X POST https://api.github.com/...". Claude Code's permission rules only match a
// command's first words, so a live session in the app also runs this file as a PreToolUse hook (see guardHooks): what
// it finds and the owner has not allowed is refused, and written down for a permission request.
// Run as a hook: node src/guard.mjs --log <file> [--allow <rule>]...  (the tool call comes as JSON on standard input).
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The rules a finding is filed under: the same as Claude Code's, so allowing one releases both.
export const PUSH = 'Bash(git push:*)';
export const REMOTE = 'Bash(git remote:*)';
export const PR = 'Bash(gh pr:*)';
export const REPO = 'Bash(gh repo:*)';
// Changing something on GitHub through its API (gh api or a web request): opening a pull request, a comment, a release...
export const API = 'Bash(gh api:*)';

// git's options before the command that take the next word as their value.
const GIT_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix', '--exec-path', '--attr-source']);
// Words that run the command after them.
const WRAPPERS = new Set(['env', 'command', 'exec', 'nohup', 'time', 'sudo', 'xargs', 'nice', 'timeout', 'call', 'start', 'start-process', 'invoke-expression', 'iex', '&', '.']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'pwsh', 'powershell', 'cmd', 'wsl']);
const WEB = new Set(['curl', 'wget', 'http', 'https', 'xh', 'invoke-restmethod', 'invoke-webrequest', 'irm', 'iwr']);

/** A command's words, quotes taken off, with "|" marking where one command ends and the next begins. */
function tokens(text) {
  const out = [];
  let word = null;
  const push = () => {
    if (word !== null) out.push(word);
    word = null;
  };
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'") {
      const end = s.indexOf(c, i + 1);
      const stop = end < 0 ? s.length : end;
      let inner = s.slice(i + 1, stop);
      if (c === '"') inner = inner.replace(/\\(["\\$`])/g, '$1');
      word = (word ?? '') + inner;
      i = stop;
    } else if (c === '\\' && i + 1 < s.length && s[i + 1] !== '\n') {
      word = (word ?? '') + s[++i];
    } else if (/\s/.test(c) && c !== '\n') {
      push();
    } else if (/[\n;&|(){}`]/.test(c) || (c === '$' && s[i + 1] === '(')) {
      // "2>&1" is a redirection, not the end of a command.
      if (c === '&' && (s[i - 1] === '>' || s[i - 1] === '<')) {
        word = (word ?? '') + c;
        continue;
      }
      push();
      if (out.at(-1) !== '|') out.push('|');
    } else {
      word = (word ?? '') + c;
    }
  }
  push();
  return out;
}

/** A program's plain name: "C:\Program Files\Git\cmd\git.exe" -> "git". */
const programName = word => path.basename(String(word).replace(/\\/g, '/')).replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();

/**
 * What a shell command would publish: [{ rule, part, dir }], one per finding. part: the command found, written plainly
 * ("git push origin main", with git's options before "push" taken out); dir: the folder it would run in, when the
 * command says (git -C), relative to the folder of the session.
 */
export function publishing(command, depth = 0) {
  const found = [];
  if (depth > 4) return found;
  const all = tokens(command);
  const commands = [];
  for (let i = 0, start = 0; i <= all.length; i++) {
    if (i === all.length || all[i] === '|') {
      if (i > start) commands.push(all.slice(start, i));
      start = i + 1;
    }
  }
  for (const words of commands) {
    // A quoted word with a command in it (bash -c "...", cmd /c "...", eval "..."): looked at as a command too.
    for (const w of words) if (/\s/.test(w)) found.push(...publishing(w, depth + 1));
    found.push(...inCommand(words, depth));
  }
  const seen = new Set();
  return found.filter(f => !seen.has(`${f.rule} ${f.part}`) && seen.add(`${f.rule} ${f.part}`));
}

function inCommand(words, depth) {
  let i = 0;
  // Variables set for the command (A=1 git push) and wrappers (env, sudo, xargs...), with their options.
  for (;;) {
    while (i < words.length && /^[A-Za-z_][\w]*=/.test(words[i])) i++;
    if (i < words.length && WRAPPERS.has(programName(words[i]))) {
      i++;
      // Their options, and a number (timeout 10, nice -n 5).
      while (i < words.length && /^(-|\d+[smhd]?$)/.test(words[i])) i++;
      continue;
    }
    break;
  }
  if (i >= words.length) return [];
  const program = programName(words[i]);
  const args = words.slice(i + 1);
  if (SHELLS.has(program)) {
    // pwsh -Command git push, bash -c git push: the rest is the command.
    const at = args.findIndex(a => /^(-c|-lc|-ic|-command|\/c|\/k|-e|--exec|--)$/i.test(a));
    return at >= 0 && args.length > at + 1 ? publishing(args.slice(at + 1).join(' '), depth + 1) : [];
  }
  if (program === 'git') return inGit(args);
  if (program === 'gh') return inGh(args);
  if (WEB.has(program)) return inWeb(words[i], args);
  return [];
}

function inGit(args) {
  const dirs = [];
  let i = 0;
  for (; i < args.length && args[i].startsWith('-'); i++) {
    const a = args[i];
    if (GIT_VALUE.has(a)) {
      if (a === '-C') dirs.push(args[i + 1] ?? '');
      i++;
    } else if (a.startsWith('-C') && a.length > 2) {
      dirs.push(a.slice(2));
    }
  }
  const [sub, ...rest] = args.slice(i);
  const dir = dirs.length ? path.join(...dirs) : null;
  const finding = (rule, words) => [{ rule, part: ['git', ...words].join(' '), dir }];
  if (sub === 'push' || sub === 'send-pack') return finding(PUSH, ['push', ...rest]);
  if (sub === 'subtree' && rest.includes('push')) return finding(PUSH, [sub, ...rest]);
  if (sub === 'remote') return finding(REMOTE, [sub, ...rest]);
  return [];
}

function inGh(args) {
  let at = 0;
  for (; at < args.length && args[at].startsWith('-'); at++) if (args[at] === '-R' || args[at] === '--repo') at++;
  const [sub, ...rest] = args.slice(at);
  if (!sub) return [];
  const part = ['gh', sub, ...rest].join(' ');
  if (sub === 'pr') return [{ rule: PR, part, dir: null }];
  if (sub === 'repo') return [{ rule: REPO, part, dir: null }];
  if (sub !== 'api') return [];
  // gh api: a GET unless -X/--method says otherwise, or a POST when it sends fields or a body.
  let method = null;
  let sends = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '-X' || a === '--method') method = rest[++i] ?? '';
    else if (/^(-X|--method=)./.test(a)) method = a.replace(/^(-X|--method=)/, '');
    else if (/^(-f|-F|--field|--raw-field|--input)(=.*|.+)?$/.test(a)) sends = true;
  }
  const endpoint = rest.find(a => !a.startsWith('-')) ?? '';
  const writes = method ? !/^(GET|HEAD)$/i.test(method) : endpoint === 'graphql' ? rest.some(a => /\bmutation\b/.test(a)) : sends;
  return writes ? [{ rule: API, part, dir: null }] : [];
}

function inWeb(program, args) {
  if (!args.some(a => /(^|\/\/|@)(api|uploads)\.github\.com\b/i.test(a))) return [];
  let method = null;
  let sends = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (/^(-X|--request|-Method|--method)$/i.test(a)) method = args[++i] ?? '';
    else if (/^(-X|--request=|--method=)./.test(a)) method = a.replace(/^(-X|--request=|--method=)/, '');
    else if (/^(-d|-F|-T|--data.*|--form.*|--json|--upload-file|-Body|-InFile|--post-data|--post-file|--body-data|--body-file)(=.*|.+)?$/i.test(a)) sends = true;
  }
  const writes = method ? !/^(GET|HEAD|OPTIONS)$/i.test(method) : sends;
  return writes ? [{ rule: API, part: [program, ...args].join(' '), dir: null }] : [];
}

/** The settings that make Claude Code run this file before each command, refusing what is not in "allowed". */
export function guardHooks({ log, allowed = [] }) {
  const q = s => `"${String(s).replace(/\\/g, '/')}"`;
  // Only the guard's own rules: any other text would go into a shell command line.
  const rules = [PUSH, REMOTE, PR, REPO, API].filter(r => allowed.includes(r));
  const command = [q(process.execPath), q(fileURLToPath(import.meta.url)), '--log', q(log), ...rules.flatMap(r => ['--allow', q(r)])].join(' ');
  return { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command, timeout: 30 }] }] };
}

/** The hook: refuses a command that publishes without the owner's permission, and notes it in the log. */
async function hook(argv) {
  const opt = name => argv.flatMap((a, i) => (a === name ? [argv[i + 1]] : []));
  const [log] = opt('--log');
  const allowed = new Set(opt('--allow'));
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const call = JSON.parse(input || '{}');
  if (call.tool_name !== 'Bash') return;
  const command = String(call.tool_input?.command ?? '');
  const refused = publishing(command).filter(f => !allowed.has(f.rule));
  if (!refused.length) return;
  if (log) appendFileSync(log, `${JSON.stringify({ tool_name: 'Bash', tool_use_id: call.tool_use_id, tool_input: { command } })}\n`);
  const reason = `Refused by Chiefmate: this publishes (${[...new Set(refused.map(f => f.rule))].join(', ')}) and needs the owner's permission in the app. Say what you wanted to run and why, and stop.`;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  hook(process.argv.slice(2)).catch(error => {
    // When in doubt, refuse: exit code 2 blocks the command.
    process.stderr.write(`Chiefmate's guard failed, so the command was refused: ${error.message}`);
    process.exit(2);
  });
}
