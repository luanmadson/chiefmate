// The owner's decisions as cards, decided with one click: a pull request or a branch to merge, a proposal the manager
// triaged, and a question the manager asked (cli.mjs ask-owner). Each card says what it is, what changes if approved,
// the risk and the manager's recommendation, with the project beside its number ("PR #34 of Chiefmate").
// Cards are built from the attention notices (src/attention.mjs), so a card leaves when its notice does. "Not now"
// marks the notice as seen (the card fades to the end of the list); every decision reaches the manager as news
// ("owner_decided"; a merge is "merged" news, src/merge.mjs). A project whose work someone else reviews
// ("merge_by_owner": false) shows its pull requests as waiting for that review, with no Approve.
// Each card carries the approval level the manager gave its run, item or question ("approval": 1, the manager
// decides and does it; 2, the owner approves; 3, never without the owner; null, not given). The app folds the level 1
// cards apart and counts only the others as needing the owner.
import path from 'node:path';
import { markSeen } from './attention.mjs';
import { ownerAnswered } from './charge.mjs';
import { loadConfig } from './config.mjs';
import { t } from './i18n.mjs';
import { discardRun, mergeRun, prNumber, verdict } from './merge.mjs';
import { reportEvent } from './news.mjs';
import { decideItem } from './planning.mjs';
import { readRun } from './store.mjs';
import { clip, DATA, ensureDir, now, parseLevel, readJson, writeJson } from './util.mjs';

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

/** Closes a question: answered with one of its options, or discarded (answer null). */
function closeQuestion(id, answer) {
  const questions = readQuestions();
  const q = questions.find(x => x.id === Number(id));
  if (!q) throw new Error(`Question ${id} not found.`);
  if (q.status !== 'open') throw new Error(`Question ${id} was already ${q.status}.`);
  const choice = answer == null ? null : q.options.find(o => same(o, answer));
  if (answer != null && !choice) throw new Error(`Answer with one of: ${q.options.join(', ')}.`);
  Object.assign(q, { status: choice ? 'answered' : 'dismissed', answer: choice, answered_at: now() });
  saveQuestions(questions);
  return q;
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

function mergeCard(notice, run, item, config) {
  const project = run.project;
  const name = projectName(config, project);
  const number = prNumber(run.pullRequest);
  const label = run.pullRequest
    ? number ? t('PR #{number} of {project}', { number, project: name }) : t('Pull request of {project}', { project: name })
    : t('Branch {branch} of {project}', { branch: run.branch ?? '-', project: name });
  const byOwner = mergedByOwner(config, project);
  // A branch left in the crew's working copy (no local_clone) is merged by hand, not from here (src/merge.mjs).
  const clone = config.projects?.[project]?.local_clone;
  const inClone = !!run.pullRequest || (!!clone && path.resolve(clone) === path.resolve(run.delivered));
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

/**
 * The cards, in the notices' order (not seen first, then by level and time): { id (the notice's), kind (merge,
 * decision, question), level, approval, seen, label, title, what, change, risk, recommend, detail, approve, ... }.
 */
export function decisionCards({ config = loadConfig(), attention = [], items = [], questions = openQuestions() } = {}) {
  const cards = [];
  for (const n of attention) {
    try {
      if (n.kind === 'question') {
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

const tell = text => reportEvent('owner_decided', text);

/**
 * The owner decides a card from the app: { card (its id), action: approve | later | discard | answer, option (the
 * answer to a question), reason }. The card is checked against "cards", what is pending now.
 */
export async function decide({ card, action, option, reason } = {}, cards = []) {
  const c = cards.find(x => x.id === String(card ?? ''));
  if (!c) throw new Error(t('This decision is no longer pending.'));
  const about = `${c.label} "${c.title}"`;
  if (action === 'later') {
    markSeen([c.id]);
    tell(`The owner chose "not now" for ${about} from the app: it stays pending; don't ask again today.`);
    return { card: c.id, done: 'later' };
  }
  if (c.kind === 'merge') {
    if (action === 'approve') {
      if (!c.approve) throw new Error(t('Someone else reviews and merges the work of this project.'));
      return { card: c.id, done: 'merged', merge: await mergeRun(c.run, { by: 'owner' }) };
    }
    if (action === 'discard') {
      // Someone else's review: its pull request is theirs to close.
      if (c.thirdParty) throw new Error(t('Someone else reviews and merges the work of this project.'));
      const result = await discardRun(c.run);
      if (c.item) await decideItem(c.item, 'discard', { reason: clip(reason, 200) || 'Discarded by the owner', by: 'owner' }).catch(() => null);
      tell(`The owner discarded ${about} (run ${c.run}) from the app: ${result.kind === 'pr' ? `pull request ${result.url} closed on GitHub` : `branch ${result.branch} left unmerged`}.`);
      return { card: c.id, done: 'discarded' };
    }
  } else if (c.kind === 'decision' && ['approve', 'discard'].includes(action)) {
    await decideItem(c.item, action, { reason, by: 'owner' });
    tell(`The owner ${action === 'approve' ? 'approved' : 'discarded'} ${about} (planning item #${c.item}) from the app${action === 'approve' ? ': its task starts in its turn' : ''}.`);
    return { card: c.id, done: action === 'approve' ? 'approved' : 'discarded' };
  } else if (c.kind === 'question' && ['answer', 'discard'].includes(action)) {
    const q = closeQuestion(c.question, action === 'answer' ? String(option ?? '') : null);
    // A request of an agent in charge follows the answer by itself: authorized, on hold or refused.
    const followed = q.request ? await ownerAnswered(q).then(x => x.request, error => ({ error: error.message })) : null;
    const request = !followed ? '' : followed.error
      ? ` Request #${q.request} could not follow it (${followed.error}).`
      : ` Chiefmate applied it to request #${q.request}: ${followed.status}${followed.run ? `, run ${followed.run} queued` : ''}; don't answer that request again.`;
    tell((q.answer
      ? `The owner answered your question #${q.id} "${q.question}" from the app: "${q.answer}".${q.recommend ? ` (You had recommended "${q.recommend}".)` : ''}`
      : `The owner discarded your question #${q.id} "${q.question}" from the app without answering it.`) + request);
    return { card: c.id, done: q.answer ? 'answered' : 'discarded', answer: q.answer, run: followed?.run ?? null };
  }
  throw new Error(t('This decision does not take that action.'));
}

/** The manager's line: the questions it asked that still wait for the owner. */
export function questionsLine() {
  const open = openQuestions();
  return open.length
    ? `Your questions waiting for the owner's answer in the app (ask-owner): ${open.slice(0, 6).map(q => `#${q.id} "${clip(q.question, 100)}" (${q.options.join(' | ')}; level ${q.level ?? '?'})`).join('; ')}.`
    : '';
}
