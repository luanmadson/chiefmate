// Each project's working copy (workspaces/<project>): the crew works there, never in the folder you work in.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { t } from './i18n.mjs';
import { clip, ensureDir, WORKSPACES } from './util.mjs';

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
  if (project.setup) {
    const locks = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'].map(f => path.join(dir, f)).filter(existsSync);
    // Changes when the dependency lock file or the setup command itself changes.
    const signature = createHash('sha1').update(project.setup + locks.map(f => readFileSync(f)).join('')).digest('hex');
    const marker = path.join(dir, 'node_modules', '.chiefmate-setup');
    const ready = existsSync(marker) && readFileSync(marker, 'utf8') === signature;
    if (!ready) {
      onStep(t('Installing dependencies ({command})', { command: project.setup }));
      const r = await run(project.setup, [], dir, { shell: true, maxMinutes: 20, signal });
      signal?.throwIfAborted();
      if (r.code !== 0) throw new Error(t('"{command}" failed: {output}', { command: project.setup, output: clip(r.output, 500) }));
      if (existsSync(path.join(dir, 'node_modules'))) writeFileSync(marker, signature);
    }
  }
  return dir;
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
export const checkoutBranch = (dir, branch) => git(dir, 'checkout', branch);

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
export const deliverToClone = (dir, branch, clone) => git(dir, 'push', clone, `refs/heads/${branch}:refs/heads/${branch}`);

/** Pushes the branch and opens the pull request. Returns its address. */
export async function openPullRequest(dir, { base, branch, title, body, bodyFile }) {
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
