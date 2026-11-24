// The conversation with the manager: a Claude Code session that carries on from message to message.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { runClaude } from './claude.mjs';
import { loadAgents, loadConfig } from './config.mjs';
import { formatDateTime, formatMoney, formatPercent, t } from './i18n.mjs';
import { queued } from './queue.mjs';
import { live } from './runs.mjs';
import { describeSchedule, nextRun } from './schedule.mjs';
import { addMessage, listRuns, readState, readUsage, runCost, saveState, weekCost } from './store.mjs';
import { DATA, ensureDir, languageName, ROOT } from './util.mjs';

/** What the app shows while the manager thinks. */
export const chat = { responding: false, partial: '', actions: [] };

/** A snapshot of the moment, sent along with each of your messages. */
export function situation() {
  const config = loadConfig();
  const agents = loadAgents(config);
  const usage = readUsage();
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const lines = [`Now: ${formatDateTime(new Date())} (${zone}). Reply in ${languageName(config.language || 'en')}.`];
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
    lines.push(`- [${r.id}] ${r.title}: ${r.status}, ${formatMoney(runCost(r))}${r.pullRequest ? `, PR ${r.pullRequest}` : ''}${r.result ? `. ${r.result}` : ''}${r.note ? `. ${r.note}` : ''}`);
  }
  if (!latest.length) lines.push('- none yet');
  const limits = config.limits ?? {};
  lines.push(`Usage over the last 7 days: ${formatMoney(weekCost())} of ${formatMoney(limits.weekly_usd)} (per-run limit: ${formatMoney(limits.per_run_usd)}).`);
  const window = (w, name) => `${name} ${formatPercent(w?.used)}${w?.resets ? ` (resets ${formatDateTime(w.resets)})` : ''}`;
  lines.push(`${config.owner}'s account: ${window(usage.five_hour, '5-hour window')}; ${window(usage.seven_day, 'plan week')}. Measured ${usage.updated ? formatDateTime(usage.updated) : 'never'}.`);
  lines.push(`Projects: ${Object.entries(config.projects ?? {}).map(([id, p]) => `${id} (${p.name})`).join(', ') || 'none'}.`);
  lines.push(`Crew: ${Object.values(agents).map(a => `${a.id} (${a.name}, ${a.model ?? config.default_model})`).join(', ')}.`);
  for (const [id, m] of Object.entries(config.missions ?? {})) {
    const next = nextRun(m.schedule);
    lines.push(`Mission ${id} ("${m.name}"): ${describeSchedule(m.schedule)}${next ? `, next on ${formatDateTime(next)}` : ''}.`);
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
  const prompt = `<situation>\n${situation()}\n</situation>\n\nMessage from ${config.owner}:\n${message}`;
  const attempt = session =>
    runClaude({
      dir: ROOT,
      prompt,
      system: manager.instructions,
      model: manager.model ?? config.default_model,
      effort: manager.chat_effort ?? manager.effort,
      tools: manager.tools ?? [],
      disallowed: ['Agent', 'WebSearch', 'WebFetch'],
      budgetUsd: manager.chat_budget_usd ?? 3,
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
    addMessage('manager', r.text || t("I couldn't answer: {error}", { error: r.error }), { cost: r.cost, model: manager.model ?? config.default_model, ...(r.ok ? {} : { error: r.error }) });
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
