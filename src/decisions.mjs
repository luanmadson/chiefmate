// The owner's decisions as cards, decided with one click: a pull request or a branch to merge, a proposal the manager
// triaged, and a question the manager asked (cli.mjs ask-owner), answered with an option, in the owner's own words, or
// both. Each card says what it is, what changes if approved, the risk and the manager's recommendation, with the
// project beside its number ("PR #34 of Chiefmate").
// Cards are built from the attention notices (src/attention.mjs), so a card leaves when its notice does. "Not now"
// marks the notice as seen (the card fades to the end of the list); every decision reaches the manager as news
// ("owner_decided"; a merge is "merged" news, src/merge.mjs). A project whose work someone else reviews
// ("merge_by_owner": false) shows its pull requests as waiting for that review, with no Approve. A push the manager
// tried and the guard refused becomes a card too: the owner allows that one push (src/guard.mjs, takeGrant) or refuses it.
// So does a private repository the manager asks to create (cli.mjs repo-create; see repoCreate).
// Every click is on record (recordDecision in src/store.mjs): who, when, from where, from what to what. What has had
// no effect yet can be undone (undoDecision): the card comes back for another answer. A merge or a discard can't.
// Each card carries the approval level the manager gave its run, item or question ("approval": 1, the manager
// decides and does it; 2, the owner approves; 3, never without the owner; null, not given). The app folds the level 1
// cards apart and counts only the others as needing the owner.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { attentionArchive, markSeen, unmarkSeen } from './attention.mjs';
import { ownerAnswered } from './charge.mjs';
import { loadConfig } from './config.mjs';
import { GRANT_MINUTES, plainPush, pushFacts, readPushes, repoOf, samePath } from './guard.mjs';
import { formatDateTime, t } from './i18n.mjs';
import { discardRun, mergeRun, prNumber, verdict } from './merge.mjs';
import { refuseWhileLocked } from './lockdown.mjs';
import { reopenRequest, requestUndoBlock } from './needs.mjs';
import { newsPending, reportEvent, withdrawNews } from './news.mjs';
import { notify } from './notify.mjs';
import { decideItem, itemUndoBlock, undoItemDecision } from './planning.mjs';
import { readDecisionLog, readRun, readState, recordDecision, saveDecisionLog, UNDO_GRACE_MS } from './store.mjs';
import { localDeliveryClone } from './workspace.mjs';
import { clip, DATA, ensureDir, now, parseLevel, readJson, ROOT, writeJson } from './util.mjs';

const QUESTIONS_MAX = 200;
export const OPTIONS_MAX = 6;
const questionsFile = () => path.join(ensureDir(path.join(DATA, 'manager')), 'questions.json');
const readQuestions = () => readJson(questionsFile(), []);
const saveQuestions = list => writeJson(questionsFile(), list.slice(-QUESTIONS_MAX));
const same = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

/** Whether the owner merges the project's work (the default) or someone else reviews it ("merge_by_owner": false). */
export const mergedByOwner = (config, project) => config?.projects?.[project]?.merge_by_owner !== false;

// ---------- The manager's questions ----------

/**
 * A question for the owner, with the options they answer with: { question, context, options ("A|B|C" or a list),
 * recommend (one of the options), project, level (the approval level, 1 to 3) }. It waits as a card until answered or
 * discarded.
 */
export function addQuestion({ question, context, options, recommend, project, level, request = null } = {}, config = loadConfig()) {
  const text = clip(question, 300);
  if (!text) throw new Error('The question is missing.');
  const list = (Array.isArray(options) ? options : String(options ?? '').split('|')).map(o => clip(o, 60)).filter(Boolean);
  const choices = list.filter((o, i) => list.findIndex(x => same(x, o)) === i);
  if (!choices.length) choices.push(t('Yes'), t('No'));
  if (choices.length < 2 || choices.length > OPTIONS_MAX) throw new Error(`Give 2 to ${OPTIONS_MAX} options, separated by "|".`);
  const recommended = recommend ? choices.find(o => same(o, recommend)) : null;
  if (recommend && !recommended) throw new Error(`The recommendation must be one of the options: ${choices.join(', ')}.`);
  const approval = parseLevel(level);
  const id = clip(project, 60);
  if (id && !config.projects?.[id]) throw new Error(`${id} is not a project in the settings.`);
  const questions = readQuestions();
  const q = {
    id: Math.max(0, ...questions.map(x => x.id)) + 1, question: text, context: String(context ?? '').trim().slice(0, 2000),
    options: choices, recommend: recommended ?? null, project: id || null, level: approval, at: now(), status: 'open', answer: null, answered_at: null,
    // A request of a project's agent in charge, taken to the owner (src/charge.mjs): the answer decides it.
    ...(request != null ? { request: Number(request) } : {}),
  };
  saveQuestions([...questions, q]);
  return q;
}

/** The questions still open, oldest first. */
export const openQuestions = () => readQuestions().filter(q => q.status === 'open');

/**
 * Closes a question: answered with one of its options, what the owner wrote ("note": an explanation with the option,
 * or an answer of their own instead), or both; or discarded (no answer, no note).
 */
function closeQuestion(id, answer, note = null) {
  const questions = readQuestions();
  const q = questions.find(x => x.id === Number(id));
  if (!q) throw new Error(`Question ${id} not found.`);
  if (q.status !== 'open') throw new Error(`Question ${id} was already ${q.status}.`);
  const given = answer == null || String(answer).trim() === '' ? null : answer;
  const choice = given == null ? null : q.options.find(o => same(o, given));
  if (given != null && !choice) throw new Error(`Answer with one of: ${q.options.join(', ')}.`);
  const written = clip(String(note ?? '').trim(), 2000);
  Object.assign(q, { status: choice || written ? 'answered' : 'dismissed', answer: choice, answered_at: now() }, written ? { note: written } : {});
  saveQuestions(questions);
  return q;
}

