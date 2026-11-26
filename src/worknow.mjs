// "Work now": the owner acts on a project at once, as they would opening Claude Code in a terminal, but inside the app,
// with the project's context ready and the manager told. One click on the project's page opens a live session in the
// app (src/sessions.mjs) with the project's agent in charge (its name and role, src/charge.mjs) that really acts: it
// reads, edits, runs commands and uses the project's external tools. It takes no place in the queue and doesn't count
// in max_parallel: it is the owner working. It opens in the owner's clone; when a run of the crew is going on in the
// same project, the owner chooses first: pause that run (it resumes when the session ends) or work in a separate copy
// (a git worktree of the clone). The manager is told, never asked: when it opens, at its milestones (a commit, a
// publication asked) and when it ends ("owner_working" news, and a line in its situation). When it ends, or after a
// while with no activity, a summary of what was done and what is left open is kept in
// data/projects/<id>/work-notes.jsonl, read by the next session's first message.
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { docsDir } from './access.mjs';
import { inCharge, mattersText, openMatters, readRequests } from './charge.mjs';
import { loadConfig } from './config.mjs';
import { formatDateTime, t } from './i18n.mjs';
import { readMemory } from './leads.mjs';
import { reportEvent } from './news.mjs';
import { listRuns, readRun } from './store.mjs';
import { clip, DATA, ensureDir, languageName, now, WORKSPACES } from './util.mjs';
import { noTrace } from './workspace.mjs';

export const WORK_TOOLS = ['claude', 'codex'];
// Without activity for this long, an open session's summary is written (once per stretch of work).
export const IDLE_MINUTES = 30;
// A commit is told to the manager at most this often.
const MILESTONE_MINUTES = 10;

/** The profile id of a project's "Work now" session, per tool. */
export const workProfileId = (projectId, tool = 'claude') => `project-${projectId}-work${tool === 'codex' ? '-codex' : ''}`;
/** The project of a "Work now" profile id, or null. */
export const workProject = profileId => /^project-(.+)-work(?:-codex)?$/.exec(String(profileId ?? ''))?.[1] ?? null;
const toolOf = profileId => (/-work-codex$/.test(String(profileId ?? '')) ? 'codex' : 'claude');
const toolName = tool => (tool === 'codex' ? 'Codex' : 'Claude Code');

/**
 * The profile of a project's "Work now" session (never written to the settings): the agent in charge's name and role,
 * the project's blocks of the prompt builder as an automatic profile has them, and the project's external tools
 * (projects.<id>.mcp, through sessionMcp). builderBlocks: the blocks an automatic profile of the project gets.
 */
export function workProfile(config, projectId, tool = 'claude', builderBlocks = []) {
  const project = config.projects?.[projectId];
  if (!project) throw new Error(t('Unknown project: {id}', { id: projectId }));
  if (!WORK_TOOLS.includes(tool)) throw new Error(t('Choose Claude Code or Codex.'));
  const who = inCharge(config, projectId);
  if (!who) throw new Error(t('{project} has no one in its crew to be in charge.', { project: projectId }));
  const name = project.name ?? projectId;
  return {
    id: workProfileId(projectId, tool), name: t('{project}: {agent}, working with you', { project: name, agent: t(who.member.name ?? who.member.id) }),
    tool, project: projectId, library_folder: null, prompt_blocks: builderBlocks,
    model: tool === 'claude' ? who.member.model ?? config.default_model ?? null : null, cwd: null, mcp: [], auto: true,
    work: true, member: who.member.id, memberName: who.member.name ?? who.member.id, memberRole: who.member.title ?? who.member.role ?? '', lead: who.lead,
  };
}

/** The profile behind a "Work now" profile id, or null when it is not one. */
export function findWorkProfile(config, profileId, builderBlocks = []) {
  const project = workProject(profileId);
  return project && config.projects?.[project] ? workProfile(config, project, toolOf(profileId), builderBlocks) : null;
}

// ---------- The notes kept between sessions ----------

const notesFile = projectId => path.join(DATA, 'projects', String(projectId).replace(/[^\w.-]/g, '_'), 'work-notes.jsonl');

