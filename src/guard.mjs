// What a shell command would publish, however it is written: "git -C dir push", "bash -c 'git push'",
// "gh api ... -X POST", "curl -X POST https://api.github.com/...", and "tailscale funnel 3000", which shares a port of
// this computer (Tailscale Serve on the tailnet, Funnel on the internet). Claude Code's permission rules only match a
// command's first words, so a live session in the app also runs this file as a PreToolUse hook (see guardHooks): what
// it finds and the owner has not allowed is refused, and written down for a permission request.
// The manager is refused the same way, with one exception the owner gives on a card: one plain push (see takeGrant).
// Run as a hook: node src/guard.mjs --log <file> [--allow <rule>]... [--grants <file> [--session <id>]
// [--main-dir <folder>]... [--main-repo <owner/name>]...]  (the tool call comes as JSON on standard input).
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLocked, protectedFolders, recordCreated, recordSignal } from './lockdown.mjs';
import { DATA, ensureDir, ROOT } from './util.mjs';

// The rules a finding is filed under: the same as Claude Code's, so allowing one releases both.
export const PUSH = 'Bash(git push:*)';
export const REMOTE = 'Bash(git remote:*)';
export const PR = 'Bash(gh pr:*)';
export const REPO = 'Bash(gh repo:*)';
// Changing something on GitHub through its API (gh api or a web request): opening a pull request, a comment, a release...
export const API = 'Bash(gh api:*)';
// A gist (maybe public), a release, a GitHub Actions workflow started, a secret stored in a repository.
export const GIST = 'Bash(gh gist:*)';
export const RELEASE = 'Bash(gh release:*)';
export const WORKFLOW = 'Bash(gh workflow:*)';
export const SECRET = 'Bash(gh secret:*)';
// Tailscale Serve or Funnel changed: a port of this computer shared on the tailnet, or opened to the internet.
export const SERVE = 'Bash(tailscale serve:*)';
export const FUNNEL = 'Bash(tailscale funnel:*)';
// Every rule above, the ones the owner may allow.
const RULES = [PUSH, REMOTE, PR, REPO, API, GIST, RELEASE, WORKFLOW, SECRET, SERVE, FUNNEL];

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

// Chiefmate's own commands whose words are only text (a message, an instruction for the crew, a note, a question): none
// runs what it is given. needs-you only without --check, which a shell runs.
const CLI_TEXT = new Set(['chat', 'defect', 'task', 'ask', 'mission', 'plan', 'request', 'ask-owner', 'gap', 'edit', 'guide', 'radar', 'session', 'needs-you']);
// git's commands whose quoted words are only text (a message): with no option before them but -C <folder>, as a -c
// could set an alias or an editor that runs a command.
const GIT_TEXT = new Set(['commit', 'tag', 'notes', 'stash', 'merge']);
// gh's commands whose quoted words are only text (a title, a body, a search, a query): not alias, config, extension or
// codespace, which may keep or run a command.
const GH_TEXT = new Set(['issue', 'pr', 'repo', 'api', 'search', 'run', 'workflow', 'release', 'label', 'status']);

// A command that bash, PowerShell (Codex's shell on Windows) and tokens() all read as the same words, with nothing run
// but its program: plain characters and spaces, or quoted text with nothing inside that one of them expands or reads
// as the quote's end ($, a backquote, an escaped quote, curly quotes). No separator, comment or line break outside
// quotes, no $'...'.
const PLAIN_WORDS = /^(?:[\w./:=@,+ \t-]|'[^'\u2018-\u201f]*'|"(?:[^"\\$`\u2018-\u201f]|\\[^"\\$`\s\u2018-\u201f])*")*\s*$/;

/**
 * Whether the quoted words of the whole command are only text for its program, never run: one command in plain words
 * (PLAIN_WORDS), with nothing before its program, of Chiefmate's command line (CLI_TEXT: node .../cli.mjs task ...
 * "<instruction>"), of git (GIT_TEXT: git commit -m "...") or of gh (GH_TEXT: gh issue create --body "...").
 */
function onlyText(command) {
  const words = tokens(command);
  if (words.includes('|') || !PLAIN_WORDS.test(String(command))) return false;
  const { program, args, at } = programOf(words);
  if (at !== 0) return false;
  if (program === 'node') return programName(args[0] ?? '') === 'cli.mjs' && CLI_TEXT.has(args[1]) && !args.includes('--check');
  let i = 0;
  if (program === 'git') {
    while (args[i] === '-C' && i + 1 < args.length) i += 2;
    return GIT_TEXT.has(args[i]);
  }
  if (program === 'gh') {
    while ((args[i] === '-R' || args[i] === '--repo') && i + 1 < args.length) i += 2;
    return GH_TEXT.has(args[i]);
  }
  return false;
}

