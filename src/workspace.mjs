// Each project's working copy (workspaces/<project>): the crew works there, never in the folder you work in.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { t } from './i18n.mjs';
import { refuseWhileLocked } from './lockdown.mjs';
import { clip, ensureDir, slug, WORKSPACES } from './util.mjs';

/**
 * Runs a command and returns { code, output, stopped }. With shell, it accepts "npm ci" and the like. After maxMinutes
 * (stopped: "timeout"), or when signal aborts ("aborted"), it is stopped with every process it started.
 */
export function run(command, args, dir, { shell = false, maxMinutes = 20, signal } = {}) {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve({ code: -1, output: '', stopped: 'aborted' });
    const child = spawn(command, args, { cwd: dir, shell, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    let output = '';
    let stopped = null;
    let grace = null;
    const collect = d => (output = (output + d).slice(-20000));
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const finish = result => {
      clearTimeout(timer);
      clearTimeout(grace);
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const stop = why => {
      if (stopped) return;
      stopped = why;
      if (why === 'timeout') output += `\n(stopped after ${maxMinutes} minutes)`;
      killTree(child);
      // A process left holding the output open must not keep the caller waiting.
      grace = setTimeout(() => finish({ code: -1, output, stopped }), 10_000);
    };
    const timer = setTimeout(() => stop('timeout'), maxMinutes * 60_000);
    const onAbort = () => stop('aborted');
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', error => finish({ code: -1, output: error.message, stopped }));
    child.on('close', code => finish({ code: stopped ? -1 : code, output, stopped }));
  });
}

/**
 * Ends a process and every process it started. On Windows, killing git alone leaves its helpers (git-remote-https,
 * which does the download) running, and they keep the output open, so the command never seemed to end.
 */
function killTree(child) {
  if (process.platform === 'win32' && child.pid) {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill());
  } else {
    child.kill();
  }
}

/** git in dir; with signal, a command stopped by it throws its AbortError. */
async function gitRun(dir, args, { signal } = {}) {
  const r = await run('git', args, dir, { signal });
  signal?.throwIfAborted();
  if (r.code !== 0) throw new Error(t('git {command} failed: {output}', { command: args.join(' '), output: clip(r.output, 500) }));
  return r.output.trim();
}

const git = (dir, ...args) => gitRun(dir, args);

export const projectDir = id => path.join(WORKSPACES, id);

/**
 * The branch a run starts from: the project's main_branch or, with "main_branch": "current", the branch
 * checked out right now in your own clone (local_clone), so the crew starts where you are working.
 */
export async function baseBranch(project) {
  if (project.main_branch && project.main_branch !== 'current') return project.main_branch;
  if (!project.local_clone) throw new Error(t('A project with "main_branch": "current" needs "local_clone".'));
  const r = await run('git', ['branch', '--show-current'], project.local_clone);
  const branch = r.output.trim();
  if (r.code !== 0 || !branch) throw new Error(t("Couldn't read the current branch of {path}.", { path: project.local_clone }));
  return branch;
}

/**
 * Makes the working copy match the base branch of its origin, and installs dependencies when they change.
 * signal (optional) stops it at once, such as for a pause for an update: it throws its AbortError, and the next call
 * starts over cleanly.
 */
export async function prepareWorkspace(id, project, base, onStep = () => {}, { signal } = {}) {
  ensureDir(WORKSPACES);
  const dir = projectDir(id);
  if (!existsSync(path.join(dir, '.git'))) {
    onStep(t('Downloading the project (first time)'));
    // Cloned beside its place and moved there once complete: a clone cut off leaves no half copy behind.
    const partial = `${dir}.partial`;
    rmSync(partial, { recursive: true, force: true, maxRetries: 5 });
    const filter = project.clone_filter ? [`--filter=${project.clone_filter}`] : [];
    // Your own clone lends the objects it has (git alternates): only what it lacks comes from the repository.
    const lend = project.local_clone && existsSync(project.local_clone) && path.resolve(project.local_clone) !== path.resolve(project.repository);
    const reference = lend ? ['--reference-if-able', project.local_clone] : [];
    const r = await run('git', ['clone', '-c', 'core.longpaths=true', ...reference, ...filter, project.repository, partial], WORKSPACES, { maxMinutes: 30, signal });
    signal?.throwIfAborted();
    if (r.code !== 0) throw new Error(t("Couldn't download the project: {output}", { output: clip(r.output, 500) }));
    if (existsSync(dir)) rmdirSync(dir); // an empty folder only: anything in it stops the copy here
    renameSync(partial, dir);
  }
  onStep(t('Updating the working copy'));
  // A git command cut off (a pause, a time limit) leaves its lock behind; no other git works in this copy meanwhile.
  rmSync(path.join(dir, '.git', 'index.lock'), { force: true });
  const step = (...args) => gitRun(dir, args, { signal });
  await step('fetch', 'origin', '--prune');
  await step('checkout', '-f', base);
  await step('reset', '--hard', `origin/${base}`);
  await step('clean', '-fd');
  await installSetup(dir, project, onStep, { signal });
  return dir;
}

