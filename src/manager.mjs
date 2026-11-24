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
import { addMessage, listRuns, readPending, readState, readUsage, savePending, saveState, stepsOf } from './store.mjs';
import { updateInfo } from './update.mjs';
import { DATA, ensureDir, languageName, now, ROOT, VERSION } from './util.mjs';

/**
 * What the app shows while the manager thinks (or writes the summary that renews the conversation): since when, the
 * text so far, its actions ({ at, text }) and how full the context is. "cancel" stops the answer going on.
 */
export const chat = { responding: false, renewing: false, interrupting: false, since: null, partial: '', actions: [], context: null, cancel: null };

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

// ---------- Messages: sent at any time, queued while the manager is busy ----------

const MAX_PENDING = 50;

/**
 * Sends a message to the manager. When it is free, the message goes at once; while it answers (or renews the
 * conversation), the message waits in the queue (data/manager/pending.json), where it can still be edited or removed,
 * and the whole queue goes together, in order, as the next message. Returns the message, with "queued" and "position".
 */
export function sendToManager(text) {
  const message = String(text ?? '').trim();
  if (!message) throw new Error(t('Write a message.'));
  const list = readPending();
  if (list.length >= MAX_PENDING) throw new Error(t('The queue already has {count} messages. Wait for the manager, or remove some.', { count: list.length }));
  const queued = chat.responding || list.length > 0;
  const item = { id: randomUUID().slice(0, 8), text: message, at: now(), queued };
  list.push(item);
  savePending(list);
  deliverPending();
  return { ...item, position: queued ? list.length : 0 };
}

/** Changes a message still in the queue. Returns the queue, or null when the message is no longer there. */
export function editPending(id, text) {
  const message = String(text ?? '').trim();
  if (!message) throw new Error(t('Write a message.'));
  const list = readPending();
  const item = list.find(m => m.id === id);
  if (!item) return null;
  Object.assign(item, { text: message, edited: now() });
  savePending(list);
  return list;
}

/** Takes a message out of the queue. Returns the queue, or null when the message is no longer there. */
export function removePending(id) {
  const list = readPending();
  if (!list.some(m => m.id === id)) return null;
  const rest = list.filter(m => m.id !== id);
  savePending(rest);
  return rest;
}

/** Whether the manager is answering, or has messages waiting (the self-update waits for both). */
export const managerBusy = () => chat.responding || readPending().length > 0;

/** When the manager is free, hands it the whole queue as one message. Returns whether an answer started. */
export function deliverPending() {
  if (chat.responding) return false;
  const items = readPending();
  if (!items.length) return false;
  savePending([]);
  answer(items).catch(error => addMessage('manager', t("I couldn't answer: {error}", { error: error.message }), { error: error.message }));
  return true;
}

/**
 * Ends the current answer (or the renewal) at once. The conversation goes on in the same session: the next message
 * says it was interrupted, and the queue goes right after. Returns false when the manager was not answering.
 */
export function interruptManager() {
  if (!chat.responding) return false;
  chat.interrupting = true;
  chat.cancel?.(t('interrupted by you'));
  return true;
}

/** The text the manager receives: your message, or the queue in order with the time of each one. */
export function composeMessage(owner, items, interrupted = null) {
  const parts = [];
  if (interrupted) {
    parts.push(`${owner} interrupted your previous answer at ${formatDateTime(interrupted)}. What you were doing then may be half done: check it before you carry on.`);
  }
  if (items.length === 1 && !items[0].queued) parts.push(`Message from ${owner}:\n${items[0].text}`);
  else {
    const head = items.length === 1 ? `A message from ${owner}, sent while you were busy` : `${items.length} messages from ${owner}, sent while you were busy, oldest first`;
    parts.push(`${head}:\n\n${items.map(m => `[sent ${formatDateTime(m.at)}${m.edited ? `, edited ${formatDateTime(m.edited)}` : ''}]\n${m.text}`).join('\n\n')}`);
  }
  return parts.join('\n\n');
}