/** A question answered or discarded comes back open (its answer undone, undoDecision). */
function reopenQuestion(id, was) {
  const questions = readQuestions();
  const q = questions.find(x => x.id === Number(id));
  if (!q || q.status !== was) throw new Error(t('This decision can no longer be undone.'));
  Object.assign(q, { status: 'open', answer: null, answered_at: null });
  delete q.note;
  saveQuestions(questions);
  return q;
}

/** The "owner_decided" news of a question closed from its card: the option, what the owner wrote, or the discard. */
export function questionNews(q) {
  const asked = `your question #${q.id} "${q.question}"`;
  if (q.status !== 'answered') return `The owner discarded ${asked} from the app without answering it.`;
  const mine = q.recommend ? ` (You had recommended "${q.recommend}".)` : '';
  if (!q.answer) return `The owner answered ${asked} from the app in their own words, choosing none of the options: "${q.note}".${mine}`;
  return `The owner answered ${asked} from the app: "${q.answer}".${q.note ? ` And wrote: "${q.note}".` : ''}${mine}`;
}

// ---------- The manager's pushes ----------
// The guard refuses the manager every push. One it tried that could be allowed (a plain push of one branch, not the
// main one, not forced) becomes a request here: the owner allows it on its card, for that repository, branch, folder
// and source, once, within GRANT_MINUTES, or refuses it. The hook and "cli.mjs push" take the grant (src/guard.mjs).

const PUSHES_MAX = 100;
const PUSH_OPEN_FOR = 24 * 3600_000; // a request not answered in a day leaves the cards
export const pushesFile = () => path.join(ensureDir(path.join(DATA, 'manager')), 'pushes.json');
const cliPush = p => `node src/cli.mjs push "${p.dir.replaceAll('\\', '/')}" ${p.branch}`;

/** The requests still waiting for the owner, oldest first. */
export const openPushes = (list = readPushes(pushesFile())) => list.filter(p => p.status === 'open' && Date.now() - Date.parse(p.at) < PUSH_OPEN_FOR);

/**
 * Turns what the guard refused in the manager's answer (its log, moved to "history" once read) into push requests: one
 * per push that could be allowed, unless the same one already waits. Returns the new requests.
 */
export function pushRequestsFrom(log, history = null) {
  if (!existsSync(log)) return [];
  const text = readFileSync(log, 'utf8');
  // Every refusal stays on record, not only the pushes.
  if (history && text.trim()) appendFileSync(history, text.endsWith('\n') ? text : `${text}\n`);
  rmSync(log, { force: true });
  const lines = text.split('\n').filter(Boolean);
  const made = [];
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a line cut by a crash
    }
    const command = String(entry.tool_input?.command ?? '');
    const target = plainPush(command, entry.cwd || ROOT);
    if (!target.branch) continue;
    const facts = pushFacts(target);
    if (!facts.repo || facts.main) continue;
    const request = addPushRequest({ ...target, ...facts, command });
    if (request) made.push(request);
  }
  return made;
}

/** A push request for the owner: { dir, remote, src, branch, repo, commits, count, command }. Null when the same one waits. */
export function addPushRequest({ dir, remote, src, branch, repo, commits = [], count = 0, command = '' }) {
  const list = readPushes(pushesFile());
  const same = p => p.repo === repo && p.branch === branch && p.src === src && samePath(p.dir, dir);
  const open = openPushes(list).find(same);
  if (open) {
    // Tried again: what it would send now.
    Object.assign(open, { commits: commits.slice(0, 20), count, command: clip(command, 500) });
    writeJson(pushesFile(), list);
    return null;
  }
  const request = { id: randomUUID().slice(0, 8), status: 'open', repo, branch, dir, remote, src, commits: commits.slice(0, 20), count, command: clip(command, 500), at: now() };
  writeJson(pushesFile(), [...list, request].slice(-PUSHES_MAX));
  notify(t('The manager asks to push'), t('Branch {branch} to {repo}', { branch, repo }), 'chiefmate:decisions', { urgent: true });
  return request;
}

/** The owner's answer to a request kept in "file": allowed (once, for GRANT_MINUTES) or refused. Returns the request. */
function answerRequest(file, open, id, allow) {
  const list = readPushes(file);
  const p = list.find(x => x.id === String(id ?? ''));
  if (!p || !open([p]).length) throw new Error(t('This decision is no longer pending.'));
  Object.assign(p, allow
    ? { status: 'allowed', decided: now(), expires: new Date(Date.now() + GRANT_MINUTES * 60_000).toISOString() }
    : { status: 'refused', decided: now() });
  writeJson(file, list);
  return p;
}

/** A push or repository request answered comes back open, its grant taken back. Refused once used or past its day. */
function reopenRequestIn(file, open, id, was) {
  const list = readPushes(file);
  const p = list.find(x => x.id === String(id ?? ''));
  if (!p || p.status !== was || !open([{ ...p, status: 'open' }]).length) throw new Error(t('This decision can no longer be undone.'));
  p.status = 'open';
  delete p.decided;
  delete p.expires;
  writeJson(file, list);
  return p;
}