/** Runs the project's "setup" (such as "npm ci") when the dependency lock file or the command itself changed. */
export async function installSetup(dir, project, onStep = () => {}, { signal } = {}) {
  if (!project.setup) return;
  const locks = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'].map(f => path.join(dir, f)).filter(existsSync);
  const signature = createHash('sha1').update(project.setup + locks.map(f => readFileSync(f)).join('')).digest('hex');
  const marker = path.join(dir, 'node_modules', '.chiefmate-setup');
  if (existsSync(marker) && readFileSync(marker, 'utf8') === signature) return;
  onStep(t('Installing dependencies ({command})', { command: project.setup }));
  const r = await run(project.setup, [], dir, { shell: true, maxMinutes: 20, signal });
  signal?.throwIfAborted();
  if (r.code !== 0) throw new Error(t('"{command}" failed: {output}', { command: project.setup, output: clip(r.output, 500) }));
  if (existsSync(path.join(dir, 'node_modules'))) writeFileSync(marker, signature);
}

// ---------- A paused run's work, kept while it waits ----------

/** The ref that keeps a paused run's stash, so it survives even if the stash list is cleared. */
export const shelfRef = id => `refs/chiefmate/shelf/${id}`;

/**
 * Puts a paused run's uncommitted work (new files included) aside: a stash named after the run, also kept under
 * shelfRef. The working copy is left clean. Returns the stash commit, or null when there was nothing to keep.
 */
export async function shelveWork(dir, id) {
  if (!(await git(dir, 'status', '--porcelain'))) return null;
  await git(dir, 'stash', 'push', '--include-untracked', '-m', `chiefmate: paused run ${id}`);
  const commit = await git(dir, 'rev-parse', 'stash@{0}');
  await git(dir, 'update-ref', shelfRef(id), commit);
  return commit;
}

/**
 * Puts a paused run's work back (see shelveWork) on the working copy, which must be clean, then drops its stash and
 * ref. When it doesn't apply cleanly, the copy is cleaned again, the stash kept, and it throws. A copy with changes
 * already (the work put back just before a crash, say) is left as it is: it throws without applying or cleaning.
 */
export async function restoreShelf(dir, id, commit) {
  if (await git(dir, 'status', '--porcelain')) throw new Error(t('The working copy has changes not committed yet: the work put aside was not put back over them.'));
  const r = await run('git', ['stash', 'apply', commit], dir);
  if (r.code !== 0) {
    await git(dir, 'reset', '--hard', '-q');
    await git(dir, 'clean', '-fdq');
    throw new Error(t('git stash apply failed: {output}', { output: clip(r.output, 500) }));
  }
  // The stash list may have moved on: its entry is found by its commit.
  const list = (await git(dir, 'stash', 'list', '--format=%H')).split('\n');
  const at = list.indexOf(commit);
  if (at >= 0) await git(dir, 'stash', 'drop', '-q', `stash@{${at}}`);
  await run('git', ['update-ref', '-d', shelfRef(id)], dir);
}

/**
 * A resumed run whose branch has no commits of its own starts again from its base as it is on origin now, so it
 * doesn't go on from an old copy of the project. Only on a clean working copy. Returns { from, to, behind } when the
 * branch was moved, else null.
 */