async function answer(items) {
  // Set before anything else, so a message sent meanwhile goes to the queue.
  Object.assign(chat, { responding: true, interrupting: false, partial: '', actions: [], cancel: null, since: now() });
  let state = null;
  try {
    for (const m of items) addMessage('you', m.text, { at: m.at, ...(m.queued ? { queued: true, delivered: now() } : {}), ...(m.edited ? { edited: m.edited } : {}) });
    const config = loadConfig();
    const manager = loadAgents(config).manager;
    if (!manager) throw new Error(t('agents/manager.md is missing.'));
    state = readState();
    state.manager ??= {};
    chat.context = state.manager.context ?? null;

    const model = manager.model ?? config.default_model;
    const libraries = await chatLibraries(config);
    await processes(60_000).catch(() => {}); // the projects running on this computer, for the situation
    const prompt = `<situation>\n${situation(libraries)}\n</situation>\n\n${composeMessage(config.owner, items, state.manager.interrupted)}`;
    const attempt = session => {
      // Interrupted while the situation was being gathered: nothing to stop.
      if (chat.interrupting) return Promise.resolve({ ok: false, canceled: true, text: '', error: t('interrupted by you') });
      const run = runClaude({
        dir: ROOT,
        // A conversation renewed for its size starts with the summary of the previous one and the manager's notes.
        prompt: !session.resume && state.manager.handoff ? `${handoff()}${prompt}` : prompt,
        system: manager.instructions,
        model,
        effort: manager.chat_effort ?? manager.effort,
        tools: manager.tools ?? [],
        disallowed: CHAT_DISALLOWED,
        addDirs: libraries.map(l => l.dir),
        // The command line refuses to write to this conversation from inside it.
        env: { CHIEFMATE_MANAGER: '1' },
        attribution: config.attribution !== false,
        maxMinutes: 15,
        session,
        log: conversationLog(),
        onEvent: event => {
          if (event.type === 'say') chat.partial = event.text;
          if (event.type === 'action') chat.actions = [...chat.actions, { at: now(), text: event.text }].slice(-40);
          if (event.type === 'context') chat.context = { ...chat.context, used: event.used, window: event.window };
        },
      });
      chat.cancel = run.cancel;
      return run.promise;
    };

    let r;
    let resumed = false;
    if (state.manager.session) {
      r = await attempt({ id: state.manager.session, resume: true });
      resumed = r.ok || !!r.text;
      // The old conversation is gone: start another one. Not when the answer was stopped (interrupted, or over the
      // time limit): the session is still there, and the next message carries on in it.
      if (!resumed && !r.canceled) r = null;
    }
    if (!r) {
      const id = randomUUID();
      r = await attempt({ id, resume: false });
      if (!r.session) r.session = id;
    }
    if (r.canceled && chat.interrupting) {
      if (chat.partial) addMessage('manager', chat.partial, { model, interrupted: true });
      addMessage('system', t('You interrupted the answer. The conversation goes on in the same session, and the manager is told in your next message.'));
      state.manager.interrupted = now();
    } else {
      addMessage('manager', r.text || t("I couldn't answer: {error}", { error: r.error }), { model, ...(r.ok ? {} : { error: r.error }) });
      delete state.manager.interrupted; // this message told it
    }
    let compacted = 0;
    if (r.session) {
      if (!resumed && (r.ok || r.text)) delete state.manager.handoff; // the summary went into the new conversation
      state.manager.session = r.session;
      compacted = r.context?.compactions ?? 0;
      const before = resumed ? state.manager.context ?? {} : {};
      if (r.context?.used) {
        state.manager.context = {
          used: r.context.used, window: r.context.window, updated: now(),
          compactions: (before.compactions ?? 0) + compacted, compacted: compacted ? now() : before.compacted ?? null,
        };
      }
    }
    // Only the manager's part: the rest of the state (the schedule's) may have changed during the answer.
    const fresh = readState();
    fresh.manager = state.manager;
    saveState(fresh);
    if (compacted) {
      addMessage('system', t('Claude Code compacted this conversation on its own to make room ({count} time(s) so far).', { count: state.manager.context?.compactions ?? compacted }));
    }
  } finally {
    Object.assign(chat, { responding: false, interrupting: false, partial: '', actions: [], context: null, cancel: null, since: null });
    // The messages sent meanwhile go first; the renewal waits for a quiet moment.
    if (!deliverPending()) setImmediate(() => renewIfFull().catch(error => console.error('Renewal:', error.message)));
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
  Object.assign(chat, { responding: true, renewing: true, interrupting: false, partial: '', actions: [], since: now() });
  try {
    const run = runClaude({
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
      onEvent: event => {
        if (event.type === 'action') chat.actions = [...chat.actions, { at: now(), text: event.text }].slice(-40);
      },
    });
    chat.cancel = run.cancel;
    const r = await run.promise;
    if (r.canceled && chat.interrupting) {
      return addMessage('system', t('You interrupted the renewal. The conversation goes on as it was; Chiefmate tries again after the next answer.'));
    }
    const summary = r.ok ? r.text.trim() : '';
    if (!summary) return console.error('Renewal: no summary.', r.error ?? '');
    const fresh = readState();
    if (fresh.manager?.session !== session) return; // a new conversation was started meanwhile
    writeFileSync(HANDOFF_FILE, `${summary}\n`);
    fresh.manager = { handoff: true, renewed: now(), previous: { ...c, session } };
    saveState(fresh);
    addMessage('system', t('This conversation filled {percent} of its context. The manager wrote a short summary, and your next message starts a new conversation with it and the notes.', { percent: formatPercent(c.used / c.window) }));
  } finally {
    Object.assign(chat, { responding: false, renewing: false, interrupting: false, partial: '', actions: [], cancel: null, since: null });
    deliverPending(); // the messages sent during the renewal
  }
}

/** Starts a new conversation: the manager forgets the history (its notes in data/manager/notes.md stay). */
export function newConversation() {
  const state = readState();
  state.manager = {};
  saveState(state);
  addMessage('system', t('New conversation. The manager keeps only its notes.'));
}
