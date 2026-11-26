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
import { saveRun } from './store.mjs';
import { clip, languageName, now } from './util.mjs';

/**
 * Sends a message to the agent of a run going on: the owner's, from the agent's panel, or the manager's (by
 * "manager", cli.mjs guide), recorded as the manager's. Returns the message, as recorded.
 */
export function talkTo(runId, text, { by = 'owner' } = {}) {
  const message = String(text ?? '').trim();
  if (!message) throw new Error(t('Write your message to the agent.'));
  const id = String(runId ?? '');
  const l = liveOf(id);
  const run = activeRun(id);
  if (!l || !run || !l.agent || !l.talking) throw new Error(t('No agent is at work on this run now: a message only goes to a step going on.'));
  const who = by === 'manager' ? 'manager' : 'owner';
  const entry = { id: randomUUID().slice(0, 8), at: now(), who, step: l.step, agent: l.agent, text: clip(message, 4000), status: 'pending' };
  (run.talk ??= []).push(entry);
  // The agent is waiting for the owner right now (its waiting command asked within the last 20 seconds): the owner's
  // message answers that request, and nothing is interrupted. The manager's never answers for the owner.
  const request = who === 'owner' && Date.now() < l.heldUntil ? [...(run.requests ?? [])].reverse().find(r => r.status === 'open' && r.wait && r.step === l.step) : null;
  if (request) {
    Object.assign(request, { status: 'done', done: now(), by: 'owner', answer: entry.text });
    Object.assign(entry, { status: 'delivered', delivered: now(), via: 'request', request: request.id });
  } else {
    l.process?.interrupt?.();
  }
  saveRun(run);
  return entry;
}

/** The messages to a step (the owner's and the manager's) not delivered yet. */
export const pendingTalk = (run, step) => (run.talk ?? []).filter(m => (m.who === 'owner' || m.who === 'manager') && m.status === 'pending' && m.step === step);

/** Records something the agent said in the conversation: its answer to the owner, or a request (needs-you). */
export function agentSays(run, { step, agent, text, kind = 'answer', request = null, replyTo = null }) {
  const entry = { id: randomUUID().slice(0, 8), at: now(), who: 'agent', kind, step, agent, text: clip(String(text ?? '').trim(), 4000) };
  if (request) entry.request = request;
  if (replyTo) entry.replyTo = replyTo;
  (run.talk ??= []).push(entry);
  return entry;
}

/** The next turn of a resumed session: the messages of the owner (and of the manager), and what to do with them. */
export function ownerTurn(messages, config = loadConfig()) {
  const owner = config.owner || 'the owner';
  const fromManager = messages.some(m => m.who === 'manager');
  const fromOwner = messages.some(m => m.who !== 'manager');
  const from = fromManager && fromOwner ? `${owner} and from Chiefmate's manager` : fromManager ? "Chiefmate's manager" : owner;
  const lines = [
    `${messages.length > 1 ? `Messages from ${from}` : `Message from ${from}`}, sent to you directly while you were working${fromOwner ? ' (from the Chiefmate app)' : ''}.`,
    'Your work was paused at a safe point: the branch, the files and this session are as you left them.',
    ...(fromManager ? [`The manager coordinates the crew for ${owner}: follow its guidance as you would ${owner}'s, within the rules you already have.`] : []),
    '',
  ];
  const sender = m => (m.who === 'manager' ? 'the manager' : owner);
  for (const m of messages) lines.push(messages.length > 1 || fromManager ? `[from ${sender(m)}, sent ${formatDateTime(m.at)}]\n${m.text}\n` : m.text);
  lines.push(
    '',
    `First answer ${fromOwner ? owner : 'the manager'} in one short message, in ${languageName(config.language || 'en')}: it shows in the app, next to the message.`,
    "Then go on with your part, taking the message into account. When you finish, your last message is still the step's full report.",
  );
  return lines.join('\n');
}

/** The lines of a step's direct conversation, in the owner's language, for the step's report. */
export function talkLines(run, step, agentName = id => id, config = loadConfig()) {
  const owner = config.owner || t('the owner');
  return (run.talk ?? []).filter(m => m.step === step).map(m => {
    if (m.who === 'owner') return t('{owner} guided: "{text}"', { owner, text: clip(m.text, 600) }) + (m.status === 'undelivered' ? ` (${t('not delivered')})` : '');
    if (m.who === 'manager') return t('The manager guided: "{text}"', { text: clip(m.text, 600) }) + (m.status === 'undelivered' ? ` (${t('not delivered')})` : '');
    if (m.kind === 'request') return t('{agent} asked for help: "{text}"', { agent: agentName(m.agent), text: clip(m.text, 400) });
    return t('{agent} answered: "{text}"', { agent: agentName(m.agent), text: clip(m.text, 600) });
  });
}

/** The section added to a step's report when the owner talked to the agent during it. Empty when they didn't. */
export function talkSection(run, step, agentName, config = loadConfig()) {
  const talk = (run.talk ?? []).filter(m => m.step === step);
  if (!talk.some(m => m.who === 'owner' || m.who === 'manager')) return '';
  const lines = talkLines(run, step, agentName, config);
  const heading = talk.some(m => m.who === 'owner')
    ? t('Direct talk with {owner} during this step', { owner: config.owner || t('the owner') })
    : t('Guidance from the manager during this step');
  return `\n\n---\n**${heading}**\n${lines.map(l => `- ${l}`).join('\n')}`;
}

/** For the manager's <situation>: the direct talk in the runs given (going on and latest), newest last. */
export function talkSituation(runs, owner = 'the owner') {
  const lines = [];
  for (const run of runs) {
    const talk = run.talk ?? [];
    if (!talk.some(m => m.who === 'owner' || m.who === 'manager')) continue;
    const said = talk.slice(-6).map(m => {
      if (m.who === 'owner') return `${owner} guided step ${m.step} (${m.agent}): "${clip(m.text, 200)}"`;
      if (m.who === 'manager') return `You (the manager) guided step ${m.step} (${m.agent}): "${clip(m.text, 200)}"${m.status === 'pending' ? ' (waiting for a safe point)' : ''}`;
      return `${m.agent} ${m.kind === 'request' ? 'asked for help' : 'answered'}: "${clip(m.text, 160)}"`;
    });
    lines.push(`- [${run.id}] ${run.title}: ${said.join('; ')}`);
  }
  return lines.length
    ? [`Direct talk between ${owner} and the crew (from the agent's panel in the app, and your own "guide"; take it into account, above all in final reviews):`, ...lines.slice(-6)].join('\n')
    : `Direct talk between ${owner} and the crew: none in these runs.`;
}