export async function freshenBranch(dir, base, { signal } = {}) {
  await gitRun(dir, ['fetch', 'origin', '--prune'], { signal });
  const from = await headCommit(dir);
  const to = await git(dir, 'rev-parse', `origin/${base}`);
  if (from === to || (await git(dir, 'rev-list', '--count', `origin/${base}..HEAD`)) !== '0') return null;
  if (await git(dir, 'status', '--porcelain')) return null;
  const behind = Number(await git(dir, 'rev-list', '--count', `HEAD..origin/${base}`));
  await git(dir, 'reset', '--hard', '-q', to);
  return { from, to, behind };
}

/**
 * A reference library: a git repository the crew and the manager read, such as your personal documentation.
 * It is cloned into workspaces/.library/<id> and reset to GitHub before use, so anything changed there is discarded.
 */
export function prepareLibrary(id, source, onStep = () => {}) {
  // Runs of different projects (and the manager) share the libraries: one update at a time per library, and whoever
  // asks while it goes on gets that same update instead of a second git command in the same folder.
  if (!libraryJobs.has(id)) libraryJobs.set(id, updateLibrary(id, source, onStep).finally(() => libraryJobs.delete(id)));
  return libraryJobs.get(id);
}

const libraryJobs = new Map();

async function updateLibrary(id, source, onStep) {
  const dir = path.join(WORKSPACES, '.library', id);
  const name = source.name ?? id;
  if (!existsSync(path.join(dir, '.git'))) {
    onStep(t('Downloading the library {name} (first time)', { name }));
    ensureDir(path.dirname(dir));
    const r = await run('git', ['clone', '--depth', '1', '-c', 'core.longpaths=true', source.repository, dir], path.dirname(dir), { maxMinutes: 15 });
    if (r.code !== 0) throw new Error(t("Couldn't download the library {name}: {output}", { name, output: clip(r.output, 500) }));
    return dir;
  }
  onStep(t('Updating the library {name}', { name }));
  await git(dir, 'fetch', '--depth', '1', 'origin', source.main_branch ?? 'main');
  await git(dir, 'reset', '--hard', 'FETCH_HEAD');
  await git(dir, 'clean', '-fd');
  return dir;
}

/**
 * A file's last commit in a library's copy: { hash, date, subject, approximate }, or null when git has none. The copy
 * is shallow: when the commit found is where its history is cut, the history is deepened (at most 3 times 50 commits);
 * "approximate" when it still is, as the file may have changed before that.
 */
export async function libraryFileCommit(dir, file, branch = 'main') {
  await libraryJobs.get(path.basename(dir))?.catch(() => {});
  const shallow = () => {
    try {
      return readFileSync(path.join(dir, '.git', 'shallow'), 'utf8').split(/\s+/).filter(Boolean);
    } catch {
      return [];
    }
  };
  const rel = path.relative(dir, file).split(path.sep).join('/');
  for (let tries = 0; ; tries++) {
    const line = await git(dir, 'log', '-1', '--format=%H%x09%cI%x09%s', '--', rel);
    if (!line) return null;
    const [hash, date, ...subject] = line.split('\t');
    const commit = { hash, date, subject: subject.join('\t'), approximate: shallow().includes(hash) };
    if (!commit.approximate || tries >= 3) return commit;
    // FETCH_HEAD is left alone: its date is when the copy was last updated (src/prompts.mjs).
    const r = await run('git', ['fetch', '--deepen=50', '--no-write-fetch-head', 'origin', branch], dir, { maxMinutes: 5 });
    if (r.code !== 0) return commit;
  }
}

export const createBranch = (dir, branch) => git(dir, 'checkout', '-B', branch);

