// The team leads: a project with "lead" in its settings has one. The lead keeps the project's memory
// (data/projects/<id>/memory.md), plans each request sent with "ask" into at most MAX_TASKS tasks for the project's
// crew, and reviews the crew's work. In a level 1 run with a final review, its review is the final one (delegated
// review, unless the project sets "delegated_review": false): it approves (its report is the pull request's text),
// returns the work to the crew with what to fix (at most MAX_ROUNDS times) or escalates it to the manager, who also
// reviews when the project's checks fail. In any other run, its review is an opinion the manager reads in its own.
// The lead only runs as steps of the project's runs: it is never on when the project has no work.
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { formatDateTime, t } from './i18n.mjs';
import { clip, DATA, ensureDir, languageName, now, readJson, writeJson } from './util.mjs';

/** The lead's member id in the project's crew (src/config.mjs). */
export const LEAD = 'lead';
/** At most this many tasks per request, so a request never floods the queue. */
export const MAX_TASKS = 3;
/** At most this many times a lead's final review sends the work back to the crew; then the manager reviews it. */
export const MAX_ROUNDS = 2;
const MAX_MEMORY = 20_000;

// ---------- The project's memory (data/projects/<id>/memory.md) ----------

const safeId = id => String(id).replace(/[^\w.-]/g, '_').replace(/^\.+/, '_');
export const memoryFile = projectId => path.join(DATA, 'projects', safeId(projectId), 'memory.md');

export function readMemory(projectId) {
  try {
    return readFileSync(memoryFile(projectId), 'utf8').trim();
  } catch {
    return '';
  }
}

/** How big the memory is and when it was last saved, for the app and the manager; null when there is none yet. */
export function memoryInfo(projectId) {
  try {
    const text = readFileSync(memoryFile(projectId), 'utf8').trim();
    return text ? { lines: text.split('\n').length, updated: statSync(memoryFile(projectId)).mtime.toISOString() } : null;
  } catch {
    return null;
  }
}

export function saveMemory(projectId, text) {
  const file = memoryFile(projectId);
  ensureDir(path.dirname(file));
  const body = String(text).trim();
  writeFileSync(file, `${body.length > MAX_MEMORY ? `${body.slice(0, MAX_MEMORY)}\n\n(cut at ${MAX_MEMORY} characters)` : body}\n`);
}

// ---------- What the lead returns: fenced blocks at the end of its report ----------

/** The last block fenced as ~~~<name> (or ```<name>) ... ~~~ in a text: { body, start, end }, or null. */
function lastBlock(text, name) {
  const re = new RegExp(`^(~{3,}|\`{3,})[ \\t]*${name}[^\\n]*\\n([\\s\\S]*?)\\n\\1[ \\t]*$`, 'gm');
  let found = null;
  for (const m of String(text ?? '').matchAll(re)) found = { body: m[2], start: m.index, end: m.index + m[0].length };
  return found;
}

const cut = (text, b) => `${text.slice(0, b.start)}${text.slice(b.end)}`.replace(/\n{3,}/g, '\n\n').trim();

/** The project memory the lead returned, taken out of its report: { memory (or null), report }. */
export function takeMemory(report) {
  const text = String(report ?? '');
  const b = lastBlock(text, 'project-memory');
  return b && b.body.trim() ? { memory: b.body.trim(), report: cut(text, b) } : { memory: null, report: text };
}

/**
 * The lead's plan, from the ~~~chiefmate-plan block of its report: { tasks: [{ agent, part }], note, dropped, error }.
 * members: the project's crew that may take tasks ({ id: { name } }). Unknown members and tasks past MAX_TASKS are
 * dropped, and said so.
 */
export function parsePlan(report, members) {
  const b = lastBlock(report, 'chiefmate-plan');
  if (!b) return { tasks: [], note: '', dropped: [], error: 'no plan block' };
  let data;
  try {
    data = JSON.parse(b.body);
  } catch (error) {
    return { tasks: [], note: '', dropped: [], error: `the plan is not valid JSON (${error.message})` };
  }
  const { tasks, dropped } = pickTasks(Array.isArray(data) ? data : data?.tasks, members);
  return { tasks, note: clip(data?.note ?? '', 400), dropped, error: null };
}