/** The owner's answer to a push request: allowed (once, for GRANT_MINUTES) or refused. Returns the request. */
export const answerPush = (id, allow) => answerRequest(pushesFile(), openPushes, id, allow);

/** The manager's line: its push requests waiting for the owner, and the pushes allowed and not used yet. */
export function pushesLine() {
  const list = readPushes(pushesFile());
  const open = openPushes(list);
  const allowed = list.filter(p => p.status === 'allowed' && Date.parse(p.expires) > Date.now());
  const parts = [
    open.length ? `waiting for the owner's card: ${open.map(p => `${p.branch} to ${p.repo}`).join('; ')}` : '',
    allowed.length ? `allowed by the owner, once each: ${allowed.map(p => `${p.branch} to ${p.repo} from ${p.dir}, until ${formatDateTime(p.expires)} (${cliPush(p)})`).join('; ')}` : '',
  ].filter(Boolean);
  return parts.length ? `Your pushes: ${parts.join('. ')}.` : '';
}

// ---------- The manager's new repositories ----------
// The guard refuses the manager "gh repo create". It asks with "cli.mjs repo-create <name> --private --from <folder>"
// instead: a request here and a card for the owner. Once allowed (that name and folder, once, within GRANT_MINUTES),
// the same command creates the repository, always private, in the account gh is signed in to, adds it to the folder
// as "origin" and sends the folder's branch as its first main branch. From then on it is like any other repository:
// its main branch only through Chiefmate's merge, other branches through a push card.

export const reposFile = () => path.join(ensureDir(path.join(DATA, 'manager')), 'repos.json');
const REPO_NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const cliRepo = r => `node src/cli.mjs repo-create ${r.name} --private --from "${r.dir.replaceAll('\\', '/')}"`;

/** The repository requests still waiting for the owner, oldest first. */
export const openRepoRequests = (list = readPushes(reposFile())) => list.filter(r => r.status === 'open' && Date.now() - Date.parse(r.at) < PUSH_OPEN_FOR);