/** Where a simple command writes its standard output: the last file it is redirected to, or null (a stream, none). */
function outputFile(words) {
  let file = null;
  for (let i = 0; i < words.length; i++) {
    const m = /^(1|&)?(>>?|>\|)(.*)$/.exec(words[i]);
    if (!m) continue;
    const target = m[3] || words[++i] || '';
    // "&1", "/dev/stdout" and the like are a stream, not a file.
    file = target && !/^[&(]/.test(target) && !SPECIAL_FILE.test(target) ? target : null;
  }
  return file;
}

// Files that are a stream or a process, not a file.
const SPECIAL_FILE = /^\/(dev|proc)\//i;

/**
 * The files a simple command writes a heredoc's text into, and nothing else: "cat > f <<'EOF'", "cat <<'EOF' >> f",
 * "tee [-a] f... <<'EOF'", with cat or tee written plainly as its first word. [] for any other command.
 */
function heredocFiles(head) {
  const program = /^\s*(cat|tee)\s/.exec(head)?.[1];
  const words = tokens(head);
  if (!program || words.includes('|')) return [];
  const args = words.slice(1).filter(w => !w.startsWith('<<'));
  if (program === 'cat') {
    const file = outputFile(args);
    return file ? [file] : [];
  }
  const files = [];
  for (let j = 0; j < args.length; j++) {
    if (/^\d?&?>/.test(args[j])) {
      if (/^\d?&?>>?$/.test(args[j])) j++;
    } else if (!args[j].startsWith('-')) files.push(args[j]);
  }
  return files.length && !files.some(f => SPECIAL_FILE.test(f)) ? files : [];
}

// The programs a command that writes heredocs into files may also run, for their texts to count as data: none of them
// runs a file, a hook or a script, so nothing in the command can run what was written.
const INERT = new Set(['cat', 'tee', 'mkdir', 'cd', 'pwd', 'ls', 'echo', 'printf', 'true', ':', 'chmod', 'touch', 'wc']);
// What may stay around the texts: plain words, redirections, separators, and quotes with nothing inside that bash
// expands. No variable, pattern, brace, parenthesis, escape or comment: each may name the file another way (bash *.sh,
// $f, {t,}.sh) or be read by bash otherwise than here ("${x:-"<<EOF "}", $[1 << 2], a function made of cat).
const PLAIN_AROUND = /^(?:[\w./:=@,+\s<>&|;-]|'[^'\u2018-\u201f]*'|"[^"\\$`!\u2018-\u201f]*")*$/;

/**
 * The command without its heredocs' texts when all it does is write them into files: each one by cat or tee
 * ("cat > test.sh <<'EOF' ... EOF"), as written (a quoted delimiter, or nothing bash would expand), and nothing else
 * run but INERT programs, in plain words. Those texts are data, not commands. Read as bash reads it (quotes,
 * comments, "<<-"), and kept whole otherwise: any other program may run what was written (bash test.sh, a glob, a
 * hook, a test runner), and so may a pipe, a substitution, a heredoc with no end or an unusual delimiter.
 */
function withoutWrittenText(command) {
  const s = String(command ?? '');
  if (!s.includes('<<')) return s;
  const docs = [];
  let line = []; // this line's heredocs, waiting for its end
  let segment = 0; // where the simple command going on begins
  const close = end => {
    for (const d of line) if (d.end === undefined) d.end = end;
    segment = end;
  };
  let word = true; // at a word's start: "#" begins a comment
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '`' || ((c === '$' || c === '<' || c === '>') && s[i + 1] === '(')) return s;
    if (c === '\\') {
      i++;
      word = false;
    } else if (c === "'" || (c === '$' && s[i + 1] === "'")) {
      // '...' has no escapes; $'...' has.
      let j = c === '$' ? i + 2 : i + 1;
      if (c === '$') while (j < s.length && s[j] !== "'") j += s[j] === '\\' ? 2 : 1;
      else j = s.indexOf("'", j);
      if (j < 0 || j >= s.length) return s;
      i = j;
      word = false;
    } else if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
      if (j >= s.length || /`|\$\(/.test(s.slice(i, j))) return s;
      i = j;
      word = false;
    } else if (c === '#' && word) {
      const e = s.indexOf('\n', i);
      i = (e < 0 ? s.length : e) - 1;
    } else if (c === '<' && s[i + 1] === '<') {
      if (s[i + 2] === '<') {
        i += 2;
        word = true;
        continue;
      }
      let j = i + 2;
      const tabs = s[j] === '-';
      if (tabs) j++;
      while (s[j] === ' ' || s[j] === '\t') j++;
      const from = j;
      while (j < s.length && !/[\s;&|()<>]/.test(s[j])) j++;
      const raw = s.slice(from, j);
      const delim = raw.replace(/^(['"])(.*)\1$/, '$2');
      // Only a plain delimiter, quoted whole or not at all: any other is read as bash may not.
      if (!/^[\w.-]+$/.test(delim) || (raw !== delim && raw !== `'${delim}'` && raw !== `"${delim}"`)) return s;
      line.push({ delim, tabs, quoted: raw !== delim, segment });
      i = j - 1;
      word = false;
    } else if (c === '\n') {
      close(i);
      // The heredocs' texts follow this line, one after another, each up to its delimiter alone on a line.
      let p = i + 1;
      for (const d of line) {
        d.from = p;
        for (;;) {
          const e = s.indexOf('\n', p);
          const end = e < 0 ? s.length : e;
          if ((d.tabs ? s.slice(p, end).replace(/^\t+/, '') : s.slice(p, end)) === d.delim) {
            d.to = p;
            d.after = end;
            p = end;
            break;
          }
          if (e < 0) return s;
          p = e + 1;
        }
        docs.push(d);
      }
      line = [];
      i = Math.max(i, p - 1);
      segment = i + 1;
      word = true;
    } else if (/[;&|]/.test(c)) {
      // ">&2", "<&0" and "&>" are redirections, not the end of a command.
      if (c === '&' && (s[i - 1] === '>' || s[i - 1] === '<' || s[i + 1] === '>')) {
        word = false;
        continue;
      }
      close(i);
      // What ends the command: a pipe sends its output to the next one.
      for (const d of line) if (d.end === i) d.pipe = c === '|' && s[i + 1] !== '|';
      if (['||', '&&', '|&', ';;'].includes(s.slice(i, i + 2))) {
        if (s.slice(i, i + 2) === '|&') for (const d of line) if (d.end === i) d.pipe = true;
        i++;
      }
      segment = i + 1;
      word = true;
    } else {
      word = /[\s()<>]/.test(c);
    }
  }
  if (line.length || !docs.length) return s;
  // Each text goes into a file by cat or tee, as written: no pipe after it, nothing bash would expand in it.
  if (docs.some(d => d.pipe || (!d.quoted && /[$`\\]/.test(s.slice(d.from, d.to))) || !heredocFiles(s.slice(d.segment, d.end)).length)) return s;
  // The command around the texts (their delimiters taken out too) runs nothing but INERT programs, in plain words.
  let rest = '';
  let at = 0;
  for (const d of docs) {
    rest += s.slice(at, d.from);
    at = d.after;
  }
  rest += s.slice(at);
  const words = tokens(rest);
  const programs = words.filter((w, i) => w !== '|' && (i === 0 || words[i - 1] === '|'));
  return PLAIN_AROUND.test(rest) && programs.every(p => INERT.has(p)) ? rest : s;
}