/** The tasks of a plan or of a review's fixes ([{ agent, task }]) that the crew can take, at most MAX_TASKS: { tasks, dropped }. */
function pickTasks(list, members) {
  const byName = Object.fromEntries(Object.entries(members).map(([id, a]) => [String(a.name ?? id).toLowerCase(), id]));
  const tasks = [];
  const dropped = [];
  for (const x of Array.isArray(list) ? list : []) {
    const asked = String(x?.agent ?? '').trim();
    const agent = members[asked] ? asked : byName[asked.toLowerCase()];
    const part = String(x?.task ?? x?.part ?? '').trim();
    if (!agent || !part) dropped.push(`${asked || '?'}: ${clip(part, 80) || '(no task)'}${agent ? '' : ' (not in the crew)'}`);
    else if (tasks.length >= MAX_TASKS) dropped.push(`${agent}: ${clip(part, 80)} (past the limit of ${MAX_TASKS})`);
    else tasks.push({ agent, part });
  }
  return { tasks, dropped };
}

/** The crew that takes a lead's tasks: the project's crew without the manager and the lead. */
export const taskTakers = agents => Object.fromEntries(Object.entries(agents).filter(([id]) => id !== 'manager' && id !== LEAD));

/**
 * Puts the lead's plan in the run: its tasks become steps right after the planning step, linked to the request, then
 * the lead's first review. With no task, what is left (the lead's review and the final review) is skipped.
 * Returns the plan, also kept in run.lead.plan.
 */
export function applyPlan(run, planStep, agents) {
  const plan = planStep.status === 'done'
    ? parsePlan(planStep.report, taskTakers(agents))
    : { tasks: [], note: '', dropped: [], error: planStep.error || 'the planning step failed' };
  const at = run.steps.indexOf(planStep) + 1;
  const tasks = plan.tasks.map((x, i) => ({ agent: x.agent, part: x.part, status: 'pending', by: LEAD, task: i + 1, tasks: plan.tasks.length }));
  run.steps.splice(at, 0, ...tasks);
  if (tasks.length && !run.steps.some(s => s.agent === LEAD && s.role === 'review')) run.steps.push(leadReviewStep());
  if (!tasks.length) {
    for (const s of [...run.steps.slice(at), ...(run.review ? [run.review] : [])]) if (s.status === 'pending') s.status = 'skipped';
  }
  run.lead = { ...run.lead, plan: { at: now(), tasks: plan.tasks, note: plan.note, dropped: plan.dropped, error: plan.error } };
  return plan;
}

export const leadPlanStep = request => ({ agent: LEAD, role: 'plan', part: String(request).trim(), status: 'pending' });
const FIRST_REVIEW = "First review of the crew's work in this run: write your opinion for the manager, who does the final review.";
const FINAL_REVIEW = "Final review of the crew's work in this run (delegated review): approve it, send it back to the crew with what to fix, or escalate it to the manager.";
export const leadReviewStep = (round = 1) => ({ agent: LEAD, role: 'review', status: 'pending', part: FIRST_REVIEW, ...(round > 1 ? { round } : {}) });

// ---------- The delegated review: the lead's review is the final one in level 1 runs ----------

/** Whether a project's team lead does the final review of its level 1 runs: on with a lead, unless "delegated_review": false. */
export function leadReviews(config, projectId) {
  const spec = config?.projects?.[projectId]?.lead;
  return spec === true || (!!spec && typeof spec === 'object' && spec.delegated_review !== false);
}

/** Whether a run's final review is its team lead's: level 1, with a final review planned, in a project whose lead does it. */
export const delegatedReview = (run, config) => !!run?.review && run.level === 1 && leadReviews(config, run.project);

/**
 * Marks a lead's review step as the final one or not, when it starts (not when it resumes from a pause): the level may
 * have changed since the run was queued. Returns whether it is the final one.
 */
export function markReview(run, step, config) {
  step.final = delegatedReview(run, config);
  step.part = step.final ? FINAL_REVIEW : FIRST_REVIEW;
  return step.final;
}