const runCommand = (file, args, cwd) => {
  const r = spawnSync(file, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  return { ok: r.status === 0, out: String(r.stdout ?? '').trim(), err: String(r.stderr || r.error?.message || '').trim() };
};
const gitIn = (dir, ...args) => runCommand('git', ['-C', dir, ...args]);
/** GitHub's command line; in the smoke test, a stand-in (CHIEFMATE_GH, a .mjs run with this Node.js). */
function gh(...args) {
  const stand = process.env.CHIEFMATE_SMOKE && process.env.CHIEFMATE_GH;
  return stand ? runCommand(process.execPath, [stand, ...args]) : runCommand('gh', args);
}

/**
 * What creating the repository "name" from "dir" would do, checked now: { owner, name, repo, dir, branch, commits,
 * count }, or { problem } when it can't: a bad name, not the top folder of a git repository, no branch or commit, a
 * remote "origin" already there, gh not signed in, or a repository of that name already in the account.
 */
export function repoFacts({ name, dir }) {
  name = String(name ?? '').trim();
  if (!REPO_NAME.test(name) || /^\.+$/.test(name) || /\.git$/i.test(name)) return { problem: `"${name}" is not a valid repository name: letters, digits, ".", "-" and "_" only.` };
  if (!dir) return { problem: 'Which folder? --from <folder>' };
  const folder = path.resolve(String(dir));
  const top = gitIn(folder, 'rev-parse', '--show-toplevel');
  if (!top.ok || !samePath(top.out, folder)) return { problem: `${folder} is not the top folder of a git repository.` };
  const branch = gitIn(folder, 'symbolic-ref', '--short', 'HEAD').out;
  if (!branch) return { problem: `${folder} has no branch checked out.` };
  if (!gitIn(folder, 'rev-parse', '--verify', '-q', 'HEAD').ok) return { problem: `${folder} has no commit yet: commit its files first.` };
  if (gitIn(folder, 'remote').out.split('\n').includes('origin')) {
    return { problem: `${folder} already has a remote "origin" (${gitIn(folder, 'remote', 'get-url', 'origin').out}): it has a repository already.` };
  }
  const login = gh('api', 'user', '--jq', '.login');
  if (!login.ok || !login.out) return { problem: `GitHub's command line (gh) is not signed in, or GitHub did not answer: ${login.err}` };
  const repo = `${login.out}/${name}`;
  const seen = gh('repo', 'view', repo, '--json', 'name');
  if (seen.ok) return { problem: `${repo} already exists on GitHub: choose another name.` };
  if (!/could not resolve|not found/i.test(seen.err)) return { problem: `Could not check whether ${repo} exists: ${seen.err}` };
  const commits = gitIn(folder, 'log', '--format=%h %s', '-n', '20', branch).out.split('\n').filter(Boolean);
  const count = Number(gitIn(folder, 'rev-list', '--count', branch).out) || commits.length;
  return { owner: login.out, name, repo, dir: folder, branch, commits, count };
}

/** A repository request for the owner: { request, again } (again: the same one already waited, now brought up to date). */
export function addRepoRequest({ owner, name, repo, dir, branch, commits = [], count = 0, description = '' }) {
  const list = readPushes(reposFile());
  const fields = { owner, name, repo, dir, branch, commits: commits.slice(0, 20), count, description: clip(description, 300) };
  const open = openRepoRequests(list).find(r => r.repo.toLowerCase() === repo.toLowerCase() && samePath(r.dir, dir));
  if (open) {
    Object.assign(open, fields);
    writeJson(reposFile(), list);
    return { request: open, again: true };
  }
  const request = { id: randomUUID().slice(0, 8), status: 'open', ...fields, at: now() };
  writeJson(reposFile(), [...list, request].slice(-PUSHES_MAX));
  notify(t('The manager asks to create a repository'), t('Private repository {repo}', { repo }), 'chiefmate:decisions', { urgent: true });
  return { request, again: false };
}

/** The owner's answer to a repository request: allowed (once, for GRANT_MINUTES) or refused. Returns the request. */
export const answerRepo = (id, allow) => answerRequest(reposFile(), openRepoRequests, id, allow);

/**
 * "cli.mjs repo-create": without the owner's grant, a request and its card ({ request, again }); with it, the
 * repository created, always private, the folder's "origin" and its branch sent ({ created }). Throws what refuses it.
 */
export function repoCreate({ name, from, description = '', visibility = '' }) {
  refuseWhileLocked(t('creating a repository'));
  if (visibility !== 'private') {
    throw new Error(visibility
      ? 'Chiefmate never creates a public or internal repository: only a private one (--private).'
      : 'Say --private: Chiefmate creates only private repositories.');
  }
  const facts = repoFacts({ name, dir: from });
  if (facts.problem) throw new Error(facts.problem);
  const list = readPushes(reposFile());
  const grant = list.find(r => r.status === 'allowed' && Date.parse(r.expires) > Date.now()
    && r.repo.toLowerCase() === facts.repo.toLowerCase() && samePath(r.dir, facts.dir) && r.branch === facts.branch);
  if (!grant) return addRepoRequest({ ...facts, description });
  // Used up at once, before anything goes to GitHub.
  Object.assign(grant, { status: 'used', used: now() });
  writeJson(reposFile(), list);
  const record = fields => writeJson(reposFile(), readPushes(reposFile()).map(r => (r.id === grant.id ? { ...r, ...fields } : r)));
  const fail = (what, r, next) => {
    record({ status: 'failed', error: clip(`${what}: ${r.err || r.out}`, 500) });
    throw new Error(`${what}: ${r.err || r.out}. ${next}`);
  };
  const byHand = "Tell the owner what is left, for them to finish by hand; don't try it another way.";
  // What the owner saw on the card: the name, the description and the folder's branch.
  const made = gh('repo', 'create', facts.repo, '--private', ...(grant.description ? ['--description', grant.description] : []));
  if (!made.ok) fail(`GitHub did not create ${facts.repo}`, made, 'The grant was used: run the same command again to ask the owner once more.');
  const url = `https://github.com/${facts.repo}.git`;
  const remote = gitIn(facts.dir, 'remote', 'add', 'origin', url);
  if (!remote.ok) fail(`${facts.repo} was created (private), but the folder's remote "origin" could not be added`, remote, byHand);
  const sent = gitIn(facts.dir, 'push', '-u', 'origin', `refs/heads/${facts.branch}:refs/heads/${facts.branch}`);
  if (!sent.ok) fail(`${facts.repo} was created (private) and is the folder's "origin", but its branch ${facts.branch} could not be sent`, sent, byHand);
  // The remote's default branch, known here too: later pushes to it are refused as pushes to the main branch.
  gitIn(facts.dir, 'remote', 'set-head', 'origin', facts.branch);
  const created = { status: 'created', url: made.out.split('\n').find(l => /^https?:\/\//.test(l)) || `https://github.com/${facts.repo}`, created: now() };
  record(created);
  return { created: { ...grant, ...created } };
}

/** The manager's line: its repository requests waiting for the owner, and the ones allowed and not used yet. */
export function reposLine() {
  const list = readPushes(reposFile());
  const open = openRepoRequests(list);
  const allowed = list.filter(r => r.status === 'allowed' && Date.parse(r.expires) > Date.now());
  const parts = [
    open.length ? `waiting for the owner's card: ${open.map(r => `${r.repo} from ${r.dir}`).join('; ')}` : '',
    allowed.length ? `allowed by the owner, once each: ${allowed.map(r => `${r.repo} from ${r.dir}, until ${formatDateTime(r.expires)} (${cliRepo(r)})`).join('; ')}` : '',
  ].filter(Boolean);
  return parts.length ? `Your new repositories: ${parts.join('. ')}.` : '';
}

// ---------- The cards ----------

const projectName = (config, id) => config.projects?.[id]?.name ?? id ?? '';
const firstLine = text => String(text ?? '').split('\n').map(l => l.trim()).find(Boolean) ?? '';
const plainVerdict = text => String(text ?? '').replace(/[*_`>#]/g, '').replace(/\s+/g, ' ').trim();
const verdicts = new Map(); // run id -> the final review's verdict, read once (the file doesn't change after the run)

/**
 * The recommendation in the manager's verdict, which also says what it fixed and the risks: { short, text }. "short"
 * is the verdict alone ("Approve with caveats"), "text" the recommendation's own words. Looked for after a
 * "Recommendation:" label (in English or Portuguese), else in the verdict's last paragraph.
 */
export function verdictRecommendation(review) {
  const lines = String(review ?? '').split('\n').map(l => plainVerdict(l).replace(/^[-+•]\s*/, '')).filter(Boolean);
  const label = /^(?:my\s+|minha\s+|i\s+)?(?:recommend(?:ation)?|recomenda[çc][ãa]o|recomendo)\b\s*[:—–-]?\s*/i;
  const at = lines.findIndex(l => label.test(l));
  let text = at >= 0 ? lines[at].replace(label, '') || lines[at + 1] || '' : '';
  if (!text) {
    const inline = /\b(?:recommendation|recomenda[çc][ãa]o)\s*[:—–]\s*(.+)$/i.exec(lines.join(' '));
    text = inline ? inline[1] : lines.at(-1) ?? '';
  }
  text = text.trim().replace(/^./, c => c.toUpperCase());
  const v = text.toLowerCase();
  let short = '';
  if (/\b(do not|don't|not)\s+approv|\bn[ãa]o\s+aprov|\breject|\brecus/.test(v)) short = t('Do not approve');
  else if (/\bcaveat|ressalva|\bwith conditions|\bcom condi/.test(v)) short = t('Approve with caveats');
  else if (/\bapprove|\baprov/.test(v)) short = t('Approve');
  return { short: short || clip(text.split(/[.:;,(]/)[0], 60), text: clip(text, 240) };
}

function runVerdict(run) {
  if (!verdicts.has(run.id)) verdicts.set(run.id, verdict(run));
  return verdicts.get(run.id);
}

/** The run behind a merge notice: "pr:<run>", or the board item's run ("plan:<n>:..."). */
function noticeRun(notice, items) {
  if (notice.run) return readRun(notice.run);
  const item = items.find(i => notice.id.startsWith(`plan:${i.id}:`));
  return item?.run ? readRun(item.run) : null;
}

/** "PR #34 of Chiefmate", "Branch x of Riffdex": a run's delivery, as its card and the record name it. */
function deliveryLabel(run, config) {
  const name = projectName(config, run.project);
  const number = prNumber(run.pullRequest);
  return run.pullRequest
    ? number ? t('PR #{number} of {project}', { number, project: name }) : t('Pull request of {project}', { project: name })
    : t('Branch {branch} of {project}', { branch: run.branch ?? '-', project: name });
}

/** A merge on record with the owner's decisions, from a card, the run's page or the manager's: it can't be undone. */
export function recordMerge(id, { by = 'owner', via = 'app' } = {}, config = loadConfig()) {
  const run = readRun(String(id ?? ''));
  if (!run?.merged || run.merged.by === 'outside') return null;
  return recordDecision({ kind: 'merge', ref: run.id, label: deliveryLabel(run, config), title: run.title ?? run.id, from: 'pending', to: 'merged', by, via });
}

function mergeCard(notice, run, item, config) {
  const project = run.project;
  const label = deliveryLabel(run, config);
  const byOwner = mergedByOwner(config, project);
  // A branch left in the crew's working copy (no local_clone) is merged by hand, not from here (src/merge.mjs).
  const inClone = !!run.pullRequest || !!localDeliveryClone(run, config);
  const failed = (run.checks ?? []).filter(c => !c.ok).length;
  const review = runVerdict(run);
  const needs = run.outcome?.needs && !/^(no|não|nao|none|nenhum)\b/i.test(run.outcome.needs) ? run.outcome.needs : '';
  const risk = [
    failed ? t('{count} check(s) failed: look at them before approving.', { count: failed }) : (run.checks ?? []).length ? t('The checks passed.') : '',
    review ? '' : t('No final review by the manager.'),
    needs,
  ].filter(Boolean).join(' ');
  const how = run.pullRequest ? t('Chiefmate merges the pull request on GitHub.') : t('Chiefmate merges the branch into the branch checked out in your clone; nothing is sent to GitHub.');
  const advice = review ? verdictRecommendation(review) : null;
  return {
    id: notice.id, kind: 'merge', level: notice.level, seen: !!notice.seen, at: notice.at, project, label,
    title: run.title, what: clip(run.summary || run.title, 300),
    change: !byOwner ? '' : inClone ? [how, run.outcome?.change].filter(Boolean).join(' ') : t("The branch is in the crew's working copy, not in a clone of yours (local_clone): merge it by hand."),
    risk: risk || t('No risk noted.'),
    recommend: advice?.text ?? '', recommendShort: advice?.short ?? '',
    detail: [review ? `${t("Manager's verdict")}:\n${review}` : '', run.outcome?.done?.length ? `${t('What was done')}:\n- ${run.outcome.done.join('\n- ')}` : ''].filter(Boolean).join('\n\n'),
    url: run.pullRequest ?? null, run: run.id, item: item?.id ?? null, approve: byOwner && inClone, thirdParty: !byOwner,
    approval: run.level ?? item?.level ?? null,
  };
}

function decisionCard(notice, item, config) {
  const recommend = { now: t('Do now'), later: t('Later'), discard: t('Discard') }[item.recommend] ?? '';
  return {
    id: notice.id, kind: 'decision', level: notice.level, seen: !!notice.seen, at: notice.at, project: item.project,
    label: t('Item #{number} of {project}', { number: item.id, project: projectName(config, item.project) }),
    title: item.title, what: clip(firstLine(item.description) || item.title, 300),
    change: t("It becomes a task for {agent}, with the manager's review: one per project at a time, in your order.", { agent: item.agent ?? '-' }),
    risk: item.recommend_risk || t('No risk noted.'),
    recommend: [recommend, item.recommend_note].filter(Boolean).join(': '), recommendShort: recommend,
    detail: item.description && item.description !== firstLine(item.description) ? item.description : '',
    agent: item.agent ?? null, item: item.id, approve: true, approval: item.level ?? null,
  };
}

function questionCard(notice, q, config) {
  return {
    id: notice.id, kind: 'question', level: notice.level, seen: !!notice.seen, at: q.at, project: q.project,
    label: q.project ? t('Question from the manager about {project}', { project: projectName(config, q.project) }) : t('Question from the manager'),
    title: q.question, what: q.context, change: '', risk: '', recommend: q.recommend ?? '', recommendShort: q.recommend ?? '', detail: '',
    question: q.id, options: q.options, approve: false, approval: q.level ?? null,
  };
}

function pushCard(notice, p, config) {
  const project = Object.entries(config.projects ?? {}).find(([, x]) => x.repository && repoOf(x.repository) === p.repo)?.[0] ?? null;
  const more = p.count > (p.commits?.length ?? 0) ? `\n- ${t('and {count} more', { count: p.count - p.commits.length })}` : '';
  const commits = p.commits?.length ? `${t('Commits')}:\n- ${p.commits.join('\n- ')}${more}` : '';
  return {
    id: notice.id, kind: 'push', level: notice.level, seen: false, at: p.at, project,
    label: t('Push by the manager to {repo}', { repo: p.repo }),
    title: t('Send the branch {branch} to GitHub', { branch: p.branch }),
    what: t('{count} commit(s) from {folder} go to the branch {branch} of {repo}. It is not the main branch.', { count: p.count, folder: p.dir, branch: p.branch, repo: p.repo }),
    change: t('Only this push is allowed: this branch of this repository, from this folder, once, within {minutes} minutes. Never the main branch, never a forced push.', { minutes: GRANT_MINUTES }),
    risk: t('The commits go to GitHub: whoever can see the repository sees them (anyone, if it is public). Nothing goes into the main branch.'),
    recommend: '', recommendShort: '',
    detail: [commits, `${t('Command')}: \`${p.command}\``].filter(Boolean).join('\n\n'),
    push: p.id, approve: true,
  };
}

function repoCard(notice, r) {
  const more = r.count > (r.commits?.length ?? 0) ? `\n- ${t('and {count} more', { count: r.count - r.commits.length })}` : '';
  const commits = r.commits?.length ? `${t('Commits')}:\n- ${r.commits.join('\n- ')}${more}` : '';
  return {
    id: notice.id, kind: 'repo', level: notice.level, seen: false, at: r.at, project: null,
    label: t('New repository by the manager'),
    title: t('The manager asks to create the private repository {repo} and send {folder}', { repo: r.repo, folder: r.dir }),
    what: t('A new private repository {repo} in your GitHub account becomes the "origin" of {folder}, and its branch {branch} ({count} commit(s)) goes there as the main branch.', { repo: r.repo, folder: r.dir, branch: r.branch, count: r.count }),
    change: t('Only this creation is allowed: this name, from this folder, once, within {minutes} minutes. The repository is always private; later pushes follow the usual rules (the main branch only through a merge).', { minutes: GRANT_MINUTES }),
    risk: t('Everything in these commits goes to GitHub, private: only you and whoever you invite see it. Make sure no secret or personal file is in them.'),
    recommend: '', recommendShort: '',
    detail: [r.description ? `${t('Description')}: ${r.description}` : '', commits, `${t('Command')}: \`${cliRepo(r)}\``].filter(Boolean).join('\n\n'),
    repoRequest: r.id, approve: true,
  };
}

/**
 * The cards, in the notices' order (not seen first, then by level and time): { id (the notice's), kind (merge,
 * decision, question, push, repo), level, approval, seen, label, title, what, change, risk, recommend, detail, approve, ... }.
 */
export function decisionCards({ config = loadConfig(), attention = [], items = [], questions = openQuestions(), pushes = openPushes(), repos = openRepoRequests() } = {}) {
  const cards = [];
  for (const n of attention) {
    try {
      if (n.kind === 'repo') {
        const r = repos.find(x => n.id === `repo:${x.id}`);
        if (r) cards.push(repoCard(n, r));
      } else if (n.kind === 'push') {
        const p = pushes.find(x => n.id === `push:${x.id}`);
        if (p) cards.push(pushCard(n, p, config));
      } else if (n.kind === 'question') {
        const q = questions.find(x => n.id === `question:${x.id}`);
        if (q) cards.push(questionCard(n, q, config));
      } else if (n.kind === 'decision') {
        const item = items.find(i => n.id === `decide:${i.id}`);
        if (item) cards.push(decisionCard(n, item, config));
      } else if (n.id.startsWith('pr:') || n.id.startsWith('plan:')) {
        const run = noticeRun(n, items);
        const item = items.find(i => n.id.startsWith(`plan:${i.id}:`)) ?? items.find(i => run && i.run === run.id) ?? null;
        if (run?.status === 'done' && !run.merged && !run.discarded && (run.pullRequest || run.delivered)) cards.push(mergeCard(n, run, item, config));
      }
    } catch (error) {
      console.error(`Decisions: card ${n.id}:`, error.message);
    }
  }
  return cards;
}

// ---------- The owner's click ----------

/** Tells the manager; "ref" lets an undo take the news back while it waits. Returns the ref when told, else null. */
const tell = (text, ref = null, urgent = false) => (reportEvent('owner_decided', text, { ref, urgent }) && ref) || null;

/**
 * The owner decides a card from the app: { card (its id), action: approve | later | discard | answer, option (the
 * answer to a question), note (what the owner wrote to a question: with the option, or instead of one), reason }.
 * The card is checked against "cards", what is pending now.
 */
export async function decide({ card, action, option, note, reason, via = 'app' } = {}, cards = []) {
  const id = String(card ?? '');
  const c = cards.find(x => x.id === id);
  if (!c) {
    if (action === 'approve') {
      const archived = attentionArchive().find(i => i.id === id && i.run && !i.url && (i.reason === 'branch' || i.reason === 'deleted'));
      const run = archived && readRun(archived.run);
      if (run?.merged?.by === 'outside' && run.merged.how === 'local') return { card: id, done: 'already_merged' };
      if (run?.discarded?.by === 'outside' && run.discarded.how === 'local') return { card: id, done: 'branch_deleted' };
    }
    throw new Error(t('This decision is no longer pending.'));
  }
  const about = `${c.label} "${c.title}"`;
  const ref = randomUUID().slice(0, 8);
  // On record: who, when, from where, from what to what, and what undoing it needs (none: it can't be undone). The
  // record's id goes back to the app only when it can be undone, for its Undo band ("logged").
  const log = (fields, news = null) => {
    const entry = recordDecision({ kind: c.kind, ref: c.id, label: c.label, title: c.title, from: 'pending', by: 'owner', via, news, ...fields });
    return entry.final ? null : entry.id;
  };
  if (action === 'later') {
    markSeen([c.id]);
    const news = tell(`The owner chose "not now" for ${about} from the app: it stays pending; don't ask again today.`, ref);
    return { card: c.id, done: 'later', logged: log({ kind: 'seen', to: 'later', undo: { seen: c.id } }, news) };
  }
  if (c.kind === 'merge') {
    if (action === 'approve') {
      if (!c.approve) throw new Error(t('Someone else reviews and merges the work of this project.'));
      const merge = await mergeRun(c.run, { by: 'owner' });
      const done = merge.discarded ? 'branch_deleted' : merge.merged.by === 'outside' ? 'already_merged' : 'merged';
      if (done === 'merged') recordMerge(c.run, { via });
      return { card: c.id, done, merge };
    }
    if (action === 'discard') {
      // Someone else's review: its pull request is theirs to close.
      if (c.thirdParty) throw new Error(t('Someone else reviews and merges the work of this project.'));
      const result = await discardRun(c.run);
      if (c.item) await decideItem(c.item, 'discard', { reason: clip(reason, 200) || 'Discarded by the owner', by: 'owner', via, undoable: false }).catch(() => null);
      tell(`The owner discarded ${about} (run ${c.run}) from the app: ${result.kind === 'pr' ? `pull request ${result.url} closed on GitHub` : `branch ${result.branch} left unmerged`}.`);
      log({ to: 'discarded' });
      return { card: c.id, done: 'discarded' };
    }
  } else if (c.kind === 'decision' && ['approve', 'discard'].includes(action)) {
    // The item's own record (decideItem) is the decision's: it carries this news, to take back with an undo. An
    // approval from the app starts its task after the undo window.
    const item = await decideItem(c.item, action, { reason, by: 'owner', via, news: ref, grace: action === 'approve' && via !== 'cli' ? UNDO_GRACE_MS : 0 });
    tell(`The owner ${action === 'approve' ? 'approved' : 'discarded'} ${about} (planning item #${c.item}) from the app${action === 'approve' ? ': its task starts in its turn' : ''}.`, ref);
    return { card: c.id, done: action === 'approve' ? 'approved' : 'discarded', logged: item.logged };
  } else if (c.kind === 'push' && ['approve', 'discard'].includes(action)) {
    const p = answerPush(c.push, action === 'approve');
    let news = null;
    if (p.status === 'allowed') {
      reportEvent('push_allowed', `The owner allowed, from the app, your push of branch ${p.branch} to ${p.repo} (from ${p.dir}), once, until ${formatDateTime(p.expires)}. Run it now: the same command (${p.command}) or ${cliPush(p)}.`, { urgent: true });
    } else {
      news = tell(`The owner refused, from the app, your push of branch ${p.branch} to ${p.repo} (from ${p.dir}). Don't try it again.`, ref);
    }
    return { card: c.id, done: p.status, logged: log({ to: p.status, undo: { push: p.id } }, news) };
  } else if (c.kind === 'repo' && ['approve', 'discard'].includes(action)) {
    const r = answerRepo(c.repoRequest, action === 'approve');
    let news = null;
    if (r.status === 'allowed') {
      reportEvent('repo_allowed', `The owner allowed, from the app, the private repository ${r.repo} with ${r.dir} sent to it (branch ${r.branch}), once, until ${formatDateTime(r.expires)}. Run it now: ${cliRepo(r)}.`, { urgent: true });
    } else {
      news = tell(`The owner refused, from the app, the private repository ${r.repo} from ${r.dir}. Don't ask for it again.`, ref);
    }
    return { card: c.id, done: r.status, logged: log({ to: r.status, undo: { repo: r.id } }, news) };
  } else if (c.kind === 'question' && ['answer', 'discard'].includes(action)) {
    if (action === 'answer' && !String(option ?? '').trim() && !String(note ?? '').trim()) throw new Error(t('Choose an option or write your answer.'));
    const q = action === 'answer' ? closeQuestion(c.question, option ?? null, note) : closeQuestion(c.question, null);
    // A request of an agent in charge follows the answer by itself: authorized, on hold or refused.
    const followed = q.request ? await ownerAnswered(q).then(x => x.request, error => ({ error: error.message })) : null;
    const request = !followed ? '' : followed.error
      ? ` Request #${q.request} could not follow it (${followed.error}).`
      : ` Chiefmate applied it to request #${q.request}: ${followed.status}${followed.run ? `, run ${followed.run} queued` : ''}; don't answer that request again.`;
    const news = tell(questionNews(q) + request, ref);
    // A request of an agent in charge already followed the answer (a run queued, perhaps): that one can't be undone.
    const logged = log({ to: q.status, answer: [q.answer, q.note].filter(Boolean).join(' — ') || null, undo: followed ? null : { question: q.id } }, news);
    return { card: c.id, done: q.status === 'answered' ? 'answered' : 'discarded', answer: q.answer, note: q.note ?? null, run: followed?.run ?? null, logged };
  }
  throw new Error(t('This decision does not take that action.'));
}

// ---------- Undoing a decision ----------

const HISTORY_HOURS = 24; // the decisions the app lists

/**
 * Whether a decision on record can still be undone: null when it can, else why not ("final": a merge, a discard or
 * anything else that can't; "undone"; "read": the manager or the agent already has it; "started", "used", "expired",
 * "ended", "changed", "gone").
 */
export function undoBlock(entry) {
  if (entry.final) return 'final';
  if (entry.undone) return 'undone';
  // No news on record (the manager's updates off): nobody read it.
  const unread = entry.news ? newsPending(entry.news) : true;
  switch (entry.kind) {
    case 'seen':
      return readState().attention_seen?.[entry.ref] ? null : 'changed';
    case 'plan':
      return itemUndoBlock(entry);
    case 'request':
      return requestUndoBlock(entry);
    case 'question': {
      const q = readQuestions().find(x => x.id === Number(entry.undo.question));
      if (!q || q.status !== entry.to) return 'changed';
      return unread ? null : 'read';
    }
    case 'push':
    case 'repo': {
      const [file, open, id] = entry.kind === 'push' ? [pushesFile(), openPushes, entry.undo.push] : [reposFile(), openRepoRequests, entry.undo.repo];
      const p = readPushes(file).find(x => x.id === id);
      if (!p) return 'gone';
      if (p.status === 'used') return 'used';
      if (p.status !== entry.to) return 'changed';
      if (!open([{ ...p, status: 'open' }]).length) return 'expired';
      // A permission is taken back any time before it is used; a refusal, until the manager reads it.
      return p.status === 'allowed' || unread ? null : 'read';
    }
    default:
      return 'final';
  }
}

/** The owner's decisions of the last day, newest first, each with whether it can still be undone ("canUndo"). */
export function recentDecisions(max = 20) {
  const since = Date.now() - HISTORY_HOURS * 3600_000;
  return readDecisionLog().filter(e => Date.parse(e.at) >= since).reverse().slice(0, max).map(e => {
    let block;
    try {
      block = undoBlock(e);
    } catch {
      block = 'gone';
    }
    const { undo, news, ...shown } = e;
    return { ...shown, block, canUndo: !block };
  });
}

/**
 * Undoes a decision while it has had no effect: the card (the request, the item) is back as it was, for another answer.
 * Its news is taken back if the manager hasn't read it yet, else the manager is told. On record too, from and to swapped.
 */
export function undoDecision(id, { by = 'owner', via = 'app' } = {}) {
  const list = readDecisionLog();
  const entry = list.find(e => e.id === String(id ?? ''));
  if (!entry) throw new Error(t('This decision is not on record.'));
  const why = undoBlock(entry);
  if (why) {
    throw new Error({
      final: t("This decision can't be undone."), undone: t('This decision was already undone.'),
      read: t('The agent already read your answer: it can no longer be changed.'), started: t("Its task has already started: it can't be undone."),
      used: t('The permission was already used.'), expired: t('This request expired.'), ended: t('The run has ended.'),
    }[why] ?? t('This decision can no longer be undone.'));
  }
  if (entry.kind === 'seen') unmarkSeen([entry.ref]);
  else if (entry.kind === 'plan') undoItemDecision(entry);
  else if (entry.kind === 'request') reopenRequest(entry);
  else if (entry.kind === 'question') reopenQuestion(entry.undo.question, entry.to);
  else if (entry.kind === 'push') reopenRequestIn(pushesFile(), openPushes, entry.undo.push, entry.to);
  else if (entry.kind === 'repo') reopenRequestIn(reposFile(), openRepoRequests, entry.undo.repo, entry.to);
  // Its news, not read yet, goes back; already read (or a permission given), the manager hears of the change.
  const withdrawn = withdrawNews(entry.news);
  const allowed = ['push', 'repo'].includes(entry.kind) && entry.to === 'allowed';
  if (!withdrawn && (allowed || entry.news)) {
    tell(allowed
      ? `The owner took back, from the app, the permission they gave for ${entry.label} "${entry.title}": don't do it; it waits for their decision again.`
      : `The owner undid, from the app, their decision on ${entry.label} "${entry.title}" (${entry.from} → ${entry.to}): it is back to ${entry.from}, waiting for their new decision. Ignore the earlier news about it.`, null, allowed);
  }
  entry.undone = { at: now(), by, via };
  saveDecisionLog(list);
  recordDecision({ kind: entry.kind, ref: entry.ref, label: entry.label, title: entry.title, from: entry.to, to: entry.from, by, via, undoes: entry.id });
  return { undone: entry.id, kind: entry.kind, to: entry.from };
}

/** The manager's line: the questions it asked that still wait for the owner. */
export function questionsLine() {
  const open = openQuestions();
  return open.length
    ? `Your questions waiting for the owner's answer in the app (ask-owner): ${open.slice(0, 6).map(q => `#${q.id} "${clip(q.question, 100)}" (${q.options.join(' | ')}; level ${q.level ?? '?'})`).join('; ')}.`
    : '';
}
