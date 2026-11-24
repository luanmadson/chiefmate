// The conversation with the manager: a Claude Code session that carries on from message to message.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { runClaude } from './claude.mjs';
import { loadAgents, loadConfig } from './config.mjs';
import { formatDateTime, formatDuration, formatPercent, t } from './i18n.mjs';
import { queued } from './queue.mjs';
import { ALWAYS_DISALLOWED, live, prepareLibraries } from './runs.mjs';
import { describeSchedule, nextRun } from './schedule.mjs';
import { addMessage, listRuns, readState, readUsage, saveState, stepsOf } from './store.mjs';
import { updateInfo } from './update.mjs';
import { DATA, ensureDir, languageName, ROOT, VERSION } from './util.mjs';

/** What the app shows while the manager thinks. */
export const chat = { responding: false, partial: '', actions: [] };

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

/** A snapshot of the moment, sent along with each of your messages. */
export function situation(libraries = []) {
  const config = loadConfig();
  const agents = loadAgents(config);
  const usage = readUsage();
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const lines = [`Now: ${formatDateTime(new Date())} (${zone}). Reply in ${languageName(config.language || 'en')}.`];
  lines.push(`Chiefmate ${VERSION}${updateInfo.waiting ? `; an approved update with ${updateInfo.waiting} change(s) is waiting to be installed${updateInfo.blocked ? ` (blocked: ${updateInfo.blocked})` : ''}` : ''}.`);
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
  const delivery = p => (p.deliver === 'local' ? `, local delivery: the result is a branch in ${p.local_clone ?? 'the working copy'}, nothing goes to GitHub` : ', delivered as a pull request');
  lines.push(`Projects: ${Object.entries(config.projects ?? {}).map(([id, p]) => `${id} (${p.name}, ${p.repository}${delivery(p)}${p.docs ? `, personal docs in ${p.docs}` : ''})`).join('; ') || 'none'}.`);
  for (const l of libraries) lines.push(`Reference library ${l.id} (${l.name}), read only, a copy refreshed from GitHub: ${l.dir}. ${l.about}`.trim());
  lines.push(`Crew: ${Object.values(agents).map(a => `${a.id} (${a.name}, ${a.model ?? config.default_model})`).join(', ')}.`);
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
  Object.assign(chat, { responding: true, partial: '', actions: [] });

  const state = readState();
  state.manager ??= {};
  const model = manager.model ?? config.default_model;
  const libraries = await chatLibraries(config);
  const prompt = `<situation>\n${situation(libraries)}\n</situation>\n\nMessage from ${config.owner}:\n${message}`;
  const attempt = session =>
    runClaude({
      dir: ROOT,
      prompt,
      system: manager.instructions,
      model,
      effort: manager.chat_effort ?? manager.effort,
      tools: manager.tools ?? [],
      disallowed: CHAT_DISALLOWED,
      addDirs: libraries.map(l => l.dir),
      attribution: config.attribution !== false,
      maxMinutes: 15,
      session,
      log: path.join(ensureDir(path.join(DATA, 'manager')), 'conversation.jsonl'),
      onEvent: event => {
        if (event.type === 'say') chat.partial = event.text;
        if (event.type === 'action') chat.actions.push(event.text);
      },
    }).promise;

  try {
    let r;
    if (state.manager.session) {
      r = await attempt({ id: state.manager.session, resume: true });
      if (!r.ok && !r.text) r = null; // the old conversation is gone: start another one
    }
    if (!r) {
      const id = randomUUID();
      r = await attempt({ id, resume: false });
      if (!r.session) r.session = id;
    }
    if (r.session) {
      state.manager.session = r.session;
      saveState(state);
    }
    addMessage('manager', r.text || t("I couldn't answer: {error}", { error: r.error }), { model, ...(r.ok ? {} : { error: r.error }) });
  } finally {
    Object.assign(chat, { responding: false, partial: '', actions: [] });
  }
}

/** Starts a new conversation: the manager forgets the history (its notes in data/manager/notes.md stay). */
export function newConversation() {
  const state = readState();
  state.manager = {};
  saveState(state);
  addMessage('system', t('New conversation. The manager keeps only its notes.'));
}
