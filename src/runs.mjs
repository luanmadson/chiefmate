// How a run (a mission or a one-off task) goes: working copy, the crew in sequence, the manager's review,
// the project's checks and a pull request.
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runClaude } from './claude.mjs';
import { loadAgents, loadConfig } from './config.mjs';
import { formatDate, formatDateTime, formatDuration, formatPercent, t } from './i18n.mjs';
import { notify } from './notify.mjs';
import { readUsage, runDir, runFile, saveRun, stepsOf } from './store.mjs';
import { clip, languageName, now, slug, stamp } from './util.mjs';
import {
  baseBranch, changedFiles, checkoutBranch, commitPending, createBranch, deliverToClone, newCommits, openPullRequest, prepareLibrary,
  prepareWorkspace, projectDir, runChecks,
} from './workspace.mjs';

/** What the app shows as happening right now. */
export const live = { run: null, title: null, project: null, step: null, agent: null, started: null, pid: null, actions: [] };

let currentProcess = null;
let cancelRequest = null;

// No agent pushes anything to GitHub or changes it: Chiefmate itself pushes the branch and opens the pull request.
export const ALWAYS_DISALLOWED = ['Bash(git push:*)', 'Bash(gh pr:*)', 'Bash(gh repo:*)', 'Bash(git remote:*)'];

function crewRules(config, project) {
  const owner = languageName(config.language || 'en');
  const content = languageName(project.language || config.language || 'en');
  return `## Chiefmate rules (for the whole crew)
- You are part of the Chiefmate crew, working on one step of a run. Work alone, step by step. Avoid subagents: start one only when it is truly necessary, and never several at once.
- The current folder is a working copy of the project, already on the run's branch. Commit your work with clear messages that follow the project's convention (see \`git log\`); if there is none, write them in ${content}. Never push, switch branches or open pull requests: Chiefmate does that at the end.
- If the project's playbook says to create a branch, push or open a pull request, skip that part.
- The project's documentation outranks your own preferences. Read what you need before changing anything.
- Write project content in the language the project already uses.
- If you get stuck, undo whatever is half-done and explain it in your report.
- Never read, list or copy \`data/browser-profile\` (the browser profile Chiefmate uses to read the account's usage page) or anything else in Chiefmate's \`data/\` folder.
- Your last message is the step's report, in ${owner}: short markdown with what you did (and the files), the sources you used, what you left out and why, and what the reviewer should check.`;
}

export function createRun({ kind, missionId, projectId, agent, instruction, review = false, origin = 'app', notBefore = null }) {
  const config = loadConfig();
  const agents = loadAgents(config);
  let title, steps, finalReview, project;
  if (kind === 'mission') {
    const mission = config.missions?.[missionId];
    if (!mission) throw new Error(t('Unknown mission: {id}', { id: missionId }));
    project = mission.project;
    title = mission.name;
    steps = mission.steps.map(s => ({ agent: s.agent, part: s.part, status: 'pending' }));
    finalReview = mission.review ? { agent: mission.review.agent, part: mission.review.part, status: 'pending' } : null;
  } else {
    if (!agents[agent]) throw new Error(t('Unknown agent: {id}', { id: agent }));
    if (!instruction?.trim()) throw new Error(t('Write what the agent should do.'));
    project = projectId;
    title = `${t(agents[agent].name)}: ${clip(instruction, 70)}`;
    steps = [{ agent, part: instruction.trim(), status: 'pending' }];
    finalReview = review ? { agent: 'manager', part: 'Review the work of this task and write the pull request text.', status: 'pending' } : null;
  }
  if (!config.projects?.[project]) throw new Error(t('Unknown project: {id}', { id: project }));
  const base = `${stamp()}-${slug(missionId ?? agent)}`;
  let id = base;
  for (let n = 2; existsSync(runFile(id)); n++) id = `${base}-${n}`;
  return saveRun({
    id, kind, mission: missionId ?? null, project, title, instruction: instruction ?? null, origin,
    status: 'queued', created: now(), notBefore, branch: `chiefmate/${id}`, steps, review: finalReview,
  });
}

