// How a run (a mission or a one-off task) goes: working copy, the crew in sequence, the manager's review,
// the project's checks and a pull request.
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { instructionFiles, stepAccess, stepMcp } from './access.mjs';
import { browserServers, closeAfterRun } from './browsers.mjs';
import { contextWindow, runClaude } from './claude.mjs';
import { loadConfig, projectCrew } from './config.mjs';
import { currentEffort, effortChangeLine, runEffortChanges } from './effort.mjs';
import { guardHooks } from './guard.mjs';
import { askOwner, finishRequest, needsSettings } from './needs.mjs';
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
import { holdForQuarantine, lostFile, quarantinedBy, writtenSuspects } from './quarantine.mjs';
import { builderSettings, projectInstructions, writtenInstructions } from './prompts.mjs';
import { addSpeech, askedBy, speechRule } from './speech.mjs';
import { listRuns, readRun, readUsage, runDir, runFile, saveRun, stepsOf } from './store.mjs';
import { agentSays, ownerTurn, pendingTalk, talkSection } from './talk.mjs';
import { chooseTool, GROK_DENY, LOGIN_COMMAND, parseTool, qualityRecords, recordQuality, runTool, signedIn, TOOL_NAMES, toolEffort, toolModel } from './tools.mjs';
import { clip, languageName, now, parseLevel, ROOT, slug, stamp } from './util.mjs';
import {
  advanceClone, baseBranch, changedFiles, checkoutBranch, commitPending, commitSubjects, createBranch, deliverToClone, discardSince, freeBranch, freshenBranch, headCommit,
  installSetup, newCommits, noTrace, openPullRequest, prepareLibrary, prepareWorkspace, projectDir, restoreShelf, runBranch, runChecks, shelfRef,
  shelveWork, traces,
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

/** Writes a line in the log of a run going on (the agent's panel). Returns false when it is not going on. */
export function noteLive(id, text) {
  const l = live.get(id);
  if (!l) return false;
  logAction(l, { type: 'action', text });
  return true;
}

/** What the agent of a run going on is doing now, in plain words (one short line). */
export const doingNow = l => (Date.now() < (l.heldUntil ?? 0) ? t('waiting for you') : l.doing ?? null);

/** What the bubble of a run going on needs (speechNow in src/speech.mjs). */
export const liveSpeech = l => ({ step: l.step, agent: l.agent, doing: doingNow(l), held: Date.now() < (l.heldUntil ?? 0), lastAt: l.actions?.at(-1)?.at ?? null, since: l.started ?? null });

/** A line said by the agent of a run going on (cli.mjs say), for its speech bubble. Returns the entry. */
export function stepSays(runId, step, text) {
  const l = liveOf(String(runId ?? ''));
  const run = activeRun(String(runId ?? ''));
  if (!l || !run || !l.agent) throw new Error(t('No agent is at work on this run now: only a step going on speaks.'));
  if (step && Number(step) !== l.step) throw new Error(t('This step is no longer going on.'));
  const entry = addSpeech(run, { step: l.step, agent: l.agent, by: 'agent', text });
  if (!entry) throw new Error(t('Say something: one short line.'));
  saveRun(run);
  return entry;
}

// No agent pushes anything to GitHub or changes it: Chiefmate itself pushes the branch and opens the pull request.
// These rules catch the commands that start with them; the guard (guard.mjs, see crewGuard) catches the rest, however
// they are written (git -C dir push, bash -c "git push", a pull request opened through GitHub's API).
export const ALWAYS_DISALLOWED = ['Bash(git push:*)', 'Bash(gh pr:*)', 'Bash(gh repo:*)', 'Bash(git remote:*)'];

/**
 * The guard of a crew step or of the manager: refuses any publication, noting each refusal in "log" (nothing is ever
 * allowed). grants: the manager's only, the pushes the owner allowed it once (src/decisions.mjs); mainCard: where the
 * main branch may go through such a card (src/guard.mjs, mainPushTargets).
 */
export const crewGuard = (log, grants = null, mainCard = []) => guardHooks({ log, allowed: [], grants, mainCard });

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
- The current folder is a working copy of the project, already on the run's branch. Commit your work with clear messages that follow the project's convention (see \`git log\`); if there is none, write them in ${content}. Never push, switch branches or open pull requests: Chiefmate does that at the end. A command that would publish, however written, is refused by Chiefmate's guard: don't try another way, and don't stop your work for it.
- If the project's playbook says to create a branch, push or open a pull request, skip that part.${noTrace(project) ? `
- Others work on this project too and must not learn of Chiefmate or of AI agents from it: never write "Chiefmate", "Claude" or that an AI or agent did the work in commit messages, file or folder names (temporary ones too, such as no chiefmate_*.py), code, comments or documentation. Commit messages read as the owner's own, in the project's convention. Delete the temporary files and scripts you create before you finish, or keep them outside the project's folder.` : ''}
- The project's documentation outranks your own preferences. Read what you need before changing anything.
- Write project content in the language the project already uses.
- If you get stuck, undo whatever is half-done and explain it in your report.
- If you find work worth doing outside your part, don't do it: propose it for ${config.owner || 'the owner'}'s planning board, during the step or at its end, with \`${cliCommand()} plan propose ${projectId} "<short title, at most ${TITLE_MAX} characters: what will be done>" --summary "<1-2 sentences: what and why>" --agent <member who should do it> --priority high|medium|low\`. Propose only what has a clear gain, one item per idea, and check \`${cliCommand()} plan list --project ${projectId} --all\` first so you don't repeat an item. The manager triages the proposals and ${config.owner || 'the owner'} decides. Don't propose fixes within your own task or the next run of a mission already approved: those you just do.
- Never read, list or copy Chiefmate's \`data/\` folder (including \`data/browser-profile\`, the browser profile Chiefmate uses for the owner), other projects' working copies or other projects' personal documentation. You only get the folders this step needs.
- When you need ${config.owner || 'the owner'} to act (sign in somewhere, confirm something, do what only a person can do), don't stop and don't work around it: run \`${cliCommand()} needs-you "<what to do, in ${owner}>" [--url <address>] [--wait] [--check "<command that succeeds once it is done>"]\` with the Bash tool's timeout at 600000 ms. Chiefmate shows the request to the owner and opens the address in their browser. With --wait the command returns once the owner clicks "I did it" (or the check succeeds); if it says it is still waiting, run the command it prints. If it gives up waiting, finish what you can and say in your report what is left for the owner. Never type passwords or codes yourself.
- When you notice an error or failure of Chiefmate or of the communication between agents (a notice that never came, outdated information on the board or in your opening context, a Chiefmate command or tool that failed, a missing instruction), report it on your own at once, without waiting for ${config.owner || 'the owner'} to ask: \`${cliCommand()} defect report "<what happened>. Expected: <what should have happened>."\`. One report per defect, then go on with your work, and mention it in your report. It reaches the manager marked as your step's, never as ${config.owner || 'the owner'}'s message, and writes nothing in the project's folder.
- ${config.owner || 'The owner'} may write to you directly from the app while you work: the message arrives as your next turn, with your work kept as it was. Answer it in one short message, then go on. To ask ${config.owner || 'the owner'} to choose ("Resend or SES?"), run \`${cliCommand()} needs-you "<the question, in ${owner}>" --options "<option>|<option>" --recommend <option> --why "<one short sentence: why you recommend it>"\` (2 to 6 short options, in ${owner}): they get one button per option and a field to write, and the command waits and prints the answer: the option, their own words, or both. Keep needs-you without options for what they must do outside the app. For an open question, use needs-you with --wait: they can answer from the app, and the answer comes back as the command's output.
${speechRule(cliCommand(), owner, config.owner || 'the owner')}
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
  title: givenTitle = null, summary: givenSummary = null, level = null, request = null, tool: givenTool = null, due = null,
}, config = loadConfig()) {
  // The tool chosen for the run's crew steps (--tool); none: each member's own (src/tools.mjs).
  const tool = parseTool(givenTool);
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
    // A mission's step may name its own tool ("tool" in the step); --tool covers the steps without one.
    steps = mission.steps.map(s => ({ agent: s.agent, part: s.part, status: 'pending', ...(parseTool(s.tool) ? { toolAsked: parseTool(s.tool) } : {}) }));
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
    status: 'queued', created: now(), notBefore, branch: runBranch(config.projects[project], id, title), steps, review: finalReview,
    modules: (Array.isArray(modules) ? modules : String(modules ?? '').split(',')).map(m => String(m).trim()).filter(Boolean),
    ...(tool ? { tool } : {}),
    // The planning board's item this run was queued for: the item follows the run (src/planning.mjs).
    ...(plan != null && plan !== '' ? { plan: Number(String(plan).replace(/^#/, '')) } : {}),
    // The prompt written in the app's prompt builder: the steps get it instead of the one put together from the document.
    ...(prompt?.trim() ? { builderPrompt: prompt.trim() } : {}),
    // The approval level the manager gave it (1, 2 or 3; src/decisions.mjs shows it on the owner's card).
    level: parseLevel(level),
    // The request of the project's agent in charge that the manager (or the owner) authorized (src/charge.mjs).
    ...(request != null ? { ownerRequest: Number(request) } : {}),
    // A mission missed while Chiefmate was off or on standby: when it was due (src/schedule.mjs). The app marks it late.
    ...(due ? { due } : {}),
  });
  describeLater(run.id, run);
  return run;
}

// ---------- Titles and summaries from the quick model ----------

const describing = new Map(); // run id: the call going on
const describeTried = new Set(); // asked once per start of Chiefmate: a failure is not retried in a loop
const described = new Map(); // run id: the fields applied (title, summary, level), for a copy of the run read before they were

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
  described.set(id, { ...described.get(id), ...fields });
  saveRun(run);
  const l = live.get(id);
  if (l) Object.assign(l, { title: run.title, summary: run.summary });
}

/** The manager's approval level for a run (1, 2, 3, or null to clear it), kept also for a copy already in memory. */
export function setRunLevel(id, value) {
  const level = parseLevel(value);
  const run = activeRun(String(id ?? '')) ?? readRun(String(id ?? ''));
  if (!run) throw new Error(t('Run not found.'));
  run.level = level;
  described.set(run.id, { ...described.get(run.id), level });
  saveRun(run);
  return run;
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
export function pauseLive(id, why = 'update', { holdWhile = null } = {}) {
  const l = live.get(id);
  if (!l || l.cancelRequest || l.pauseRequest) return false;
  l.pauseRequest = why;
  // "owner": paused for the owner's "Work now" session (src/worknow.mjs), held while holdWhile() says so; "park": parked
  // while it waits for the owner (src/needs.mjs), held while the request is open.
  l.holdWhile = holdWhile;
  l.process?.interrupt?.();
  l.preparing?.abort();
  const text = why === 'owner' ? t('Pausing at a safe point: you are working on this project now')
    : why === 'park' ? t("Parking at a safe point while it waits for you: its project's turn goes to the next run in the queue")
    : why === 'standby' ? t('Pausing at a safe point: Chiefmate is going on standby')
    : why === 'focus' ? t('Pausing at a safe point: you paused this project, or put another in focus')
    : why === 'stop' ? t('Pausing at a safe point: Chiefmate is shutting down')
      : t('Pausing at a safe point for an update of Chiefmate');
  logAction(l, { type: 'action', text });
  return true;
}

/**
 * Asks every run going on to pause (see pauseLive). why: "update" (the default), "standby" or "stop" (the power modes,
 * src/power.mjs); "focus" pauses one run alone (src/steer.mjs). Returns the ids it asked.
 */
export const pauseAll = (why = 'update') => [...live.keys()].filter(id => pauseLive(id, why));

/** The bubble's line of a step that paused (src/speech.mjs), in the first person. */
function pausedLine(why) {
  if (why === 'owner') return t("I paused at a safe point while you work on this project; I'll go on when your session ends.");
  if (why === 'standby') return t("I paused at a safe point: Chiefmate is on standby. I'll go on when it's back.");
  if (why === 'focus') return t('I paused at a safe point: this project is out of your focus for now.');
  if (why === 'stop') return t("I paused at a safe point: Chiefmate is shutting down. I'll go on at the next start.");
  return t("I paused at a safe point for an update of Chiefmate; I'll go on right after it.");
}

/** The bubble's line of a step that ended, or that waits for the plan's limit: { text, state }. */
export function endLine(step, waitUntil = null) {
  if (waitUntil) return { state: 'waiting', text: t("Stopped: the plan's usage limit was reached. I'll go on after {time}.", { time: formatDateTime(waitUntil) }) };
  if (step.status === 'done') {
    const change = String(step.outcome?.change ?? '').trim();
    return { state: 'done', text: change ? t('My part is done: {change}', { change }) : t('My part is done.') };
  }
  return { state: 'stuck', text: t('Stopped: {error}', { error: step.error || t('the step failed') }) };
}

/** The note of a run paused for an update or a power mode, until it resumes. */
function pausedNote(why) {
  if (why === 'owner') return t('Paused at a safe point while you work on this project. It resumes by itself when your session ends.');
  if (why === 'park') return t("Parked while it waits for you: its project's turn went to the next run in the queue. It resumes first once you answer.");
  if (why === 'quarantine') return t('Paused: a file of its working copy was probably quarantined by the antivirus. It resumes by itself once the file can be read again.');
  if (why === 'standby') return t('Paused at a safe point for standby. It resumes by itself when Chiefmate is turned back on.');
  if (why === 'focus') return t('Paused at a safe point by your focus. It resumes by itself when its project is free again.');
  if (why === 'stop') return t('Paused at a safe point because Chiefmate was shut down. It resumes by itself at the next start.');
  return t('Paused for an update of Chiefmate. It resumes by itself as soon as the update is over.');
}

/**
 * Whether a run keeps its project's working copy while it is not going on: paused (or back in the queue) in the middle
 * of its work, or with its uncommitted work put aside (run.shelf). No other run of the project prepares the copy then.
 * A run parked while it waits for the owner (src/needs.mjs) leaves the copy to the project's next run once its work is
 * committed on its branch (run.parked.committed); it resumes after any run that keeps the copy.
 */
export const holdsCopy = run => !!run?.prepared && ['queued', 'waiting', 'paused'].includes(run.status) && !!(run.shelf || (run.resumeFirst && !run.parked?.committed));

/** The other run of the same project that keeps the working copy (see holdsCopy), or null. */
export const copyHolder = (run, runs = listRuns()) => runs.find(r => r.id !== run.id && r.project === run.project && holdsCopy(r)) ?? null;

/** What the step is told when its branch was brought up to date as the run resumed (step.freshBase), or ''. */
export function branchNote(fresh, base) {
  if (!fresh) return '';
  if (fresh.kept) {
    return `While this run was paused, ${base} moved on by ${fresh.behind} commit(s). Your uncommitted work did not apply on top of it, so the run's branch stays where it was, with your work back in place. Check what changed (git log HEAD..origin/${base}) before you go on.`;
  }
  return `While this run was paused, ${base} moved on by ${fresh.behind} commit(s). The run's branch had no commits of its own, so Chiefmate moved it to the current ${base} before resuming${fresh.restored ? ' and put your uncommitted work back on top of it' : ''}: the files now include the work merged meanwhile. Check what changed (git log ${fresh.from.slice(0, 7)}..HEAD) before you go on.`;
}