/** How many times the lead's final reviews sent this run's work back to the crew. */
export const returnsUsed = run => Math.max(0, ...(run.steps ?? []).map(s => s.fix ?? 0));

/** Why the manager reviews a level 1 run its lead reviewed, in words for the manager (src/runs.mjs, its final review). */
export const ESCALATIONS = {
  lead: 'the team lead escalated it to you',
  checks: "the project's checks failed after the team lead approved it",
  rounds: `${MAX_ROUNDS} rounds of fixes were not enough for the team lead`,
  level: 'the run is no longer level 1',
  failed: "the team lead's review failed",
  unclear: "the team lead's review gave no clear decision",
};

const DECISIONS = ['approve', 'return', 'escalate'];

/**
 * The decision of a lead's final review, from the ~~~chiefmate-review block of its report: { decision ('approve',
 * 'return', 'escalate' or null), fixes ([{ agent, part }] the crew can take), dropped, note, error, report (the report
 * without the block) }. members: the crew that may take the fixes.
 */
export function takeReview(report, members) {
  const text = String(report ?? '');
  const b = lastBlock(text, 'chiefmate-review');
  const none = { decision: null, fixes: [], dropped: [], note: '' };
  if (!b) return { ...none, error: 'no review block', report: text };
  const rest = cut(text, b);
  let data;
  try {
    data = JSON.parse(b.body);
  } catch (error) {
    return { ...none, error: `the review block is not valid JSON (${error.message})`, report: rest };
  }
  const said = String(data?.decision ?? '').trim().toLowerCase();
  const decision = DECISIONS.includes(said) ? said : null;
  const { tasks, dropped } = decision === 'return' ? pickTasks(data?.fixes, members) : { tasks: [], dropped: [] };
  return { decision, fixes: tasks, dropped, note: clip(data?.note ?? '', 400), error: decision ? null : `unknown decision "${clip(said, 40)}"`, report: rest };
}

/** The manager reviews the run after all (run.lead.escalated): why is a key of ESCALATIONS. */
export function escalate(run, why, note = '') {
  run.lead = { ...run.lead, verdict: null, escalated: { why, note: clip(note, 400), at: now() } };
  if (run.review) delete run.review.delegated;
}

/**
 * After a lead's final review (a step marked final): its decision is kept in run.lead.reviews and decides what comes
 * next. "approve": run.lead.verdict, and the run goes on to its checks (see settleDelegation); "return": the fixes become
 * the crew's steps right after it, then another review by the lead (at most MAX_ROUNDS times); anything else, or a
 * return past the rounds, escalates it to the manager's review. Returns { decision, why, fixes }.
 */
export function applyReview(run, step, agents) {
  const round = step.round ?? 1;
  const taken = step.status === 'done'
    ? takeReview(step.report, taskTakers(agents))
    : { decision: null, fixes: [], dropped: [], note: '', error: step.error || 'the review step failed' };
  if (step.status === 'done') step.report = taken.report;
  run.lead = {
    ...run.lead, verdict: null, escalated: null,
    ...(step.status === 'done' ? { opinion: step.report, opinionAt: now() } : {}),
    reviews: [...(run.lead?.reviews ?? []), { round, at: now(), decision: taken.decision, note: taken.note, fixes: taken.fixes, dropped: taken.dropped, error: taken.error }],
  };
  if (run.review) delete run.review.delegated;
  let why = null;
  if (taken.decision === 'approve') run.lead.verdict = { round, at: now(), note: taken.note };
  else if (taken.decision === 'return' && taken.fixes.length && returnsUsed(run) < MAX_ROUNDS) {
    const fix = returnsUsed(run) + 1;
    const steps = taken.fixes.map(x => ({ agent: x.agent, part: x.part, status: 'pending', by: LEAD, fix }));
    run.steps.splice(run.steps.indexOf(step) + 1, 0, ...steps, leadReviewStep(round + 1));
  } else {
    why = taken.decision === 'escalate' ? 'lead' : taken.decision === 'return' && taken.fixes.length ? 'rounds' : step.status === 'done' ? 'unclear' : 'failed';
    const unclear = () => [
      taken.error ?? 'sent back with no fix a member of the crew can take', taken.dropped.length ? `left out: ${taken.dropped.join('; ')}` : '', taken.note,
    ].filter(Boolean).join('; ');
    escalate(run, why, why === 'failed' ? taken.error : why === 'unclear' ? unclear() : taken.note);
  }
  return { decision: taken.decision, why, fixes: taken.fixes };
}