export function cancelCurrent(reason) {
  cancelRequest = reason;
  currentProcess?.cancel(reason);
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

const libraryIds = project => [...(project.library ?? []), ...(project.docs ? [project.docs.split('/')[0]] : [])];

/** The prompt's lines about the libraries and the project's personal documentation. */
function libraryLines(project, libraries) {
  if (!libraries.length) return [];
  const lines = ['', '## Reference library (read only)'];
  for (const l of libraries) lines.push(`- ${l.name}: \`${l.dir}\`. ${l.about}`.trim());
  lines.push('Read what helps. It is a copy: anything you change there is discarded before the next run.');
  if (project.docs) {
    const [id, ...rest] = project.docs.split('/');
    const docs = path.join(libraries.find(l => l.id === id)?.dir ?? '', ...rest);
    lines.push(
      '',
      '## Personal documentation for this project',
      `\`${docs}\`: read it first. It is the main reference for this project and takes precedence over the repository's own instructions (such as CLAUDE.md or AGENTS.md), which you still follow when they don't conflict with it. It stays outside the project's repository: never copy it into the project. If your work makes it outdated, say what should change in your report.`,
    );
  }
  return lines;
}

function logAction(event) {
  if (event.type !== 'action' && event.type !== 'say') return;
  live.actions.push({ at: now(), type: event.type, text: event.type === 'say' ? clip(event.text, 300) : event.text });
  if (live.actions.length > 300) live.actions.splice(0, live.actions.length - 300);
}

function stepPrompt({ run, step, project, previous, finalReview, changes, config, libraries, base }) {
  const prLanguage = project.language || config.language || 'en';
  const local = project.deliver === 'local';
  const lines = [
    finalReview ? `# Final review: ${run.title}` : `# ${run.title}`,
    `Project: ${project.name}${project.site ? ` (${project.site})` : ''}. ${project.about ?? ''}`.trim(),
    `Today: ${formatDateTime(new Date())}. Run branch: ${run.branch}, started from ${base}.${local ? ' Nothing from this run goes to GitHub: the branch is handed to the owner, who decides what to send.' : ''}`,
    '',
    finalReview ? '## What to do in this review' : '## Your part',
    step.part,
  ];
  if (project.playbook && run.kind === 'mission') {
    lines.push('', `This mission's playbook is \`${project.playbook}\`. Read it before you start and do only your part.`);
  }
  const notes = [project.notes, project.agent_notes?.[step.agent]].filter(Boolean).join('\n\n');
  if (notes) lines.push('', '## Notes for this project', notes);
  lines.push(...libraryLines(project, libraries));
  if (finalReview) {
    lines.push(
      '',
      `You are the manager. The crew finished the work below. Before it goes to the owner for approval${local ? ' (as a branch, not a pull request)' : ' as a pull request'}:`,
      `1. See what changed: \`git log --oneline origin/${base}..HEAD\` and the diff of every file that matters.`,
      '2. Check it against the reports and the project\'s rules. Fix whatever is wrong or incomplete, committing as "Chiefmate: manager review".',
      `3. Run the checks: ${(project.checks ?? []).map(c => `\`${c}\``).join(', ') || 'the ones the project and its documentation describe, as far as this machine allows'}.`,
      `4. Your last message presents the work for approval${local ? ', as the note that goes with the branch' : ', as the pull request text'}, in markdown and in ${languageName(prLanguage)}. End it with a section titled "${t("Manager's verdict", {}, prLanguage)}": what you fixed, the risks and your recommendation (approve, approve with caveats, or do not approve).`,
      '',
      '## Changed files',
      '```',
      changes || '(none)',
      '```',
    );
  }
  if (previous.length) {
    lines.push('', finalReview ? '## Crew reports' : '## What the previous steps did');
    for (const p of previous) lines.push('', `### ${p.agent} (${p.status})`, p.report || p.error || '(no report)');
  }
  lines.push('', crewRules(config, project));
  return lines.join('\n');
}