/** The latest summaries of the project's "Work now" sessions, newest first: { at, session, tool, done, open }. */
export function readWorkNotes(projectId, limit = 3) {
  const file = notesFile(projectId);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(line => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  }).reverse().slice(0, limit);
}

/** Keeps a session's summary for the next conversation. */
export function saveWorkNote(projectId, note) {
  ensureDir(path.dirname(notesFile(projectId)));
  appendFileSync(notesFile(projectId), `${JSON.stringify({ at: now(), ...note })}\n`);
}

// ---------- The first message: the project's context, ready ----------

/** The personal documentation's folder: in your own clone of the library when there is one, else Chiefmate's copy. */
function docsFolder(config, project, cloneOf) {
  if (!project.docs) return null;
  const id = project.docs.split('/')[0];
  const library = config.library?.[id];
  const own = library ? cloneOf(library) : null;
  const dir = docsDir(project, [{ id, dir: own ?? path.join(WORKSPACES, '.library', id) }]);
  return dir && existsSync(dir) ? { dir, copy: !own } : null;
}

// The documentation's index, by the names it usually has; else its first Markdown file.
const INDEX_NAMES = ['instrucoes_ia.md', 'index.md', 'indice.md', 'índice.md', 'readme.md', 'agents.md'];

/** The documentation's files: { index, files } (Markdown and text at its top level, at most 30). */
export function docsIndex(dir) {
  let names;
  try {
    names = readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile() && /\.(md|txt)$/i.test(e.name)).map(e => e.name).sort();
  } catch {
    return { index: null, files: [] };
  }
  const index = INDEX_NAMES.map(n => names.find(x => x.toLowerCase() === n)).find(Boolean) ?? names.find(x => /readme/i.test(x)) ?? names[0] ?? null;
  return { index: index ? path.join(dir, index) : null, files: names.filter(n => n !== index).slice(0, 30) };
}

/**
 * The project's context, for the session's first message: who the agent is, where it works, the rules that still
 * hold, the personal documentation (its index first), the notes, the memory, the project's open matters (openMatters
 * in src/charge.mjs: the board, the deliveries waiting, the week's runs, the live sessions) and the subjects left open
 * (the requests to the manager, the crew's questions, the summaries of the earlier sessions).
 * where: { dir, copy (a separate copy), crew (runs going on: { title, paused }) }. sessions: the live sessions.
 */
