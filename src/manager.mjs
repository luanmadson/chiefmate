// The conversation with the manager: a Claude Code session that carries on from message to message.
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runClaude } from './claude.mjs';
import { loadAgents, loadConfig, projectCrew } from './config.mjs';
import { formatDateTime, formatDuration, formatNumber, formatPercent, t } from './i18n.mjs';
import { processes } from './machine.mjs';
import { computerLine, planLine } from './plan.mjs';
import { focus, queued } from './queue.mjs';
import { ALWAYS_DISALLOWED, live, prepareLibraries } from './runs.mjs';
import { describeSchedule, nextRun } from './schedule.mjs';
import { addMessage, listRuns, readState, readUsage, saveState, stepsOf } from './store.mjs';
import { updateInfo } from './update.mjs';
import { DATA, ensureDir, languageName, now, ROOT, VERSION } from './util.mjs';

/** What the app shows while the manager thinks (or writes the summary that renews the conversation). */
export const chat = { responding: false, renewing: false, partial: '', actions: [], context: null };

// Above this share of the context window, the conversation is renewed with a summary as soon as the manager is free.
// Below it, Claude Code compacts the conversation on its own when it needs to.
const RENEW_AT = 0.75;
const MANAGER_DIR = path.join(DATA, 'manager');
const HANDOFF_FILE = path.join(MANAGER_DIR, 'handoff.md');
const NOTES_FILE = path.join(MANAGER_DIR, 'notes.md');
const conversationLog = () => path.join(ensureDir(MANAGER_DIR), 'conversation.jsonl');

// In the conversation the manager works in Chiefmate's own folder: it never commits there, and never pushes.
const CHAT_DISALLOWED = ['Agent', 'WebSearch', 'WebFetch', 'Bash(git commit:*)', ...ALWAYS_DISALLOWED];

// The manager reads every reference library; the copies are refreshed at most every 10 minutes.
let libraryCopies = [];
let librariesRefreshed = 0;
async function chatLibraries(config) {
  const ids = Object.keys(config.library ?? {});
  if (!ids.length) return [];
  if (Date.now() - librariesRefreshed > 10 * 60_000) {
    try {
      libraryCopies = await prepareLibraries(config, ids);
      librariesRefreshed = Date.now();
    } catch (error) {
      console.error('Library:', error.message); // keep the last copies
    }
  }
  return libraryCopies;
}

/** The project in focus, in one line: the run going on now, else the next one in the queue. */
function focusLine(config) {
  const f = focus(config);
  if (!f) return 'Focus: no project in focus (nothing running, queue empty).';
  const what = `project ${f.project} (${f.projectName}), ${f.kind} "${f.title}" [${f.run}]`;
  if (f.state === 'running') {
    const who = f.agent ? `${f.agent} at work (step ${f.step ?? '-'})` : 'preparing the working copy';
    return `Focus: ${what}, ${who}, running for ${formatDuration(Date.now() - new Date(f.since).getTime())}.`;
  }
  const when = f.notBefore && new Date(f.notBefore).getTime() > Date.now() ? `, not before ${formatDateTime(f.notBefore)}` : '';
  return `Focus: nothing running; next in the queue is ${what}${f.agent ? `, starting with ${f.agent}` : ''}${when}.`;
}

const share = c => `${formatNumber(c.used)} of ${formatNumber(c.window)} tokens (${formatPercent(c.used / c.window)})`;

/** How full the conversation's context is, and the one of the agent at work. */
function contextLine() {
  const m = readState().manager ?? {};
  const c = m.context;
  const mine = c?.used
    ? `this conversation fills ${share(c)}, ${c.compactions ?? 0} automatic compaction(s)`
    : m.handoff ? 'this conversation was just renewed, with your summary of the previous one' : 'this conversation is new';
  let agent = '';
  if (live.run && live.agent) {
    agent = live.context?.used
      ? `; ${live.agent} at work fills ${share(live.context)}, ${live.context.compactions ?? 0} compaction(s)`
      : `; ${live.agent} at work: not measured yet`;
  }
  return `Context: ${mine}${agent}. Above ${formatPercent(RENEW_AT)}, Chiefmate renews this conversation with a short summary you write; below that, Claude Code compacts it on its own.`;
}

/** The conversation's context, for the app. */
export function managerContext() {
  const m = readState().manager ?? {};
  const c = (chat.responding && !chat.renewing && chat.context) || m.context || {};
  return { ...c, renewing: chat.renewing, renewed: m.renewed ?? null, renewAt: RENEW_AT };
}