/**
 * The next turn of a step resumed after an update of Chiefmate (or another pause), with the owner's messages sent
 * meanwhile. about: what the pause itself left to say (the owner's answer to a parked request, the file restored).
 */
export function updatedTurn(messages, config = loadConfig(), why = 'update', gitRecovery = '', about = '') {
  const owner = config.owner || 'The owner';
  const lines = [
    why === 'park' ? `Chiefmate parked your run while it waited for ${owner}, so another run of this project could use its turn. Your uncommitted work was committed on your branch before that, and this session now resumes. ${about}`.trim()
      : why === 'quarantine' ? `A file you wrote vanished or could not be read right after you wrote it, most likely quarantined by the antivirus${about ? ` (${about})` : ''}. Your work was paused until it could be read again, and this session now resumes. Check that the file is intact (write it again if it is not) before you go on.`
      : why === 'update' ? 'Chiefmate was updated while you were working: your work was paused at a safe point so the new version could be installed, and this session now resumes.'
      : why === 'owner' ? `${owner} paused your work at a safe point to work on this project themselves, and this session now resumes. They may have changed the project meanwhile: check what changed on the main branch before you go on.`
      : why === 'focus' ? 'Your project was paused by its owner (or another project was put in focus) while you were working: your work was paused at a safe point, and this session now resumes.'
      : `Chiefmate was ${why === 'standby' ? 'put on standby' : 'shut down'} by its owner while you were working: your work was paused at a safe point, and this session now resumes.`,
    gitRecovery || (why === 'park'
      ? 'Meanwhile another run of this project may have used the working copy: your branch and its commits are as you left them. Check with git status and git log before you go on.'
      : 'Continue from where you left off. The branch, the files and this session are as you left them. A command that was still running when you were paused may have been cut off: check its result before you go on.'),
    "When you finish, your last message is still the step's full report.",
  ];
  return messages.length ? `${lines.join('\n')}\n\n${ownerTurn(messages, config)}` : lines.join('\n');
}