export function workContext(config, projectId, profile, where, { cloneOf = () => null, sessions = [] } = {}) {
  const project = config.projects[projectId];
  const owner = config.owner || 'the owner';
  const name = project.name ?? projectId;
  const parts = [];
  parts.push(`## You: ${profile.memberName}${profile.memberRole ? ` (${profile.memberRole})` : ''}, working now with ${owner}
${owner} opened this session with "Work now" on the project's page: they want to act on ${name} right away, with you, as in a terminal. You are ${profile.memberName}, ${profile.lead ? 'the team lead' : 'the agent in charge'} of ${name} in Chiefmate's crew; here you work directly with ${owner}, not as a step of a run: no queue, no review, no manager's authorization. You read, edit, run commands and use the project's tools. Talk in ${languageName(config.language || 'en')}, short and plain.`);
  const crew = where.crew ?? [];
  parts.push(`## Where you work
${where.copy ? `A separate copy of ${owner}'s clone (a git worktree, made detached at their clone's commit and kept between sessions: an earlier session may have left it on a branch of its own, so check git status first): ${where.dir}. A run of the crew goes on in the project meanwhile. Before you commit, create a branch named for the work (nothing that mentions Chiefmate); ${owner}'s clone sees it at once.` : `${owner}'s own clone of the project: ${where.dir}.`}${crew.length ? `\nThe crew's run${crew.length > 1 ? 's' : ''} in this project: ${crew.map(c => `"${c.title}"${c.paused ? ` (paused at ${owner}'s click; it resumes when this session ends)` : ' (going on, in its own working copy)'}`).join('; ')}.` : ''}`);
  const rules = [
    `Never push to the main branch, and never publish anything (a push, a pull request, a release, a message to someone) unless ${owner} asks: Chiefmate refuses it until ${owner} allows it in the app.`,
    ...(noTrace(project) ? ['This project carries no trace of Chiefmate: no mention of Chiefmate, its crew or its agents in commits, branches, files or messages, and no co-author line.'] : []),
    ...(project.docs ? [`The personal documentation is ${owner}'s own: it never goes into the project's repository.`] : []),
    'Chiefmate\'s guard and its emergency lockdown stay on: when an action is refused, say what you wanted to run and why, and stop.',
  ];
  parts.push(`## The rules that still hold\n${rules.map(r => `- ${r}`).join('\n')}`);
  const docs = docsFolder(config, project, cloneOf);
  if (docs) {
    const { index, files } = docsIndex(docs.dir);
    parts.push(`## The personal documentation of the project
Folder: ${docs.dir}${docs.copy ? " (Chiefmate's read-only copy of the library: anything changed there is lost)" : ''}.${index ? `\nStart with its index: ${index}. It takes precedence over the repository's own instructions where they differ.` : ''}${files.length ? `\nIts other files: ${files.join(', ')}.` : ''}`);
  }
  const notes = [project.about, project.site ? `Site: ${project.site}` : '', project.repository ? `Repository: ${project.repository}` : '', project.notes ? clip(project.notes, 4000) : '', project.agent_notes?.[profile.member] ? clip(project.agent_notes[profile.member], 2000) : ''].filter(Boolean);
  if (notes.length) parts.push(`## The project's notes\n${notes.join('\n\n')}`);
  const memory = readMemory(projectId);
  if (memory) parts.push(`## The project's memory (kept by its team lead)\n${clip(memory, 6000)}`);
  // The board, the deliveries waiting, the week's runs and the live sessions: the same summary as the agent in charge's.
  const all = listRuns();
  parts.push(mattersText(openMatters(config, projectId, { runs: all, sessions }), owner, { when: "as this session opens" }));
  const runs = all.filter(r => r.project === projectId);
  const open = [];
  for (const r of readRequests().filter(x => x.project === projectId && ['pending', 'waiting', 'owner'].includes(x.status)).slice(-6)) {
    open.push(`- Request #${r.id} to the manager (${r.status === 'pending' ? 'with the manager' : r.status === 'owner' ? `with ${owner}` : 'on hold'}): ${clip(r.plan, 200)}`);
  }
  for (const r of runs.filter(x => !['done', 'failed', 'canceled'].includes(x.status))) {
    for (const q of (r.requests ?? []).filter(x => x.status === 'open')) open.push(`- The crew asks ${owner} (run "${r.title}"): ${clip(q.what, 200)}`);
  }
  const earlier = readWorkNotes(projectId, 3);
  if (open.length || earlier.length) {
    parts.push(`## Subjects left open\n${[...open, ...earlier.map(n => `- From the "Work now" session of ${formatDateTime(n.at)}: ${clip(n.done, 400)}${n.open ? ` Left open: ${clip(n.open, 400)}` : ''}`)].join('\n')}`);
  }
  parts.push(`## Now
Read the documentation's index (when there is one) and what you need of the above, then answer ${owner} in at most five short lines: where the project stands and what is open. Then wait for what ${owner} wants to do.`);
  return parts.join('\n\n');
}

/** Claude Code's added instructions in a "Work now" session (with those of every session in the app). */
export function workSystem(config, session) {
  const owner = config.owner || 'the owner';
  const name = config.projects?.[session.project]?.name ?? session.project;
  return `You are ${session.memberName ?? 'the agent in charge'}${session.memberRole ? ` (${session.memberRole})` : ''}, of the crew of ${name}, working live with ${owner} on it ("Work now"). The project's context came with your first message.`;
}

// ---------- The manager, told ----------

/** Tells the manager (never waits for it): "owner_working" news. later: with the next news, not a turn of its own. */
export function tellManager(text, config = loadConfig(), { later = false } = {}) {
  reportEvent('owner_working', text, { config, later });
}