async function runStep({ run, step, index, dir, project, config, agents, libraries, base, finalReview = false }) {
  const agent = agents[step.agent];
  if (!agent) throw new Error(t('Unknown agent: {id}', { id: step.agent }));
  const previous = run.steps.filter(s => s !== step && s.status !== 'pending');
  const changes = finalReview ? await changedFiles(dir, base).catch(() => '') : '';
  const model = agent.model ?? config.default_model;

  Object.assign(step, { status: 'running', started: now(), error: null, model });
  Object.assign(live, { step: index + 1, agent: step.agent, started: now(), actions: [] });
  saveRun(run);

  const { promise, cancel, pid } = runClaude({
    dir,
    prompt: stepPrompt({ run, step, project, previous, finalReview, changes, config, libraries, base }),
    system: agent.instructions,
    model,
    effort: agent.effort,
    tools: agent.tools ?? [],
    disallowed: [...ALWAYS_DISALLOWED, ...(agent.disallowed ?? [])],
    addDirs: libraries.map(l => l.dir),
    attribution: config.attribution !== false,
    maxMinutes: agent.max_minutes ?? 60,
    log: path.join(runDir(run.id), `${String(index + 1).padStart(2, '0')}-${step.agent}.jsonl`),
    onEvent: logAction,
  });
  currentProcess = { cancel };
  live.pid = pid; // the agent's process: its memory counts for the project, and it is never stopped from the Projects section
  const r = await promise;
  currentProcess = null;
  live.pid = null;

  const waitUntil = limitHit(r);
  Object.assign(step, {
    status: waitUntil ? 'pending' : r.ok ? 'done' : 'failed', ended: waitUntil ? null : now(), tokens: r.tokens, turns: r.turns,
    durationMs: r.durationMs, report: r.text, error: r.error ?? null, subagents: r.subagents, actions: live.actions.length,
  });
  await commitPending(dir, `Chiefmate: ${t(agent.name)} (${run.title})`).catch(e => (step.error = `${step.error ?? ''} Commit: ${e.message}`.trim()));
  saveRun(run);
  return { waitUntil };
}

/** The pull request's text, in the project's language (lang). */
function pullRequestBody(run, checks, agents, lang) {
  const labels = { pending: t('Pending', {}, lang), running: t('Running', {}, lang), done: t('Done', {}, lang), failed: t('Failed', {}, lang) };
  const name = id => t(agents[id]?.name ?? id, {}, lang);
  const main = run.review?.report || run.steps.map(s => `## ${name(s.agent)}\n\n${s.report || s.error || t('(no report)', {}, lang)}`).join('\n\n');
  const table = stepsOf(run).map(s => `| ${name(s.agent)} | ${labels[s.status] ?? s.status} | ${formatDuration(s.durationMs)} | ${s.turns ?? ''} |`);
  const checkList = checks.map(c => `- ${c.ok ? '✅' : '❌'} \`${c.command}\``);
  return [
    main, '', '---', '',
    `### ${t('Done by Chiefmate', {}, lang)}`, '',
    `| ${t('Step', {}, lang)} | ${t('Status', {}, lang)} | ${t('Time', {}, lang)} | ${t('Turns', {}, lang)} |`, '|---|---|---|---|', ...table, '',
    `**${t('Checks after the review:', {}, lang)}**`, ...(checkList.length ? checkList : [`- ${t('(none)', {}, lang)}`]), '',
    t('Run `{id}`.', { id: run.id }, lang),
  ].join('\n');
}