/** The step's log line for a file the antivirus probably took. */
const quarantineLine = lost => t('Probable antivirus quarantine: {path} {state} right after it was written. The project waits for it.', {
  path: lost.file, state: lost.state === 'missing' ? t('vanished') : t('became unreadable'),
});

/** What a resumed step hears of its pause: the owner's answer to the request it was parked on, or the file restored. */
export function pauseAbout(run, paused) {
  if (paused?.why === 'quarantine') return paused.file ? `the file was ${paused.file}` : '';
  if (paused?.why !== 'park') return '';
  const request = run.requests?.find(r => r.id === paused.request);
  if (!request) return '';
  const what = `"${clip(request.what, 200)}"`;
  if (request.status === 'open') return `The owner has not answered your request ${what} yet: the run was resumed without it. Go on with what you can and say in your report what is left for the owner.`;
  if (request.ownerSaid) return `The owner answered your request ${what} in their conversation with the manager, who passed it on: "${request.ownerSaid}". Take it into account and go on.`;
  if (request.answer || request.note) return `The owner answered your request ${what}: ${[request.answer, request.note].filter(Boolean).join(' — ')}. Take it into account and go on.`;
  if (request.by === 'check') return `The check of your request ${what} succeeded. Go on.`;
  return `The owner says they did what you asked: ${what}. Go on.`;
}

const usageLimits = { five_hour: 'pause_at_5h_window', seven_day: 'pause_at_plan_week' };

/** The usage window at or over its limit with a reset ahead (the 5-hour one first), or undefined. */
function blockingWindow(limits, usage, at = Date.now()) {
  return Object.keys(usageLimits).find(window => {
    const ceiling = limits[usageLimits[window]];
    const w = usage[window];
    return w && ceiling && w.used >= ceiling && w.resets && new Date(w.resets).getTime() > at;
  });
}

function limitNote(window, percent, lang) {
  const name = window === 'five_hour' ? t('the 5-hour window', {}, lang) : t("the plan's week", {}, lang);
  return t('{window} of your account is at {percent}', { window: name, percent }, lang);
}

/**
 * Before every step: the account's usage against the latest limits in the settings, so a change in Usage counts at
 * once. If the settings can't be read now (a file being edited), the limits the run started with.
 */
function checkLimits(run, config) {
  if (run.ignoreLimits) return null;
  let limits;
  try {
    limits = loadConfig().limits ?? {};
  } catch {
    limits = config.limits ?? {};
  }
  const usage = readUsage();
  const window = blockingWindow(limits, usage);
  if (!window) return null;
  const w = usage[window];
  const note = limitNote(window, formatPercent(w.used));
  return { note, waitUntil: w.resets, limitWait: { window, ceiling: limits[usageLimits[window]] } };
}

/**
 * Whether a run waiting for a configured limit goes back to the queue before the reset: its limit was raised (or taken
 * out) above the current usage and no window blocks it. A wait for the account running out is never cleared here.
 */
