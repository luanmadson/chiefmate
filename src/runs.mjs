// How a run (a mission or a one-off task) goes: working copy, the crew in sequence, the manager's review,
// the project's checks and a pull request.
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { instructionFiles, stepAccess, stepMcp } from './access.mjs';
import { contextWindow, runClaude } from './claude.mjs';
import { loadConfig, projectCrew } from './config.mjs';
import {
  fullReport, generateBrief, generateOutcome, mergeOutcomes, outcomeLine, outcomeMarkdown, outcomeTemplate, parseOutcome, shortSummary, shortTitle,
  TITLE_MAX,
} from './digest.mjs';
import { formatDate, formatDateTime, formatDuration, formatNumber, formatPercent, t } from './i18n.mjs';
import {
  applyPlan, finalReviewLines, LEAD, leadLines, leadPlanStep, leadReviewStep, memberLines, readMemory, saveMemory, takeMemory,
} from './leads.mjs';
import { reportEvent } from './news.mjs';
import { notify } from './notify.mjs';
import { builderSettings, projectInstructions, writtenInstructions } from './prompts.mjs';
import { readRun, readUsage, runDir, runFile, saveRun, stepsOf } from './store.mjs';
import { agentSays, ownerTurn, pendingTalk, talkSection } from './talk.mjs';
import { clip, languageName, now, ROOT, slug, stamp } from './util.mjs';
import {
  baseBranch, changedFiles, checkoutBranch, commitPending, createBranch, deliverToClone, newCommits, openPullRequest, prepareLibrary,
  prepareWorkspace, projectDir, runChecks,
} from './workspace.mjs';

/**
 * What the app shows as happening right now: one entry per run going on, by run id (runs of different projects go on
 * at the same time). Each entry: { run, title, summary, project, step, agent, started, pid, context, actions, doing,
 * heldUntil },
 * plus, kept off the app, the run as it is in memory (its steps save it as they go), the agent's process and the
 * cancellation asked for.
 */
export const live = new Map();
export const liveRuns = () => [...live.values()].sort((a, b) => (a.since ?? '').localeCompare(b.since ?? ''));
export const liveOf = id => live.get(id) ?? null;
/** The run going on with this id, as it is in memory; null when it is not going on. */
export const activeRun = id => live.get(id)?.memory ?? null;
/** What the app and the manager see of a run going on (without the run object, its process or the cancellation). */
export const livePublic = l => ({
  run: l.run, title: l.title, summary: l.summary ?? null, project: l.project, step: l.step, agent: l.agent, started: l.started, since: l.since, pid: l.pid,
  context: l.context, actions: l.actions, doing: doingNow(l),
});

/** What the agent of a run going on is doing now, in plain words (one short line). */
export const doingNow = l => (Date.now() < (l.heldUntil ?? 0) ? t('waiting for you') : l.doing ?? null);

// No agent pushes anything to GitHub or changes it: Chiefmate itself pushes the branch and opens the pull request.
export const ALWAYS_DISALLOWED = ['Bash(git push:*)', 'Bash(gh pr:*)', 'Bash(gh repo:*)', 'Bash(git remote:*)'];

/** Chiefmate's command line, for a step: to ask for the owner (src/needs.mjs) and to propose items (src/planning.mjs). */
function cliCommand() {
  const cli = path.join(ROOT, 'src', 'cli.mjs').replaceAll('\\', '/');
  return 'node ' + (/\s/.test(cli) ? '"' + cli + '"' : cli);
}

function crewRules(config, project, projectId, reportLang = config.language || 'en') {
  const owner = languageName(config.language || 'en');
  const content = languageName(project.language || config.language || 'en');
  return `## Chiefmate rules (for the whole crew)
- You are part of the Chiefmate crew, working on one step of a run. Work alone, step by step. Avoid subagents: start one only when it is truly necessary, and never several at once.
- The current folder is a working copy of the project, already on the run's branch. Commit your work with clear messages that follow the project's convention (see \`git log\`); if there is none, write them in ${content}. Never push, switch branches or open pull requests: Chiefmate does that at the end.
- If the project's playbook says to create a branch, push or open a pull request, skip that part.
- The project's documentation outranks your own preferences. Read what you need before changing anything.
- Write project content in the language the project already uses.
- If you get stuck, undo whatever is half-done and explain it in your report.
- If you find work worth doing outside your part, don't do it: propose it for ${config.owner || 'the owner'}'s planning board, during the step or at its end, with \`${cliCommand()} plan propose ${projectId} "<short title, at most ${TITLE_MAX} characters: what will be done>" --summary "<1-2 sentences: what and why>" --agent <member who should do it> --priority high|medium|low\`. Propose only what has a clear gain, one item per idea, and check \`${cliCommand()} plan list --project ${projectId} --all\` first so you don't repeat an item. The manager triages the proposals and ${config.owner || 'the owner'} decides. Don't propose fixes within your own task or the next run of a mission already approved: those you just do.
- Never read, list or copy Chiefmate's \`data/\` folder (including \`data/browser-profile\`, the browser profile Chiefmate uses for the owner), other projects' working copies or other projects' personal documentation. You only get the folders this step needs.
- When you need ${config.owner || 'the owner'} to act (sign in somewhere, confirm something, do what only a person can do), don't stop and don't work around it: run \`${cliCommand()} needs-you "<what to do, in ${owner}>" [--url <address>] [--wait] [--check "<command that succeeds once it is done>"]\` with the Bash tool's timeout at 600000 ms. Chiefmate shows the request to the owner and opens the address in their browser. With --wait the command returns once the owner clicks Done (or the check succeeds); if it says it is still waiting, run the command it prints. If it gives up waiting, finish what you can and say in your report what is left for the owner. Never type passwords or codes yourself.
- ${config.owner || 'The owner'} may write to you directly from the app while you work: the message arrives as your next turn, with your work kept as it was. Answer it in one short message, then go on. To ask ${config.owner || 'the owner'} something, use needs-you with --wait: they can answer from the app, and the answer comes back as the command's output.
- Your last message is the step's report, in ${languageName(reportLang)}: short markdown with what you did (and the files), the sources you used, what you left out and why, and what the reviewer should check. ${config.owner || 'The owner'} must understand it in seconds, so it starts with this final summary, in plain words and with these headings exactly, the full report under the last one ("Needs you?" says whether ${config.owner || 'the owner'} must do something besides reviewing the work, and what):
${fenced(outcomeTemplate(reportLang), 'markdown')}`;
}

const BUILDER_TASK = 'Do what the project instructions below (written in the prompt builder) ask.';