/** Whether the run's lead approved it in its final review and the manager's review still waits to be skipped. */
export const awaitsDelegation = run => !!run.lead?.verdict && !run.lead?.escalated && run.review?.status === 'pending';

/**
 * Right before the manager's final review of a run its lead approved: the review is skipped (run.review.delegated) when
 * the run is still delegated (level 1) and every check passed; else the manager reviews it (escalated). checks: the
 * project's checks, just run. Returns true when skipped.
 */
export function settleDelegation(run, { delegated, checks = [] }) {
  const failed = checks.filter(c => !c.ok);
  if (!delegated) escalate(run, 'level');
  else if (failed.length) escalate(run, 'checks', failed.map(c => c.command).join(', '));
  else {
    Object.assign(run.review, { status: 'skipped', delegated: true });
    return true;
  }
  return false;
}

/** The step whose report is the text that goes to the owner: the final review's, else the lead's approving review. */
export function finalStep(run) {
  if (run.review?.status === 'done') return run.review;
  if (!run.review?.delegated) return null;
  return (run.steps ?? []).filter(s => s.agent === LEAD && s.role === 'review' && s.final && s.status === 'done').at(-1) ?? null;
}

/**
 * Who reviewed a run: { agent ('manager', the mission's reviewer, or 'lead'), delegated (the lead's review was the final
 * one), rounds (the lead's reviews done), why (why the manager reviewed a run its lead reviewed first, ESCALATIONS) },
 * or null when nobody did yet.
 */
export function reviewedBy(run) {
  const rounds = (run.steps ?? []).filter(s => s.agent === LEAD && s.role === 'review' && s.status === 'done').length;
  if (run.review?.status === 'done') return { agent: run.review.agent ?? 'manager', delegated: false, rounds, why: run.lead?.escalated?.why ?? null };
  if (run.review?.delegated) return { agent: LEAD, delegated: true, rounds, why: null };
  return rounds ? { agent: LEAD, delegated: false, rounds, why: null } : null;
}

// ---------- The crew writes to its lead first (data/projects/<id>/inbox.json) ----------

const MAX_INBOX = 200;
/** At most this many open items go in a lead's prompt, the oldest first. */
const INBOX_SHOWN = 10;
/** The lead's answers of the last days that the crew's steps read. */
const ANSWERS_DAYS = 7;
const ANSWERS_SHOWN = 5;

export const inboxFile = projectId => path.join(DATA, 'projects', safeId(projectId), 'inbox.json');
export const readInbox = (projectId, file = inboxFile(projectId)) => readJson(file, []);
export const openInbox = (projectId, file = inboxFile(projectId)) => readInbox(projectId, file).filter(x => x.status === 'open');

/**
 * What a member of a project's crew sent the manager (a message with "chat say", or a defect it reported), kept for
 * the project's team lead first: { kind ('message' or 'defect'), text, sender (agentSender in src/manager.mjs), run,
 * step, agent (its member id), defect (the defect's id) }. Returns the item, open until the lead answers it or passes
 * it on.
 */
export function toLead(projectId, { kind = 'message', text, sender = null, run = null, step = null, agent = null, defect = null }, file = inboxFile(projectId)) {
  const body = clip(String(text ?? '').trim(), 2000);
  if (!body) throw new Error(t('Write a message.'));
  const list = readInbox(projectId, file);
  const item = {
    id: list.reduce((max, x) => Math.max(max, x.id), 0) + 1, kind: kind === 'defect' ? 'defect' : 'message', text: body, at: now(), status: 'open',
    sender, run, step, agent, ...(defect != null ? { defect } : {}),
  };
  writeJson(file, [...list, item].slice(-MAX_INBOX));
  return item;
}

