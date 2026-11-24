// Each project's working copy (workspaces/<project>): the crew works there, never in the folder you work in.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { t } from './i18n.mjs';
import { clip, ensureDir, WORKSPACES } from './util.mjs';

/** Runs a command and returns { code, output }. With shell, it accepts "npm ci" and the like. */
export function run(command, args, dir, { shell = false, maxMinutes = 20 } = {}) {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd: dir, shell, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    let output = '';
    const collect = d => (output = (output + d).slice(-20000));
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => child.kill(), maxMinutes * 60_000);
    child.on('error', error => {
      clearTimeout(timer);
      resolve({ code: -1, output: error.message });
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

async function git(dir, ...args) {
  const r = await run('git', args, dir);
  if (r.code !== 0) throw new Error(t('git {command} failed: {output}', { command: args.join(' '), output: clip(r.output, 500) }));
  return r.output.trim();
}

export const projectDir = id => path.join(WORKSPACES, id);

/** Makes the working copy match the main branch on GitHub, and installs dependencies when they change. */
export async function prepareWorkspace(id, project, onStep = () => {}) {
  ensureDir(WORKSPACES);
  const dir = projectDir(id);
  if (!existsSync(path.join(dir, '.git'))) {
    onStep(t('Downloading the project from GitHub (first time)'));
    const r = await run('git', ['clone', '-c', 'core.longpaths=true', project.repository, dir], WORKSPACES, { maxMinutes: 15 });
    if (r.code !== 0) throw new Error(t("Couldn't download the project: {output}", { output: clip(r.output, 500) }));
  }
  onStep(t('Updating the working copy'));
  await git(dir, 'fetch', 'origin', '--prune');
  await git(dir, 'checkout', '-f', project.main_branch);
  await git(dir, 'reset', '--hard', `origin/${project.main_branch}`);
  await git(dir, 'clean', '-fd');
  if (project.setup) {
    const locks = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'].map(f => path.join(dir, f)).filter(existsSync);
    // Changes when the dependency lock file or the setup command itself changes.
    const signature = createHash('sha1').update(project.setup + locks.map(f => readFileSync(f)).join('')).digest('hex');
    const marker = path.join(dir, 'node_modules', '.chiefmate-setup');
    const ready = existsSync(marker) && readFileSync(marker, 'utf8') === signature;
    if (!ready) {
      onStep(t('Installing dependencies ({command})', { command: project.setup }));
      const r = await run(project.setup, [], dir, { shell: true, maxMinutes: 20 });
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
export async function prepareLibrary(id, source, onStep = () => {}) {
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

export const createBranch = (dir, branch) => git(dir, 'checkout', '-B', branch);
export const checkoutBranch = (dir, branch) => git(dir, 'checkout', branch);

/** If the agent left changes without committing, Chiefmate commits them on its behalf. */
export async function commitPending(dir, message) {
  if (!(await git(dir, 'status', '--porcelain'))) return false;
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-m', message);
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
