// Merging a run's work, only with the owner's authorization: the owner's click in the app, or the manager after the
// owner's explicit "yes" in the conversation for that run ("cli.mjs merge <run> --yes"). Chiefmate merges it itself, so
// "gh pr" and "git push" stay denied to the crew and the manager: a pull request through "gh pr merge"; a branch
// delivered locally, into the branch it started from in the owner's clone, with nothing sent to GitHub. Discarding the
// work (the owner's click on a decision card, src/decisions.mjs) closes the pull request, or leaves the branch unmerged.
// After a merge, the copies the owner reads are brought up to date (refreshCopies): the project's reference library,
// and the owner's clone only by a fast forward, never touching their changes.
// A pull request replaced by a newer run's is closed with "cli.mjs close-pr <run> --replaced-by <run>" (closeReplaced).
// A local merge into a clone with changes not committed is refused, unless the merge asks to save them first
// ("savePending", "cli.mjs merge <run> --yes --save-pending"): only the tracked files changed, in one commit with a
// neutral message, and only when neither they nor the branch conflict (savePendingFirst). Nothing leaves the computer.
// A merge that fails is kept on the run ("mergeFailed"), so its card shows it and never tries again by itself, and the
// pull requests still waiting are checked again after every merge into their base branch (checkDeliveries): the fix of
// a conflict is queued once, by Chiefmate (queueFix).
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { loadConfig, projectCrew } from './config.mjs';
import { t } from './i18n.mjs';
import { LEAD } from './leads.mjs';
import { isLocked, refuseWhileLocked } from './lockdown.mjs';
import { reportEvent } from './news.mjs';
import { nudgeQueue } from './queue.mjs';
import { createRun, setRunFields } from './runs.mjs';
import { listRuns, readRun, runDir, saveRun, settleRunOutside } from './store.mjs';
import { projectClone } from './sessions.mjs';
import { checkNow } from './update.mjs';
import { clip, now, ROOT, WORKSPACES } from './util.mjs';
import { baseBranch, fastForward, localBranchState, localDeliveryClone, prepareLibrary, projectDir, projectLibraries, run as exec } from './workspace.mjs';