const sessionAbout = (config, s) => `${config.owner || 'The owner'} is working now on ${config.projects?.[s.project]?.name ?? s.project} with ${s.memberName ?? 'its agent in charge'} (${toolName(s.tool)}, "Work now" session ${s.id}, ${s.work?.copy ? 'in a separate copy of their clone' : 'in their own clone'})`;

/** The news when a session opens: what it is, where, and what the manager may do with the queue. */
export function openedNews(config, session, crew = []) {
  const owner = config.owner || 'the owner';
  const runs = crew.length ? ` The crew's run${crew.length > 1 ? 's' : ''} in this project: ${crew.map(c => `"${c.title}" [${c.run}] ${c.paused ? `paused at ${owner}'s click, resumed when the session ends` : 'goes on in its own working copy'}`).join('; ')}.` : '';
  return `${sessionAbout(config, session)}.${runs} Nothing waits for your answer. Use it to manage the queue while the session lasts: queue no new work on this project unless ${owner} asks for it, and when a queued run of it would conflict with what ${owner} is doing, cancel it (node src/cli.mjs cancel <id>) and queue it again once the session ends; keep the parallel load lighter, so ${owner} has room in the account's usage.`;
}

/**
 * A milestone of the session going on (a commit, a publication asked), at most every MILESTONE_MINUTES for commits.
 * It goes with the manager's next news (the session going quiet or ending, at the latest): it asks nothing of the
 * manager, so it doesn't spend a turn of its own, and the owner's usage.
 */
export function milestone(config, session, what, { kind = 'commit' } = {}) {
  const last = session.work?.told?.[kind];
  if (kind === 'commit' && last && Date.now() - Date.parse(last) < MILESTONE_MINUTES * 60_000) return false;
  session.work = { ...session.work, told: { ...session.work?.told, [kind]: now() } };
  tellManager(`${sessionAbout(config, session)}: ${clip(what, 300)}.`, config, { later: true });
  return true;
}