/** Runs (or resumes) a run until the end, a pause for a limit, or a cancellation. */
export async function execute(run) {
  const config = loadConfig();
  const agents = loadAgents(config);
  const project = config.projects?.[run.project];
  cancelRequest = null;
  Object.assign(live, { run: run.id, title: run.title, project: run.project, step: null, agent: null, started: now(), pid: null, actions: [] });
  const firstTime = !run.started;
  Object.assign(run, { status: 'running', started: run.started ?? now(), notBefore: null, note: null });
  saveRun(run);
  if (firstTime) notify(t('Chiefmate started'), run.title);

  const wait = (waitUntil, note) => {
    Object.assign(run, { status: waitUntil ? 'waiting' : 'paused', notBefore: waitUntil ?? null, note });
    saveRun(run);
    notify(
      t('Chiefmate paused the run'),
      waitUntil
        ? t('{note}. I will resume on my own at {when}.', { note, when: formatDateTime(waitUntil) })
        : t('{note}. Open the app to decide.', { note }),
    );
  };

  try {
    if (!project) throw new Error(t('Unknown project: {id}', { id: run.project }));
    let dir;
    if (!run.prepared) {
      run.base = await baseBranch(project);
      dir = await prepareWorkspace(run.project, project, run.base, text => logAction({ type: 'action', text }));
      await createBranch(dir, run.branch);
      run.prepared = true;
      saveRun(run);
    } else {
      // Resuming: every finished step already left its work in commits on the run's branch.
      dir = projectDir(run.project);
      await checkoutBranch(dir, run.branch);
    }
    const base = run.base ?? project.main_branch;
    const libraries = await prepareLibraries(config, libraryIds(project), text => logAction({ type: 'action', text }));

    const order =[...run.steps.map(step => ({ step, finalReview: false })), ...(run.review ? [{ step: run.review, finalReview: true }] : [])];
    for (const [index, { step, finalReview }] of order.entries()) {
      if (step.status === 'done' || step.status === 'failed') continue;
      if (cancelRequest) break;
      const limit = checkLimits(config, run);
      if (limit) return wait(limit.waitUntil, limit.note);
      const { waitUntil } = await runStep({ run, step, index, dir, project, config, agents, libraries, base, finalReview });
      if (waitUntil) return wait(waitUntil, t('Your account reached its limit in the middle of a step'));
    }

    if (cancelRequest) {
      Object.assign(run, { status: 'canceled', ended: now(), note: cancelRequest });
      saveRun(run);
      return;
    }

    logAction({ type: 'action', text: t("Running the project's checks") });
    run.checks = await runChecks(dir, project.checks);
    const commits = await newCommits(dir, base);
    run.commits = commits.length;
    if (!commits.length) {
      Object.assign(run, { status: 'done', ended: now(), result: t('Finished with no changes to review.') });
      saveRun(run);
      notify(t('Chiefmate finished'), t('{title}: no changes to review.', { title: run.title }));
      return;
    }
    const failed = run.checks.filter(c => !c.ok).length;
    const body = pullRequestBody(run, run.checks, agents, project.language || config.language || 'en');
    const bodyFile = path.join(runDir(run.id), 'pull-request.md');

    if (project.deliver === 'local') {
      // Local delivery: the branch goes to your own clone (or stays in the working copy). Nothing goes to GitHub.
      writeFileSync(bodyFile, body);
      let where = t('the branch {branch} of the working copy ({path})', { branch: run.branch, path: dir });
      if (project.local_clone) {
        logAction({ type: 'action', text: t('Handing the branch to your clone of {name}', { name: project.name }) });
        await deliverToClone(dir, run.branch, project.local_clone);
        where = t('the branch {branch} of your clone ({path})', { branch: run.branch, path: project.local_clone });
      }
      const result = failed
        ? t('Ready on {where}, but {count} check(s) failed. Nothing was sent to GitHub.', { where, count: failed })
        : t('Ready on {where}. Nothing was sent to GitHub.', { where });
      Object.assign(run, { status: 'done', ended: now(), result, delivered: project.local_clone ?? dir });
      saveRun(run);
      notify(t('Ready for your review'), t('{title}: {result}', { title: run.title, result }), 'chiefmate:log');
      return;
    }

    logAction({ type: 'action', text: t('Pushing the branch and opening the pull request') });
    run.pullRequest = await openPullRequest(dir, {
      base, branch: run.branch, title: `${run.title} (${formatDate(run.created)})`, body, bodyFile,
    });
    const result = failed ? t('Pull request opened, but {count} check(s) failed.', { count: failed }) : t('Pull request opened and verified.');
    Object.assign(run, { status: 'done', ended: now(), result });
    saveRun(run);
    notify(t('Ready for your review'), t('{title}: {result}', { title: run.title, result }), run.pullRequest);
  } catch (error) {
    Object.assign(run, { status: 'failed', ended: now(), result: error.message });
    saveRun(run);
    notify(t('Chiefmate hit an error'), t('{title}: {error}', { title: run.title, error: clip(error.message, 180) }));
  } finally {
    Object.assign(live, { run: null, title: null, project: null, step: null, agent: null, pid: null });
  }
}