/** A snapshot of the moment, sent along with each of your messages. */
export function situation(libraries = []) {
  const config = loadConfig();
  const agents = loadAgents(config);
  const usage = readUsage();
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const lines = [`Now: ${formatDateTime(new Date())} (${zone}). Reply in ${languageName(config.language || 'en')}.`];
  lines.push(`Chiefmate ${VERSION}${updateInfo.waiting ? `; an approved update with ${updateInfo.waiting} change(s) is waiting to be installed${updateInfo.blocked ? ` (blocked: ${updateInfo.blocked})` : ''}` : ''}.`);
  lines.push(focusLine(config));
  lines.push(live.run ? `Running: ${live.title} (step ${live.step ?? '-'}: ${live.agent ?? 'preparing'}), run ${live.run}.` : 'Running: nothing.');
  const queue = queued();
  lines.push(
    queue.length
      ? `Queue: ${queue.map(r => `${r.title} [${r.id}]${r.notBefore ? ` (not before ${formatDateTime(r.notBefore)})` : ''}`).join('; ')}.`
      : 'Queue: empty.',
  );
  const latest = listRuns().filter(r => !['queued', 'waiting'].includes(r.status)).slice(0, 5);
  lines.push('Latest runs:');
  for (const r of latest) {
    const work = stepsOf(r).reduce((sum, s) => sum + (s.durationMs ?? 0), 0);
    lines.push(`- [${r.id}] ${r.title} (project ${r.project}): ${r.status}, ${formatDuration(work)} of agent work${r.pullRequest ? `, PR ${r.pullRequest}` : ''}${r.result ? `. ${r.result}` : ''}${r.note ? `. ${r.note}` : ''}`);
  }
  if (!latest.length) lines.push('- none yet');
  const window = (w, name) => `${name} ${formatPercent(w?.used)}${w?.resets ? ` (resets ${formatDateTime(w.resets)})` : ''}`;
  const limits = config.limits ?? {};
  lines.push(`${config.owner}'s account: ${window(usage.five_hour, '5-hour window')}; ${window(usage.seven_day, 'plan week')}. Measured ${usage.updated ? formatDateTime(usage.updated) : 'never'}. Runs pause at ${formatPercent(limits.pause_at_5h_window)} of the 5-hour window and ${formatPercent(limits.pause_at_plan_week)} of the plan week.`);
  lines.push(planLine(config, usage));
  lines.push(computerLine(config));
  lines.push(contextLine());
  const delivery = p => (p.deliver === 'local' ? `, local delivery: the result is a branch in ${p.local_clone ?? 'the working copy'}, nothing goes to GitHub` : ', delivered as a pull request');
  lines.push(`Projects: ${Object.entries(config.projects ?? {}).map(([id, p]) => `${id} (${p.name}, ${p.repository}${delivery(p)}${p.docs ? `, personal docs in ${p.docs}` : ''})`).join('; ') || 'none'}.`);
  for (const l of libraries) lines.push(`Reference library ${l.id} (${l.name}), read only, a copy refreshed from GitHub: ${l.dir}. ${l.about}`.trim());
  lines.push(`Crew: ${Object.values(agents).map(a => `${a.id} (${a.name}, ${a.model ?? config.default_model})`).join(', ')}.`);
  // Missions and tasks of a project with a crew of its own take only its members (you, the manager, stay global).
  for (const [id, p] of Object.entries(config.projects ?? {}).filter(([, p]) => p.crew)) {
    const team = Object.values(projectCrew(config, id, agents)).filter(a => a.id !== 'manager');
    lines.push(`Crew of project ${id} (only these take its tasks): ${team.map(a => `${a.id} (${a.name}${a.base !== a.id ? `, based on ${a.base}` : ''})`).join(', ') || 'none'}.`);
  }
  for (const [id, m] of Object.entries(config.missions ?? {})) {
    const next = nextRun(m.schedule);
    lines.push(`Mission ${id} ("${m.name}", project ${m.project}): ${describeSchedule(m.schedule)}${next ? `, next on ${formatDateTime(next)}` : ''}.`);
  }
  return lines.join('\n');
}