/**
 * What a shell command would publish: [{ rule, part, dir }], one per finding. part: the command found, written plainly
 * ("git push origin main", with git's options before "push" taken out); dir: the folder it would run in, when the
 * command says (git -C, or a cd before it), relative to the folder of the session. The quoted text of a command that
 * only reads it as text (onlyText: a message or an instruction for Chiefmate's command line, a commit message, an
 * issue's body), when that is the whole command, in plain words, is not run, so it is not looked at as a command, nor
 * are the texts of heredocs written into files by a command that does nothing else (withoutWrittenText), judged on the
 * whole command only: inside "bash -c" the rest of the line could run the file.
 */
export function publishing(command, depth = 0) {
  const found = [];
  if (depth > 4) return found;
  const all = tokens(depth === 0 ? withoutWrittenText(command) : command);
  const commands = [];
  for (let i = 0, start = 0; i <= all.length; i++) {
    if (i === all.length || all[i] === '|') {
      if (i > start) commands.push(all.slice(start, i));
      start = i + 1;
    }
  }
  const text = depth === 0 && onlyText(command);
  let cd = null;
  const at = f => (cd ? { ...f, dir: within(cd, f.dir ?? '.') } : f);
  for (const words of commands) {
    // A quoted word with a command in it (bash -c "...", cmd /c "...", eval "..."): looked at as a command too.
    if (!text) for (const w of words) if (/\s/.test(w)) found.push(...publishing(w, depth + 1).map(at));
    if (CD.has(programName(words[0]))) {
      const to = words.slice(1).find(w => !w.startsWith('-'));
      if (to) cd = within(cd, to);
      continue;
    }
    found.push(...inCommand(words, depth).map(at));
  }
  const seen = new Set();
  return found.filter(f => !seen.has(`${f.rule} ${f.part}`) && seen.add(`${f.rule} ${f.part}`));
}

/** A command's program and its arguments: { program, args, at }, with variables (A=1) and wrappers (env, sudo...) taken off; at: where the program is. */
function programOf(words) {
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
  return i >= words.length ? { program: null, args: [], at: i } : { program: programName(words[i]), args: words.slice(i + 1), at: i };
}

