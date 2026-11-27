// What a shell command would publish, however it is written: "git -C dir push", "bash -c 'git push'",
// "gh api ... -X POST", "curl -X POST https://api.github.com/...". Claude Code's permission rules only match a
// command's first words, so a live session in the app also runs this file as a PreToolUse hook (see guardHooks): what
// it finds and the owner has not allowed is refused, and written down for a permission request.
// The manager is refused the same way, with one exception the owner gives on a card: one plain push (see takeGrant).
// Run as a hook: node src/guard.mjs --log <file> [--allow <rule>]... [--grants <file>]  (the tool call comes as JSON on
// standard input).
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLocked, protectedFolders, recordSignal } from './lockdown.mjs';
import { ROOT } from './util.mjs';

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

// Words that change the folder the next commands run in.
const CD = new Set(['cd', 'pushd']);

/** A folder as the shell writes it, as a path: Git Bash's /c/Users -> C:/Users, ~ -> the home folder. */
function shellPath(word) {
  const w = String(word).replace(/^~(?=$|[\\/])/, os.homedir());
  return process.platform === 'win32' ? w.replace(/^\/([a-z])(\/|$)/i, (_, d) => `${d.toUpperCase()}:/`) : w;
}

/** "next" seen from "base": itself when absolute or with no base. */
const within = (base, next) => {
  const p = shellPath(next);
  return !base || path.isAbsolute(p) ? p : path.join(base, p);
};

// Chiefmate's own commands that only carry a text to the manager: the text is not run.
const MESSAGES = [['chat', 'say'], ['defect', 'report']];

/** Whether the shell would run something inside the text first: a $(...) or a backquote, outside single quotes. */
function substitutes(s) {
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote === "'") {
      if (c === "'") quote = null;
    } else if (c === '\\') {
      i++;
    } else if (c === '`' || (c === '$' && s[i + 1] === '(')) {
      return true;
    } else if (c === '"') {
      quote = quote ? null : '"';
    } else if (c === "'" && !quote) {
      quote = "'";
    }
  }
  return false;
}

/** Whether the whole command is "node .../cli.mjs chat say <text>" (or defect report), alone and with nothing run inside. */
function isMessage(command) {
  const words = tokens(command);
  return !words.includes('|') && programName(words[0] ?? '') === 'node' && programName(words[1] ?? '') === 'cli.mjs'
    && MESSAGES.some(([a, b]) => words[2] === a && words[3] === b) && !substitutes(String(command));
}

/**
 * What a shell command would publish: [{ rule, part, dir }], one per finding. part: the command found, written plainly
 * ("git push origin main", with git's options before "push" taken out); dir: the folder it would run in, when the
 * command says (git -C, or a cd before it), relative to the folder of the session. The text of a message to the
 * manager (node .../cli.mjs chat say "...", when that is the whole command) is not run, so it is not looked at.
 */
