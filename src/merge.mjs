// Merging a run's work, only with the owner's authorization: the owner's click in the app, or the manager after the
// owner's explicit "yes" in the conversation for that run ("cli.mjs merge <run> --yes"). Chiefmate merges it itself, so
// "gh pr" and "git push" stay denied to the crew and the manager: a pull request through "gh pr merge"; a branch
// delivered locally, into the branch it started from in the owner's clone, with nothing sent to GitHub. Discarding the
// work (the owner's click on a decision card, src/decisions.mjs) closes the pull request, or leaves the branch unmerged.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { t } from './i18n.mjs';
import { reportEvent } from './news.mjs';
import { readRun, runDir, saveRun } from './store.mjs';
import { checkNow } from './update.mjs';
import { clip, now, ROOT } from './util.mjs';
import { baseBranch, projectDir, run as exec } from './workspace.mjs';

/** What a finished run would merge: its pull request, or its branch in the owner's clone. Throws when there is nothing. */
async function target(run, config) {
  if (!run) throw new Error(t('Run not found.'));
  if (run.merged) throw new Error(t('This run was already merged.'));
  if (run.status !== 'done') throw new Error(t('Only a finished run can be merged.'));
  if (run.pullRequest) return { kind: 'pr', url: run.pullRequest };
  if (!run.delivered) throw new Error(t('This run has nothing to merge: no pull request and no branch delivered.'));
  const project = config.projects?.[run.project];
  // Without a clone of the owner's, the branch stays in the crew's working copy, which is reset before every run.
  if (!project?.local_clone || path.resolve(project.local_clone) !== path.resolve(run.delivered)) {
    throw new Error(t('The branch {branch} is not in a clone of yours (local_clone): merge it by hand.', { branch: run.branch }));
  }
  return { kind: 'local', dir: project.local_clone, branch: run.branch, base: await baseBranch(project) };
}