export function limitWaitCleared(run, limits, usage) {
  // Older runs only recorded the reason in the translated note.
  const percent = run.limitWait ? null : run.note?.match(/-?\d+%/)?.[0];
  const window = run.limitWait?.window ?? (percent && Object.keys(usageLimits).find(window =>
    ['en', 'pt-BR'].some(lang => run.note === limitNote(window, percent, lang))));
  if (!window) return false;
  // No limit in the settings pauses nothing, as in checkLimits.
  const ceiling = limits[usageLimits[window]] || Infinity;
  const used = usage[window]?.used;
  return ceiling > (run.limitWait?.ceiling ?? 0) && Number.isFinite(used) && used < ceiling
    && !blockingWindow(limits, usage);
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

const stepFileName = (index, step) => `${String(index + 1).padStart(2, '0')}-${step.agent}`;

function logAction(l, event) {
  if (event.type !== 'action' && event.type !== 'say') return;
  l.actions.push({ at: now(), type: event.type, text: event.type === 'say' ? clip(event.text, 300) : event.text });
  if (l.actions.length > 300) l.actions.splice(0, l.actions.length - 300);
}

/**
 * A step's prompt in parts, in order, each with a key and where it comes from (the project's Context tab shows them,
 * src/context.mjs): their lines, joined, are the prompt as it is sent.
 */
export function promptParts({ run, step, project, previous, finalReview, changes, traces, config, libraries, base, access, built, agents, tool = null }) {
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
      `2. Check it against the reports and the project's rules${run.lead?.opinion ? ", weighing the team lead's opinion below (its first review)" : ''}. Fix whatever is wrong or incomplete, committing as ${noTrace(project) ? "the owner would, with a short message in the project's convention that names neither Chiefmate nor a review by an AI" : '"Chiefmate: manager review"'}. When the owner guided a step directly (a "direct talk" section at the end of its report), check that the work follows what they said.`,
      `3. Run the checks: ${(project.checks ?? []).map(c => `\`${c}\``).join(', ') || 'the ones the project and its documentation describe, as far as this machine allows'}.`,
      `4. Your last message presents the work for approval${local ? ', as the note that goes with the branch' : ', as the pull request text'}, in markdown and in ${languageName(prLanguage)}, starting with the final summary the rules below describe. End it with a section titled "${t("Manager's verdict", {}, prLanguage)}": what you fixed, the risks and your recommendation (approve, approve with caveats, or do not approve).`,
    );
    // The tools' quality record (src/tools.mjs) keeps this line: did the work done on Codex or Grok need fixing?
    const onTools = [...new Set(run.steps.filter(s => s.tool && s.tool !== 'claude' && ['done', 'failed'].includes(s.status)).map(s => TOOL_NAMES[s.tool] ?? s.tool))];
    if (onTools.length) {
      lines.push(`5. Part of this work ran on ${onTools.join(' and ')}, not on Claude Code. In your verdict, write one line that starts with "Corrections:" saying, in a few words, what you had to fix in that work, or "Corrections: none".`);
    }
    lines.push(
      '',
      '## Changed files',
      '```',
      changes || '(none)',
      '```',
    );
    if (traces?.length) {
      // With no trace (src/workspace.mjs): the branch is not handed over while any of these is left.
      lines.push(
        '',
        '## Traces of Chiefmate to remove',
        'Others must not learn of Chiefmate from this work, and the branch is not handed over while any of these is left. Remove them: rename or delete the files, rewrite the text and, for commit messages or authors, rewrite this run\'s commits (`git reset --soft` to the base and commit again, as the owner would).',
        ...traces.map(x => `- ${x}`),
      );
    }
    add('review', 'Chiefmate: the final review (src/runs.mjs)', lines);
    add('lead-review', "Chiefmate: the team lead's plan and opinion", finalReviewLines(run, lead));
  }
  // The final review reads the lead's plan and opinion above, so its steps are not repeated among the crew's reports.
  const reports = finalReview && lead ? previous.filter(p => p.agent !== LEAD) : previous;
  if (reports.length) {
    const lines = ['', finalReview ? '## Crew reports' : '## What the previous steps did'];
    for (const p of reports) lines.push('', `### ${p.agent}${p.role ? `, ${p.role === 'plan' ? 'planning' : 'first review'}` : ''} (${p.status}${p.effort ? `, effort ${p.effort}` : ''})`, fullReport(p) || p.error || '(no report)');
    add('reports', 'The reports of the steps before', lines);
  }
  add('rules', 'Chiefmate (src/runs.mjs, crewRules)', ['', crewRules(config, project, run.project, finalReview ? prLanguage : config.language || 'en')]);
  add('tool', 'Chiefmate (src/runs.mjs, toolLines)', toolLines(tool ?? stepTool(config, agents?.[step.agent], finalReview, { asked: askedTool(run, step), project }).tool));
  return parts;
}

const stepPrompt = args => promptParts(args).flatMap(p => p.lines).join('\n');

/**
 * The tool a step runs on (src/tools.mjs, chooseTool): the one chosen for its task, else the member's; the final review
 * and a project marked "sensitive" always on Claude Code. options: { asked (askedTool), project }.
 */
export const stepTool = (config, agent, finalReview = false, options = {}) => chooseTool(config, agent ?? {}, { ...options, finalReview });

/** The tool chosen for a step's task (--tool): the step's own (a mission's step), else the run's; null: none. */
export const askedTool = (run, step) => step?.toolAsked ?? run?.tool ?? null;

/** What a step on Codex or Grok must know of its tool, at the end of its prompt. */
function toolLines(tool) {
  if (tool === 'codex') {
    return [
      '',
      '## Working on Codex',
      "- You run on the Codex CLI, in its sandbox: you may write only inside the working copy, its `.git` folder is read-only and there is no network. So leave your changes uncommitted: Chiefmate commits them when your step ends. Don't install packages from the network; if the work truly needs it, say so in your report.",
      "- Chiefmate's command line above (needs-you, plan, defect) talks to Chiefmate on this computer and works from the sandbox.",
      // Codex's unelevated sandbox on Windows: libuv's named pipes are refused (EPERM), the process itself is not.
      ...(process.platform === 'win32' ? ["- On Windows, the sandbox refuses the pipes a program opens to read the output of another one it starts: Node.js's child_process with its default stdio fails with EPERM, so do most test runners (`node --test`, `npm test`) and scripts that call git that way. That is the sandbox, not your change: don't spend time on it, nor change the project to get around it. Chiefmate runs the project's checks itself after the crew's steps, outside the sandbox; say in your report which ones you couldn't run."] : []),
    ];
  }
  if (tool === 'grok') {
    return [
      '',
      '## Working on Grok',
      "- You run on the Grok CLI. Commands that would publish (git push, git remote, gh pr, gh repo, gh api, gh gist, gh release, gh workflow, gh secret, requests to GitHub's API) are refused by rule, even inside a longer command line: keep those words out of your commands.",
      "- The rules match words anywhere in a command, so a commit message or a search may be refused too (\"push\", \"remote\", or \"gh\" followed by \"pr\", as in \"high priority\"). Then reword it, or leave your changes uncommitted: Chiefmate commits them when your step ends.",
    ];
  }
  return [];
}

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

