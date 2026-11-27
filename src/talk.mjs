// The owner's direct conversation with an agent at work. From the agent's panel in the app, the owner writes to the
// step going on; the message reaches the agent without losing its work:
// - when the agent is waiting for the owner (needs-you --wait), the message answers that request and the waiting
//   command hands it over;
// - otherwise the agent is interrupted at a safe point (once the actions under way finish) and the same Claude Code
//   session is resumed (--resume) with the message as its next turn, on the same branch and working copy.
// Every exchange is kept in the run ("talk"), goes into the step's report and reaches the manager in <situation>.
import { randomUUID } from 'node:crypto';
import { loadConfig } from './config.mjs';
import { formatDateTime, t } from './i18n.mjs';
import { activeRun, liveOf } from './runs.mjs';
import { addSpeech } from './speech.mjs';
import { saveRun } from './store.mjs';
import { clip, languageName, now } from './util.mjs';

/** Sends the owner's message to the agent of a run going on. Returns the message, as recorded. */
export function talkTo(runId, text) {
  const message = String(text ?? '').trim();
  if (!message) throw new Error(t('Write your message to the agent.'));
  const id = String(runId ?? '');
  const l = liveOf(id);
  const run = activeRun(id);
  if (!l || !run || !l.agent || !l.talking) throw new Error(t('No agent is at work on this run now: a message only goes to a step going on.'));
  const entry = { id: randomUUID().slice(0, 8), at: now(), who: 'owner', step: l.step, agent: l.agent, text: clip(message, 4000), status: 'pending' };
  (run.talk ??= []).push(entry);
  // The owner's words go in the agent's speech bubble too (src/speech.mjs).
  addSpeech(run, { step: l.step, agent: l.agent, by: 'owner', text: entry.text });
  // The agent is waiting for the owner right now (its waiting command asked within the last 20 seconds): the message
  // answers that request, and nothing is interrupted.
  const request = Date.now() < l.heldUntil ? [...(run.requests ?? [])].reverse().find(r => r.status === 'open' && r.wait && r.step === l.step) : null;
  if (request) {
    Object.assign(request, { status: 'done', done: now(), by: 'owner', answer: entry.text });
    Object.assign(entry, { status: 'delivered', delivered: now(), via: 'request', request: request.id });
  } else {
    l.process?.interrupt?.();
  }
  saveRun(run);
  return entry;
}

/** The owner's messages of a step not delivered yet. */
export const pendingTalk = (run, step) => (run.talk ?? []).filter(m => m.who === 'owner' && m.status === 'pending' && m.step === step);

/** Records something the agent said in the conversation: its answer to the owner, or a request (needs-you). */
export function agentSays(run, { step, agent, text, kind = 'answer', request = null, replyTo = null }) {
  const entry = { id: randomUUID().slice(0, 8), at: now(), who: 'agent', kind, step, agent, text: clip(String(text ?? '').trim(), 4000) };
  if (request) entry.request = request;
  if (replyTo) entry.replyTo = replyTo;
  (run.talk ??= []).push(entry);
  return entry;
}

/** The next turn of a resumed session: the owner's messages, and what to do with them. */
export function ownerTurn(messages, config = loadConfig()) {
  const owner = config.owner || 'the owner';
  const lines = [
    `${messages.length > 1 ? `Messages from ${owner}` : `Message from ${owner}`}, sent to you directly from the Chiefmate app while you were working.`,
    'Your work was paused at a safe point: the branch, the files and this session are as you left them.',
    '',
  ];
  for (const m of messages) lines.push(messages.length > 1 ? `[sent ${formatDateTime(m.at)}]\n${m.text}\n` : m.text);
  lines.push(
    '',
    `First answer ${owner} in one short message, in ${languageName(config.language || 'en')}: it shows in the app, next to the message.`,
    "Then go on with your part, taking the message into account. When you finish, your last message is still the step's full report.",
  );
  return lines.join('\n');
}

/** The lines of a step's direct conversation, in the owner's language, for the step's report. */
export function talkLines(run, step, agentName = id => id, config = loadConfig()) {
  const owner = config.owner || t('the owner');
  return (run.talk ?? []).filter(m => m.step === step).map(m => {
    if (m.who === 'owner') return t('{owner} guided: "{text}"', { owner, text: clip(m.text, 600) }) + (m.status === 'undelivered' ? ` (${t('not delivered')})` : '');
    if (m.kind === 'request') return t('{agent} asked for help: "{text}"', { agent: agentName(m.agent), text: clip(m.text, 400) });
    return t('{agent} answered: "{text}"', { agent: agentName(m.agent), text: clip(m.text, 600) });
  });
}

/** The section added to a step's report when the owner talked to the agent during it. Empty when they didn't. */
export function talkSection(run, step, agentName, config = loadConfig()) {
  if (!(run.talk ?? []).some(m => m.step === step && m.who === 'owner')) return '';
  const lines = talkLines(run, step, agentName, config);
  return `\n\n---\n**${t('Direct talk with {owner} during this step', { owner: config.owner || t('the owner') })}**\n${lines.map(l => `- ${l}`).join('\n')}`;
}

/** For the manager's <situation>: the direct talk in the runs given (going on and latest), newest last. */
export function talkSituation(runs, owner = 'the owner') {
  const lines = [];
  for (const run of runs) {
    const talk = run.talk ?? [];
    if (!talk.some(m => m.who === 'owner')) continue;
    const said = talk.slice(-6).map(m => {
      if (m.who === 'owner') return `${owner} guided step ${m.step} (${m.agent}): "${clip(m.text, 200)}"`;
      return `${m.agent} ${m.kind === 'request' ? 'asked for help' : 'answered'}: "${clip(m.text, 160)}"`;
    });
    lines.push(`- [${run.id}] ${run.title}: ${said.join('; ')}`);
  }
  return lines.length
    ? [`Direct talk between ${owner} and the crew (from the agent's panel in the app; take it into account, above all in final reviews):`, ...lines.slice(-6)].join('\n')
    : `Direct talk between ${owner} and the crew: none in these runs.`;
}