/** The final review's verdict, from the pull request text Chiefmate wrote (in either language). */
export function verdict(run) {
  const file = path.join(runDir(run.id), 'pull-request.md');
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8');
  const titles = [...new Set(['en', 'pt-BR'].map(lang => t("Manager's verdict", {}, lang)))].map(s => s.replace(/[.*+?^${}()|[\]\\']/g, '\\$&'));
  const found = text.match(new RegExp(`^(#+)\\s*(?:${titles.join('|')})\\s*$`, 'im'));
  if (!found) return null;
  const after = text.slice(found.index + found[0].length);
  const end = after.search(new RegExp(`^#{1,${found[1].length}}\\s`, 'm'));
  return clip((end < 0 ? after : after.slice(0, end)).trim(), 1200) || null;
}

/** What a merge of the run would do, without doing it. */
export async function previewMerge(id, config = loadConfig()) {
  const run = readRun(String(id ?? ''));
  const where = await target(run, config);
  return {
    run: run.id, title: run.title, project: run.project, ...where,
    failedChecks: (run.checks ?? []).filter(c => !c.ok).length, verdict: verdict(run),
  };
}

const git = (dir, ...args) => exec('git', args, dir);

/** Merges the run's branch into the base branch checked out in the owner's clone, refusing anything unclear. */
async function mergeLocal({ dir, branch, base }) {
  const current = (await git(dir, 'branch', '--show-current')).output.trim();
  if (current !== base) throw new Error(t('Check out {base} in {path} first: it has {current} checked out now.', { base, path: dir, current: current || '-' }));
  const status = await git(dir, 'status', '--porcelain', '--untracked-files=no');
  if (status.code !== 0 || status.output.trim()) throw new Error(t('{path} has changes not committed: commit them or put them aside first.', { path: dir }));
  const r = await git(dir, 'merge', '--no-ff', '--no-edit', branch);
  if (r.code !== 0) {
    await git(dir, 'merge', '--abort');
    throw Object.assign(new Error(t("The branch {branch} doesn't merge cleanly into {base}: nothing was changed. {output}", { branch, base, output: clip(r.output, 400) })), { conflict: true, detail: clip(r.output, 400) });
  }
}

// gh's words for a pull request that conflicts with its base branch.
const CONFLICT = /not mergeable|cannot be cleanly created|merge conflict|conflicting/i;

/**
 * Tells the manager at once that the owner's merge failed (merge_failed), so it queues the fix of a conflict and tells
 * the owner in one line. The news carries gh's or git's own output when there is one (the error's message is in the
 * owner's language).
 */
function reportFailure(run, where, error, config) {
  const project = config.projects?.[run.project];
  const base = where?.base ?? project?.main_branch ?? 'main';
  const what = where?.kind === 'pr' ? `pull request ${where.url} (branch ${run.branch ?? '?'})`
    : `branch ${run.branch ?? '?'} into ${base} in ${where?.dir ?? run.delivered ?? '?'} (a local delivery, nothing on GitHub)`;
  const why = error.conflict ? `a conflict with ${base}. ${error.detail ?? ''}` : clip(error.detail ?? error.message, 500);
  const item = run.plan ? ` Board item #${run.plan}.` : '';
  return reportEvent('merge_failed', `The owner's Approve of run ${run.id} "${run.title}" (project ${run.project}) failed: ${what}. Cause: ${error.conflict ? '' : 'not a conflict: '}${why.trim()}${item}`, { config, urgent: true });
}

/**
 * Merges a finished run's work. "by" says whose authorization it was: "owner" (the app) or "manager" (after the
 * owner's explicit yes). A merged pull request of Chiefmate itself is installed at once (checkNow). When the owner's
 * merge fails, the manager hears of it at once and the error says so.
 */
export async function mergeRun(id, { by = 'owner' } = {}, config = loadConfig()) {
  const run = readRun(String(id ?? ''));
  const where = await target(run, config);
  try {
    if (where.kind === 'pr') {
      const dir = existsSync(projectDir(run.project)) ? projectDir(run.project) : ROOT;
      const r = await exec('gh', ['pr', 'merge', where.url, '--merge'], dir);
      if (r.code !== 0) {
        throw Object.assign(new Error(t("GitHub didn't merge the pull request: {output}", { output: clip(r.output, 500) })), { conflict: CONFLICT.test(r.output), detail: clip(r.output, 500) });
      }
    } else {
      await mergeLocal(where);
    }
  } catch (error) {
    // The manager knows when its own merge fails: only the owner's is news to it.
    if (by !== 'manager' && reportFailure(run, where, error, config)) error.message += ` ${t('The manager was told and takes care of it.')}`;
    throw error;
  }
  run.merged = { at: now(), by: by === 'manager' ? 'manager' : 'owner', how: where.kind };
  saveRun(run);
  // The manager knows what it merged itself: only a merge from the app is news to it.
  if (run.merged.by === 'owner') {
    const what = where.kind === 'pr' ? `pull request ${where.url}` : `branch ${where.branch} into ${where.base} in ${where.dir} (nothing sent to GitHub)`;
    reportEvent('merged', `The owner merged run ${run.id} "${run.title}" (project ${run.project}) from the app: ${what}.`);
  }
  if (where.kind === 'pr') checkNow().catch(error => console.error('Update check:', error.message));
  return { run: run.id, ...where, merged: run.merged };
}

/**
 * Discards a finished run's work on the owner's click: its pull request is closed on GitHub (it can be reopened there,
 * and its branch stays); a local branch is left in the owner's clone, unmerged. Then "run.discarded".
 */
export async function discardRun(id, config = loadConfig()) {
  const run = readRun(String(id ?? ''));
  const where = await target(run, config).catch(error => {
    // A local branch outside the owner's clone can still be discarded: nothing is touched.
    if (run && !run.merged && run.status === 'done' && run.delivered) return { kind: 'local', branch: run.branch };
    throw error;
  });
  if (where.kind === 'pr') {
    const dir = existsSync(projectDir(run.project)) ? projectDir(run.project) : ROOT;
    const r = await exec('gh', ['pr', 'close', where.url], dir);
    if (r.code !== 0 && !/already closed/i.test(r.output)) throw new Error(t("GitHub didn't close the pull request: {output}", { output: clip(r.output, 500) }));
  }
  run.discarded = { at: now(), by: 'owner', how: where.kind };
  saveRun(run);
  return { run: run.id, ...where, discarded: run.discarded };
}
