// The team leads: a project with "lead" in its settings has one. The lead keeps the project's memory
// (data/projects/<id>/memory.md), plans each request sent with "ask" into at most MAX_TASKS tasks for the project's
// crew, and does the first review of the crew's work, with an opinion the manager reads in its final review.
// The lead only runs as steps of the project's runs: it is never on when the project has no work.
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { formatDateTime } from './i18n.mjs';
import { clip, DATA, ensureDir, now } from './util.mjs';

/** The lead's member id in the project's crew (src/config.mjs). */
export const LEAD = 'lead';
/** At most this many tasks per request, so a request never floods the queue. */
export const MAX_TASKS = 3;
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

/** The last block fenced as ~~~<name> in a report, taken out of it: { body (trimmed, or null when none or empty), report }. */
export function takeBlock(report, name) {
  const text = String(report ?? '');
  const b = lastBlock(text, name);
  return b && b.body.trim() ? { body: b.body.trim(), report: cut(text, b) } : { body: null, report: text };
}

/** The project memory the lead returned, taken out of its report: { memory (or null), report }. */
export function takeMemory(report) {
  const { body, report: rest } = takeBlock(report, 'project-memory');
  return { memory: body, report: rest };
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
  const list = Array.isArray(data) ? data : Array.isArray(data?.tasks) ? data.tasks : [];
  const byName = Object.fromEntries(Object.entries(members).map(([id, a]) => [String(a.name ?? id).toLowerCase(), id]));
  const tasks = [];
  const dropped = [];
  for (const x of list) {
    const asked = String(x?.agent ?? '').trim();
    const agent = members[asked] ? asked : byName[asked.toLowerCase()];
    const part = String(x?.task ?? x?.part ?? '').trim();
    if (!agent || !part) dropped.push(`${asked || '?'}: ${clip(part, 80) || '(no task)'}${agent ? '' : ' (not in the crew)'}`);
    else if (tasks.length >= MAX_TASKS) dropped.push(`${agent}: ${clip(part, 80)} (past the limit of ${MAX_TASKS})`);
    else tasks.push({ agent, part });
  }
  return { tasks, note: clip(data?.note ?? '', 400), dropped, error: null };
}

/** The crew that takes a lead's tasks: the project's crew without the manager, the lead and the inactive members. */
export const taskTakers = agents => Object.fromEntries(Object.entries(agents).filter(([id, a]) => id !== 'manager' && id !== LEAD && a?.status !== 'inactive'));

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
export const leadReviewStep = () => ({
  agent: LEAD, role: 'review', status: 'pending',
  part: "First review of the crew's work in this run: write your opinion for the manager, who does the final review.",
});

// ---------- What the steps read ----------

const memoryText = memory => memory || '(empty: this is the first run with a team lead, so start it)';

const MEMORY_RULES = [
  'Return the memory whole and updated, in markdown and under about 150 lines, at the very end of your last message, in a block fenced exactly like this:',
  '~~~project-memory',
  '<the whole project memory>',
  '~~~',
  'Keep in it the decisions taken, the history (one line per run: the date, what was asked, the outcome), the owner\'s preferences in this project and what was tried (and how it went). Keep what still matters, summarize what is old, never write secrets or passwords. Chiefmate saves it and takes the block out of your report.',
];

/** The lead's own part of the prompt: the memory, and how to plan or how to review. */
export function leadLines({ run, step, agents, memory, base }) {
  const lines = ['', '## Project memory (you keep it)', memoryText(memory)];
  if (step.role === 'plan') {
    const crew = Object.values(taskTakers(agents)).map(a => `- \`${a.id}\` (${a.name}${a.base && a.base !== a.id ? `, based on ${a.base}` : ''}): ${a.role ?? ''}`.trim());
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
      `You do the first review of the crew's work in this run; the manager does the final review, talks with the owner and reads your opinion. See what changed (\`git log --oneline origin/${base}..HEAD\` and the diffs), check each task against ${run.instruction && run.kind === 'ask' ? 'the request' : "the run's goal"}, the reports and the project's rules, and run the project's checks if they are quick. Don't fix anything yourself.`,
      'Your report is your opinion for the manager: each task, done or not and how well; the problems found, with the file and line; what the manager should check or fix; and your recommendation (approve, approve with caveats, or do not approve).',
    );
    if (run.kind === 'ask' && run.instruction) lines.push('', '## The request', run.instruction);
  }
  lines.push('', ...MEMORY_RULES);
  return lines;
}

/** For a crew member's step in a project with a lead: the memory (read only) and, for a planned task, the request. */
export function memberLines({ run, step, lead, memory }) {
  const lines = [];
  if (step.by === LEAD && run.instruction) {
    lines.push('', '## The request this task is part of', `Task ${step.task} of ${step.tasks} that the team lead (${lead.name}) planned for this request from the owner:`, run.instruction);
  }
  if (memory) lines.push('', `## Project memory (kept by the team lead, ${lead.name}; read only)`, memory, '', 'If you learn something the team lead should remember, say it in your report.');
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
  if (run.lead.opinion) lines.push('', `## The team lead's opinion (first review, by ${lead?.name ?? LEAD})`, run.lead.opinion);
  return lines;
}

// ---------- What the manager sees ----------

/**
 * One line about a project's lead for the manager's situation: what it is on now and its memory.
 * going: the project's run going on (as in memory), or null; next: the project's next run in the queue, or null.
 */
export function leadSituation(projectId, lead, going, next, info = memoryInfo(projectId)) {
  let doing;
  if (going) {
    const s = [...(going.steps ?? []), ...(going.review ? [going.review] : [])].find(x => x.status === 'running');
    const planned = going.lead?.plan ? `, planned ${going.lead.plan.tasks.length} task(s)${going.lead.plan.note ? ` (${clip(going.lead.plan.note, 120)})` : ''}` : '';
    if (s?.agent === LEAD && s.role === 'plan') doing = `planning the request "${clip(going.instruction, 140)}" into tasks, run ${going.id}`;
    else if (s?.agent === LEAD) doing = `reviewing the crew's work first, run ${going.id}${planned}`;
    else doing = `on run ${going.id} "${clip(going.title, 80)}" (${s ? `${s.agent} at work` : 'preparing'})${planned}`;
  } else if (next) doing = `next in the queue: "${clip(next.title, 80)}" [${next.id}]`;
  else doing = 'off (it only runs when the project has work)';
  const memory = info ? `memory of ${info.lines} line(s), updated ${formatDateTime(info.updated)}` : 'no memory yet';
  return `Team lead of project ${projectId}: ${lead.name} (based on ${lead.base}): ${doing}; ${memory}. Send it requests with \`node src/cli.mjs ask ${projectId} "<request>"\`.`;
}