/** The open items in a lead's prompt (plan or review), with how to answer them; empty when there are none. */
export function inboxLines(items) {
  if (!items.length) return [];
  const shown = items.slice(0, INBOX_SHOWN);
  return [
    '',
    '## Open messages from your crew (answer them or pass them on)',
    "Your crew wrote these to the manager, and they reach you first. Answer each one you can settle yourself (a question about the work, the project or its rules; a defect that is in fact a misunderstanding, saying what to do instead). Pass on to the manager only what is the manager's to decide: a real defect of Chiefmate, a request beyond this project or beyond level 1, anything about money, accounts, security or the owner. Leave open what you can't settle yet.",
    ...shown.map(x => `- #${x.id} (${x.kind === 'defect' ? `defect${x.defect != null ? ` #${x.defect} of Chiefmate` : ''}` : 'message'}, ${formatDateTime(x.at)}, from ${x.agent ?? 'a member'}${x.run ? ` in run ${x.run}` : ''}): ${clip(x.text, 600)}`),
    ...(items.length > shown.length ? [`- and ${items.length - shown.length} more, for your next step.`] : []),
    'End your report, before the memory block, with what you did with each, in this exact format (JSON):',
    '~~~crew-answers',
    '[{"id": 1, "answer": "<your answer to the member>"}, {"id": 2, "forward": "<one line for the manager: what it has to decide>"}]',
    '~~~',
  ];
}

/** The lead's answers to its crew, from the ~~~crew-answers block of its report: { answers: [{ id, answer, forward }], report }. */
export function takeAnswers(report) {
  const text = String(report ?? '');
  const b = lastBlock(text, 'crew-answers');
  if (!b) return { answers: [], report: text };
  let data;
  try {
    data = JSON.parse(b.body);
  } catch {
    data = [];
  }
  const answers = (Array.isArray(data) ? data : []).map(x => ({
    id: Number(x?.id), answer: clip(String(x?.answer ?? '').trim(), 1200), forward: clip(String(x?.forward ?? '').trim(), 600),
  })).filter(x => Number.isInteger(x.id) && (x.answer || x.forward));
  return { answers, report: cut(text, b) };
}

/**
 * Applies the lead's answers to its project's inbox: an item answered keeps the answer; one passed on goes to the
 * manager (the caller tells it). Only open items change. by: where it was done ({ run }). Returns { answered, forwarded }.
 */
export function applyAnswers(projectId, answers, { run = null } = {}, file = inboxFile(projectId)) {
  const list = readInbox(projectId, file);
  const answered = [];
  const forwarded = [];
  for (const a of answers) {
    const item = list.find(x => x.id === a.id && x.status === 'open');
    if (!item) continue;
    if (a.forward) {
      Object.assign(item, { status: 'forwarded', forward: a.forward, done: now(), doneIn: run });
      forwarded.push(item);
    } else {
      Object.assign(item, { status: 'answered', answer: a.answer, done: now(), doneIn: run });
      answered.push(item);
    }
  }
  if (answered.length || forwarded.length) writeJson(file, list);
  return { answered, forwarded };
}

/** The manager (or the owner) takes an open item itself: it leaves the lead's inbox. Returns the item. */
export function takeFromLead(projectId, id, by = 'manager', file = inboxFile(projectId)) {
  const list = readInbox(projectId, file);
  const item = list.find(x => x.id === Number(id));
  if (!item) throw new Error(t('No message #{id} for the team lead of {project}.', { id, project: projectId }));
  if (item.status !== 'open') throw new Error(t('Message #{id} was already handled ({status}).', { id: item.id, status: item.status }));
  Object.assign(item, { status: 'taken', by, done: now() });
  writeJson(file, list);
  return item;
}

/** For the crew's steps: the lead's latest answers to the crew's messages (of the last days), so the members learn them. */
export function answerLines(projectId, lead, file = inboxFile(projectId), today = Date.now()) {
  const since = today - ANSWERS_DAYS * 86400_000;
  const recent = readInbox(projectId, file).filter(x => x.status === 'answered' && Date.parse(x.done) >= since).slice(-ANSWERS_SHOWN);
  if (!recent.length) return [];
  return [
    '',
    `## The team lead's answers to the crew's messages (${lead.name}, the latest)`,
    ...recent.map(x => `- To ${x.agent ?? 'a member'} (${formatDateTime(x.at)}), who wrote "${clip(x.text, 300)}": ${x.answer}`),
  ];
}