/** What a finished run would merge: its pull request, or its branch in the owner's clone. Throws when there is nothing. */
async function target(run, config) {
  if (!run) throw new Error(t('Run not found.'));
  if (run.merged) throw new Error(t('This run was already merged.'));
  if (run.status !== 'done') throw new Error(t('Only a finished run can be merged.'));
  if (run.pullRequest) return { kind: 'pr', url: run.pullRequest };
  if (!run.delivered) throw new Error(t('This run has nothing to merge: no pull request and no branch delivered.'));
  const project = config.projects?.[run.project];
  // Without a clone of the owner's, the branch stays in the crew's working copy, which is reset before every run.
  const dir = localDeliveryClone(run, config);
  if (!dir) {
    throw new Error(t('The branch {branch} is not in a clone of yours (local_clone): merge it by hand.', { branch: run.branch }));
  }
  return { kind: 'local', dir, branch: run.branch, base: run.base ?? await baseBranch(project) };
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

/** The delivery may have settled since the app last drew its Approve button. */
async function resolveLocal(run, config) {
  if (run?.status !== 'done' || run.pullRequest || !run.delivered) return null;
  if (!run.merged && !run.discarded) {
    const state = await localBranchState(run, config);
    if (!state) return null;
    run = settleRunOutside(run, state);
  }
  const outcome = run?.merged ?? run?.discarded;
  if (outcome?.by !== 'outside' || outcome.how !== 'local') return null;
  return { run: run.id, kind: 'local', branch: run.branch, merged: run.merged, discarded: run.discarded };
}

// The message of the commit that saves the clone's changes before a merge: neutral, as the owner would write it.
export const SAVE_MESSAGE = 'Save local changes before merge';

/**
 * Saves the clone's changes to tracked files in one commit before a merge (never the untracked files), after making
 * sure nothing conflicts: no merge or rebase under way, no file left unmerged, and the changes merge cleanly with the
 * branch (checked on a snapshot, "git stash create", which touches neither the files nor the branches). Returns
 * { commit, files }, or throws with nothing changed.
 */
export async function savePendingFirst({ dir, branch }) {
  const status = await git(dir, 'status', '--porcelain', '--untracked-files=no');
  if (status.code !== 0) throw new Error(t("Couldn't read the state of {path}: {output}", { path: dir, output: clip(status.output, 300) }));
  // git's output comes with its warnings (line endings, say): only the lines that are what was asked count.
  const lines = status.output.split(/\r?\n/).filter(l => /^[ MADRCTU]{2} /.test(l));
  const object = output => output.match(/^[0-9a-f]{40,64}$/m)?.[0] ?? '';
  const gitDir = (await git(dir, 'rev-parse', '--absolute-git-dir')).output.trim();
  const busy = ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'].some(marker => existsSync(path.join(gitDir, marker)));
  if (busy || lines.some(l => /^(?:U.|.U|AA|DD)\s/.test(l))) {
    throw Object.assign(new Error(t('{path} has a merge or another operation under way, or files in conflict: nothing was saved or merged.', { path: dir })), { conflict: true });
  }
  const files = lines.map(l => l.slice(3).replace(/^.* -> /, '').replace(/^"|"$/g, ''));
  const snapshot = object((await git(dir, 'stash', 'create')).output);
  if (!snapshot) return { commit: null, files: [] };
  const check = await git(dir, 'merge-tree', '--write-tree', '--name-only', snapshot, `refs/heads/${branch}`);
  if (check.code !== 0) {
    const said = check.output.split(/\r?\n/).filter(l => l.trim() && !/^warning:/.test(l) && !/^[0-9a-f]{40,64}$/.test(l));
    const detail = clip(said.join(' ').trim() || check.output, 400);
    throw Object.assign(new Error(t('Your changes in {path} conflict with the branch {branch}: nothing was saved or merged. {output}', { path: dir, branch, output: detail })), { conflict: true, detail });
  }
  const saved = await git(dir, 'commit', '-a', '-q', '-m', SAVE_MESSAGE);
  if (saved.code !== 0) throw new Error(t("Couldn't save the changes of {path}: {output}", { path: dir, output: clip(saved.output, 300) }));
  return { commit: object((await git(dir, 'rev-parse', 'HEAD')).output), files };
}

/**
 * Merges the run's branch into the base branch checked out in the owner's clone, refusing anything unclear. With
 * savePending, the clone's changes to tracked files are saved in a commit first (savePendingFirst). Returns { saved }.
 */
async function mergeLocal({ dir, branch, base }, { savePending = false } = {}) {
  const current = (await git(dir, 'branch', '--show-current')).output.trim();
  if (current !== base) throw new Error(t('Check out {base} in {path} first: it has {current} checked out now.', { base, path: dir, current: current || '-' }));
  const status = await git(dir, 'status', '--porcelain', '--untracked-files=no');
  let saved = null;
  if (status.code !== 0 || status.output.trim()) {
    if (!savePending || status.code !== 0) throw Object.assign(new Error(t('{path} has changes not committed: commit them or put them aside first.', { path: dir })), { pending: true });
    saved = await savePendingFirst({ dir, branch });
  }
  const r = await git(dir, 'merge', '--no-ff', '--no-edit', `refs/heads/${branch}`);
  if (r.code !== 0) {
    await git(dir, 'merge', '--abort');
    const kept = saved?.commit ? ` ${t('Your changes stay saved in the commit {commit}.', { commit: saved.commit.slice(0, 7) })}` : '';
    throw Object.assign(new Error(t("The branch {branch} doesn't merge cleanly into {base}: nothing was changed. {output}", { branch, base, output: clip(r.output, 400) }) + kept), { conflict: true, detail: clip(r.output, 400) });
  }
  return { saved };
}

// gh's words for a pull request that conflicts with its base branch.
const CONFLICT = /not mergeable|cannot be cleanly created|merge conflict|conflicting/i;

/** The branch a run's work goes into: the one it started from, else the project's main branch. */
const baseOf = (run, config, where = null) => where?.base ?? run.base
  ?? (config.projects?.[run.project]?.main_branch && config.projects[run.project].main_branch !== 'current' ? config.projects[run.project].main_branch : 'main');

/** What the news says of a conflict's fix: queued now, already there, or not queued (the manager then queues it). */
function fixNews(fixed, conflict) {
  const f = fixed?.fix;
  if (f) {
    const approved = f.ownerApproved ? ", marked as approved by the owner (merge it yourself after your review)" : '';
    return fixed.queued ? ` Chiefmate queued its fix at once: run ${f.id} "${f.title}" (level ${f.level ?? '?'})${approved}; don't queue another.`
      : ` Its fix is already there (${f.status}): run ${f.id} "${f.title}"${approved}; don't queue another.`;
  }
  return conflict ? ` Chiefmate could not queue its fix${fixed?.error ? ` (${fixed.error})` : ''}: queue it yourself.` : '';
}

/**
 * Tells the manager at once that the owner's merge failed (merge_failed), with the fix of a conflict Chiefmate queued
 * (fixed), so it tells the owner in one line. The news carries gh's or git's own output when there is one (the error's
 * message is in the owner's language).
 */
function reportFailure(run, where, error, config, fixed = null) {
  const base = baseOf(run, config, where);
  const what = where?.kind === 'pr' ? `pull request ${where.url} (branch ${run.branch ?? '?'})`
    : `branch ${run.branch ?? '?'} into ${base} in ${where?.dir ?? run.delivered ?? '?'} (a local delivery, nothing on GitHub)`;
  const why = error.conflict ? `a conflict with ${base}. ${error.detail ?? ''}` : clip(error.detail ?? error.message, 500);
  const item = `${run.plan ? ` Board item #${run.plan}.` : ''} Level ${run.level ?? '?'}.`;
  return reportEvent('merge_failed', `The owner's Approve of run ${run.id} "${run.title}" (project ${run.project}) failed: ${what}. Cause: ${error.conflict ? '' : 'not a conflict: '}${why.trim()}${item}${fixNews(fixed, error.conflict)}`, { config, urgent: true });
}

/** The files in conflict that git or gh named in its output ("CONFLICT (content): Merge conflict in <file>"). */
const conflictFiles = output => [...new Set([...String(output ?? '').matchAll(/Merge conflict in (.+?)\s*$/gm)].map(m => m[1].trim()))];

/**
 * Keeps a merge that failed on the run ("mergeFailed": when, by whom, how, into which branch, whether it was a
 * conflict, and why), so its card shows it and a new click doesn't try again, and queues the fix of a conflict. The
 * owner's Approve goes with that fix (queueFix's "approved"). Returns queueFix's { fix, queued }, or { fix: null }.
 */
function recordFailure(run, where, error, by, config) {
  const fresh = readRun(run.id) ?? run;
  const failed = {
    at: now(), by: by === 'manager' ? 'manager' : 'owner', how: where?.kind ?? null, base: baseOf(run, config, where),
    conflict: !!error.conflict, why: clip(String(error.detail ?? error.message).replace(/\s*[.]\s*$/, ''), 300),
  };
  fresh.mergeFailed = failed;
  saveRun(fresh);
  if (!failed.conflict) return { fix: null };
  try {
    return queueFix(fresh, { base: failed.base, files: conflictFiles(error.detail), approved: failed.by === 'owner' ? { at: failed.at } : null, config });
  } catch (e) {
    console.error(`Merge: the fix of ${run.id}:`, e.message);
    return { fix: null, error: e.message };
  }
}

/**
 * After a merge, the copies the owner reads: each reference library that copies the project's repository is updated
 * (it only follows its origin), and, for a pull request, the owner's clone moves forward to the merged base branch when
 * it is a fast forward with nothing of theirs in the way. Chiefmate's own installation updates itself (src/update.mjs).
 * Returns { done: [what was updated], skipped: [why something was not] }; it never throws.
 */
export async function refreshCopies(run, where, config = loadConfig(), { library = prepareLibrary, workspaces = WORKSPACES } = {}) {
  const result = { done: [], skipped: [] };
  const project = config.projects?.[run.project];
  if (!project) return result;
  for (const id of projectLibraries(config, run.project)) {
    const name = config.library[id].name ?? id;
    if (!existsSync(path.join(workspaces, '.library', id, '.git'))) continue;
    try {
      await library(id, config.library[id]);
      result.done.push(t('the library {name}', { name }));
    } catch (error) {
      result.skipped.push(t('the library {name} was not updated: {error}', { name, error: clip(error.message, 200) }));
    }
  }
  const clone = where.kind === 'pr' ? projectClone(project) : null;
  // A local delivery was merged in the clone itself; the installation and the crew's copy are not the owner's to read.
  if (clone && ![ROOT, projectDir(run.project)].some(d => path.resolve(d).toLowerCase() === clone.toLowerCase())) {
    const base = run.base ?? (project.main_branch && project.main_branch !== 'current' ? project.main_branch : null);
    const fetched = base ? await exec('git', ['fetch', '-q', 'origin', base], clone, { maxMinutes: 2 }) : { code: 1, output: 'no base branch' };
    const why = fetched.code !== 0 ? t("couldn't fetch {base}: {output}", { base: base ?? '-', output: clip(fetched.output, 200) }) : await fastForward(clone, 'FETCH_HEAD', base);
    if (why) result.skipped.push(t('Your clone ({path}) was not updated: {why}. Update it yourself when you can.', { path: clone, why }));
    else result.done.push(t('your clone'));
  }
  return result;
}

/**
 * Merges a finished run's work. "by" says whose authorization it was: "owner" (the app) or "manager" (after the
 * owner's explicit yes). A merged pull request of Chiefmate itself is installed at once (checkNow). When the owner's
 * merge fails, the manager hears of it at once and the error says so.
 */
export async function mergeRun(id, { by = 'owner', savePending = false } = {}, config = loadConfig()) {
  refuseWhileLocked(t('merge'));
  const run = readRun(String(id ?? ''));
  const settled = await resolveLocal(run, config);
  if (settled) return settled;
  const where = await target(run, config);
  let saved = null;
  try {
    if (where.kind === 'pr') {
      const dir = existsSync(projectDir(run.project)) ? projectDir(run.project) : ROOT;
      const r = await exec('gh', ['pr', 'merge', where.url, '--merge'], dir);
      if (r.code !== 0) {
        throw Object.assign(new Error(t("GitHub didn't merge the pull request: {output}", { output: clip(r.output, 500) })), { conflict: CONFLICT.test(r.output), detail: clip(r.output, 500) });
      }
    } else {
      ({ saved } = await mergeLocal(where, { savePending }));
    }
  } catch (error) {
    if (where.kind === 'local') {
      const settled = await resolveLocal(run, config);
      if (settled) return settled;
    }
    const fixed = recordFailure(run, where, error, by, config);
    if (fixed.queued) nudgeQueue();
    const fix = fixed.fix ? ` ${t('Chiefmate queued the fix of the conflict: "{title}". Its card shows how it goes.', { title: fixed.fix.title })}` : '';
    // The manager knows when its own merge fails: only the owner's is news to it.
    if (by !== 'manager' && reportFailure(run, where, error, config, fixed)) {
      error.message += fix || ` ${error.conflict ? t('The manager was told and queues the fix.') : t('The manager was told and will say what to do.')}`;
    } else error.message += fix;
    throw error;
  }
  run.merged = { at: now(), by: by === 'manager' ? 'manager' : 'owner', how: where.kind, ...(saved?.commit ? { saved } : {}) };
  saveRun(run);
  if (where.kind === 'pr') {
    checkNow().catch(error => console.error('Update check:', error.message));
    // The pull requests still waiting may no longer merge cleanly into the base branch that just moved.
    checkSoon(run.project);
  }
  const copies = await refreshCopies(run, where, config);
  // The manager knows what it merged itself: only a merge from the app is news to it.
  if (run.merged.by === 'owner') {
    const what = where.kind === 'pr' ? `pull request ${where.url}` : `branch ${where.branch} into ${where.base} in ${where.dir} (nothing sent to GitHub)`;
    reportEvent('merged', `The owner merged run ${run.id} "${run.title}" (project ${run.project}) from the app: ${what}.${saved?.commit ? ` ${savedLine(saved, where.dir)}` : ''}${copies.skipped.length ? ` Not updated after it: ${copies.skipped.join(' ')}` : ''}`);
  }
  return { run: run.id, ...where, merged: run.merged, saved, savedNote: saved?.commit ? savedLine(saved, where.dir) : '', copies, copiesNote: copies.skipped.join(' ') };
}

/** The line of the merge's answer and report about the changes saved before it. */
export const savedLine = (saved, dir) => t('Before the merge, your changes to {count} tracked file(s) in {path} were saved in the commit {commit} ("{message}"): {files}. Files not tracked were left as they were; nothing was sent anywhere.', {
  count: saved.files.length, path: dir, commit: saved.commit.slice(0, 7), message: SAVE_MESSAGE, files: clip(saved.files.join(', '), 300),
});

/**
 * Discards a finished run's work on the owner's click: its pull request is closed on GitHub (it can be reopened there,
 * and its branch stays); a local branch is left in the owner's clone, unmerged. Then "run.discarded".
 */
export async function discardRun(id, config = loadConfig()) {
  refuseWhileLocked(t('closing a pull request'));
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

/** A pull request's number, from its address. */
export const prNumber = url => /\/pull\/(\d+)/.exec(String(url ?? ''))?.[1] ?? null;

/**
 * Why the newer run replaces the old one, or throws: both finished, of the same project, the old one's pull request
 * neither merged nor closed, the newer one's still alive, and the newer run either works on the same board item or its
 * instruction names the old run (its id, branch or pull request), as the fix of a conflict does.
 */
/** What in a run's instruction names the old run (its id, branch, pull request, or "PR #<n>"), or null. */
function namedIn(text, old) {
  const number = prNumber(old.pullRequest);
  return [old.id, old.branch, old.pullRequest].filter(Boolean).find(s => text.includes(s))
    ?? (number && new RegExp(`(PR|pull request) #${number}\\b`, 'i').test(text) ? `#${number}` : null);
}

function replacement(old, newer) {
  if (!old || !newer) throw new Error(t('Run not found.'));
  if (old.id === newer.id) throw new Error(t('A run does not replace itself.'));
  if (!old.pullRequest) throw new Error(t('The run {run} has no pull request to close.', { run: old.id }));
  if (old.merged) throw new Error(t('This run was already merged.'));
  if (old.discarded) throw new Error(t('The pull request of {run} was already closed.', { run: old.id }));
  if (newer.project !== old.project) throw new Error(t('{new} is of another project: it does not replace {old}.', { new: newer.id, old: old.id }));
  if (newer.status !== 'done' || !newer.pullRequest || newer.discarded) {
    throw new Error(t('{new} has no pull request still open or merged: nothing replaces {old} yet.', { new: newer.id, old: old.id }));
  }
  if (old.plan && old.plan === newer.plan) return `the same board item, #${old.plan}`;
  const named = newer.fixOf === old.id ? old.id : namedIn(String(newer.instruction ?? ''), old);
  if (named) return `its instruction names ${named}`;
  throw new Error(t('Nothing says {new} replaces {old}: neither the same board item nor its instruction naming the old run.', { new: newer.id, old: old.id }));
}

/** What closing a replaced run's pull request would do, without doing it. */
export function previewClose(id, replacedBy) {
  const old = readRun(String(id ?? ''));
  const newer = readRun(String(replacedBy ?? ''));
  const why = replacement(old, newer);
  return { run: old.id, title: old.title, project: old.project, url: old.pullRequest, replacedBy: newer.id, newUrl: newer.pullRequest, newTitle: newer.title, why };
}

/**
 * Closes a run's pull request on GitHub, with a comment naming the one that replaces it, only when a newer run's pull
 * request does (see replacement). "by" is who asked: "manager" or "owner". The branch stays and the pull request can be
 * reopened there; the run is marked discarded, with who asked and what replaced it, so its card settles.
 */
export async function closeReplaced(id, replacedBy, { by = 'owner' } = {}, config = loadConfig()) {
  refuseWhileLocked(t('closing a pull request'));
  const p = previewClose(id, replacedBy);
  const who = by === 'manager' ? 'manager' : 'owner';
  const comment = `Replaced by ${p.newUrl} (Chiefmate run ${p.replacedBy}): ${p.why}. Closed by Chiefmate at the ${who}'s request; the branch stays and this pull request can be reopened.`;
  const dir = existsSync(projectDir(p.project)) ? projectDir(p.project) : ROOT;
  const r = await exec('gh', ['pr', 'close', p.url, '--comment', comment], dir);
  if (r.code !== 0 && !/already closed/i.test(r.output)) throw new Error(t("GitHub didn't close the pull request: {output}", { output: clip(r.output, 500) }));
  const run = readRun(p.run);
  run.discarded = { at: now(), by: who, how: 'pr', replacedBy: p.replacedBy };
  saveRun(run);
  // The manager knows what it closed itself: only the owner's is news to it.
  if (who === 'owner') reportEvent('owner_decided', `The owner closed pull request ${p.url} of run ${p.run} "${p.title}" (project ${p.project}): replaced by ${p.newUrl} (run ${p.replacedBy}).`, { config });
  return { ...p, discarded: run.discarded };
}

// ---------- A delivery that no longer merges: the fix of its conflict ----------

/**
 * The fix of a run's conflict, the newest: a run queued for it ("fixOf"), or one of the same project queued since the
 * run ended whose instruction names it (the manager's). Never a canceled one. Null when there is none.
 */
export function fixFor(old, runs = listRuns()) {
  const since = String(old.ended ?? old.created ?? '');
  return runs
    .filter(r => r.id !== old.id && r.status !== 'canceled' && (r.fixOf === old.id
      || (!r.fixOf && r.project === old.project && String(r.created ?? '') >= since && !!namedIn(String(r.instruction ?? ''), old))))
    .sort((a, b) => String(b.created ?? '').localeCompare(String(a.created ?? '')))[0] ?? null;
}

/**
 * Where a fix stands, for the old run's card: queued, running, ready (its work waits), merged, stopped (it failed or was
 * discarded: the manager's to settle), or "manager" (none yet).
 */
export function fixState(fix) {
  if (!fix) return 'manager';
  if (['queued', 'waiting'].includes(fix.status)) return 'queued';
  if (fix.status === 'done') return fix.merged ? 'merged' : fix.discarded ? 'stopped' : 'ready';
  return fix.status === 'failed' ? 'stopped' : 'running';
}

/** The standard instruction of a conflict's fix: bring the old branch in, solve it reading both sides, run the checks. */
function fixInstruction(old, { base, files, clone }) {
  const where = old.pullRequest ? `its pull request ${old.pullRequest} (branch ${old.branch})` : `its branch ${old.branch}, delivered to ${clone}`;
  const listed = files.length ? ` (files in conflict: ${files.slice(0, 20).join(', ')}${files.length > 20 ? ', and more' : ''})` : '';
  return [
    `Fix the conflict of run ${old.id} "${old.title}": ${where} no longer merges cleanly into ${base}${listed}.`,
    `Bring that branch into this run's own: ${old.pullRequest ? `git fetch origin ${old.branch}` : `git fetch "${clone}" ${old.branch}`}, then git merge FETCH_HEAD (never a rebase or a squash: its commits stay as they are).`,
    `Solve each conflict reading both sides: keep what the branch meant to do and what ${base} brought since, and drop neither without saying why in your report.`,
    "Then run the project's checks and tests, and fix what fails.",
    old.pullRequest ? `This run's work replaces the old one: once it is merged, the old pull request shows as merged by itself, since its commits are in ${base}.`
      : "This run's work replaces the old one: once its branch is merged, the old branch settles by itself.",
  ].join(' ');
}

/**
 * Queues the fix of a run's conflict with its base branch, unless it has one (fixFor): a task with the manager's review,
 * at the run's level and for its board item. "approved" ({ at }: the owner's Approve that failed on the conflict) goes
 * with it ("ownerApproved"), so the manager merges it after its review; a fix already there and not ended gets it too.
 * Returns { fix, queued }.
 */
export function queueFix(old, { base, files = [], approved = null, config = loadConfig(), runs = listRuns() } = {}) {
  const mark = approved ? { run: old.id, at: approved.at } : null;
  const existing = fixFor(old, runs);
  if (existing) {
    const open = !existing.merged && !existing.discarded && !['failed', 'canceled'].includes(existing.status);
    return { fix: mark && open && !existing.ownerApproved ? setRunFields(existing.id, { ownerApproved: mark }) : existing, queued: false };
  }
  const crew = projectCrew(config, old.project);
  const agent = crew.generalist ? 'generalist' : Object.keys(crew).find(a => a !== 'manager' && a !== LEAD);
  const number = prNumber(old.pullRequest);
  const what = number ? `PR #${number}` : t('branch {branch}', { branch: old.branch ?? '-' });
  const fix = createRun({
    kind: 'task', projectId: old.project, agent, review: true, origin: 'conflict', plan: old.plan ?? null, level: old.level ?? null,
    instruction: fixInstruction(old, { base: base ?? baseOf(old, config), files, clone: old.pullRequest ? null : localDeliveryClone(old, config) ?? old.delivered }),
    title: t('{project}: {what} ({title}) without conflict', { project: config.projects?.[old.project]?.name ?? old.project, what, title: clip(old.title, 28) }),
    summary: t('Brings {what} up to date with {base} and solves its conflict, so it can be merged; this work replaces it.', { what, base: base ?? baseOf(old, config) }),
    fixOf: old.id, ownerApproved: mark,
  }, config);
  return { fix, queued: true };
}

// The checks: a bare copy of each project's repository of their own (commits and trees; the files a merge needs come
// when it needs them), never the crew's working copy, which a run may be using.
const CHECK_EVERY = 5 * 60_000;
const WAITING_FOR = 30 * 24 * 3600_000; // as long as a delivery can wait (src/attention.mjs)
let checking = null;
let checkAgain = false;

async function checkCopy(id, repository, workspaces) {
  const dir = path.join(workspaces, '.merge-check', id);
  if (existsSync(path.join(dir, 'HEAD'))) return dir;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.dirname(dir), { recursive: true });
  const r = await exec('git', ['clone', '--bare', '--no-tags', '--filter=blob:none', '-c', 'core.longpaths=true', repository, dir], path.dirname(dir), { maxMinutes: 10 });
  if (r.code !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`git clone: ${clip(r.output, 300)}`);
  }
  return dir;
}