// How each tool runs a step, for its context report.
const TOOL_CONTEXT = {
  claude: "- The user's own Claude Code configuration: none. Setting sources `project,local` (no user settings, hooks, plugins or skills), `claudeMdExcludes` for `~/.claude` (no global CLAUDE.md or rules), `--strict-mcp-config`.",
  codex: "- Codex CLI (`codex exec`): without the owner's own Codex configuration (`--ignore-user-config`; the sign-in stays), in its `workspace-write` sandbox (it writes only the working copy, `.git` is read-only, no network), never asking, with Chiefmate's guard as a PreToolUse hook. Chiefmate commits what it leaves. No MCP server and no extra folder are given to it.",
  grok: "- Grok CLI (`grok --prompt-file`): approving its own actions except the deny rules below (Grok takes no hook from the command line), without the owner's Claude Code and Cursor hooks, MCP servers, skills, rules and instructions (`GROK_CLAUDE_*` and `GROK_CURSOR_*` off); Grok's own settings (`~/.grok`) still apply. No MCP server and no extra folder are given to it.",
};

/** What the step received, written next to its log as data/runs/<id>/<NN>-<agent>.context.md. */
function contextReport({ run, step, index, agent, dir, model, prompt, tools, disallowed, access, mcp, built, args, tool = 'claude' }) {
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
  // The level the tool was given, as in the step's record: none for a level it lacks (Codex has no max).
  const effort = toolEffort(tool, agent.effort);
  return [
    `# Context received: ${step.agent} (step ${index + 1}), run ${run.id}`,
    '',
    `- Tool: ${TOOL_NAMES[tool]}. Model: \`${model ?? `${TOOL_NAMES[tool]}'s default`}\`${effort ? `, effort \`${effort}\`` : ''}, time limit ${agent.max_minutes ?? 60} min`,
    `- Agent: \`${agent.id}\`${agent.base ? ` (based on \`${agent.base}\`, crew of ${agent.project})` : ''}, instructions from \`${agent.file}\``,
    TOOL_CONTEXT[tool],
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
    tool === 'claude' ? "## System prompt (added to Claude Code's own)" : "## The agent's instructions (at the top of the first prompt)",
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

/**
 * Before a step on Codex or Grok: when the tool is not signed in, the owner is asked (needs-you, with the command to
 * run) and the step waits, its clock stopped, until they click "I did it" or the sign-in is found, within the longest
 * wait. Returns whether the tool is signed in.
 */
async function signInFirst(l, run, index, tool) {
  if (await signedIn(tool)) return true;
  const request = await askOwner({
    run: run.id, step: index + 1, wait: true,
    what: t('Sign in to {tool} so this step can run on it: in a terminal, run "{command}" (it opens your browser), then click "I did it". The step goes on by itself once you are signed in.', { tool: TOOL_NAMES[tool], command: LOGIN_COMMAND[tool] }),
  });
  logAction(l, { type: 'action', text: t('Waiting for you to sign in to {tool}', { tool: TOOL_NAMES[tool] }) });
  const until = Date.now() + needsSettings().maxWaitMinutes * 60_000;
  while (Date.now() < until && !l.cancelRequest && !l.pauseRequest) {
    l.heldUntil = Date.now() + 20_000;
    await new Promise(resolve => setTimeout(resolve, 10_000));
    const done = run.requests?.find(r => r.id === request.id)?.status === 'done';
    if (await signedIn(tool)) {
      if (!done) finishRequest(run.id, request.id, 'check');
      l.heldUntil = 0;
      return true;
    }
    if (done) break;
  }
  l.heldUntil = 0;
  return false;
}

async function runStep({ l, run, step, index, dir, project, config, agents, libraries, base, finalReview = false }) {
  if (!agents[step.agent]) throw new Error(t('Unknown agent: {id}', { id: step.agent }));
  // The effort is read again at each step: a change made from the app or the command line counts from the next step.
  const agent = { ...agents[step.agent], effort: currentEffort(run.project, step.agent, agents[step.agent].effort ?? null) ?? undefined };
  const previous = run.steps.filter(s => s !== step && s.status !== 'pending' && s.status !== 'skipped');
  const changes = finalReview ? await changedFiles(dir, base).catch(() => '') : '';
  const found = finalReview && noTrace(project) ? await traces(dir, base).catch(() => []) : [];
  const choice = stepTool(config, agent, finalReview, { asked: askedTool(run, step), project });
  // A tool chosen for the task but not signed in here: the step runs on Claude Code (the member's own tool asks for the sign-in).
  // A step paused for an update resumes on the tool it ran on.
  const resumedOn = step.paused ? step.tool ?? null : null;
  const unsigned = !resumedOn && choice.task && choice.tool !== 'claude' && !(await signedIn(choice.tool));
  const tool = resumedOn ?? (unsigned ? 'claude' : choice.tool);
  const model = tool === 'claude' ? agent.model ?? config.default_model : toolModel(tool, agent.model);
  const access = stepAccess({ config, projectId: run.project, project, libraries, manager: step.agent === 'manager' });
  const mcp = stepMcp(config, project, agent);
  let built = null;
  try {
    built = run.builderPrompt ? writtenInstructions(run.builderPrompt) : projectInstructions(config, project, run.modules ?? []);
  } catch (error) {
    logAction(l, { type: 'action', text: t("Couldn't read the prompt builder: {error}", { error: error.message }) });
  }
  for (const a of built?.adaptations ?? []) logAction(l, { type: 'action', text: t('Prompt builder: a line of "{block}" was adapted to the crew\'s rules', { block: a.block }) });
  const op = step.gitRecovery;
  const gitRecovery = op ? `Chiefmate found an unfinished git ${op} in the working copy and aborted it before checking out the run branch: the commits are as they were, but what that ${op} had not committed yet is gone. Check the working copy (git status, git log) and redo the ${op} if it is still needed.` : '';
  const freshNote = branchNote(step.freshBase, base);
  const prompt = [stepPrompt({ run, step, project, previous, finalReview, changes, traces: found, config, libraries, base, access, built, agents, tool }), gitRecovery, freshNote].filter(Boolean).join('\n\n');
  const { tools, disallowed } = tool === 'claude' ? stepTools(agent, mcp, access) : { tools: [], disallowed: tool === 'grok' ? GROK_DENY : [] };
  const name = stepFileName(index, step);
  const contextFile = path.join(runDir(run.id), `${name}.context.md`);

  // A team lead reads and judges: whatever it changes in the working copy (through the shell) is dropped after its step.
  const before = agent.lead ? await headCommit(dir) : null;
  // Asked to pause for an update while the step was being prepared: it starts after the update, as it would now.
  if (l.pauseRequest) return { paused: true };
  // A step paused for an update of Chiefmate resumes its own Claude Code session, with its clock and its counts.
  const paused = step.paused ?? null;
  delete step.paused;
  // Told once: a later resume finds, and tells, an operation of its own.
  delete step.gitRecovery;
  delete step.freshBase;
  Object.assign(step, { status: 'running', started: paused ? step.started ?? now() : now(), error: null, model, tool, effort: toolEffort(tool, agent.effort), promptBlocks: built?.blocks ?? null, adaptations: built?.adaptations ?? null });
  Object.assign(l, {
    step: index + 1, agent: step.agent, started: now(), context: { used: 0, window: contextWindow(model), compactions: 0 }, actions: [], heldUntil: 0, talking: false, reply: null, session: null,
    doing: finalReview ? t('reviewing the work') : step.role === 'plan' ? t('planning the request') : t('getting started'),
  });
  // The bubble opens with who asked for the task (src/speech.mjs).
  const asked = paused ? null : askedBy(run, step);
  if (asked) addSpeech(run, { step: index + 1, agent: step.agent, ...asked });
  saveRun(run);
  if (['expired', 'off', 'unknown'].includes(choice.reason)) {
    logAction(l, { type: 'action', text: t('{tool} is not available to the crew now: this step runs on Claude Code', { tool: TOOL_NAMES[choice.asked] ?? choice.asked }) });
  }
  if (choice.reason === 'sensitive') {
    logAction(l, { type: 'action', text: t('{tool} was chosen, but this project is marked sensitive: this step runs on Claude Code', { tool: TOOL_NAMES[choice.asked] ?? choice.asked }) });
  }
  if (unsigned) {
    logAction(l, { type: 'action', text: t('{tool} is not signed in on this computer: this step runs on Claude Code', { tool: TOOL_NAMES[choice.tool] }) });
  }
  if (tool !== 'claude' && !(await signInFirst(l, run, index, tool))) {
    // Parked (or paused) while it waited for the sign-in: the step starts again when the run resumes.
    if (l.pauseRequest && !l.cancelRequest) {
      step.status = 'pending';
      saveRun(run);
      return { paused: true };
    }
    Object.assign(step, { status: 'failed', ended: now(), error: l.cancelRequest ?? t('{tool} is not signed in on this computer.', { tool: TOOL_NAMES[tool] }) });
    saveRun(run);
    return {};
  }

  // The files the step writes, and the other actions after them: one gone or unreadable at the end is probably the antivirus's.
  const writes = [];
  const commands = [];
  let seq = 0;
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
    // Playwright's browser on the project's own profile, its window named after the project and the run (src/browsers.mjs).
    mcpServers: browserServers(config, mcp.servers, { project: run.project, owner: `run:${run.id}`, task: run.title || run.id }),
    hooks: crewGuard(path.join(runDir(run.id), `${name}.guard.jsonl`)),
    guardLog: path.join(runDir(run.id), `${name}.guard.jsonl`),
    // For "needs-you": which run and step is asking, and where Chiefmate answers.
    env: { CHIEFMATE_RUN: run.id, CHIEFMATE_STEP: String(index + 1), CHIEFMATE_PORT: String(Number(process.env.CHIEFMATE_PORT) || config.port || 4747) },
    // With no trace, commits never credit Claude, whatever the installation's setting.
    attribution: config.attribution !== false && !noTrace(project),
    maxMinutes: agent.max_minutes ?? 60,
    isHeld: () => Date.now() < l.heldUntil,
    log: path.join(runDir(run.id), `${name}.jsonl`),
    onEvent: event => {
      if (event.type === 'action') {
        seq++;
        if (event.file) writes.push({ file: path.resolve(dir, event.file), seq });
        else commands.push({ text: event.text, seq });
      }
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
    turn = updatedTurn(messages, config, paused.why ?? 'update', [gitRecovery, freshNote].filter(Boolean).join(' '), pauseAbout(run, paused));
    addSpeech(run, { step: index + 1, agent: step.agent, by: 'auto', state: 'working', text: t("I'm back from the pause and going on where I stopped.") });
    logAction(l, { type: 'action', text: (paused.why ?? 'update') === 'update' ? t('Chiefmate was updated: the agent goes on in the same session') : t('Back from the pause: the agent goes on in the same session') });
  }
  let r;
  let pausedNow = false;
  l.talking = true;
  for (;;) {
    const proc = tool === 'claude' ? runClaude({ ...common, prompt: turn, session, spentMs }) : runTool(tool, { ...common, prompt: turn, session, spentMs });
    if (!session.resume) {
      try {
        writeFileSync(contextFile, contextReport({ run, step, index, agent, dir, model, prompt, tools, disallowed, access, mcp, built, args: proc.args, tool }));
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
    Object.assign(step, { status: 'pending', paused: { session: r.session ?? l.session ?? session.id, spentMs, total, at: now(), why: l.pauseRequest, ...(l.pauseRequest === 'park' ? { request: run.parked?.request ?? null } : {}) } });
    addSpeech(run, { step: index + 1, agent: step.agent, by: 'auto', state: 'waiting', text: pausedLine(l.pauseRequest) });
    logAction(l, { type: 'action', text: l.pauseRequest === 'update' ? t('Paused for the update: the step resumes in the same session afterwards') : t('Paused: the step resumes in the same session afterwards') });
    saveRun(run);
    return { paused: true };
  }
  Object.assign(r, total);

  const waitUntil = limitHit(r);
  // A file the step wrote is gone or can't be read: probably quarantined by the antivirus. Nothing is committed (its
  // absence would be), the project's queue waits, and the step resumes in the same session once the file is back.
  const quarantined = lost => {
    logAction(l, { type: 'action', text: quarantineLine(lost) });
    holdForQuarantine({ project: run.project, file: lost.file, state: lost.state, run: run.id, step: index + 1, agent: step.agent, title: run.title });
    Object.assign(step, { status: 'pending', ended: null, paused: { session: r.session ?? l.session ?? session.id, spentMs, total, at: now(), why: 'quarantine', file: lost.file } });
    l.pauseRequest = 'quarantine';
    saveRun(run);
    return { paused: true };
  };
  const lost = !waitUntil && !l.cancelRequest && !r.canceled ? await lostFile(writtenSuspects(writes, commands, dir)).catch(() => null) : null;
  if (lost) return quarantined(lost);
  // The final summary at the top of the report is kept apart (step.outcome): the app shows it first, the rest folded.
  const reportLang = finalReview ? project.language || config.language || 'en' : config.language || 'en';
  const { outcome, rest } = parseOutcome(r.text || '', [reportLang, config.language]);
  Object.assign(step, {
    status: waitUntil ? 'pending' : r.ok ? 'done' : 'failed', ended: waitUntil ? null : now(), tokens: r.tokens, turns: r.turns,
    durationMs: r.durationMs, report: rest + talkSection(run, index + 1, id => t(agents[id]?.name ?? id), config), error: r.error ?? null, subagents: r.subagents, actions: l.actions.length,
    context: r.context ? { ...r.context, compactions: l.context?.compactions ?? r.context.compactions } : null,
    outcome: outcome ? { ...outcome, lang: reportLang } : null,
  });
  addSpeech(run, { step: index + 1, agent: step.agent, by: 'auto', ...endLine(step, waitUntil) });
  if (r.context?.used) {
    logAction(l, { type: 'action', text: t('Context at the end of the step: {used} of {window} tokens ({percent}), {count} compaction(s)', {
      used: formatNumber(r.context.used), window: formatNumber(r.context.window), percent: formatPercent(r.context.used / r.context.window), count: step.context.compactions,
    }) });
  }
  if (before) {
    const dropped = await discardSince(dir, before).catch(e => (step.error = `${step.error ?? ''} Discard: ${e.message}`.trim(), false));
    if (dropped) logAction(l, { type: 'action', text: t('The team lead changed files, which it may not do: the changes were dropped') });
  } else {
    // A commit refused over a file the antivirus probably took: the step waits for it, as above.
    let blocked = null;
    await commitPending(dir, noTrace(project) ? run.title : `Chiefmate: ${t(agent.name)} (${run.title})`).catch(async e => {
      blocked = await quarantinedBy(e, dir).catch(() => null);
      if (!blocked) step.error = `${step.error ?? ''} Commit: ${e.message}`.trim();
    });
    if (blocked && !waitUntil) return quarantined(blocked);
  }
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
  const table = stepsOf(run).map(s => `| ${name(s.agent)} | ${labels[s.status] ?? s.status} | ${formatDuration(s.durationMs)} | ${s.turns ?? ''} | ${'effort' in s ? s.effort ?? t('default', {}, lang) : ''} |`);
  const efforts = runEffortChanges(run).map(e => `- ${effortChangeLine(e)}`);
  const checkList = checks.map(c => `- ${c.ok ? '✅' : '❌'} \`${c.command}\``);
  return [
    ...(summary ? [summary, '', `### ${t('Full report', {}, lang)}`, ''] : []),
    main, '', '---', '',
    `### ${t('Done by Chiefmate', {}, lang)}`, '',
    `| ${t('Step', {}, lang)} | ${t('Status', {}, lang)} | ${t('Time', {}, lang)} | ${t('Turns', {}, lang)} | ${t('Effort', {}, lang)} |`, '|---|---|---|---|---|', ...table, '',
    ...(efforts.length ? [`**${t('Effort changed during the run:', {}, lang)}**`, ...efforts, ''] : []),
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
  // A run paused in the middle of its work keeps the working copy: this one waits in the queue (the queue's own check
  // in pickNext, repeated here). So does a parked run that left the copy to the project's next run (see holdsCopy).
  const released = !!run.parked?.committed && !run.shelf;
  const holder = run.prepared && !released ? null : copyHolder(run);
  if (holder) {
    run.note = t('Waits for the paused run {id}, which keeps the working copy.', { id: holder.id });
    saveRun(run);
    return;
  }
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
  delete run.limitWait;
  // Parked until the owner answered (src/needs.mjs): its step knows the request (step.paused.request).
  delete run.parked;
  saveRun(run);

  // Paused for an update of Chiefmate: back to the front of the queue, to resume as soon as the update is over. Always
  // "return await": the run stays in `live` (busy for the update, the power modes and the queue) until its work is put
  // aside and its record saved; a plain "return" would let the finally below drop it from `live` first.
  const pauseForUpdate = async () => {
    // Parked for the owner's answer (src/needs.mjs): the project's next run takes the working copy, so what the step left
    // uncommitted goes on its branch now; only then does the run leave the copy (run.parked.committed, see holdsCopy).
    if (l.pauseRequest === 'park' && run.parked && run.prepared) {
      try {
        await commitPending(projectDir(run.project), noTrace(project) ? run.title : `Chiefmate: work in progress (${run.title})`);
        run.parked.committed = true;
      } catch (error) {
        log(t("Couldn't commit the work before parking: {error}", { error: error.message }));
      }
    }
    // What the agent had not committed yet is put aside (a stash named after the run), so nothing done in the copy
    // meanwhile can lose it; it goes back when the run resumes. Not for a file the antivirus probably took: the copy
    // stays as the step left it while the project waits, so the file restored finds the step's work around it.
    if (run.prepared && !run.shelf && l.pauseRequest !== 'quarantine') {
      try {
        const commit = await shelveWork(projectDir(run.project), run.id);
        if (commit) {
          run.shelf = { commit, at: now() };
          log(t('The work not committed yet was put aside until the run resumes.'));
        }
      } catch (error) {
        log(t("Couldn't put aside the work not committed yet: {error}", { error: error.message }));
      }
    }
    // Paused for the owner's session (or parked for an answer): held (not in the queue) while it is open (or the request
    // unanswered); it goes back to the queue when it ends.
    const held = ['owner', 'park'].includes(l.pauseRequest) && l.holdWhile?.() !== false;
    Object.assign(run, { status: held ? 'paused' : 'queued', resumeFirst: true, note: pausedNote(l.pauseRequest) });
    saveRun(run);
  };

  const wait = (waitUntil, note, limitWait) => {
    Object.assign(run, { status: waitUntil ? 'waiting' : 'paused', notBefore: waitUntil ?? null, note });
    if (limitWait) run.limitWait = limitWait;
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
    const early = checkLimits(run, config);
    if (early) return wait(early.waitUntil, early.note, early.limitWait);
    if (firstTime) {
      // The title and summary from the quick model take a few seconds: the notice waits for them, briefly.
      const pending = describing.get(run.id);
      if (pending) await Promise.race([pending, new Promise(resolve => setTimeout(resolve, 20_000))]);
      notify(t('Chiefmate started'), run.summary ? clip(`${run.title}. ${run.summary}`, 250) : run.title);
    }
    if (l.pauseRequest) return await pauseForUpdate();
    let dir;
    if (!run.prepared) {
      // A pause for an update stops the preparation at once (see pauseLive): it starts over when the run resumes.
      l.preparing = new AbortController();
      run.base = await baseBranch(project);
      l.preparing.signal.throwIfAborted();
      dir = await prepareWorkspace(run.project, project, run.base, log, { signal: l.preparing.signal });
      l.preparing = null;
      // A neutral name is not unique by itself: a branch of yours with that name is never overwritten.
      if (noTrace(project) && project.deliver === 'local' && project.local_clone && existsSync(project.local_clone)) {
        run.branch = await freeBranch(project.local_clone, run.branch);
      }
      // Where the run starts: what it created or changed is read against it (the app's "Files", src/files.mjs).
      run.baseCommit = await headCommit(dir);
      await createBranch(dir, run.branch);
      run.prepared = true;
      saveRun(run);
    } else {
      // Resuming: every finished step already left its work in commits on the run's branch.
      dir = projectDir(run.project);
      const steps = stepsOf(run);
      const index = steps.findIndex(step => step.status === 'pending' || step.status === 'running');
      const step = steps[index];
      try {
        // Parked with its work committed: another run of the project may have used the copy meanwhile, and what it left
        // uncommitted there is not this run's work.
        if (released) await discardSince(dir, await headCommit(dir));
        await checkoutBranch(dir, run.branch, operation => {
          const text = t('The unfinished Git {operation} was aborted before resuming: the commits are kept.', { operation });
          log(text);
          const logIndex = index < 0 ? steps.length - 1 : index;
          if (steps[logIndex]) {
            const file = path.join(runDir(run.id), `${stepFileName(logIndex, steps[logIndex])}.jsonl`);
            appendFileSync(file, `\n${JSON.stringify({ type: 'chiefmate_action', text })}\n`);
          }
          if (step) {
            step.gitRecovery = operation;
            saveRun(run);
          }
        });
      } catch (error) {
        if (step) Object.assign(step, { status: 'failed', ended: now(), error: error.message });
        throw error;
      }
      // A branch with no commits of its own starts again from its base as it is now; the work put aside at the pause
      // goes back on top of it or, when it doesn't fit there, on the branch where it was.
      let fresh = null;
      try {
        fresh = await freshenBranch(dir, run.base ?? project.main_branch);
      } catch (error) {
        log(t("Couldn't bring the run's branch up to date: {error}", { error: error.message }));
      }
      if (run.shelf) {
        try {
          try {
            await restoreShelf(dir, run.id, run.shelf.commit);
          } catch (error) {
            if (!fresh) throw error;
            await discardSince(dir, fresh.from);
            fresh = { ...fresh, kept: true };
            await restoreShelf(dir, run.id, run.shelf.commit);
          }
        } catch (error) {
          const text = t('The work put aside at the pause could not be put back. It is kept in the stash "chiefmate: paused run {id}" ({ref}) of {path}. {error}', {
            id: run.id, ref: shelfRef(run.id), path: dir, error: error.message,
          });
          if (step) Object.assign(step, { status: 'failed', ended: now(), error: text });
          throw new Error(text, { cause: error });
        }
        delete run.shelf;
        if (fresh) fresh.restored = true;
        log(t('The work not committed yet was put back.'));
      }
      if (fresh) {
        if (!fresh.kept) {
          run.baseCommit = fresh.to;
          log(t('The branch had no commits of its own: it now starts from the current {base}.', { base: run.base ?? project.main_branch }));
          await installSetup(dir, project, log);
        } else log(t("The work not committed yet didn't apply on the current {base}: the branch stays where it was.", { base: run.base ?? project.main_branch }));
        if (step) step.freshBase = fresh;
      }
      saveRun(run);
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
      if (l.pauseRequest) return await pauseForUpdate();
      const { step, finalReview } = order[index];
      const limit = checkLimits(run, config);
      if (limit) return wait(limit.waitUntil, limit.note, limit.limitWait);
      // What the final review commits tells whether it had to correct the crew's work (the tools' quality, src/tools.mjs).
      const reviewFrom = finalReview ? await headCommit(dir).catch(() => null) : null;
      const { waitUntil, paused } = await runStep({ l, run, step, index, dir, project, config, agents, libraries, base, finalReview });
      if (reviewFrom && step.status === 'done') step.commits = await commitSubjects(dir, reviewFrom).catch(() => []);
      if (paused && !l.cancelRequest) return await pauseForUpdate();
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
      if (noTrace(project)) {
        const left = await traces(dir, base);
        if (left.length) throw new Error(t('Not handed over: the work still names Chiefmate ({list}). It stays on the branch {branch} of the working copy ({path}) until the next run of the project.', { list: clip(left.join('; '), 300), branch: run.branch, path: dir }));
      }
      let where = t('the branch {branch} of the working copy ({path})', { branch: run.branch, path: dir });
      let onto = null; // "deliver_branch": "current" and the move forward went through
      if (project.local_clone) {
        log(t('Handing the branch to your clone of {name}', { name: project.name }));
        run.deliveredCommit = await headCommit(dir);
        await deliverToClone(dir, run.branch, project.local_clone);
        where = t('the branch {branch} of your clone ({path})', { branch: run.branch, path: project.local_clone });
        if (project.deliver_branch === 'current') {
          const why = await advanceClone(project.local_clone, run.branch, base);
          if (why) log(t("Your clone's branch was not moved forward ({why}): the work stays on {branch}", { why, branch: run.branch }));
          else {
            onto = base;
            where = t('your branch {branch}, moved forward in your clone ({path})', { branch: base, path: project.local_clone });
          }
        }
      }
      const result = failed
        ? t('Ready on {where}, but {count} check(s) failed. Nothing was sent to GitHub.', { where, count: failed })
        : t('Ready on {where}. Nothing was sent to GitHub.', { where });
      Object.assign(run, {
        status: 'done', ended: now(), result, delivered: project.local_clone ?? dir,
        // Already on your branch: nothing is left to merge.
        ...(onto ? { merged: { at: now(), by: 'owner', how: 'local' } } : {}),
      });
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
      return await pauseForUpdate();
    }
    // A git step that met a file the antivirus probably took: the run waits in the queue instead of failing.
    const lost = !l.cancelRequest && project ? await quarantinedBy(error, projectDir(run.project)).catch(() => null) : null;
    if (lost) {
      log(quarantineLine(lost));
      for (const step of stepsOf(run)) if (step.status === 'failed' && step.error === error.message) Object.assign(step, { status: 'pending', ended: null, error: null });
      holdForQuarantine({ project: run.project, file: lost.file, state: lost.state, run: run.id, title: run.title });
      Object.assign(run, { status: 'queued', resumeFirst: true, note: pausedNote('quarantine') });
      saveRun(run);
      return;
    }
    Object.assign(run, { status: 'failed', ended: now(), result: error.message });
    saveRun(run);
    notify(t('Chiefmate hit an error'), t('{title}: {error}', { title: run.title, error: clip(error.message, 180) }), 'chiefmate:log', { urgent: true });
    reportEvent('run_failed', `${aboutRun(run)} failed: ${clip(error.message, 400)}`);
  } finally {
    live.delete(run.id);
    closeAfterRun();
    // A run that ended with steps on Codex or Grok: how each did, for the manager's choice of tools (node src/cli.mjs tools).
    if (['done', 'failed'].includes(run.status) && !run.qualityRecorded) {
      try {
        const records = qualityRecords(run, run.review?.commits ?? []);
        if (records.length) {
          recordQuality(records);
          run.qualityRecorded = true;
          saveRun(run);
        }
      } catch (error) {
        console.error('Tools quality:', error.message);
      }
    }
    // A run that failed or was canceled gets its final summary too, in the background.
    if (['failed', 'canceled'].includes(run.status)) outcomeLater(run.id);
  }
}