// ---------- What the steps read ----------

const memoryText = memory => memory || '(empty: this is the first run with a team lead, so start it)';

const MEMORY_RULES = [
  'Return the memory whole and updated, in markdown and under about 150 lines, at the very end of your last message, in a block fenced exactly like this:',
  '~~~project-memory',
  '<the whole project memory>',
  '~~~',
  'Keep in it the decisions taken, the history (one line per run: the date, what was asked, the outcome), the owner\'s preferences in this project and what was tried (and how it went). Keep what still matters, summarize what is old, never write secrets or passwords. Chiefmate saves it and takes the block out of your report.',
];

/**
 * The lead's own part of the prompt: the memory, how to plan or how to review, and the crew's open messages (inbox).
 * project, owner and lang (the language of the text that goes to the owner) matter for a final review (step.final).
 */
export function leadLines({ run, step, agents, memory, base, project = {}, owner = 'the owner', lang = 'en', inbox = [] }) {
  const lines = ['', '## Project memory (you keep it)', memoryText(memory)];
  const crew = Object.values(taskTakers(agents)).map(a => `- \`${a.id}\` (${a.name}${a.base && a.base !== a.id ? `, based on ${a.base}` : ''}): ${a.role ?? ''}`.trim());
  const goal = run.instruction && run.kind === 'ask' ? 'the request' : "the run's goal";
  if (step.role === 'review' && step.final) {
    const left = Math.max(0, MAX_ROUNDS - returnsUsed(run));
    const checks = (project.checks ?? []).map(c => `\`${c}\``).join(', ') || 'the ones the project and its documentation describe, as far as this machine allows';
    const where = project.deliver === 'local' ? 'as a branch, with your text as its note' : 'as a pull request, with your text as its description';
    lines.push(
      '',
      '## How to review (you are the team lead, and your review is the final one)',
      `This run is level 1, and in this project the team lead does the final review of such runs (delegated review): the manager does not review it again and reads only your verdict to decide the merge with ${owner}. The manager reviews the work itself only if you escalate it, if the project's checks fail after you approve it, or if ${MAX_ROUNDS} rounds of fixes are not enough. You never merge, push or publish anything: that stays with the manager, with ${owner}'s authorization. This is review round ${step.round ?? 1} of this run.`,
      `1. See what changed: \`git log --oneline origin/${base}..HEAD\` and the diff of every file that matters. Check the sources the work relies on (links, data, quotes, documentation) and each task against ${goal}, the reports and the project's rules. When ${owner} guided a step directly (a "direct talk" section at the end of its report), check that the work follows what they said.`,
      `2. Run the checks: ${checks}.`,
      "3. Don't fix anything yourself: what is wrong goes back to the crew, with precise instructions.",
      '4. Decide, and end your report, before the memory block, with your decision in this exact format (JSON):',
      '~~~chiefmate-review',
      '{"decision": "approve", "fixes": [], "note": "<one line on why>"}',
      '~~~',
      `- "approve": the work is ready to go to ${owner} ${where}. Your report is then that text, in ${languageName(lang)}: start it with the final summary the rules below describe, say what was done and how you checked it, and end it with a section titled "${t("Team lead's verdict", {}, lang)}": what you checked, the risks and your recommendation (approve, or approve with caveats).`,
      `- "return": something must be fixed first. Put each fix in "fixes" as {"agent": "<member id>", "task": "<what to change, precisely>"}, for the member who should do it (at most ${MAX_TASKS}); the run goes back to them, then comes back to you for another review. ${left ? `You may send it back ${left} more time(s); after that, the manager reviews it.` : 'You may not send it back again: if it still needs fixes, escalate it.'}`,
      '- "escalate": the manager must review it: a risk or a decision beyond level 1, something you can\'t judge, or work you would not approve.',
      '',
      'The crew of this project:',
      ...(crew.length ? crew : ['- (nobody: escalate instead of sending the work back)']),
    );
    if (run.kind === 'ask' && run.instruction) lines.push('', '## The request', run.instruction);
  } else if (step.role === 'plan') {
    lines.push(
      '',
      '## How to plan (you are the team lead)',
      `The request above came from the owner through the manager. Read the memory, the project's documentation and as much of the working copy as you need, then split the request into at most ${MAX_TASKS} tasks for the project's crew. Prefer fewer: one task is often enough. The tasks run in the order you give, one after another on this run's branch, and each member reads the reports of the steps before. Write each task so the member can work alone. Don't do the work yourself and don't change any file.`,
      '',
      'The crew of this project:',
      ...(crew.length ? crew : ['- (nobody: plan no task and say so)']),
      '',
      'Your report explains the plan in a few lines. Then, before the memory block, end it with the plan in this exact format (JSON):',
      '~~~chiefmate-plan',
      '{"tasks": [{"agent": "<member id>", "task": "<what to do>"}], "note": "<one line on why this plan>"}',
      '~~~',
      'Chiefmate queues the tasks in this run, linked to the request. When there is nothing to do (the request is unclear, already done or not for this crew), leave "tasks" empty and say why in "note".',
    );
  } else {
    lines.push(
      '',
      '## How to review (you are the team lead)',
      `You do the first review of the crew's work in this run; the manager does the final review, talks with the owner and reads your opinion. See what changed (\`git log --oneline origin/${base}..HEAD\` and the diffs), check each task against ${goal}, the reports and the project's rules, and run the project's checks if they are quick. Don't fix anything yourself.`,
      'Your report is your opinion for the manager: each task, done or not and how well; the problems found, with the file and line; what the manager should check or fix; and your recommendation (approve, approve with caveats, or do not approve).',
    );
    if (run.kind === 'ask' && run.instruction) lines.push('', '## The request', run.instruction);
  }
  lines.push(...inboxLines(inbox), '', ...MEMORY_RULES);
  return lines;
}