/** Whether an action of the agent is a commit (as describeAction writes a command: its text has the command). */
export const isCommit = text => /\bgit(\s+-C\s+("[^"]*"|\S+))?\s+commit\b/.test(String(text ?? ''));

// ---------- The summary, for the next conversation ----------

/** The session's history in a few lines, for the summary: the owner's messages, what the agent said and its commands. */
export function historyDigest(items, size = 12_000) {
  const lines = [];
  for (const e of items) {
    if (e.kind === 'owner' && !e.first) lines.push(`Owner: ${clip(e.text, 600)}`);
    else if (e.kind === 'say') lines.push(`Agent: ${clip(e.text, 800)}`);
    else if (e.kind === 'action' && !/^(Read|Leu|Looked|Procurou|Searched)/.test(e.text ?? '')) lines.push(`Action: ${clip(e.text, 160)}`);
  }
  const text = lines.join('\n');
  return text.length > size ? text.slice(-size) : text;
}

/** The summary's two parts from the quick model's answer ("Done: ..." and "Open: ...", also "Feito:" and "Em aberto:"), or null. */
export function parseSummary(answer) {
  const text = String(answer ?? '').replace(/\*\*/g, '').trim();
  if (!text) return null;
  const done = /(?:done|feito)\s*:\s*([\s\S]*?)(?:\n\s*(?:open|em aberto)\s*:|$)/i.exec(text)?.[1]?.trim();
  const open = /(?:^|\n)\s*(?:open|em aberto)\s*:\s*([\s\S]*)$/i.exec(text)?.[1]?.trim();
  if (!done && !open) return { done: clip(text, 1200), open: '' };
  return { done: clip(done ?? '', 1200), open: /^(none|nothing|nada|nenhum|nenhuma)\.?$/i.test(open ?? '') ? '' : clip(open ?? '', 1200) };
}

/**
 * Writes the session's summary: what was done and what is left open, from its history, through the quick model
 * (digest.mjs); without it, the agent's last words. Kept in the project's work notes; returns it.
 * ask: the call to the quick model (askQuick), given by the caller.
 */
export async function summarize(config, session, items, ask) {
  const digest = historyDigest(items);
  if (!digest.trim()) return null;
  const prompt = `Below is a live working session between ${config.owner || 'the owner'} and an AI agent on the project ${config.projects?.[session.project]?.name ?? session.project}. Write a summary for whoever works on it next, in exactly this shape and nothing else, the labels "Done:" and "Open:" as they are and the rest in ${languageName(config.language || 'en')}:
Done: <what was done, one to three sentences, with files or commits that matter>
Open: <what was left open or still to decide, one to three sentences, or "none">

${digest}`;
  const answer = ask ? await ask(prompt, config).catch(() => null) : null;
  const lastSaid = [...items].reverse().find(e => e.kind === 'say')?.text ?? '';
  const summary = parseSummary(answer) ?? { done: clip(lastSaid, 600), open: '' };
  saveWorkNote(session.project, { session: session.id, tool: session.tool, ...summary });
  return summary;
}

// ---------- The manager's line ----------

/** For the manager's situation: the "Work now" sessions open. */
export function workLine(sessions, config = loadConfig()) {
  const open = sessions.filter(s => s.work && s.mode === 'app' && s.status === 'open');
  if (!open.length) return '';
  const owner = config.owner || 'the owner';
  return `${owner} working now (sessions opened with "Work now"; told to you, not asked: queue no new work on the same project unless ${owner} asks for it, hold back a queued run of it that would conflict, and keep the parallel load lighter meanwhile): ${open.map(s => `${config.projects?.[s.project]?.name ?? s.project} with ${s.memberName ?? 'its agent'} since ${formatDateTime(s.started ?? s.created)}${s.work?.copy ? ', in a separate copy' : ''}${s.work?.held?.length ? `, the crew's run ${s.work.held.join(', ')} paused` : ''}`).join('; ')}.`;
}

/** The latest notes in the app's shape, for a project: { at, done, open }. */
export const workNotesView = projectId => readWorkNotes(projectId, 3).map(n => ({ at: n.at, done: n.done, open: n.open ?? '' }));

// ---------- Opening and ending ----------

/** Where a project's separate copy goes: one per project, kept and used again. */
export const copyFolder = projectId => path.join(WORKSPACES, '.work', String(projectId).replace(/[^\w.-]/g, '_'));

/**
 * The separate copy of the owner's clone: a git worktree, detached at the clone's commit, made once and used again.
 * Nothing is committed or pushed; the clone's .git only records the worktree. Returns its folder.
 */
async function separateCopy(clone, projectId, { dryRun = false } = {}) {
  const dir = copyFolder(projectId);
  if (existsSync(path.join(dir, '.git'))) return dir;
  if (existsSync(dir) && readdirSync(dir).length) throw new Error(t('The folder of the separate copy is in use: {path}', { path: dir }));
  if (dryRun) return dir;
  ensureDir(path.dirname(dir));
  const { run } = await import('./workspace.mjs');
  const r = await run('git', ['-C', clone, 'worktree', 'add', '--detach', dir, 'HEAD'], clone, { maxMinutes: 5 });
  if (r.code !== 0) throw new Error(t('The separate copy could not be made: {error}', { error: clip(r.output, 400) }));
  return dir;
}

/** The crew's runs going on in a project: { run, title, agent }. */
async function crewOn(projectId) {
  const { liveRuns } = await import('./runs.mjs');
  return liveRuns().filter(l => l.project === projectId).map(l => ({ run: l.run, title: l.title, agent: l.agent }));
}

/**
 * "Work now", the owner's click on a project's page: opens (or brings back) the project's session. When a run of the
 * crew is going on in the project and the owner hasn't chosen yet, nothing opens: { conflict: [runs] } asks them to
 * choose "pause" (the run pauses at a safe point and resumes when the session ends) or "copy" (a separate copy).
 * Never opened by an agent: only the app's button calls it. Returns the session (with "existing" when it was open).
 */
export async function openWork(projectId, { tool = 'claude', choice = null, dryRun = false, config = loadConfig() } = {}) {
  const { refuseWhileLocked } = await import('./lockdown.mjs');
  refuseWhileLocked(t('live session'));
  const sessions = await import('./sessions.mjs');
  const project = config.projects?.[projectId];
  if (!project) throw new Error(t('Unknown project: {id}', { id: projectId }));
  const profileId = workProfileId(projectId, tool);
  const open = sessions.listSessions().find(s => s.work && s.project === projectId && s.mode === 'app' && ['open', 'login', 'starting'].includes(s.status));
  if (open) return { ...open, existing: true };
  const clone = sessions.projectClone(project);
  if (!clone) throw new Error(t('No clone of yours on this computer: set "local_clone" in its settings.'));
  const crew = await crewOn(projectId);
  if (crew.length && !['pause', 'copy'].includes(choice)) return { conflict: crew };
  const copy = crew.length && choice === 'copy';
  const dir = copy ? await separateCopy(clone, projectId, { dryRun }) : clone;
  const where = { dir, copy, crew: crew.map(c => ({ ...c, paused: choice === 'pause' })) };
  if (dryRun) {
    const { profile, prompt } = sessions.planWork(config, profileId, where);
    return { dryRun: true, profile: profile.id, tool, cwd: dir, copy, crew: where.crew, prompt: prompt.text };
  }
  const session = await sessions.openSession(profileId, { config, work: where });
  if (choice === 'pause' && crew.length) {
    const { pauseLive } = await import('./runs.mjs');
    // Held while the session is open; a session that already ended lets the run go back to the queue (src/runs.mjs).
    const held = crew.filter(c => pauseLive(c.run, 'owner', { holdWhile: () => sessions.readSession(session.id)?.status !== 'ended' })).map(c => c.run);
    sessions.updateWork(session.id, { held });
  }
  tellManager(openedNews(config, sessions.readSession(session.id) ?? session, where.crew), config);
  return sessions.readSession(session.id) ?? session;
}

/**
 * A "Work now" session ended (by the owner) or went quiet: its summary is written and kept, the manager told, and,
 * when it ended, the crew's runs it paused go back to the queue. Returns the summary.
 */
export async function closeWork(id, { ended = true } = {}) {
  const sessions = await import('./sessions.mjs');
  const session = sessions.readSession(id);
  if (!session?.work) return null;
  const config = loadConfig();
  // Only what came after the last summary; marked at once, so the idle check doesn't write it twice.
  const since = session.work.summarized ?? null;
  const items = sessions.sessionHistory(id, null, 600).items.filter(e => !since || (e.at ?? '') > since);
  sessions.updateWork(id, { summarized: now() });
  const { askQuick } = await import('./digest.mjs');
  const summary = await summarize(config, session, items, askQuick);
  if (summary) sessions.noteSession(id, t('Summary kept for the next conversation. Done: {done}{open}', { done: summary.done, open: summary.open ? ` ${t('Left open: {open}', { open: summary.open })}` : '' }));
  // Only the runs still paused: one canceled or failed meanwhile stays as it is. One still pausing goes back to the
  // queue by itself (holdWhile in openWork).
  const paused = (session.work.held ?? []).filter(run => readRun(run)?.status === 'paused');
  let resumed = [];
  if (ended && session.work.held?.length) {
    const { resume } = await import('./queue.mjs');
    resumed = paused.filter(run => resume(run) === 'queued');
    sessions.updateWork(id, { held: [] });
  }
  const about = sessionAbout(config, session);
  const nothing = since ? 'Nothing new since its last summary.' : 'Nothing was done.';
  tellManager(`${about}: ${ended ? 'the session ended' : `no activity for ${IDLE_MINUTES} minutes`}. ${summary ? `Done: ${clip(summary.done, 500)}${summary.open ? ` Left open: ${clip(summary.open, 400)}` : ''}` : nothing}${resumed.length ? ` The crew's run ${resumed.join(', ')} went back to the queue.` : ''}${!ended && paused.length ? ` The crew's run ${paused.join(', ')} stays paused until the session ends.` : ''}`, config);
  return summary;
}