/** Returns a working copy to its run branch, recovering any Git operation left by an interrupted step. */
export async function checkoutBranch(dir, branch, onRecovery = () => {}) {
  if (!existsSync(path.join(dir, '.git'))) throw new Error(t('No Git working copy found at "{path}".', { path: dir }));
  const gitDir = await git(dir, 'rev-parse', '--absolute-git-dir');
  const operation = [
    ['rebase', ['rebase-merge', 'rebase-apply']],
    ['merge', ['MERGE_HEAD']],
    ['cherry-pick', ['CHERRY_PICK_HEAD']],
    ['revert', ['REVERT_HEAD']],
  ].find(([, markers]) => markers.some(marker => existsSync(path.join(gitDir, marker))))?.[0];
  if (operation) {
    try {
      const sequenceHead = path.join(gitDir, 'sequencer', 'head');
      // A sequence's --abort would roll back its completed commits too. Clear the conflict at the current HEAD, then
      // drop the picks left in the sequence (--quit), which a reset keeps when the conflict was not the last one.
      const keepCommits = ['cherry-pick', 'revert'].includes(operation) && existsSync(sequenceHead)
        && readFileSync(sequenceHead, 'utf8').trim() !== await headCommit(dir);
      if (keepCommits) {
        await git(dir, 'reset', '--merge', 'HEAD');
        await git(dir, operation, '--quit');
      } else await git(dir, operation, '--abort');
    } catch (error) {
      throw new Error(t('Could not abort the Git {operation}. In "{path}", run "git status", finish or abort the operation, then resume the run. {error}', {
        operation, path: dir, error: error.message,
      }), { cause: error });
    }
    onRecovery(operation);
  }
  return git(dir, 'checkout', branch);
}

/** If the agent left changes without committing, Chiefmate commits them on its behalf. */
export async function commitPending(dir, message) {
  if (!(await git(dir, 'status', '--porcelain'))) return false;
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-m', message);
  return true;
}

/** The commit the working copy is on. */
export const headCommit = dir => git(dir, 'rev-parse', 'HEAD');

/**
 * Takes the working copy back to a commit, dropping what a step that may not change files (a team lead) left behind:
 * its commits, its changes and its new files (ignored ones, such as installed packages, stay). Whether anything was dropped.
 */
export async function discardSince(dir, commit) {
  const changed = (await headCommit(dir)) !== commit || !!(await git(dir, 'status', '--porcelain'));
  if (!changed) return false;
  await git(dir, 'reset', '--hard', '-q', commit);
  await git(dir, 'clean', '-fdq');
  return true;
}

export async function newCommits(dir, base) {
  const list = await git(dir, 'log', '--oneline', `origin/${base}..HEAD`);
  return list ? list.split('\n') : [];
}

/** The subjects of the commits made since a commit, oldest first. */
export async function commitSubjects(dir, from) {
  const list = await git(dir, 'log', '--reverse', '--format=%s', `${from}..HEAD`);
  return list ? list.split('\n') : [];
}

export const changedFiles = (dir, base) => git(dir, 'diff', '--stat', `origin/${base}...HEAD`);

export async function runChecks(dir, commands = []) {
  const results = [];
  for (const command of commands) {
    const r = await run(command, [], dir, { shell: true, maxMinutes: 15 });
    results.push({ command, ok: r.code === 0, output: clip(r.output.split('\n').slice(-12).join('\n'), 1500) });
  }
  return results;
}

/** Local delivery: copies the run's branch into your own clone of the project. Nothing goes to GitHub. */
export const deliverToClone = (dir, branch, clone) => {
  refuseWhileLocked(t('delivery to your clone'));
  return git(dir, 'push', clone, `refs/heads/${branch}:refs/heads/${branch}`);
};

/** The owner's clone in which this run was delivered. */
export function localDeliveryClone(run, config) {
  const clone = config?.projects?.[run.project]?.local_clone;
  return !run.pullRequest && clone && run.delivered && path.resolve(clone) === path.resolve(run.delivered) ? clone : null;
}

/** The local delivery's state, using the base it started from even when another branch is checked out. */
export async function localBranchState(delivery, config) {
  const clone = localDeliveryClone(delivery, config);
  if (!clone || !delivery.branch || !existsSync(path.join(clone, '.git'))) return null;
  const git = (...args) => run('git', args, clone, { maxMinutes: 1 });
  const ref = `refs/heads/${delivery.branch}`;
  const refs = await git('for-each-ref', '--format=%(refname)', ref);
  if (refs.code !== 0) return null;
  const exists = refs.output.split(/\r?\n/).includes(ref);
  const tip = exists ? ref : delivery.deliveredCommit;
  if (tip) {
    const base = delivery.base ?? await baseBranch(config.projects[delivery.project]).catch(() => null);
    if (base && base !== delivery.branch && (await git('merge-base', '--is-ancestor', tip, `refs/heads/${base}`)).code === 0) return 'branch';
  }
  return exists ? null : 'deleted';
}