/**
 * For a crew member's step in a project with a lead: the memory (read only) and, for a planned task, the request; for a
 * fix the lead's final review asked (step.fix), what it is; and the lead's latest answers to the crew (answers: lines
 * from answerLines).
 */
export function memberLines({ run, step, lead, memory, answers = [] }) {
  const lines = [];
  if (step.fix) {
    lines.push(
      '',
      `## The team lead sent the work back (fix round ${step.fix} of at most ${MAX_ROUNDS})`,
      `The team lead (${lead.name}) did the final review of this run and asks you to fix what "Your part" says; its whole review is among the reports of the previous steps. Fix exactly that, commit, and say in your report what you changed. Then the team lead reviews the work again.`,
    );
    if (run.kind === 'ask' && run.instruction) lines.push('', '## The request this run is for', run.instruction);
  } else if (step.by === LEAD && run.instruction) {
    lines.push('', '## The request this task is part of', `Task ${step.task} of ${step.tasks} that the team lead (${lead.name}) planned for this request from the owner:`, run.instruction);
  }
  if (memory) lines.push('', `## Project memory (kept by the team lead, ${lead.name}; read only)`, memory, '', 'If you learn something the team lead should remember, say it in your report.');
  if (answers.length) lines.push(...answers);
  // Who answers to whom: what the member writes to the manager reaches the lead first.
  lines.push('', `## Your team lead (${lead.name})`, `In this project you answer to the team lead, who answers to the manager. What you write to the manager (\`chat say\`) and the defects you report reach the team lead first: it answers you or passes on to the manager what is the manager's to decide.`);
  return lines;
}