/** What a run is about, for its title and summary: the instruction, the prompt builder's prompt or the mission's steps. */
function workOf(run, config = loadConfig()) {
  if (run.kind === 'mission') {
    return [config.missions?.[run.mission]?.description, ...(run.steps ?? []).map(s => `${s.agent}: ${s.part}`)].filter(Boolean).join('\n');
  }
  return run.instruction === BUILDER_TASK && run.builderPrompt ? run.builderPrompt : run.instruction || run.title;
}

/**
 * Queues a run. title and summary: given by whoever queues it (the manager's --title and --summary); what is missing
 * comes from the instruction's first sentence at once and from the quick model a moment later (describeLater).
 */
export function createRun({
  kind, missionId, projectId, agent, instruction, review = false, origin = 'app', notBefore = null, modules = [], plan = null, prompt = null,
  title: givenTitle = null, summary: givenSummary = null,
}) {
  const config = loadConfig();
  let title, steps, finalReview, project;
  if (kind === 'mission') {
    const mission = config.missions?.[missionId];
    if (!mission) throw new Error(t('Unknown mission: {id}', { id: missionId }));
    project = mission.project;
    title = mission.name;
    const agents = projectCrew(config, project);
    for (const s of [...mission.steps, ...(mission.review ? [mission.review] : [])]) {
      if (!agents[s.agent] || s.agent === LEAD) throw new Error(t('{agent} is not in the crew of {project}.', { agent: s.agent, project }));
    }
    steps = mission.steps.map(s => ({ agent: s.agent, part: s.part, status: 'pending' }));
    finalReview = mission.review ? { agent: mission.review.agent, part: mission.review.part, status: 'pending' } : null;
  } else if (kind === 'ask') {
    // A request for a project's team lead: it plans the tasks, the crew does them, the lead and then the manager review.
    if (!config.projects?.[projectId]) throw new Error(t('Unknown project: {id}', { id: projectId }));
    const lead = projectCrew(config, projectId)[LEAD];
    if (!lead) throw new Error(t('{project} has no team lead: add "lead" to its settings, or queue a task or a mission.', { project: projectId }));
    if (!instruction?.trim()) throw new Error(t('Write what the agent should do.'));
    project = projectId;
    steps = [leadPlanStep(instruction)];
    finalReview = { agent: 'manager', part: 'Review the work done for this request and write the pull request text.', status: 'pending' };
  } else {
    if (!config.projects?.[projectId]) throw new Error(t('Unknown project: {id}', { id: projectId }));
    const agents = projectCrew(config, projectId);
    if (agent === LEAD) throw new Error(t('The team lead takes requests, not tasks: use "ask".'));
    if (!agents[agent]) throw new Error(t('{agent} is not in the crew of {project}.', { agent, project: projectId }));
    // A task sent from the app's prompt builder carries its prompt: the instruction may then be left out.
    if (!instruction?.trim() && prompt?.trim()) instruction = BUILDER_TASK;
    if (!instruction?.trim()) throw new Error(t('Write what the agent should do.'));
    project = projectId;
    steps = [{ agent, part: instruction.trim(), status: 'pending' }];
    finalReview = review ? { agent: 'manager', part: 'Review the work of this task and write the pull request text.', status: 'pending' } : null;
  }
  if (!config.projects?.[project]) throw new Error(t('Unknown project: {id}', { id: project }));
  // In a project with a team lead, the lead reviews the crew's work first in every run, and keeps the memory.
  if (kind !== 'ask' && projectCrew(config, project)[LEAD]) steps.push(leadReviewStep());
  // The title says what will be done, short; the summary, what it is and why. "auto" ones are replaced by the quick model's.
  const mission = kind === 'mission' ? config.missions[missionId] : null;
  const given = { title: clip(givenTitle, TITLE_MAX + 20), summary: clip(givenSummary, 400) };
  const briefBy = {
    title: given.title ? 'given' : mission ? 'mission' : 'auto',
    summary: given.summary ? 'given' : mission?.description ? 'mission' : 'auto',
  };
  const work = instruction === BUILDER_TASK && prompt?.trim() ? prompt : instruction;
  title = given.title || title || shortTitle(work) || t('Untitled');
  const summary = given.summary || (mission ? clip(mission.description, 400) : '') || shortSummary(work);
  const base = `${stamp()}-${slug(missionId ?? agent ?? LEAD)}`;
  let id = base;
  for (let n = 2; existsSync(runFile(id)); n++) id = `${base}-${n}`;
  const run = saveRun({
    id, kind, mission: missionId ?? null, project, title, summary, briefBy, instruction: instruction ?? null, origin,
    status: 'queued', created: now(), notBefore, branch: `chiefmate/${id}`, steps, review: finalReview,
    modules: (Array.isArray(modules) ? modules : String(modules ?? '').split(',')).map(m => String(m).trim()).filter(Boolean),
    // The planning board's item this run was queued for: the item follows the run (src/planning.mjs).
    ...(plan != null && plan !== '' ? { plan: Number(String(plan).replace(/^#/, '')) } : {}),
    // The prompt written in the app's prompt builder: the steps get it instead of the one put together from the document.
    ...(prompt?.trim() ? { builderPrompt: prompt.trim() } : {}),
  });
  describeLater(run.id, run);
  return run;
}

// ---------- Titles and summaries from the quick model ----------

const describing = new Map(); // run id: the call going on
const describeTried = new Set(); // asked once per start of Chiefmate: a failure is not retried in a loop
const described = new Map(); // run id: the fields applied, for a copy of the run read before they were

/** Whether a run still has a title or summary to generate (old runs have neither). */
export const needsBrief = run => (run.briefBy
  ? run.briefBy.title === 'auto' || run.briefBy.summary === 'auto'
  : !(run.kind === 'mission' && run.summary));

/**
 * Generates, in the background, the title and summary a run is missing (new runs, and old ones when the app lists
 * them). Returns the call going on, or null.
 */
export function describeLater(id, known = null) {
  if (describing.has(id)) return describing.get(id);
  if (describeTried.has(id)) return null;
  const run = known ?? activeRun(id) ?? readRun(id);
  if (!run || !needsBrief(run)) return null;
  describeTried.add(id);
  const config = loadConfig();
  const job = generateBrief({ what: workOf(run, config), project: config.projects?.[run.project]?.name ?? run.project, config })
    .then(brief => brief && applyBrief(id, brief))
    .catch(error => console.error('Title and summary:', error.message))
    .finally(() => describing.delete(id));
  describing.set(id, job);
  return job;
}

function applyBrief(id, brief) {
  const run = activeRun(id) ?? readRun(id);
  if (!run) return;
  const by = { title: run.briefBy?.title ?? (run.kind === 'mission' ? 'mission' : 'auto'), summary: run.briefBy?.summary ?? 'auto' };
  const fields = { briefBy: { ...by } };
  if (by.title === 'auto') Object.assign(fields, { title: brief.title, briefBy: { ...fields.briefBy, title: 'model' } });
  if (by.summary === 'auto') Object.assign(fields, { summary: brief.summary, briefBy: { ...fields.briefBy, summary: 'model' } });
  Object.assign(run, fields);
  described.set(id, fields);
  saveRun(run);
  const l = live.get(id);
  if (l) Object.assign(l, { title: run.title, summary: run.summary });
}

/** Cancels a run going on: its agent stops now, and the run ends as canceled. Returns false when it is not going on. */
export function cancelLive(id, reason) {
  const l = live.get(id);
  if (!l) return false;
  l.cancelRequest = reason;
  l.process?.cancel(reason);
  return true;
}

/**
 * Asks a run going on to pause for an update of Chiefmate: its agent is interrupted at a safe point (once the actions
 * under way finish) and the step is kept to resume the same Claude Code session after the update; the run goes back
 * to the front of the queue. A run preparing its working copy stops at once (a download, say) and prepares it again
 * when it resumes; one running its checks or opening its pull request pauses only at its next step, or ends first.
 * Returns false when it is not going on, or was already asked.
 */
export function pauseLive(id) {
  const l = live.get(id);
  if (!l || l.cancelRequest || l.pauseRequest) return false;
  l.pauseRequest = true;
  l.process?.interrupt?.();
  l.preparing?.abort();
  logAction(l, { type: 'action', text: t('Pausing at a safe point for an update of Chiefmate') });
  return true;
}

/** Asks every run going on to pause for an update of Chiefmate (see pauseLive). Returns the ids it asked. */
export const pauseAll = () => [...live.keys()].filter(pauseLive);

/** The next turn of a step resumed after an update of Chiefmate, with the owner's messages sent meanwhile. */
export function updatedTurn(messages, config = loadConfig()) {
  const lines = [
    'Chiefmate was updated while you were working: your work was paused at a safe point so the new version could be installed, and this session now resumes.',
    'Continue from where you left off. The branch, the files and this session are as you left them. A command that was still running when you were paused may have been cut off: check its result before you go on.',
    "When you finish, your last message is still the step's full report.",
  ];
  return messages.length ? `${lines.join('\n')}\n\n${ownerTurn(messages, config)}` : lines.join('\n');
}

/** Before every step: your account's usage, in the plan's 5-hour window and week. */
function checkLimits(config, run) {
  if (run.ignoreLimits) return null;
  const limits = config.limits ?? {};
  const usage = readUsage();
  const window = (w, ceiling, name) =>
    w && ceiling && w.used >= ceiling && w.resets && new Date(w.resets).getTime() > Date.now()
      ? { note: t('{window} of your account is at {percent}', { window: name, percent: formatPercent(w.used) }), waitUntil: w.resets }
      : null;
  return window(usage.five_hour, limits.pause_at_5h_window, t('the 5-hour window')) ?? window(usage.seven_day, limits.pause_at_plan_week, t("the plan's week"));
}

/** If the account ran out in the middle of a step, the step starts over once the limit resets. */
function limitHit(result) {
  if (result.ok || result.canceled) return null;
  const usage = readUsage();
  const rejected = usage.status === 'rejected' || /usage limit|rate limit|limit reached/i.test(result.error ?? '');
  if (!rejected) return null;
  const resets = [usage.five_hour, usage.seven_day].filter(w => w?.status === 'rejected' && w.resets).map(w => w.resets);
  return resets[0] ?? usage.five_hour?.resets ?? new Date(Date.now() + 60 * 60000).toISOString();
}

/**
 * The reference libraries a project uses: those in its "library" list and the one holding its personal "docs"
 * (written "<library>/<folder>"). Each comes back as { id, name, about, dir }.
 */
export async function prepareLibraries(config, ids, onStep = () => {}) {
  const list = [];
  for (const id of new Set(ids)) {
    const source = config.library?.[id];
    if (!source?.repository) throw new Error(t('Unknown library: {id}', { id }));
    list.push({ id, name: source.name ?? id, about: source.about ?? '', dir: await prepareLibrary(id, source, onStep) });
  }
  return list;
}

export const libraryIds = project => [...(project.library ?? []), ...(project.docs ? [project.docs.split('/')[0]] : [])];

/**
 * The prompt's lines about the libraries this step may read and the project's personal documentation.
 * A crew member gets only the libraries the project lists, plus its own documentation folder; the manager gets them all.
 */
function libraryLines(project, libraries, access) {
  const lines = [];
  const shown = libraries.filter(l => access.addDirs.includes(l.dir));
  if (shown.length) lines.push('', '## Reference library (read only)');
  for (const l of shown) lines.push(`- ${l.name}: \`${l.dir}\`. ${l.about}`.trim());
  if (shown.length) lines.push('Read what helps. It is a copy: anything you change there is discarded before the next run.');
  if (access.docs) {
    const docs = access.docs;
    lines.push(
      '',
      '## Personal documentation for this project',
      `\`${docs}\`: read it first. It is the main reference for this project and takes precedence over the repository's own instructions (such as CLAUDE.md or AGENTS.md), which you still follow when they don't conflict with it. It stays outside the project's repository: never copy it into the project. If your work makes it outdated, say what should change in your report.`,
    );
  }
  return lines;
}

function logAction(l, event) {
  if (event.type !== 'action' && event.type !== 'say') return;
  l.actions.push({ at: now(), type: event.type, text: event.type === 'say' ? clip(event.text, 300) : event.text });
  if (l.actions.length > 300) l.actions.splice(0, l.actions.length - 300);
}

/**
 * A step's prompt in parts, in order, each with a key and where it comes from (the project's Context tab shows them,
 * src/context.mjs): their lines, joined, are the prompt as it is sent.
 */
export function promptParts({ run, step, project, previous, finalReview, changes, config, libraries, base, access, built, agents }) {
  const prLanguage = project.language || config.language || 'en';
  const local = project.deliver === 'local';
  const parts = [];
  const add = (key, source, lines) => {
    if (lines.length) parts.push({ key, source, lines });
  };
  add('header', 'Chiefmate: the run and the step', [
    finalReview ? `# Final review: ${run.title}` : `# ${run.title}`,
    `Project: ${project.name}${project.site ? ` (${project.site})` : ''}. ${project.about ?? ''}`.trim(),
    `Today: ${formatDateTime(new Date())}. Run branch: ${run.branch}, started from ${base}.${local ? ' Nothing from this run goes to GitHub: the branch is handed to the owner, who decides what to send.' : ''}`,
    '',
    finalReview ? '## What to do in this review' : step.agent === LEAD && step.role === 'plan' ? '## The request to plan' : '## Your part',
    step.part,
  ]);
  // In a project with a team lead: the lead gets its memory and how to plan or review; the crew, the memory to read.
  const lead = agents?.[LEAD] ?? null;
  const memorySource = `data/projects/${run.project}/memory.md`;
  if (lead && step.agent === LEAD) {
    const lines = leadLines({ run, step, agents, memory: readMemory(run.project), base });
    // Its first three lines are the memory ('', its heading, its text); the rest, how to plan or to review.
    add('memory', memorySource, lines.slice(0, 3));
    add('lead', 'Chiefmate (src/leads.mjs)', lines.slice(3));
  } else if (lead && !finalReview) add('memory', memorySource, memberLines({ run, step, lead, memory: readMemory(run.project) }));
  if (project.playbook && run.kind === 'mission') {
    add('playbook', `projects.${run.project}.playbook`, ['', `This mission's playbook is \`${project.playbook}\`. Read it before you start and do only your part.`]);
  }
  // From the prompt builder when there is one for the project; else the project's notes.
  if (built) add('builder', built.file, ['', '## Project instructions (from the prompt builder)', built.text]);
  const projectNotes = (built ? null : project.notes) || null;
  const noteKey = project.agent_notes?.[step.agent] != null ? step.agent : agentBase(step.agent, run, config);
  const memberNotes = project.agent_notes?.[noteKey] || null;
  const notesHead = ['', '## Notes for this project'];
  if (projectNotes) add('notes', `projects.${run.project}.notes`, [...notesHead, projectNotes]);
  if (memberNotes) add('agent-notes', `projects.${run.project}.agent_notes.${noteKey}`, projectNotes ? ['', memberNotes] : [...notesHead, memberNotes]);
  add('libraries', `projects.${run.project}.library, projects.${run.project}.docs`, libraryLines(project, libraries, access));
  if (finalReview) {
    const lines = [];
    lines.push(
      '',
      `You are the manager. The crew finished the work below. Before it goes to the owner for approval${local ? ' (as a branch, not a pull request)' : ' as a pull request'}:`,
      `1. See what changed: \`git log --oneline origin/${base}..HEAD\` and the diff of every file that matters.`,
      `2. Check it against the reports and the project's rules${run.lead?.opinion ? ", weighing the team lead's opinion below (its first review)" : ''}. Fix whatever is wrong or incomplete, committing as "Chiefmate: manager review". When the owner guided a step directly (a "direct talk" section at the end of its report), check that the work follows what they said.`,
      `3. Run the checks: ${(project.checks ?? []).map(c => `\`${c}\``).join(', ') || 'the ones the project and its documentation describe, as far as this machine allows'}.`,
      `4. Your last message presents the work for approval${local ? ', as the note that goes with the branch' : ', as the pull request text'}, in markdown and in ${languageName(prLanguage)}, starting with the final summary the rules below describe. End it with a section titled "${t("Manager's verdict", {}, prLanguage)}": what you fixed, the risks and your recommendation (approve, approve with caveats, or do not approve).`,
      '',
      '## Changed files',
      '```',
      changes || '(none)',
      '```',
    );
    add('review', 'Chiefmate: the final review (src/runs.mjs)', lines);
    add('lead-review', "Chiefmate: the team lead's plan and opinion", finalReviewLines(run, lead));
  }
  // The final review reads the lead's plan and opinion above, so its steps are not repeated among the crew's reports.
  const reports = finalReview && lead ? previous.filter(p => p.agent !== LEAD) : previous;
  if (reports.length) {
    const lines = ['', finalReview ? '## Crew reports' : '## What the previous steps did'];
    for (const p of reports) lines.push('', `### ${p.agent}${p.role ? `, ${p.role === 'plan' ? 'planning' : 'first review'}` : ''} (${p.status})`, fullReport(p) || p.error || '(no report)');
    add('reports', 'The reports of the steps before', lines);
  }
  add('rules', 'Chiefmate (src/runs.mjs, crewRules)', ['', crewRules(config, project, run.project, finalReview ? prLanguage : config.language || 'en')]);
  return parts;
}

const stepPrompt = args => promptParts(args).flatMap(p => p.lines).join('\n');

/** What a step may use: the agent's tools and its MCP servers', and what is denied (always, by the agent, by access). */
export function stepTools(agent, mcp, access) {
  return {
    tools: [...new Set([...(agent.tools ?? []), ...mcp.tools])],
    disallowed: [...new Set([...ALWAYS_DISALLOWED, ...(agent.disallowed ?? []), ...access.denied])],
  };
}

/**
 * The context of the step at work: the tokens of its last turn, against the model's window, and how many times
 * Claude Code compacted it. Every step starts with a new session, so nothing more is done than showing and logging it.
 */
function followContext(l, event) {
  if (event.type === 'start' && event.model) l.context = { ...l.context, window: contextWindow(event.model) };
  if (event.type === 'context') l.context = { ...l.context, used: event.used, window: event.window };
  if (event.type === 'compact') {
    l.context = { ...l.context, compactions: (l.context?.compactions ?? 0) + 1 };
    const before = event.before ? t('{tokens} tokens before', { tokens: formatNumber(event.before) }) : '';
    logAction(l, { type: 'action', text: (event.trigger === 'manual' ? t('Context compacted') : t('Context compacted automatically')) + (before ? ` (${before})` : '') });
  }
}

/** The base agent of a crew member (a project's crew can rename agents), for the project's per-agent notes. */
const agentBase = (id, run, config) => projectCrew(config, run.project)[id]?.base ?? id;

// A fence longer than any run of backticks in the text, so the text shows whole.
const fence = text => '`'.repeat(Math.max(3, ...(String(text).match(/`+/g) ?? []).map(m => m.length + 1)));
const fenced = (text, lang = '') => `${fence(text)}${lang}\n${text}\n${fence(text)}`;
const bullets = items => (items.length ? items.map(i => `- \`${i}\``).join('\n') : '- (none)');

/** What the step received, written next to its log as data/runs/<id>/<NN>-<agent>.context.md. */
function contextReport({ run, step, index, agent, dir, model, prompt, tools, disallowed, access, mcp, built, args }) {
  const builder = built
    ? [
      `- File: \`${built.file}\``,
      `- Blocks: ${built.blocks.join(', ')}`,
      ...(built.off?.length ? [`- Turned off for the project ("prompt_exclude"): ${built.off.join(', ')}`] : []),
      ...built.missing.map(m => `- Not found: ${m}`),
      ...(built.unresolved?.length ? [`- Variables left unfilled (no value in the document): ${built.unresolved.map(v => `{${v}}`).join(', ')}`] : []),
      ...built.adaptations.map(a => `- Adapted in "${a.block}" (Chiefmate's rules prevail): ${a.line}`),
    ].join('\n')
    : "- Not used (no file, or no block for the project): the project's notes went instead.";
  return [
    `# Context received: ${step.agent} (step ${index + 1}), run ${run.id}`,
    '',
    `- Model: \`${model}\`${agent.effort ? `, effort \`${agent.effort}\`` : ''}, time limit ${agent.max_minutes ?? 60} min`,
    `- Agent: \`${agent.id}\`${agent.base ? ` (based on \`${agent.base}\`, crew of ${agent.project})` : ''}, instructions from \`${agent.file}\``,
    "- The user's own Claude Code configuration: none. Setting sources `project,local` (no user settings, hooks, plugins or skills), `claudeMdExcludes` for `~/.claude` (no global CLAUDE.md or rules), `--strict-mcp-config`.",
    '',
    '## Folders',
    `- Working copy (the current folder): \`${dir}\``,
    ...(access.addDirs.length ? access.addDirs.map(d => `- Also allowed (--add-dir): \`${d}\``) : ['- No other folder.']),
    '',
    '## Tools allowed',
    bullets(tools),
    '',
    '## Tools and paths denied',
    bullets(disallowed),
    '',
    '## External tools (MCP)',
    mcp.names.length ? mcp.names.map(n => `- \`${n}\`: \`${JSON.stringify(mcp.servers[n])}\``).join('\n') : '- (none)',
    ...(mcp.unknown.length ? [`- Released but missing from "mcp_servers": ${mcp.unknown.join(', ')}`] : []),
    '',
    "## The repository's instruction files",
    bullets(instructionFiles(dir)),
    '',
    '## Prompt builder',
    builder,
    '',
    '## Command line',
    fenced(args.map(a => (/[\s"{}]/.test(a) ? JSON.stringify(a) : a)).join(' ')),
    '',
    "## System prompt (added to Claude Code's own)",
    fenced(agent.instructions, 'markdown'),
    '',
    '## Prompt',
    fenced(prompt, 'markdown'),
    '',
  ].join('\n');
}

/** Adds to the context report what Claude Code says it loaded, from the first event of the step. */
function appendLoaded(file, init) {
  const names = list => (list ?? []).map(x => (typeof x === 'string' ? x : x?.name ?? JSON.stringify(x))).join(', ') || '(none)';
  const servers = (init.mcp_servers ?? []).map(s => `${s.name} (${s.status})`).join(', ') || '(none)';
  try {
    appendFileSync(file, [
      '## What Claude Code loaded (as it reported when the step started)',
      `- Tools: ${names(init.tools)}`,
      `- MCP servers: ${servers}`,
      `- Skills: ${names(init.skills)}`,
      `- Plugins: ${names(init.plugins)}`,
      `- Extra folders: ${names(init.additional_directories)}`,
      '',
    ].join('\n'));
  } catch {
    // the report is a convenience: the step goes on
  }
}

async function runStep({ l, run, step, index, dir, project, config, agents, libraries, base, finalReview = false }) {
  const agent = agents[step.agent];
  if (!agent) throw new Error(t('Unknown agent: {id}', { id: step.agent }));
  const previous = run.steps.filter(s => s !== step && s.status !== 'pending' && s.status !== 'skipped');
  const changes = finalReview ? await changedFiles(dir, base).catch(() => '') : '';
  const model = agent.model ?? config.default_model;
  const access = stepAccess({ config, projectId: run.project, project, libraries, manager: step.agent === 'manager' });
  const mcp = stepMcp(config, project, agent);
  let built = null;
  try {
    built = run.builderPrompt ? writtenInstructions(run.builderPrompt) : projectInstructions(config, project, run.modules ?? []);
  } catch (error) {
    logAction(l, { type: 'action', text: t("Couldn't read the prompt builder: {error}", { error: error.message }) });
  }
  for (const a of built?.adaptations ?? []) logAction(l, { type: 'action', text: t('Prompt builder: a line of "{block}" was adapted to the crew\'s rules', { block: a.block }) });
  const prompt = stepPrompt({ run, step, project, previous, finalReview, changes, config, libraries, base, access, built, agents });
  const { tools, disallowed } = stepTools(agent, mcp, access);
  const name = `${String(index + 1).padStart(2, '0')}-${step.agent}`;
  const contextFile = path.join(runDir(run.id), `${name}.context.md`);

  // A team lead reads and judges: whatever it changes in the working copy (through the shell) is dropped after its step.
  const before = agent.lead ? await headCommit(dir) : null;
  // Asked to pause for an update while the step was being prepared: it starts after the update, as it would now.
  if (l.pauseRequest) return { paused: true };
  // A step paused for an update of Chiefmate resumes its own Claude Code session, with its clock and its counts.
  const paused = step.paused ?? null;
  delete step.paused;
  Object.assign(step, { status: 'running', started: paused ? step.started ?? now() : now(), error: null, model, promptBlocks: built?.blocks ?? null, adaptations: built?.adaptations ?? null });
  Object.assign(l, {
    step: index + 1, agent: step.agent, started: now(), context: { used: 0, window: contextWindow(model), compactions: 0 }, actions: [], heldUntil: 0, talking: false, reply: null, session: null,
    doing: finalReview ? t('reviewing the work') : step.role === 'plan' ? t('planning the request') : t('getting started'),
  });
  saveRun(run);

  // Every step keeps its Claude Code session, so a message from the owner can resume it (src/talk.mjs).
  let session = paused ? { id: paused.session, resume: true } : { id: randomUUID() };
  const common = {
    dir,
    system: agent.instructions,
    model,
    effort: agent.effort,
    tools,
    disallowed,
    addDirs: access.addDirs,
    mcpServers: mcp.servers,
    // For "needs-you": which run and step is asking, and where Chiefmate answers.
    env: { CHIEFMATE_RUN: run.id, CHIEFMATE_STEP: String(index + 1), CHIEFMATE_PORT: String(Number(process.env.CHIEFMATE_PORT) || config.port || 4747) },
    attribution: config.attribution !== false,
    maxMinutes: agent.max_minutes ?? 60,
    isHeld: () => Date.now() < l.heldUntil,
    log: path.join(runDir(run.id), `${name}.jsonl`),
    onEvent: event => {
      followContext(l, event);
      logAction(l, event);
      if (event.doing) l.doing = event.doing;
      if (event.type === 'start' && event.session) l.session = event.session;
      if (event.type === 'start' && event.init && !session.resume) appendLoaded(contextFile, event.init);
      // The first thing the agent says after the owner's message is its answer, shown next to the message.
      if (event.type === 'say' && l.reply) {
        agentSays(run, { step: index + 1, agent: step.agent, text: event.text, replyTo: l.reply });
        l.reply = null;
        saveRun(run);
      }
    },
  };
  let turn = prompt;
  let spentMs = paused?.spentMs ?? 0;
  const total = paused?.total ?? { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, turns: 0, durationMs: 0, subagents: 0 };
  let resuming = !!paused;
  if (paused) {
    // The owner's messages sent while the step was paused go with the notice of the update.
    const messages = pendingTalk(run, index + 1);
    for (const m of messages) Object.assign(m, { status: 'delivered', delivered: now(), via: 'resume' });
    if (messages.length) l.reply = messages.at(-1).id;
    turn = updatedTurn(messages, config);
    logAction(l, { type: 'action', text: t('Chiefmate was updated: the agent goes on in the same session') });
  }
  let r;
  let pausedNow = false;
  l.talking = true;
  for (;;) {
    const proc = runClaude({ ...common, prompt: turn, session, spentMs });
    if (!session.resume) {
      try {
        writeFileSync(contextFile, contextReport({ run, step, index, agent, dir, model, prompt, tools, disallowed, access, mcp, built, args: proc.args }));
      } catch (error) {
        logAction(l, { type: 'action', text: t("Couldn't write the context report: {error}", { error: error.message }) });
      }
    }
    l.process = { cancel: proc.cancel, interrupt: proc.interrupt };
    l.pid = proc.pid; // the agent's process: its memory counts for the project, and it is never stopped from the Projects section
    // Canceled while the step was being prepared (or between two turns): stop the agent that just started.
    if (l.cancelRequest) proc.cancel(l.cancelRequest);
    r = await proc.promise;
    l.process = null;
    l.pid = null;
    spentMs = r.spentMs ?? spentMs;
    for (const k of Object.keys(total.tokens)) total.tokens[k] += r.tokens?.[k] ?? 0;
    total.turns += r.turns ?? 0;
    total.durationMs += r.durationMs ?? 0;
    total.subagents += r.subagents ?? 0;
    // The session paused for an update is gone (or never started): the step starts over, as it did before pauses.
    if (resuming && !r.ok && !r.canceled && !r.interrupted && !r.turns && !r.text && !l.cancelRequest && !limitHit(r)) {
      resuming = false;
      session = { id: randomUUID() };
      turn = prompt;
      logAction(l, { type: 'action', text: t("The step's session could not be resumed after the update: it starts over") });
      continue;
    }
    resuming = false;
    // Paused for an update of Chiefmate: the session is kept, and the step resumes it after the update (the owner's
    // messages not delivered yet go along then).
    if (l.pauseRequest && !l.cancelRequest && !r.canceled && (r.interrupted || pendingTalk(run, index + 1).length)) {
      pausedNow = true;
      l.talking = false;
      break;
    }
    // Messages the owner sent meanwhile: resume the same session with them as the next turn. Checked and closed with
    // no wait in between, so a message sent at the very end is never left behind.
    const messages = pendingTalk(run, index + 1);
    if (!messages.length) {
      l.talking = false;
      break;
    }
    if (l.cancelRequest || r.canceled || limitHit(r) || (!r.ok && !r.interrupted)) {
      l.talking = false;
      for (const m of messages) Object.assign(m, { status: 'undelivered' });
      saveRun(run);
      break;
    }
    for (const m of messages) Object.assign(m, { status: 'delivered', delivered: now(), via: 'resume' });
    l.reply = messages.at(-1).id;
    session = { id: r.session ?? l.session ?? session.id, resume: true };
    turn = ownerTurn(messages, config);
    logAction(l, { type: 'action', text: t('Your message was delivered: the agent goes on in the same session') });
    saveRun(run);
  }
  l.reply = null;
  if (pausedNow) {
    Object.assign(step, { status: 'pending', paused: { session: r.session ?? l.session ?? session.id, spentMs, total, at: now() } });
    logAction(l, { type: 'action', text: t('Paused for the update: the step resumes in the same session afterwards') });
    saveRun(run);
    return { paused: true };
  }
  Object.assign(r, total);

  const waitUntil = limitHit(r);
  // The final summary at the top of the report is kept apart (step.outcome): the app shows it first, the rest folded.
  const reportLang = finalReview ? project.language || config.language || 'en' : config.language || 'en';
  const { outcome, rest } = parseOutcome(r.text || '', [reportLang, config.language]);
  Object.assign(step, {
    status: waitUntil ? 'pending' : r.ok ? 'done' : 'failed', ended: waitUntil ? null : now(), tokens: r.tokens, turns: r.turns,
    durationMs: r.durationMs, report: rest + talkSection(run, index + 1, id => t(agents[id]?.name ?? id), config), error: r.error ?? null, subagents: r.subagents, actions: l.actions.length,
    context: r.context ? { ...r.context, compactions: l.context?.compactions ?? r.context.compactions } : null,
    outcome: outcome ? { ...outcome, lang: reportLang } : null,
  });
  if (r.context?.used) {
    logAction(l, { type: 'action', text: t('Context at the end of the step: {used} of {window} tokens ({percent}), {count} compaction(s)', {
      used: formatNumber(r.context.used), window: formatNumber(r.context.window), percent: formatPercent(r.context.used / r.context.window), count: step.context.compactions,
    }) });
  }
  if (before) {
    const dropped = await discardSince(dir, before).catch(e => (step.error = `${step.error ?? ''} Discard: ${e.message}`.trim(), false));
    if (dropped) logAction(l, { type: 'action', text: t('The team lead changed files, which it may not do: the changes were dropped') });
  } else await commitPending(dir, `Chiefmate: ${t(agent.name)} (${run.title})`).catch(e => (step.error = `${step.error ?? ''} Commit: ${e.message}`.trim()));
  saveRun(run);
  return { waitUntil };
}

/** The pull request's text, in the project's language (lang). */
function pullRequestBody(run, checks, agents, lang) {
  const labels = { pending: t('Pending', {}, lang), running: t('Running', {}, lang), done: t('Done', {}, lang), failed: t('Failed', {}, lang), skipped: t('Skipped', {}, lang) };
  const name = id => t(agents[id]?.name ?? id, {}, lang);
  const main = run.review?.report || run.steps.map(s => `## ${name(s.agent)}\n\n${fullReport(s) || s.error || t('(no report)', {}, lang)}`).join('\n\n');
  // The same final summary the app shows opens the text; the review's report follows (without its own copy of it).
  const summary = run.prOutcome ? outcomeMarkdown(run.prOutcome, run.prOutcome.lang ?? lang) : '';
  const table = stepsOf(run).map(s => `| ${name(s.agent)} | ${labels[s.status] ?? s.status} | ${formatDuration(s.durationMs)} | ${s.turns ?? ''} |`);
  const checkList = checks.map(c => `- ${c.ok ? '✅' : '❌'} \`${c.command}\``);
  return [
    ...(summary ? [summary, '', `### ${t('Full report', {}, lang)}`, ''] : []),
    main, '', '---', '',
    `### ${t('Done by Chiefmate', {}, lang)}`, '',
    `| ${t('Step', {}, lang)} | ${t('Status', {}, lang)} | ${t('Time', {}, lang)} | ${t('Turns', {}, lang)} |`, '|---|---|---|---|', ...table, '',
    `**${t('Checks after the review:', {}, lang)}**`, ...(checkList.length ? checkList : [`- ${t('(none)', {}, lang)}`]), '',
    t('Run `{id}`.', { id: run.id }, lang),
  ].join('\n');
}

/**
 * After a step of the team lead: the project memory it returned is saved (and taken out of its report); its plan
 * puts the crew's tasks in the run; its first review becomes the opinion the manager reads in the final review.
 * Everything it decided stays in the run (run.lead) and in the logbook.
 */
function afterLead(run, step, agents, log) {
  const name = t(agents[LEAD]?.name ?? LEAD);
  if (step.status === 'done') {
    const { memory, report } = takeMemory(step.report);
    if (memory) {
      try {
        saveMemory(run.project, memory);
        step.report = report;
        step.memory = true;
        log(t('{lead} updated the project memory', { lead: name }));
      } catch (error) {
        log(t("Couldn't save the project memory: {error}", { error: error.message }));
      }
    }
  }
  if (step.role === 'plan') {
    const plan = applyPlan(run, step, agents);
    log(plan.tasks.length
      ? t('{lead} planned {count} task(s): {list}', { lead: name, count: plan.tasks.length, list: plan.tasks.map(x => t(agents[x.agent]?.name ?? x.agent)).join(', ') })
      : t('{lead} planned no task: {note}', { lead: name, note: plan.note || plan.error || t('no reason given') }));
    if (plan.dropped.length) log(t('{lead} left out of the plan: {list}', { lead: name, list: plan.dropped.join('; ') }));
  } else if (step.role === 'review' && step.status === 'done') {
    run.lead = { ...run.lead, opinion: step.report, opinionAt: now() };
    log(t('{lead} wrote its opinion for the final review', { lead: name }));
  }
  saveRun(run);
}

/**
 * A run's final summary, once it ends: run.outcome in the owner's language (the app, the notifications, the manager)
 * and run.prOutcome for the pull request (the final review's own, else the quick model's, in the project's language).
 * Without the quick model, the steps' own summaries are put together.
 */
async function settleOutcome(run, config, prLang) {
  const ownerLang = config.language || 'en';
  const steps = stepsOf(run).filter(s => !['pending', 'skipped'].includes(s.status) && s.agent !== LEAD);
  const review = run.review?.outcome ?? null;
  let owner = review?.lang === ownerLang ? review : null;
  let pr = null;
  if (!owner) {
    const made = await generateOutcome({ run, steps, config, prLang }).catch(() => null);
    if (made) [owner, pr] = [{ ...made.owner, lang: ownerLang }, made.pr ? { ...made.pr, lang: prLang } : null];
  }
  const merged = owner ? null : mergeOutcomes(steps.filter(s => s.outcome?.lang === ownerLang));
  run.outcome = owner ?? (merged ? { ...merged, lang: ownerLang } : null);
  run.prOutcome = review ?? pr ?? run.outcome;
}

const outcomeTried = new Set();

/**
 * The final summary of a run that ended without one (an older run, or one that failed or was canceled), generated in
 * the background when the app opens it. Returns the call going on, or null.
 */
export function outcomeLater(id) {
  const run = readRun(id);
  if (!run || run.outcome || live.has(id) || outcomeTried.has(id) || !['done', 'failed', 'canceled'].includes(run.status)) return null;
  outcomeTried.add(id);
  const config = loadConfig();
  return settleOutcome(run, config, config.projects?.[run.project]?.language || config.language || 'en')
    .then(() => {
      const fresh = readRun(id);
      if (fresh && run.outcome && !fresh.outcome) saveRun(Object.assign(fresh, { outcome: run.outcome, prOutcome: run.prOutcome }));
    })
    .catch(error => console.error('Final summary:', error.message));
}

/** A run for the manager's news: its short title, its summary and, once it ended, its final summary. */
function aboutRun(run) {
  const o = run.outcome;
  const outcome = o ? ` [final summary: done: ${o.done.join('; ') || '-'}; what changes: ${o.change || '-'}; needs the owner: ${o.needs || 'no'}]` : '';
  return `Run ${run.id} "${run.title}" (project ${run.project}${run.summary ? `; ${run.summary}` : ''})${outcome}`;
}

/** Runs (or resumes) a run until the end, a pause for a limit, or a cancellation. */
export async function execute(run) {
  const config = loadConfig();
  const agents = projectCrew(config, run.project);
  const project = config.projects?.[run.project];
  const prLang = project?.language || config.language || 'en';
  if (live.has(run.id)) throw new Error(`Run ${run.id} is already going on.`);
  Object.assign(run, described.get(run.id) ?? {});
  const l = {
    run: run.id, title: run.title, summary: run.summary ?? null, doing: t('preparing the working copy'), project: run.project, step: null, agent: null, started: now(), since: now(), pid: null, context: null, actions: [],
    heldUntil: 0, memory: run, process: null, cancelRequest: null, preparing: null,
  };
  live.set(run.id, l);
  const log = text => logAction(l, { type: 'action', text });
  const firstTime = !run.started;
  Object.assign(run, { status: 'running', started: run.started ?? now(), notBefore: null, note: null });
  delete run.resumeFirst;
  saveRun(run);

  // Paused for an update of Chiefmate: back to the front of the queue, to resume as soon as the update is over.
  const pauseForUpdate = () => {
    Object.assign(run, { status: 'queued', resumeFirst: true, note: t('Paused for an update of Chiefmate. It resumes by itself as soon as the update is over.') });
    saveRun(run);
  };

  const wait = (waitUntil, note) => {
    Object.assign(run, { status: waitUntil ? 'waiting' : 'paused', notBefore: waitUntil ?? null, note });
    saveRun(run);
    notify(
      t('Chiefmate paused the run'),
      waitUntil
        ? t('{note}. I will resume on my own at {when}.', { note, when: formatDateTime(waitUntil) })
        : t('{note}. Open the app to decide.', { note }),
    );
    reportEvent('run_paused', `${aboutRun(run)} paused: ${note}. ${waitUntil ? `It resumes on its own at ${formatDateTime(waitUntil)}.` : 'It waits for the owner to decide (resume or cancel).'}`);
  };

  try {
    if (!project) throw new Error(t('Unknown project: {id}', { id: run.project }));
    // Over the limits already: wait before touching the working copy.
    const early = checkLimits(config, run);
    if (early) return wait(early.waitUntil, early.note);
    if (firstTime) {
      // The title and summary from the quick model take a few seconds: the notice waits for them, briefly.
      const pending = describing.get(run.id);
      if (pending) await Promise.race([pending, new Promise(resolve => setTimeout(resolve, 20_000))]);
      notify(t('Chiefmate started'), run.summary ? clip(`${run.title}. ${run.summary}`, 250) : run.title);
    }
    if (l.pauseRequest) return pauseForUpdate();
    let dir;
    if (!run.prepared) {
      run.base = await baseBranch(project);
      // A pause for an update stops the preparation at once (see pauseLive): it starts over when the run resumes.
      l.preparing = new AbortController();
      dir = await prepareWorkspace(run.project, project, run.base, log, { signal: l.preparing.signal });
      l.preparing = null;
      await createBranch(dir, run.branch);
      run.prepared = true;
      saveRun(run);
    } else {
      // Resuming: every finished step already left its work in commits on the run's branch.
      dir = projectDir(run.project);
      await checkoutBranch(dir, run.branch);
    }
    const base = run.base ?? project.main_branch;
    const libraries = await prepareLibraries(config, libraryIds(project), log);
    // The prompt builder's document in a library ("prompt_builder.library_file"): its copy up to date, so the steps'
    // instructions are put together from the latest version (the copy itself is not given to the steps).
    const builderLibrary = builderSettings(config).library;
    if (builderLibrary?.known && !libraries.some(x => x.id === builderLibrary.id)) {
      await prepareLibrary(builderLibrary.id, config.library[builderLibrary.id], log).catch(error => log(error.message));
    }

    // The steps in order, the final review last. The order is read again after every step: a team lead's plan adds
    // the crew's tasks right after its planning step.
    for (;;) {
      const order = [...run.steps.map(step => ({ step, finalReview: false })), ...(run.review ? [{ step: run.review, finalReview: true }] : [])];
      const index = order.findIndex(x => x.step.status === 'pending' || x.step.status === 'running');
      if (index < 0 || l.cancelRequest) break;
      if (l.pauseRequest) return pauseForUpdate();
      const { step, finalReview } = order[index];
      const limit = checkLimits(config, run);
      if (limit) return wait(limit.waitUntil, limit.note);
      const { waitUntil, paused } = await runStep({ l, run, step, index, dir, project, config, agents, libraries, base, finalReview });
      if (paused && !l.cancelRequest) return pauseForUpdate();
      if (waitUntil) return wait(waitUntil, t('Your account reached its limit in the middle of a step'));
      if (step.agent === LEAD) afterLead(run, step, agents, log);
    }
    const planning = run.steps.find(s => s.agent === LEAD && s.role === 'plan');
    if (planning?.status === 'failed' && !l.cancelRequest) {
      throw new Error(t("The team lead's planning failed: {error}", { error: clip(planning.error || t('no reason given'), 300) }));
    }

    if (l.cancelRequest) {
      Object.assign(run, { status: 'canceled', ended: now(), note: l.cancelRequest });
      saveRun(run);
      return;
    }

    log(t("Running the project's checks"));
    l.doing = t("running the project's checks");
    run.checks = await runChecks(dir, project.checks);
    const commits = await newCommits(dir, base);
    run.commits = commits.length;
    l.doing = t('writing the final summary');
    if (!commits.length) {
      const plan = run.lead?.plan;
      const result = plan && !plan.tasks.length
        ? t('The team lead planned no task: {note}', { note: plan.note || plan.error || t('no reason given') })
        : t('Finished with no changes to review.');
      run.result = result;
      await settleOutcome(run, config, prLang);
      Object.assign(run, { status: 'done', ended: now() });
      saveRun(run);
      notify(t('Chiefmate finished'), t('{title}: no changes to review.', { title: run.title }));
      reportEvent('run_finished', `${aboutRun(run)} finished with no changes to review: ${result}`);
      return;
    }
    const failed = run.checks.filter(c => !c.ok).length;
    await settleOutcome(run, config, prLang);
    saveRun(run);
    const body = pullRequestBody(run, run.checks, agents, prLang);
    const bodyFile = path.join(runDir(run.id), 'pull-request.md');

    if (project.deliver === 'local') {
      // Local delivery: the branch goes to your own clone (or stays in the working copy). Nothing goes to GitHub.
      writeFileSync(bodyFile, body);
      let where = t('the branch {branch} of the working copy ({path})', { branch: run.branch, path: dir });
      if (project.local_clone) {
        log(t('Handing the branch to your clone of {name}', { name: project.name }));
        await deliverToClone(dir, run.branch, project.local_clone);
        where = t('the branch {branch} of your clone ({path})', { branch: run.branch, path: project.local_clone });
      }
      const result = failed
        ? t('Ready on {where}, but {count} check(s) failed. Nothing was sent to GitHub.', { where, count: failed })
        : t('Ready on {where}. Nothing was sent to GitHub.', { where });
      Object.assign(run, { status: 'done', ended: now(), result, delivered: project.local_clone ?? dir });
      saveRun(run);
      notify(t('Ready for your review'), t('{title}: {result}', { title: run.title, result: [outcomeLine(run.outcome), result].filter(Boolean).join(' ') }), 'chiefmate:log');
      reportEvent('run_finished', `${aboutRun(run)} finished and was delivered locally, waiting for the owner's review: ${result}`);
      return;
    }

    log(t('Pushing the branch and opening the pull request'));
    l.doing = t('opening the pull request');
    run.pullRequest = await openPullRequest(dir, {
      base, branch: run.branch, title: `${run.prOutcome?.title || run.title} (${formatDate(run.created)})`, body, bodyFile,
    });
    const result = failed ? t('Pull request opened, but {count} check(s) failed.', { count: failed }) : t('Pull request opened and verified.');
    Object.assign(run, { status: 'done', ended: now(), result });
    saveRun(run);
    notify(t('Ready for your review'), t('{title}: {result}', { title: run.title, result: [outcomeLine(run.outcome), result].filter(Boolean).join(' ') }), run.pullRequest);
    reportEvent('pr_ready', `${aboutRun(run)} finished: pull request ${run.pullRequest} waits for the owner's approval. ${result}`);
  } catch (error) {
    if (error?.name === 'AbortError' && l.pauseRequest && !l.cancelRequest) {
      log(t('Preparation stopped for the update: it starts over when the run resumes'));
      return pauseForUpdate();
    }
    Object.assign(run, { status: 'failed', ended: now(), result: error.message });
    saveRun(run);
    notify(t('Chiefmate hit an error'), t('{title}: {error}', { title: run.title, error: clip(error.message, 180) }), 'chiefmate:log', { urgent: true });
    reportEvent('run_failed', `${aboutRun(run)} failed: ${clip(error.message, 400)}`);
  } finally {
    live.delete(run.id);
    // A run that failed or was canceled gets its final summary too, in the background.
    if (['failed', 'canceled'].includes(run.status)) outcomeLater(run.id);
  }
}