// ---------- No trace of Chiefmate ("no_trace", on by default with local delivery) ----------

/** Whether the project's work must not show Chiefmate to others: its branch names, commits and files. */
export const noTrace = project => !!(project?.no_trace ?? project?.deliver === 'local');

/**
 * The run's branch: chiefmate/<id>, or, with no trace, a neutral name from the title after the "deliver_branch"
 * prefix ("wip/" by default; "current" delivers onto your clone's branch, through a branch with that default name).
 */
export function runBranch(project, id, title) {
  if (!noTrace(project)) return `chiefmate/${id}`;
  const given = project.deliver_branch && project.deliver_branch !== 'current' ? String(project.deliver_branch) : 'wip/';
  const prefix = /[/_-]$/.test(given) ? given : `${given}/`;
  return `${prefix}${slug(title) || id.slice(0, 15)}`;
}

/** The name itself, or with -2, -3... when your clone already has a branch of that name. */
export async function freeBranch(clone, name) {
  for (let n = 1; n < 100; n++) {
    const candidate = n === 1 ? name : `${name}-${n}`;
    const r = await run('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`], clone);
    if (r.code !== 0) return candidate;
  }
  return `${name}-${Date.now()}`;
}

/**
 * "deliver_branch": "current": moves your clone's branch forward to the run's branch, never switching branches. Only
 * when the clone still has the run's base checked out, with no changes to tracked files, and the move is a fast
 * forward; the run's branch is then removed. Returns null when done, or why it was not.
 */
export async function advanceClone(clone, branch, base) {
  const why = await fastForward(clone, branch, base);
  if (!why) await run('git', ['branch', '-d', branch], clone);
  return why;
}

/**
 * Moves your clone's base branch forward to "ref", never switching branches nor touching your changes: only when the
 * clone has the base checked out, no changes to tracked files, and the move is a fast forward (git itself refuses to
 * overwrite an untracked file). Returns null when done, or why it was not.
 */
export async function fastForward(clone, ref, base) {
  const current = (await run('git', ['branch', '--show-current'], clone, { maxMinutes: 1 })).output.trim();
  if (current !== base) return t('your clone has {current} checked out, not {base}', { current: current || '-', base });
  const status = await run('git', ['status', '--porcelain', '--untracked-files=no'], clone, { maxMinutes: 1 });
  if (status.code !== 0 || status.output.trim()) return t('your clone has changes not committed');
  const r = await run('git', ['merge', '--ff-only', '-q', ref], clone, { maxMinutes: 2 });
  if (r.code !== 0) return t('{base} moved on in your clone: not a fast forward', { base });
  return null;
}

/** Whether two repository addresses are the same: case, a final ".git" and slashes aside (local folders too). */
export function sameRepository(a, b) {
  const norm = s => String(s ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase();
  return !!norm(a) && norm(a) === norm(b);
}

/** The reference libraries that are a copy of the project's own repository (their ids). */
export const projectLibraries = (config, id) => Object.entries(config?.library ?? {})
  .filter(([, source]) => sameRepository(source?.repository, config?.projects?.[id]?.repository)).map(([lib]) => lib);

/**
 * How far a copy is behind its origin's branch, asking the origin itself (git ls-remote; nothing is downloaded):
 * { branch, behind } with behind 0 (up to date), a count, or -1 (behind, the commits not in the copy), or null when it
 * can't be told. "branch": the one given, else the one checked out.
 */
export async function behindOrigin(dir, branch = null) {
  const name = branch || (await run('git', ['branch', '--show-current'], dir, { maxMinutes: 0.5 })).output.trim();
  if (!name) return null;
  const remote = await run('git', ['ls-remote', 'origin', `refs/heads/${name}`], dir, { maxMinutes: 0.5 });
  const sha = remote.code === 0 ? remote.output.trim().split(/\s/)[0] : '';
  if (!/^[0-9a-f]{40}$/.test(sha)) return null;
  if ((await run('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], dir, { maxMinutes: 0.5 })).code === 0) return { branch: name, behind: 0 };
  const count = await run('git', ['rev-list', '--count', `HEAD..${sha}`], dir, { maxMinutes: 0.5 });
  return { branch: name, behind: count.code === 0 ? Number(count.output.trim()) || -1 : -1 };
}

const TRACE = /chiefmate/i;
const TRACE_COMMIT = /chiefmate|co-authored-by:.*(claude|anthropic)|generated with.*claude/i;

/**
 * What in the run's work names Chiefmate: commit messages and authors, file names and added lines. Only the run's own
 * work counts: commits already on a branch of origin (such as the main branch's, merged in during the run) and the
 * lines they brought are someone else's.
 */
export async function traces(dir, base) {
  const branch = await git(dir, 'branch', '--show-current');
  // The run's branch itself may already be on origin (a pull request that failed after the push).
  const own = ['HEAD', '--not', ...(branch ? [`--exclude=refs/remotes/origin/${branch}`] : []), '--remotes', `origin/${base}`];
  const found = [];
  const log = await git(dir, 'log', '--format=%h %an <%ae> %cn <%ce>%n%B%x00', ...own);
  for (const entry of log.split('\0').map(e => e.trim()).filter(Boolean)) {
    if (TRACE_COMMIT.test(entry) || /claude|anthropic/i.test(entry.split('\n')[0])) found.push(t('commit {commit}', { commit: entry.split(' ')[0] }));
  }
  const ownCommits = new Set((await git(dir, 'rev-list', ...own)).split('\n').filter(Boolean));
  const ownFiles = new Set((await git(dir, 'log', '--name-only', '--format=', ...own)).split('\n').filter(Boolean));
  const files = (await git(dir, 'diff', '--name-only', `origin/${base}...HEAD`)).split('\n').filter(f => TRACE.test(f) && ownFiles.has(f));
  found.push(...files.map(file => t('file {file}', { file })));
  // Added lines naming Chiefmate, by file and line number in HEAD.
  let file = null;
  let number = 0;
  const lines = new Map();
  for (const line of (await git(dir, 'diff', '-U0', '--no-color', `origin/${base}...HEAD`)).split('\n')) {
    const hunk = line.match(/^@@ -\S+ \+(\d+)/);
    if (hunk) number = Number(hunk[1]);
    else if (line.startsWith('+++ ')) file = line === '+++ /dev/null' ? null : line.replace(/^\+\+\+ (b\/)?/, '');
    else if (line.startsWith('+') && file) {
      if (TRACE.test(line)) lines.set(file, [...(lines.get(file) ?? []), number]);
      number++;
    }
  }
  // Only those the run's own commits wrote (git blame), not those merged in from elsewhere.
  for (const [f, numbers] of lines) {
    const blame = await git(dir, 'blame', '-s', '-l', ...numbers.flatMap(n => ['-L', `${n},${n}`]), 'HEAD', '--', f).catch(() => '');
    const authors = blame.split('\n').map(l => l.split(' ')[0].replace(/^\^/, '')).filter(Boolean);
    if (!blame || authors.some(c => ownCommits.has(c))) found.push(t('text in {file}', { file: f }));
  }
  return found;
}

/** Pushes the branch and opens the pull request. Returns its address. */
export async function openPullRequest(dir, { base, branch, title, body, bodyFile }) {
  refuseWhileLocked(t('push and pull request'));
  await git(dir, 'push', '--force-with-lease', '-u', 'origin', branch);
  writeFileSync(bodyFile, body);
  const r = await run('gh', ['pr', 'create', '--base', base, '--head', branch, '--title', title, '--body-file', bodyFile], dir);
  const url = r.output.match(/https:\/\/github\.com\/\S+\/pull\/\d+/)?.[0];
  if (url) return url;
  // A pull request for this branch may already exist (a resumed run, for example).
  const existing = await run('gh', ['pr', 'view', branch, '--json', 'url', '-q', '.url'], dir);
  if (existing.code === 0 && existing.output.trim().startsWith('https://')) return existing.output.trim();
  throw new Error(t("Couldn't open the pull request: {output}", { output: clip(r.output, 500) }));
}