/** For the manager's final review: the lead's plan and its opinion, which the manager weighs. */
export function finalReviewLines(run, lead) {
  if (!run.lead) return [];
  const lines = [];
  const plan = run.lead.plan;
  if (plan) {
    lines.push('', `## The team lead's plan (${lead?.name ?? LEAD})`);
    if (run.instruction && run.kind === 'ask') lines.push(`Request: ${run.instruction}`);
    for (const [i, x] of plan.tasks.entries()) lines.push(`${i + 1}. ${x.agent}: ${x.part}`);
    if (plan.note) lines.push(`Note: ${plan.note}`);
    if (plan.dropped?.length) lines.push(`Dropped: ${plan.dropped.join('; ')}`);
  }
  const reviews = run.lead.reviews ?? [];
  const escalated = run.lead.escalated;
  if (reviews.length) {
    lines.push('', `## The team lead's final reviews (delegated review, by ${lead?.name ?? LEAD})`);
    for (const r of reviews) {
      const fixes = r.fixes?.length ? `; sent back: ${r.fixes.map(x => `${x.agent}: ${clip(x.part, 200)}`).join('; ')}` : '';
      lines.push(`- Round ${r.round}: ${r.decision ?? 'no decision'}${r.note ? ` (${r.note})` : ''}${fixes}${r.error ? `; ${r.error}` : ''}`);
    }
  }
  if (escalated) {
    lines.push('', `This run is level 1, so its team lead did the final review, but it comes to you because ${ESCALATIONS[escalated.why] ?? escalated.why}${escalated.note ? ` (${escalated.note})` : ''}. Review it fully, as usual.`);
  }
  const name = lead?.name ?? LEAD;
  if (run.lead.opinion) lines.push('', reviews.length ? `## The team lead's last review (by ${name})` : `## The team lead's opinion (first review, by ${name})`, run.lead.opinion);
  return lines;
}

// ---------- What the manager sees ----------

/**
 * One line about a project's lead for the manager's situation: what it is on now, its memory, whether it does the
 * final review of level 1 runs and what its crew sent that is still open with it (instead of each message).
 * going: the project's run going on (as in memory), or null; next: the project's next run in the queue, or null.
 * extra: { delegated (leadReviews), open (openInbox) }.
 */
export function leadSituation(projectId, lead, going, next, info = memoryInfo(projectId), { delegated = false, open = [] } = {}) {
  let doing;
  if (going) {
    const s = [...(going.steps ?? []), ...(going.review ? [going.review] : [])].find(x => x.status === 'running');
    const planned = going.lead?.plan ? `, planned ${going.lead.plan.tasks.length} task(s)${going.lead.plan.note ? ` (${clip(going.lead.plan.note, 120)})` : ''}` : '';
    if (s?.agent === LEAD && s.role === 'plan') doing = `planning the request "${clip(going.instruction, 140)}" into tasks, run ${going.id}`;
    else if (s?.agent === LEAD && s.final) doing = `doing the final review of run ${going.id} (delegated review, round ${s.round ?? 1})${planned}`;
    else if (s?.agent === LEAD) doing = `reviewing the crew's work first, run ${going.id}${planned}`;
    else doing = `on run ${going.id} "${clip(going.title, 80)}" (${s ? `${s.agent} at work` : 'preparing'})${planned}`;
  } else if (next) doing = `next in the queue: "${clip(next.title, 80)}" [${next.id}]`;
  else doing = 'off (it only runs when the project has work)';
  const memory = info ? `memory of ${info.lines} line(s), updated ${formatDateTime(info.updated)}` : 'no memory yet';
  const review = delegated
    ? 'it does the final review of level 1 runs (delegated review: you get only its verdict, and review yourself only what it escalates or what fails its checks)'
    : 'it does the first review, you the final one';
  const messages = open.filter(x => x.kind !== 'defect').length;
  const defects = open.length - messages;
  const inbox = open.length
    ? `open with it from its crew (it answers them at its next step; take one yourself only when it can't wait, with \`node src/cli.mjs inbox ${projectId} take <n>\`): ${[messages ? `${messages} message(s)` : '', defects ? `${defects} defect(s)` : ''].filter(Boolean).join(', ')}, the oldest from ${formatDateTime(open[0].at)}: ${open.slice(0, 3).map(x => `#${x.id} ${x.agent ?? '?'}: "${clip(x.text, 140)}"`).join('; ')}${open.length > 3 ? `; and ${open.length - 3} more` : ''}`
    : 'nothing open from its crew';
  return `Team lead of project ${projectId}: ${lead.name} (based on ${lead.base}): ${doing}; ${memory}; ${review}; ${inbox}. Send it requests with \`node src/cli.mjs ask ${projectId} "<request>"\`.`;
}