function inCommand(words, depth) {
  const { program, args, at: i } = programOf(words);
  if (!program) return [];
  if (SHELLS.has(program)) {
    // pwsh -Command git push, bash -c git push: the rest is the command.
    const at = args.findIndex(a => /^(-c|-lc|-ic|-command|\/c|\/k|-e|--exec|--)$/i.test(a));
    return at >= 0 && args.length > at + 1 ? publishing(args.slice(at + 1).join(' '), depth + 1) : [];
  }
  if (program === 'git') return inGit(args);
  if (program === 'gh') return inGh(args);
  if (program === 'tailscale') return inTailscale(args);
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

// gh's groups that publish, with their rule, and what each does that only looks: nothing is published.
const GH_RULES = { pr: PR, repo: REPO, gist: GIST, release: RELEASE, workflow: WORKFLOW, secret: SECRET };
const GH_READ = {
  pr: new Set(['view', 'list', 'status', 'diff', 'checks']), repo: new Set(['view', 'list']), gist: new Set(['view', 'list']),
  release: new Set(['view', 'list', 'download']), workflow: new Set(['view', 'list']), secret: new Set(['list']),
};

function inGh(args) {
  let at = 0;
  for (; at < args.length && args[at].startsWith('-'); at++) if (args[at] === '-R' || args[at] === '--repo') at++;
  const [sub, ...rest] = args.slice(at);
  if (!sub) return [];
  const part = ['gh', sub, ...rest].join(' ');
  if (Object.hasOwn(GH_RULES, sub)) {
    const action = rest.find((a, i) => !a.startsWith('-') && rest[i - 1] !== '-R' && rest[i - 1] !== '--repo');
    return GH_READ[sub].has(action) ? [] : [{ rule: GH_RULES[sub], part, dir: null }];
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

// Tailscale's groups that change what this computer shares, with their rule. Only "status" right after one only looks:
// any other word, an option first included, may be a port shared (tailscale serve --set-path status 3000).
const TAILSCALE_RULES = { serve: SERVE, funnel: FUNNEL };

function inTailscale(args) {
  // Tailscale reads its groups whatever the case, after its own options (--socket <path>).
  let at = 0;
  for (; at < args.length && !Object.hasOwn(TAILSCALE_RULES, args[at].toLowerCase()); at++) {
    // Another group ends the search; a word after an option written without "=" is that option's value.
    if (!args[at].startsWith('-') && !(at > 0 && args[at - 1].startsWith('-') && !args[at - 1].includes('='))) return [];
  }
  if (at >= args.length) return [];
  const [sub, ...rest] = [args[at].toLowerCase(), ...args.slice(at + 1)];
  return rest[0]?.toLowerCase() === 'status' ? [] : [{ rule: TAILSCALE_RULES[sub], part: ['tailscale', sub, ...rest].join(' '), dir: null }];
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
  const add = (kind, detail, target = null) => found.push({ kind, detail: clip(detail), ...(target ? { target } : {}) });
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
      if (wide) add('wide_delete', words.join(' '), p);
      else if ((samePath(p, cwd) || !inside(p, cwd)) && !inside(p, temp)) add('mass_delete', words.join(' '), p);
    }
  }
  // One finding per deletion, and one for the protected folders however many times they are named.
  const seen = new Set();
  const key = f => (f.kind === 'protected_access' ? f.kind : `${f.kind} ${f.detail} ${f.target ?? ''}`);
  return found.filter(f => !seen.has(key(f)) && seen.add(key(f)));
}

const MAKERS = new Set(['mkdir', 'md', 'new-item', 'ni']);

/**
 * The folders a shell command would create outside "cwd" (the agent's own folder), not existing yet: mkdir, md and
 * New-Item (-ItemType Directory), git clone's and git worktree add's destination. Noted by the hook (recordCreated in
 * src/lockdown.mjs), so the emergency watch knows a folder deleted later was the same agent's. exists: for the tests.
 */
export function createdPaths(command, { cwd = process.cwd(), home = os.homedir(), exists = existsSync } = {}) {
  const out = [];
  const all = tokens(command);
  const commands = [];
  for (let i = 0, start = 0; i <= all.length; i++) {
    if (i === all.length || all[i] === '|') {
      if (i > start) commands.push(all.slice(start, i));
      start = i + 1;
    }
  }
  for (const words of commands) {
    let i = 0;
    while (i < words.length && (/^[A-Za-z_][\w]*=/.test(words[i]) || WRAPPERS.has(programName(words[i])))) i++;
    const program = programName(words[i] ?? '');
    const args = words.slice(i + 1);
    let targets = [];
    if (MAKERS.has(program)) {
      // New-Item makes a folder only with -ItemType Directory (or its short forms).
      const type = args.findIndex(a => /^-(itemtype|type|it)$/i.test(a));
      if (['new-item', 'ni'].includes(program) && !(type >= 0 && /^dir/i.test(args[type + 1] ?? ''))) continue;
      targets = args.filter((a, k) => !a.startsWith('-') && !(k > 0 && /^-(itemtype|type|it|name)$/i.test(args[k - 1])));
    } else if (program === 'git' && args[0] === 'clone') {
      const plain = args.slice(1).filter(a => !a.startsWith('-'));
      if (plain.length >= 2) targets = [plain.at(-1)];
    } else if (program === 'git' && args[0] === 'worktree' && args[1] === 'add') {
      const plain = args.slice(2).filter(a => !a.startsWith('-'));
      if (plain.length) targets = [plain[0]];
    }
    for (const target of targets) {
      const p = asPath(target, cwd, home);
      if (!p || inside(p, cwd) || exists(p)) continue;
      // The topmost folder that will be new: "mkdir -p ~/a/b" creates ~/a when it is missing.
      let top = p;
      while (path.dirname(top) !== top && !exists(path.dirname(top)) && !inside(path.dirname(top), cwd)) top = path.dirname(top);
      out.push(top);
    }
  }
  return [...new Set(out)];
}

const clip = s => (s.length > 300 ? `${s.slice(0, 299)}…` : s);

// ---------- The manager's push, allowed once by the owner ----------
// The manager is refused every publication, like the crew. The one exception is the owner's: a plain push of one
// branch (never forced) that the manager tried, allowed on its card in the app (src/decisions.mjs), for the same
// repository, branch, folder and source, within GRANT_MINUTES, once. Never the main branch, except in a project whose
// owner lets it go that way ("main_push": "card", a project without pull requests): there, a push of the main branch
// alone, by the manager or by a "Work now" session (src/worknow.mjs), gets the same card (see mainPushTarget). The
// requests and the grants are one file (pushesFile), read by the hook (--grants) and by "cli.mjs push"; each grant
// given and each one used is also written down for good (pushLogFile).

export const GRANT_MINUTES = 30;
export const MAIN_BRANCHES = new Set(['main', 'master']);
// The only options a push may carry to be allowed (a push of the main branch takes none).
const PLAIN_OPTIONS = new Set(['-u', '--set-upstream', '-q', '--quiet', '-v', '--verbose']);

/** The owner's push requests and grants (src/decisions.mjs). */
export const pushesFile = () => path.join(ensureDir(path.join(DATA, 'manager')), 'pushes.json');
/** The record of every push the owner allowed and of every push that went on such a grant, one line each. */
export const pushLogFile = grants => path.join(path.dirname(grants), 'push-log.jsonl');

// Where a push's messages go, written unquoted at its end ("2>&1", ">/dev/null", "2> $null"): nothing it sends changes.
// Taken off the text itself, so a quoted "2>&1", which git would get as one more branch, is not taken for one.
const TO_STREAMS = /(?:\s+[12]?>(?:&[12]|>?\s*(?:\/dev\/null|\$null|nul)))+\s*$/i;

/**
 * A push the owner may allow the manager: { dir, remote, src, branch } for exactly
 * "[cd <folder> &&] git [-C <folder>]... push [-u|-q|-v] <remote> <branch>|<source>:<branch>", alone, with its messages
 * sent to the other stream or nowhere at most ("2>&1"); otherwise { refused }: "forced" (--force, --force-with-lease,
 * +refspec, --mirror, --delete, a deletion), "main" (main or master) or "shape" (anything else). The same push written
 * either way is the same push: one grant serves them all. cwd: the folder the command runs in.
 */
export function plainPush(command, cwd = process.cwd()) {
  const p = pushParts(command, cwd);
  if (p.refused) return p;
  if (MAIN_BRANCHES.has(p.branch.toLowerCase())) return { refused: 'main' };
  return { dir: p.dir, remote: p.remote, src: p.src, branch: p.branch };
}

/** What plainPush reads, the main branch included, and whether it is bare: no option, the branch by its own name. */
function pushParts(command, cwd) {
  const shape = { refused: 'shape' };
  // "cd <folder> && git push ...": the push runs there, and only if the cd worked.
  const into = /^\s*cd\s+("[^"]*"|'[^']*'|[^\s"';&|<>()`]+)\s*&&([\s\S]*)$/.exec(String(command ?? ''));
  const moved = into ? tokens(into[1]) : [];
  if (into && (moved.length !== 1 || /^-|[$%*?[\]~<>`]/.test(moved[0]))) return shape;
  const words = tokens((into ? into[2] : String(command ?? '')).replace(TO_STREAMS, ''));
  if (!words.length || words.includes('|') || programName(words[0]) !== 'git') return shape;
  // Nothing the shell would turn into other words: variables, commands in backquotes, patterns, the home folder,
  // other redirections.
  if (words.some(w => /[$%*?[\]~<>`]/.test(w))) return shape;
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
  const dir = path.resolve(cwd, ...dirs);
  // The branch it lands on, by its own name, so neither form hides the main branch: "heads/<name>" is that branch, and
  // HEAD alone the one checked out (none when detached).
  const named = (parts[1] ?? parts[0]).replace(/^(refs\/)?heads\//i, '');
  const branch = /^head$/i.test(named) ? git(dir, 'symbolic-ref', '--short', '--quiet', 'HEAD') : named;
  if (parts.length > 2 || !src || !/^\w[\w./-]*$/.test(branch) || branch.includes('..') || branch.startsWith('refs/')) return shape;
  return { dir, remote, src, branch, bare: rest.length === 2 && refspec === branch };
}

const git = (dir, ...args) => {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  return r.status === 0 ? String(r.stdout).trim() : '';
};

/** "owner/name" (lowercase) for a GitHub address or "owner/name", the address itself otherwise. */
export const repoOf = url => (/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(url ?? '')?.[1] ?? String(url ?? '').trim()).toLowerCase();

// Files that change a database's structure, by the usual conventions: a "migrations" (or "migration", "migrate")
// folder, Alembic's "alembic/versions", or Flyway's "V<n>__<name>.sql".
const MIGRATION = /(^|\/)(migrations?|migrate|alembic\/versions)\/|(^|\/)V\d+(_\d+)*__[^/]*\.sql$/i;
const LISTED = 20;

/**
 * What the push would send: { repo, main (the main branch: main, master or the remote's default), commits (up to 20,
 * "hash subject"), count, files (up to 20) and fileCount, migrations (up to 20) and migrationCount, tip (the commit the
 * source is at) }. The commits are those of the source not yet on the remote; the files, what they change against the
 * remote's branch (for a branch not there yet, what they touch).
 */
export function pushFacts({ dir, remote, src, branch }) {
  const url = /[:/]/.test(remote) ? remote : git(dir, 'remote', 'get-url', '--push', remote);
  const head = git(dir, 'symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`).replace(`${remote}/`, '');
  const commits = git(dir, 'log', '--format=%h %s', '-n', String(LISTED), src, '--not', `--remotes=${remote}`).split('\n').filter(Boolean);
  const count = Number(git(dir, 'rev-list', '--count', src, '--not', `--remotes=${remote}`)) || commits.length;
  const base = /[:/]/.test(remote) ? '' : git(dir, 'rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${branch}`);
  const names = !count ? '' : base
    ? git(dir, '-c', 'core.quotePath=false', 'diff', '--name-only', `${base}...${src}`)
    : git(dir, '-c', 'core.quotePath=false', 'log', '--format=', '--name-only', src, '--not', `--remotes=${remote}`);
  const files = [...new Set(names.split('\n').map(f => f.trim()).filter(Boolean))];
  const migrations = files.filter(f => MIGRATION.test(f));
  return {
    repo: repoOf(url), main: MAIN_BRANCHES.has(branch.toLowerCase()) || (!!head && head === branch), commits, count,
    files: files.slice(0, LISTED), fileCount: files.length, migrations: migrations.slice(0, LISTED), migrationCount: migrations.length,
    tip: git(dir, 'rev-parse', '--verify', '--quiet', `${src}^{commit}`),
  };
}

/**
 * Where the main branch may go through the owner's card: the folders (local_clone, and repository when it is a folder)
 * and the GitHub repository of each project with "main_push": "card", as [{ project, dir } | { project, repo }].
 */
export function mainPushTargets(config) {
  const all = Object.entries(config?.projects ?? {}).filter(([, p]) => p?.main_push === 'card').flatMap(([project, p]) => {
    const repository = String(p.repository ?? '').trim();
    const folder = path.isAbsolute(repository);
    return [
      ...(p.local_clone ? [{ project, dir: path.resolve(String(p.local_clone)) }] : []),
      ...(repository && folder ? [{ project, dir: path.resolve(repository) }] : []),
      ...(repository && !folder ? [{ project, repo: repoOf(repository) }] : []),
    ];
  });
  // Once each: a project's clone is often its repository too.
  return all.filter((x, i) => all.findIndex(y => (x.dir ? y.dir && samePath(y.dir, x.dir) : y.repo === x.repo)) === i);
}

/** The project of "targets" (mainPushTargets) that a push from this folder to this repository belongs to: its id, or null. */
export function mainCardProject(targets, dir, repo) {
  if (!targets?.length || !dir) return null;
  // The folder itself, the top of its working tree and, for a worktree, the clone it belongs to.
  const [top, common] = git(dir, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir').split('\n');
  const folders = [dir, top, common && path.dirname(common)].filter(Boolean);
  const hit = targets.find(x => (x.dir && folders.some(f => samePath(f, x.dir))) || (x.repo && repo && x.repo === repo));
  return hit ? hit.project ?? '' : null;
}

/**
 * A push of the main branch the owner may allow on a card: exactly "[cd <folder> &&] git [-C <folder>]... push
 * <remote> <branch>", alone ("2>&1" at most), with no option and the branch by its own name, where <branch> is the
 * main branch (main, master or the remote's default) of a project with "main_push": "card" (targets: mainPushTargets).
 * Returns { dir, remote, src, branch, project, facts }, or null. A forced push or a deletion is never one.
 */
export function mainPushTarget(command, cwd, targets) {
  if (!targets?.length) return null;
  const p = pushParts(command, cwd);
  if (!p.branch || !p.bare) return null;
  const target = { dir: p.dir, remote: p.remote, src: p.src, branch: p.branch };
  const facts = pushFacts(target);
  if (!facts.main || !facts.repo) return null;
  const project = mainCardProject(targets, target.dir, facts.repo);
  return project == null ? null : { ...target, project: project || null, facts };
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

/**
 * The grant that lets this push go now: allowed, not expired nor used, given to the same asker (the manager, or the id
 * of a "Work now" session) for the same repository, branch, folder and source. main: whether the push is one of the
 * main branch the owner may allow (mainPushTarget): such a push takes only a grant given for the main branch, and only
 * with the commits its card showed (the source still at the same commit); such a grant serves nothing else, and any
 * other push of the main branch never goes.
 */
export function grantFor(list, target, facts, asker = 'manager', main = false) {
  if (!target?.branch || !facts?.repo) return null;
  if ((!!facts.main || MAIN_BRANCHES.has(target.branch.toLowerCase())) !== main) return null;
  return list.find(g => g.status === 'allowed' && Date.parse(g.expires) > Date.now() && !!g.main === main && (g.session ?? 'manager') === asker
    && g.repo === facts.repo && g.branch === target.branch && g.src === target.src && samePath(g.dir, target.dir)
    && (!main || (!!g.tip && g.tip === facts.tip))) ?? null;
}

/** Takes the grant for this push, if there is one, and uses it up at once, written down (logPush). Returns it, or null. */
export function takeGrant(file, target, facts = target?.branch ? pushFacts(target) : null, asker = 'manager', main = false) {
  if (!file) return null;
  const list = readPushes(file);
  const grant = grantFor(list, target, facts, asker, main);
  if (!grant) return null;
  Object.assign(grant, { status: 'used', used: new Date().toISOString() });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(list, null, 2));
  renameSync(temporary, file);
  logPush(file, 'used', grant);
  return grant;
}

/**
 * Writes down for good, next to the grants file, a push the owner allowed ("allowed") or one that went on that grant
 * ("used"): who asked, where to, what it carried and when. Never throws: the record never gets in the way of a push.
 */
export function logPush(grants, event, p) {
  try {
    const entry = {
      at: new Date().toISOString(), event, id: p.id, by: p.session ? `session ${p.session}` : 'manager', project: p.project ?? null,
      repo: p.repo, branch: p.branch, main: !!p.main, dir: p.dir, remote: p.remote, src: p.src, tip: p.tip || null,
      commits: p.count ?? 0, files: p.fileCount ?? null, migrations: p.migrationCount ?? null, expires: p.expires ?? null,
    };
    appendFileSync(pushLogFile(grants), `${JSON.stringify(entry)}\n`);
  } catch {
    // a record that could not be written is not a reason to stop
  }
}

/**
 * The settings that make Claude Code run this file before each command, refusing what is not in "allowed". grants:
 * the owner's push requests and grants (see takeGrant), for the manager and a "Work now" session; session: that
 * session's id, so it takes only its own grants; mainCard: where the main branch may go through a card
 * (mainPushTargets).
 */
export function guardHooks({ log, allowed = [], grants = null, who = grants ? 'manager' : 'step', noMain = false, session = null, mainCard = [] }) {
  const q = s => `"${String(s).replace(/\\/g, '/')}"`;
  // Only the guard's own rules: any other text would go into a shell command line. So would a folder, a repository
  // or an id, which are passed only when nothing in them is read by a shell inside double quotes.
  const plain = s => !!s && !/["%$`!\r\n]/.test(String(s));
  const rules = RULES.filter(r => allowed.includes(r));
  const by = ['step', 'manager', 'session'].includes(who) ? who : 'step';
  const card = grants ? (mainCard ?? []).flatMap(x => (x.dir && plain(x.dir) ? ['--main-dir', q(x.dir)] : x.repo && plain(x.repo) ? ['--main-repo', q(x.repo)] : [])) : [];
  const command = [q(process.execPath), q(fileURLToPath(import.meta.url)), '--log', q(log), '--who', by, ...rules.flatMap(r => ['--allow', q(r)]),
    ...(grants ? ['--grants', q(grants)] : []), ...(grants && plain(session) ? ['--session', q(session)] : []), ...card, ...(noMain ? ['--no-main'] : [])].join(' ');
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
  // Whose grants this command may take: the manager's, or those of the "Work now" session it runs in.
  const asker = opt('--session')[0] ?? 'manager';
  const allowed = new Set(opt('--allow'));
  const mainCard = [...opt('--main-dir').map(dir => ({ dir })), ...opt('--main-repo').map(repo => ({ repo }))];
  // Said when a push to the main branch is refused for good, where some project's main branch goes through a card.
  const onlyCard = mainCard.length ? ` (In a project whose owner lets its main branch go through a card, only "git push <remote> <main branch>" goes that way: alone, with no option.)` : '';
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
  // Who ran it, where and what, for the emergency watch (src/sentinel.mjs): the run and step, or the live session.
  const cwd = call.cwd || process.cwd();
  const facts = { who, run: process.env.CHIEFMATE_RUN, step: process.env.CHIEFMATE_STEP, session: process.env.CHIEFMATE_SESSION, cwd, command };
  const grave = risky.some(r => r.kind !== 'mass_delete');
  for (const r of risky) recordSignal(r.kind, r.detail, { ...facts, refused: grave, ...(r.target ? { target: r.target, existed: existsSync(r.target) } : {}) });
  if (grave) {
    return deny("Refused by Chiefmate: this reaches into Chiefmate's protected folders, or deletes a whole drive, a personal folder or Chiefmate. The owner was warned. Don't try it another way: say why you wanted it, and stop.");
  }
  // The folders the command creates outside the agent's own, noted only when it goes on (a refused one creates none).
  const goes = () => {
    try {
      recordCreated(createdPaths(command, { cwd }), facts);
    } catch {
      // noting never blocks a command
    }
  };
  const found = publishing(command);
  // The main branch of a project whose owner lets it go through a card ("main_push": "card"): it goes once they allow
  // that push there, and only that way, never on a session's general permission to push. Until then it is refused and
  // noted, and becomes the card (src/decisions.mjs).
  const main = grants && found.length && found.every(f => f.rule === PUSH) ? mainPushTarget(command, cwd, mainCard) : null;
  if (main) {
    if (takeGrant(grants, main, main.facts, asker, true)) return goes();
    if (log) appendFileSync(log, `${JSON.stringify({ tool_name: 'Bash', tool_use_id: call.tool_use_id, tool_input: { command }, cwd, card: 'main' })}\n`);
    if (who !== 'session') recordSignal('publish_refused', found.map(f => f.part).join('; '), { ...facts, refused: true });
    return deny(`Refused by Chiefmate for now: the main branch (${main.branch}) of this project goes to GitHub only once the owner allows this push on its card. The owner now gets the card in the app, with what goes (commits, files, migrations); you are told when they allow it, and may then run the same command again, once, within ${GRANT_MINUTES} minutes, with nothing committed meanwhile (the card allows exactly the commits it shows). Only "git push <remote> ${main.branch}" goes that way (alone, or after "cd <folder> &&" or with "-C <folder>", with "2>&1" at most), with no option; never a forced push or a deleted branch. Say what goes and why, and stop.`);
  }
  // A "Work now" session (src/worknow.mjs): only a plain push of one branch other than the main one may ever go, once
  // the owner allows pushing; any other push is refused at once, so it never becomes a permission request. HEAD is
  // the branch checked out, and "heads/<name>" that branch (pushParts).
  if (argv.includes('--no-main') && found.some(f => f.rule === PUSH)) {
    const target = plainPush(command, cwd);
    if (!target.branch || pushFacts(target).main) {
      return deny(`Refused by Chiefmate, always: nothing goes straight to the main branch (main, master or the default one), and no push is forced. Only "git push [-u] <remote> <branch>" of a branch of the work goes (alone, or after "cd <folder> &&", with "2>&1" at most), once the owner allowed pushing.${onlyCard} Say what you wanted to send and why, and stop.`);
    }
  }
  const refused = found.filter(f => !allowed.has(f.rule));
  if (!refused.length) return goes();
  // The manager's push the owner allowed on its card: it goes, once.
  const target = grants && refused.every(f => f.rule === PUSH) ? plainPush(command, cwd) : null;
  if (target?.branch && takeGrant(grants, target, undefined, asker)) return goes();
  if (log) appendFileSync(log, `${JSON.stringify({ tool_name: 'Bash', tool_use_id: call.tool_use_id, tool_input: { command }, cwd })}\n`);
  const rules = [...new Set(refused.map(f => f.rule))].join(', ');
  // The manager asks for a new repository through Chiefmate's command line, never through gh (src/decisions.mjs, repoCreate).
  const creating = refused.some(f => f.rule === REPO && /^gh repo create\b/.test(f.part));
  const reason = who !== 'manager'
    ? `Refused by Chiefmate: this publishes (${rules}) and needs the owner's permission in the app. Say what you wanted to run and why, and stop.`
    : creating
      ? `Refused by Chiefmate: the manager never runs "gh repo create". To create a private repository in the owner's account from a local folder, run node src/cli.mjs repo-create <name> --private --from <folder> [--description "<text>"]: the owner gets a card to allow it once, and you run the same command again when they do. Never a public repository.`
      : target?.refused === 'main' || target?.refused === 'forced'
        ? `Refused by Chiefmate, always: the manager never pushes to the main branch (main, master or the default one) nor forces a push (--force, --force-with-lease, +refspec, --mirror, --delete).${target.refused === 'main' ? onlyCard : ''} Tell the owner what you wanted to send and why.`
        : target
          ? `Refused by Chiefmate: this push needs the owner's permission. If it is a plain push of one branch, the owner now gets a card to allow it once (this repository and branch, for ${GRANT_MINUTES} minutes); you are told when they do, and may run the same command again. Only "git -C <folder> push [-u] <remote> <branch>" (or "cd <folder> && git push [-u] <remote> <branch>", with "2>&1" at most) can be allowed, alone and with no other option; the grant serves any of these forms of the same push. Say what you want to send and why, and stop.`
          : `Refused by Chiefmate: this publishes (${rules}), and the manager never does. Say what you wanted to run and why.`;
  // A live session's refusal becomes a permission request for the owner, present; the crew's and the manager's count.
  if (who !== 'session') recordSignal('publish_refused', refused.map(f => f.part).join('; '), { ...facts, refused: true });
  deny(reason);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  hook(process.argv.slice(2)).catch(error => {
    // When in doubt, refuse: exit code 2 blocks the command.
    process.stderr.write(`Chiefmate's guard failed, so the command was refused: ${error.message}`);
    process.exit(2);
  });
}