export async function talkToManager(message) {
  if (!message) throw new Error(t('Empty message.'));
  if (chat.responding) throw new Error(t('The manager is still answering the previous message.'));
  const config = loadConfig();
  const manager = loadAgents(config).manager;
  if (!manager) throw new Error(t('agents/manager.md is missing.'));
  addMessage('you', message);
  const state = readState();
  state.manager ??= {};
  Object.assign(chat, { responding: true, partial: '', actions: [], context: state.manager.context ?? null });

  const model = manager.model ?? config.default_model;
  const libraries = await chatLibraries(config);
  await processes(60_000).catch(() => {}); // the projects running on this computer, for the situation
  const prompt = `<situation>\n${situation(libraries)}\n</situation>\n\nMessage from ${config.owner}:\n${message}`;
  const attempt = session =>
    runClaude({
      dir: ROOT,
      // A conversation renewed for its size starts with the summary of the previous one and the manager's notes.
      prompt: !session.resume && state.manager.handoff ? `${handoff()}${prompt}` : prompt,
      system: manager.instructions,
      model,
      effort: manager.chat_effort ?? manager.effort,
      tools: manager.tools ?? [],
      disallowed: CHAT_DISALLOWED,
      addDirs: libraries.map(l => l.dir),
      attribution: config.attribution !== false,
      maxMinutes: 15,
      session,
      log: conversationLog(),
      onEvent: event => {
        if (event.type === 'say') chat.partial = event.text;
        if (event.type === 'action') chat.actions.push(event.text);
        if (event.type === 'context') chat.context = { ...chat.context, used: event.used, window: event.window };
      },
    }).promise;

  try {
    let r;
    let resumed = false;
    if (state.manager.session) {
      r = await attempt({ id: state.manager.session, resume: true });
      resumed = r.ok || !!r.text;
      if (!resumed) r = null; // the old conversation is gone: start another one
    }
    if (!r) {
      const id = randomUUID();
      r = await attempt({ id, resume: false });
      if (!r.session) r.session = id;
    }
    addMessage('manager', r.text || t("I couldn't answer: {error}", { error: r.error }), { model, ...(r.ok ? {} : { error: r.error }) });
    if (r.session) {
      if (!resumed && (r.ok || r.text)) delete state.manager.handoff; // the summary went into the new conversation
      state.manager.session = r.session;
      const compacted = r.context?.compactions ?? 0;
      const before = resumed ? state.manager.context ?? {} : {};
      if (r.context?.used) {
        state.manager.context = {
          used: r.context.used, window: r.context.window, updated: now(),
          compactions: (before.compactions ?? 0) + compacted, compacted: compacted ? now() : before.compacted ?? null,
        };
      }
      saveState(state);
      if (compacted) {
        addMessage('system', t('Claude Code compacted this conversation on its own to make room ({count} time(s) so far).', { count: state.manager.context?.compactions ?? compacted }));
      }
    }
  } finally {
    Object.assign(chat, { responding: false, partial: '', actions: [], context: null });
    setImmediate(() => renewIfFull().catch(error => console.error('Renewal:', error.message)));
  }
}

const readText = file => {
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
};

/** What opens a conversation renewed for its size: the manager's summary of the previous one and its notes. */
function handoff() {
  const summary = readText(HANDOFF_FILE);
  const notes = readText(NOTES_FILE);
  const parts = ['This conversation continues an earlier one, renewed because its context was filling up.'];
  if (summary) parts.push(`Your summary of it (data/manager/handoff.md):\n${summary}`);
  if (notes) parts.push(`Your notes (data/manager/notes.md):\n${notes}`);
  return `<handoff>\n${parts.join('\n\n')}\n</handoff>\n\n`;
}

const HANDOFF_PROMPT = `Chiefmate is about to renew this conversation because its context is filling up. Write the handoff for your next conversation: it starts with this handoff and your notes in data/manager/notes.md, and nothing else from this one.
- Short: at most 250 words, in bullet points.
- What the owner asked and still expects, decisions and agreements, open threads, promises you made and what to check next.
- Leave out what is already in your notes, and the situation, which comes again with every message.
Your reply is the handoff itself, with nothing before or after it.`;

/**
 * Renews the conversation once its context passes RENEW_AT and the manager is free: the manager writes a short
 * summary (data/manager/handoff.md), and the next message starts a new conversation with it and the notes.
 * If the summary fails, the conversation carries on and Claude Code's own compaction still works.
 */
async function renewIfFull() {
  const state = readState();
  const c = state.manager?.context;
  const session = state.manager?.session;
  if (!session || !c?.used || !c.window || c.used / c.window < RENEW_AT || chat.responding) return;
  const config = loadConfig();
  const manager = loadAgents(config).manager;
  if (!manager) return;
  Object.assign(chat, { responding: true, renewing: true, partial: '', actions: [] });
  try {
    const r = await runClaude({
      dir: ROOT,
      prompt: HANDOFF_PROMPT,
      system: manager.instructions,
      model: manager.model ?? config.default_model,
      effort: manager.chat_effort ?? manager.effort,
      tools: ['Read', 'Glob', 'Grep'],
      disallowed: [...CHAT_DISALLOWED, 'Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'],
      attribution: config.attribution !== false,
      maxMinutes: 10,
      session: { id: session, resume: true },
      log: conversationLog(),
    }).promise;
    const summary = r.ok ? r.text.trim() : '';
    if (!summary) return console.error('Renewal: no summary.', r.error ?? '');
    const fresh = readState();
    if (fresh.manager?.session !== session) return; // a new conversation was started meanwhile
    writeFileSync(HANDOFF_FILE, `${summary}\n`);
    fresh.manager = { handoff: true, renewed: now(), previous: { ...c, session } };
    saveState(fresh);
    addMessage('system', t('This conversation filled {percent} of its context. The manager wrote a short summary, and your next message starts a new conversation with it and the notes.', { percent: formatPercent(c.used / c.window) }));
  } finally {
    Object.assign(chat, { responding: false, renewing: false, partial: '', actions: [] });
  }
}

/** Starts a new conversation: the manager forgets the history (its notes in data/manager/notes.md stay). */
export function newConversation() {
  const state = readState();
  state.manager = {};
  saveState(state);
  addMessage('system', t('New conversation. The manager keeps only its notes.'));
}