/** The branches of a repository and their commits, read on its origin without fetching anything. */
async function remoteHeads(repository, cwd) {
  const r = await exec('git', ['ls-remote', '--heads', repository], cwd, { maxMinutes: 2 });
  if (r.code !== 0) throw new Error(`git ls-remote: ${clip(r.output, 300)}`);
  return new Map(r.output.split(/\r?\n/).map(l => /^([0-9a-f]{40,64})\s+refs\/heads\/(.+)$/.exec(l.trim())).filter(Boolean).map(m => [m[2], m[1]]));
}

/** Whether the commit "head" merges cleanly into "base" (git merge-tree, which touches no files): { clean, files }, or null. */
export async function mergesCleanly(dir, base, head) {
  const r = await exec('git', ['merge-tree', '--write-tree', '--name-only', '--no-messages', base, head], dir, { maxMinutes: 5 });
  // The merged tree first, then the files in conflict; anything else (a commit git can't find exits with 1 too) is no answer.
  const lines = r.output.split(/\r?\n/).map(l => l.trim()).filter(l => l && !/^(warning|hint|remote):/i.test(l));
  if (![0, 1].includes(r.code) || !/^[0-9a-f]{40,64}$/.test(lines[0] ?? '')) return null;
  return r.code === 0 ? { clean: true, files: [] } : { clean: false, files: [...new Set(lines.slice(1))] };
}