export function publishing(command, depth = 0) {
  const found = [];
  if (depth > 4 || (depth === 0 && isMessage(command))) return found;
  const all = tokens(command);
  const commands = [];
  for (let i = 0, start = 0; i <= all.length; i++) {
    if (i === all.length || all[i] === '|') {
      if (i > start) commands.push(all.slice(start, i));
      start = i + 1;
    }
  }
  let cd = null;
  for (const words of commands) {
    // A quoted word with a command in it (bash -c "...", cmd /c "...", eval "..."): looked at as a command too.
    for (const w of words) if (/\s/.test(w)) found.push(...publishing(w, depth + 1));
    if (CD.has(programName(words[0]))) {
      const to = words.slice(1).find(w => !w.startsWith('-'));
      if (to) cd = within(cd, to);
      continue;
    }
    found.push(...inCommand(words, depth).map(f => (cd ? { ...f, dir: within(cd, f.dir ?? '.') } : f)));
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
  const dir = dirs.length ? dirs.reduce(within, null) : null;
  const finding = (rule, words) => [{ rule, part: ['git', ...words].join(' '), dir }];
  if (sub === 'push' || sub === 'send-pack') return finding(PUSH, ['push', ...rest]);
  if (sub === 'subtree' && rest.includes('push')) return finding(PUSH, [sub, ...rest]);
  if (sub === 'remote') {
    // Only looking: "git remote", "git remote -v", "git remote show" and "git remote get-url".
    const action = rest.find(a => !/^(-v|--verbose)$/.test(a));
    return action === undefined || action === 'show' || action === 'get-url' ? [] : finding(REMOTE, [sub, ...rest]);
  }
  return [];
}

// What gh does that only looks: nothing is published.
const GH_READ = { pr: new Set(['view', 'list', 'status', 'diff', 'checks']), repo: new Set(['view', 'list']) };

function inGh(args) {
  let at = 0;
  for (; at < args.length && args[at].startsWith('-'); at++) if (args[at] === '-R' || args[at] === '--repo') at++;
  const [sub, ...rest] = args.slice(at);
  if (!sub) return [];
  const part = ['gh', sub, ...rest].join(' ');
  if (sub === 'pr' || sub === 'repo') {
    const action = rest.find((a, i) => !a.startsWith('-') && rest[i - 1] !== '-R' && rest[i - 1] !== '--repo');
    return GH_READ[sub].has(action) ? [] : [{ rule: sub === 'pr' ? PR : REPO, part, dir: null }];
  }
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

// ---------- What the emergency lockdown's detection looks for (src/lockdown.mjs) ----------

const DELETERS = new Set(['rm', 'rmdir', 'rd', 'del', 'erase', 'remove-item', 'ri', 'rimraf']);

/** Whether "inner" is "outer" or inside it (on Windows, whatever the case). */
const inside = (inner, outer) => {
  const rel = path.relative(process.platform === 'win32' ? outer.toLowerCase() : outer, process.platform === 'win32' ? inner.toLowerCase() : inner);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** A word as a path from "cwd": the home folder's usual spellings expanded, an option's value ("--path=x") taken. */
function asPath(word, cwd, home) {
  let w = String(word).replace(/^-{1,2}[\w-]+=/, '');
  w = w.replace(/^(~|\$HOME|\$\{HOME\}|\$env:USERPROFILE|\$env:HOME|%USERPROFILE%)(?=$|[\\/])/i, home);
  if (!w || /^[a-z][a-z0-9+.-]*:\/\//i.test(w)) return null;
  // Git Bash's drive paths on Windows: /c/Users -> C:/Users.
  if (process.platform === 'win32') w = w.replace(/^\/([a-z])(?=$|\/)/i, (_, d) => `${d.toUpperCase()}:/`);
  return path.resolve(cwd, w);
}

/**
 * What a shell command does that the lockdown's detection weighs: [{ kind, detail }], kind 'protected_access' (a word
 * that is a path inside a protected folder), 'wide_delete' (a recursive deletion of a drive, the home folder or one of
 * its folders, a folder above cwd, Chiefmate's own folder or a protected one: grave) or 'mass_delete' (a recursive
 * deletion outside cwd, or of all of it; the system's temporary folder aside). Only real paths count: a folder's name
 * in a search or a text is not one.
 */
export function riskyCommand(command, { cwd = process.cwd(), protect = [], home = os.homedir(), root = null, temp = os.tmpdir() } = {}, depth = 0) {
  const found = [];
  if (depth > 4) return found;
  const add = (kind, detail) => found.push({ kind, detail: clip(detail) });
  // A protected folder's full path anywhere in the text, whatever its slashes: PowerShell keeps backslashes that the
  // shell's words below take as escapes.
  const flat = s => String(s).replace(/\\+/g, '/').replace(/\/+$/, '').toLowerCase();
  const text = flat(command);
  if (depth === 0 && protect.some(dir => new RegExp(`${flat(dir).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.-])`).test(text))) add('protected_access', String(command));
  const all = tokens(command);
  const commands = [];
  for (let i = 0, start = 0; i <= all.length; i++) {
    if (i === all.length || all[i] === '|') {
      if (i > start) commands.push(all.slice(start, i));
      start = i + 1;
    }
  }
  for (const words of commands) {
    for (const w of words) if (/\s/.test(w)) found.push(...riskyCommand(w, { cwd, protect, home, root, temp }, depth + 1));
    for (const w of words) {
      const p = asPath(w, cwd, home);
      if (p && protect.some(dir => inside(p, dir))) add('protected_access', words.join(' '));
    }
    let i = 0;
    while (i < words.length && (/^[A-Za-z_][\w]*=/.test(words[i]) || WRAPPERS.has(programName(words[i])))) i++;
    const program = programName(words[i] ?? '');
    if (!DELETERS.has(program)) continue;
    const args = words.slice(i + 1);
    // rm -rf / -Rf / -r, --recursive; Remove-Item -Recurse (or its short forms); rd, rmdir and del /s; rimraf.
    const recursive = program === 'rimraf'
      || args.some(a => /^-[a-z]{1,3}$/i.test(a) && /r/i.test(a))
      || args.some(a => /^(--recursive|-rec(u(r(se?)?)?)?|\/s)$/i.test(a));
    if (!recursive) continue;
    for (const target of args.filter(a => !/^(-|\/[a-z]$)/i.test(a))) {
      // The temporary folder as the shell names it (Git Bash's /tmp, $TMPDIR, %TEMP%...).
      if (/^(\/tmp|\$\{?(TMPDIR|TEMP|TMP)\}?|\$env:(TEMP|TMP)|%(TEMP|TMP)%)([\\/]|$)/i.test(target)) continue;
      const p = asPath(target.replace(/[\\/]?\*+$/, '') || '.', cwd, home);
      if (!p) continue;
      const wide = samePath(path.parse(p).root, p) // a whole drive
        || inside(home, p) // the home folder, or above it
        || samePath(path.dirname(p), home) // a folder right in it (Documents, Desktop...)
        || (inside(cwd, p) && !samePath(cwd, p)) // a folder above the agent's own
        || (root && inside(root, p)) // Chiefmate itself
        || protect.some(dir => inside(p, dir) || inside(dir, p));
      if (wide) add('wide_delete', words.join(' '));
      else if ((samePath(p, cwd) || !inside(p, cwd)) && !inside(p, temp)) add('mass_delete', words.join(' '));
    }
  }
  // One finding per deletion, and one for the protected folders however many times they are named.
  const seen = new Set();
  const key = f => (f.kind === 'protected_access' ? f.kind : `${f.kind} ${f.detail}`);
  return found.filter(f => !seen.has(key(f)) && seen.add(key(f)));
}

const clip = s => (s.length > 300 ? `${s.slice(0, 299)}…` : s);

// ---------- The manager's push, allowed once by the owner ----------
// The manager is refused every publication, like the crew. The one exception is the owner's: a plain push of one
// branch (never the main one, never forced) that the manager tried, allowed on its card in the app (src/decisions.mjs),
// for the same repository, branch, folder and source, within GRANT_MINUTES, once. The requests and the grants are one
// file (data/manager/pushes.json), read by the hook (--grants) and by "cli.mjs push".

export const GRANT_MINUTES = 30;
export const MAIN_BRANCHES = new Set(['main', 'master']);
// The only options a push may carry to be allowed.
const PLAIN_OPTIONS = new Set(['-u', '--set-upstream', '-q', '--quiet', '-v', '--verbose']);

// Where a command's messages go ("2>&1", ">/dev/null", "2> $null"): nothing of what a push sends changes.
const TO_STREAM = /^[12]?>&[12]$/;
const TO_NOWHERE = /^[12]?>>?(\/dev\/null|\$null|nul)?$/i;

/**
 * A push the owner may allow the manager: { dir, remote, src, branch } for exactly
 * "[cd <folder> &&] git [-C <folder>]... push [-u|-q|-v] <remote> <branch>|<source>:<branch>", alone, with its messages
 * sent to the other stream or nowhere at most ("2>&1"); otherwise { refused }: "forced" (--force, --force-with-lease,
 * +refspec, --mirror, --delete, a deletion), "main" (main or master) or "shape" (anything else). The same push written
 * either way is the same push: one grant serves them all. cwd: the folder the command runs in.
 */
export function plainPush(command, cwd = process.cwd()) {
  const shape = { refused: 'shape' };
  // "cd <folder> && git push ...": the push runs there, and only if the cd worked.
  const into = /^\s*cd\s+("[^"]*"|'[^']*'|[^\s"';&|<>()`]+)\s*&&([\s\S]*)$/.exec(String(command ?? ''));
  const moved = into ? tokens(into[1]) : [];
  if (into && (moved.length !== 1 || /^-|[$%*?[\]~<>]/.test(moved[0]))) return shape;
  const words = [];
  for (let k = 0, all = tokens(into ? into[2] : command); k < all.length; k++) {
    if (TO_STREAM.test(all[k]) || (TO_NOWHERE.test(all[k]) && /[a-z]$/i.test(all[k]))) continue;
    if (TO_NOWHERE.test(all[k]) && /^(\/dev\/null|\$null|nul)$/i.test(all[k + 1] ?? '')) {
      k++;
      continue;
    }
    words.push(all[k]);
  }
  if (!words.length || words.includes('|') || programName(words[0]) !== 'git') return shape;
  // Nothing the shell would turn into other words: variables, patterns, the home folder, other redirections.
  if (words.some(w => /[$%*?[\]~<>]/.test(w))) return shape;
  let i = 1;
  const dirs = into ? [shellPath(moved[0])] : [];
  for (; words[i] === '-C' && i + 1 < words.length; i += 2) dirs.push(shellPath(words[i + 1]));
  if (words[i] !== 'push') return shape;
  const rest = words.slice(i + 1);
  if (rest.some(w => /^(--(force|mirror|delete|prune)|-[a-zA-Z]*[fd][a-zA-Z]*$)/.test(w) || /^[+:]/.test(w))) return { refused: 'forced' };
  const args = rest.filter(w => !w.startsWith('-'));
  if (rest.some(w => w.startsWith('-') && !PLAIN_OPTIONS.has(w)) || args.length !== 2) return shape;
  const [remote, refspec] = args;
  const parts = refspec.split(':');
  const src = parts[0];
  const branch = (parts[1] ?? parts[0]).replace(/^refs\/heads\//, '');
  if (parts.length > 2 || !src || !/^\w[\w./-]*$/.test(branch) || branch.includes('..') || branch.startsWith('refs/')) return shape;
  if (MAIN_BRANCHES.has(branch.toLowerCase())) return { refused: 'main' };
  return { dir: path.resolve(cwd, ...dirs), remote, src, branch };
}

const git = (dir, ...args) => {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  return r.status === 0 ? String(r.stdout).trim() : '';
};

/** "owner/name" (lowercase) for a GitHub address or "owner/name", the address itself otherwise. */
export const repoOf = url => (/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(url ?? '')?.[1] ?? String(url ?? '').trim()).toLowerCase();

/**
 * What the push would send: { repo, main (the main branch: main, master or the remote's default), commits (up to 20,
 * "hash subject"), count }. The commits are those of the source not yet on the remote.
 */
export function pushFacts({ dir, remote, src, branch }) {
  const url = /[:/]/.test(remote) ? remote : git(dir, 'remote', 'get-url', '--push', remote);
  const head = git(dir, 'symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`).replace(`${remote}/`, '');
  const commits = git(dir, 'log', '--format=%h %s', '-n', '20', src, '--not', `--remotes=${remote}`).split('\n').filter(Boolean);
  const count = Number(git(dir, 'rev-list', '--count', src, '--not', `--remotes=${remote}`)) || commits.length;
  return { repo: repoOf(url), main: MAIN_BRANCHES.has(branch.toLowerCase()) || (!!head && head === branch), commits, count };
}

/** The manager's push requests and grants (a list), or [] when the file is missing or unreadable. */
export function readPushes(file) {
  try {
    const list = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** Whether two folders are the same (on Windows, whatever the case). */
export const samePath = (a, b) => {
  const norm = p => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  return !!a && !!b && norm(a) === norm(b);
};

/** The grant that lets this push go now: allowed, not expired nor used, for the same repository, branch, folder and source. */
export function grantFor(list, target, facts) {
  if (!target?.branch || !facts?.repo || facts.main || MAIN_BRANCHES.has(target.branch.toLowerCase())) return null;
  return list.find(g => g.status === 'allowed' && Date.parse(g.expires) > Date.now() && g.repo === facts.repo
    && g.branch === target.branch && g.src === target.src && samePath(g.dir, target.dir)) ?? null;
}

/** Takes the grant for this push, if there is one, and uses it up at once. Returns it, or null. */
export function takeGrant(file, target, facts = target?.branch ? pushFacts(target) : null) {
  if (!file) return null;
  const list = readPushes(file);
  const grant = grantFor(list, target, facts);
  if (!grant) return null;
  Object.assign(grant, { status: 'used', used: new Date().toISOString() });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(list, null, 2));
  renameSync(temporary, file);
  return grant;
}

/**
 * The settings that make Claude Code run this file before each command, refusing what is not in "allowed". grants:
 * the manager's push requests and grants (see takeGrant).
 */
export function guardHooks({ log, allowed = [], grants = null, who = grants ? 'manager' : 'step', noMain = false }) {
  const q = s => `"${String(s).replace(/\\/g, '/')}"`;
  // Only the guard's own rules: any other text would go into a shell command line.
  const rules = [PUSH, REMOTE, PR, REPO, API].filter(r => allowed.includes(r));
  const by = ['step', 'manager', 'session'].includes(who) ? who : 'step';
  const command = [q(process.execPath), q(fileURLToPath(import.meta.url)), '--log', q(log), '--who', by, ...rules.flatMap(r => ['--allow', q(r)]), ...(grants ? ['--grants', q(grants)] : []), ...(noMain ? ['--no-main'] : [])].join(' ');
  return { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command, timeout: 30 }] }] };
}

const deny = reason => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));

/**
 * The hook: refuses every command while Chiefmate is in emergency lockdown; refuses a command that reaches into the
 * protected folders or deletes a whole drive, a personal folder or Chiefmate, and one that publishes without the
 * owner's permission, noting it in the log. What it finds goes to the lockdown's detection as signals.
 */
async function hook(argv) {
  const opt = name => argv.flatMap((a, i) => (a === name ? [argv[i + 1]] : []));
  const [log] = opt('--log');
  const [grants] = opt('--grants');
  const who = opt('--who')[0] ?? 'step';
  const allowed = new Set(opt('--allow'));
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const call = JSON.parse(input || '{}');
  if (isLocked()) return deny('Refused by Chiefmate: it is in emergency lockdown, and nothing runs until the owner releases it. Stop now.');
  if (call.tool_name !== 'Bash') return;
  const command = String(call.tool_input?.command ?? '');
  let risky = [];
  try {
    risky = riskyCommand(command, { cwd: call.cwd || process.cwd(), protect: protectedFolders(), root: ROOT });
  } catch {
    // the detection never blocks a command by failing
  }
  for (const r of risky) recordSignal(r.kind, r.detail, { who });
  if (risky.some(r => r.kind !== 'mass_delete')) {
    return deny("Refused by Chiefmate: this reaches into Chiefmate's protected folders, or deletes a whole drive, a personal folder or Chiefmate. The owner was warned. Don't try it another way: say why you wanted it, and stop.");
  }
  const found = publishing(command);
  const cwd = call.cwd || process.cwd();
  // A "Work now" session (src/worknow.mjs): only a plain push of one branch other than the main one may ever go, once
  // the owner allows pushing; any other push is refused at once, so it never becomes a permission request. HEAD is
  // the branch checked out, and "heads/<name>" that branch.
  if (argv.includes('--no-main') && found.some(f => f.rule === PUSH)) {
    const target = plainPush(command, cwd);
    const named = /^head$/i.test(target.branch ?? '') ? git(target.dir, 'symbolic-ref', '--short', 'HEAD') : target.branch;
    const branch = named?.replace(/^(refs\/)?heads\//i, '');
    if (!branch || pushFacts({ ...target, branch }).main) {
      return deny('Refused by Chiefmate, always: nothing goes straight to the main branch (main, master or the default one), and no push is forced. Only "git push [-u] <remote> <branch>" of a branch of the work goes (alone, or after "cd <folder> &&", with "2>&1" at most), once the owner allowed pushing. Say what you wanted to send and why, and stop.');
    }
  }
  const refused = found.filter(f => !allowed.has(f.rule));
  if (!refused.length) return;
  // The manager's push the owner allowed on its card: it goes, once.
  const target = grants && refused.every(f => f.rule === PUSH) ? plainPush(command, cwd) : null;
  if (target?.branch && takeGrant(grants, target)) return;
  if (log) appendFileSync(log, `${JSON.stringify({ tool_name: 'Bash', tool_use_id: call.tool_use_id, tool_input: { command }, cwd })}\n`);
  const rules = [...new Set(refused.map(f => f.rule))].join(', ');
  // The manager asks for a new repository through Chiefmate's command line, never through gh (src/decisions.mjs, repoCreate).
  const creating = refused.some(f => f.rule === REPO && /^gh repo create\b/.test(f.part));
  const reason = !grants
    ? `Refused by Chiefmate: this publishes (${rules}) and needs the owner's permission in the app. Say what you wanted to run and why, and stop.`
    : creating
      ? `Refused by Chiefmate: the manager never runs "gh repo create". To create a private repository in the owner's account from a local folder, run node src/cli.mjs repo-create <name> --private --from <folder> [--description "<text>"]: the owner gets a card to allow it once, and you run the same command again when they do. Never a public repository.`
      : target?.refused === 'main' || target?.refused === 'forced'
        ? 'Refused by Chiefmate, always: the manager never pushes to the main branch (main, master or the default one) nor forces a push (--force, --force-with-lease, +refspec, --mirror, --delete). Tell the owner what you wanted to send and why.'
        : target
          ? `Refused by Chiefmate: this push needs the owner's permission. If it is a plain push of one branch, the owner now gets a card to allow it once (this repository and branch, for ${GRANT_MINUTES} minutes); you are told when they do, and may run the same command again. Only "git -C <folder> push [-u] <remote> <branch>" (or "cd <folder> && git push [-u] <remote> <branch>", with "2>&1" at most) can be allowed, alone and with no other option; the grant serves any of these forms of the same push. Say what you want to send and why, and stop.`
          : `Refused by Chiefmate: this publishes (${rules}), and the manager never does. Say what you wanted to run and why.`;
  // A live session's refusal becomes a permission request for the owner, present; the crew's and the manager's count.
  if (who !== 'session') recordSignal('publish_refused', refused.map(f => f.part).join('; '), { who });
  deny(reason);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  hook(process.argv.slice(2)).catch(error => {
    // When in doubt, refuse: exit code 2 blocks the command.
    process.stderr.write(`Chiefmate's guard failed, so the command was refused: ${error.message}`);
    process.exit(2);
  });
}