/**
 * Checks again the pull requests waiting for the owner whose branch or base branch moved since their last check
 * ("run.mergeCheck"): one that no longer merges cleanly is marked ("run.conflict", with its files) and gets its fix
 * (queueFix, once, told to the manager as "conflict" news); one that merges again loses the mark. Only "project"'s
 * when given. Never throws: returns what it found, [{ run, clean, files, fix, queued }].
 */
export async function checkDeliveries({ config = loadConfig(), project = null, workspaces = WORKSPACES } = {}) {
  const found = [];
  const waiting = listRuns().filter(r => r.status === 'done' && r.pullRequest && r.branch && !r.merged && !r.discarded
    && (!project || r.project === project) && config.projects?.[r.project]?.repository && config.projects[r.project].merge_by_owner !== false
    && Date.now() - Date.parse(r.ended ?? r.created ?? 0) < WAITING_FOR);
  for (const [id, runs] of Map.groupBy(waiting, r => r.project)) {
    try {
      const repository = config.projects[id].repository;
      const heads = await remoteHeads(repository, existsSync(workspaces) ? workspaces : ROOT);
      let dir = null;
      for (const r of runs) {
        const base = baseOf(r, config);
        const tips = { base: heads.get(base), head: heads.get(r.branch) };
        if (!tips.base || !tips.head || (r.mergeCheck?.base === tips.base && r.mergeCheck?.head === tips.head)) continue;
        dir ??= await checkCopy(id, repository, workspaces);
        const fetched = await exec('git', ['fetch', '-q', '--no-tags', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`, `+refs/heads/${r.branch}:refs/remotes/origin/${r.branch}`], dir, { maxMinutes: 5 });
        if (fetched.code !== 0) throw new Error(`git fetch: ${clip(fetched.output, 300)}`);
        const result = await mergesCleanly(dir, tips.base, tips.head);
        const fresh = result && readRun(r.id);
        if (!fresh || fresh.merged || fresh.discarded) continue;
        const known = !!fresh.conflict;
        fresh.mergeCheck = { at: now(), base: tips.base, head: tips.head, clean: result.clean };
        if (result.clean) delete fresh.conflict;
        else fresh.conflict = { at: fresh.conflict?.at ?? now(), base, files: result.files.slice(0, 50) };
        saveRun(fresh);
        const fixed = result.clean ? {} : queueFix(fresh, { base, files: result.files, config });
        if (fixed.queued) nudgeQueue();
        if (!result.clean && !known) {
          const files = result.files.length ? ` (files in conflict: ${clip(result.files.join(', '), 300)})` : '';
          reportEvent('conflict', `Pull request ${fresh.pullRequest} of run ${fresh.id} "${fresh.title}" (project ${id}, level ${fresh.level ?? '?'}) no longer merges cleanly into ${base}${files}, after ${base} moved. Its card in Decisions shows it in conflict, with no Approve.${fixNews(fixed, true)}`, { config });
        }
        found.push({ run: fresh.id, clean: result.clean, files: result.files, fix: fixed.fix?.id ?? null, queued: !!fixed.queued });
      }
    } catch (error) {
      console.error(`Merge check (${id}):`, error.message);
    }
  }
  return found;
}

/** checkDeliveries in the background, one at a time (once more after the one going on, when asked meanwhile). */
export function checkSoon(project = null) {
  if (process.env.CHIEFMATE_SMOKE || isLocked()) return null;
  if (checking) {
    checkAgain = true;
    return checking;
  }
  checking = checkDeliveries({ project })
    .catch(error => console.error('Merge check:', error.message))
    .finally(() => {
      checking = null;
      if (checkAgain) {
        checkAgain = false;
        checkSoon();
      }
    });
  return checking;
}

/** The server's checks: soon after it starts, then every CHECK_EVERY (a merge seen on GitHub shows there). */
export function startMergeChecks() {
  if (process.env.CHIEFMATE_SMOKE) return;
  setTimeout(() => checkSoon(), 60_000).unref?.();
  setInterval(() => checkSoon(), CHECK_EVERY).unref?.();
}
