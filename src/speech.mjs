// The crew's speech bubbles: short lines, in plain words and in the first person, that tell the owner at a glance what
// an agent is doing and why. Kept in the run as "speech", newest last:
// - "agent": said by the agent itself (cli.mjs say, from its step);
// - "manager", "lead", "owner": who asked the agent for its task, or wrote to it during its step;
// - "auto": written by Chiefmate at the moments it knows (needs you, paused, finished, stopped).
// When the agent has said nothing lately, the bubble shows a line made from what it is doing (doingNow), marked as
// automatic and never recorded.
import { randomUUID } from 'node:crypto';
import { t } from './i18n.mjs';
import { clip, now } from './util.mjs';

/** The longest line, in characters. */
export const SPEECH_MAX = 160;
/** Lines kept per run. */
export const SPEECH_KEEP = 200;
/** Lines the app gets per run (the bubble and its history). */
export const SPEECH_SHOWN = 30;
/** A line of the agent said within this many seconds of its previous one takes that one's place. */
export const SPEECH_GAP_SECONDS = 60;
/** A line is shown in the bubble for this long; then the automatic line takes over. */
export const SPEECH_FRESH_MINUTES = 10;
/** A step with no action for this long shows as stuck. */
export const STUCK_MINUTES = 20;

const BY = ['agent', 'auto', 'manager', 'lead', 'owner'];
const STATES = ['working', 'waiting', 'stuck', 'done'];

/** One line of plain text: spaces and line breaks collapsed, at most SPEECH_MAX characters. */
export const speechLine = text => clip(String(text ?? '').replace(/\s+/g, ' ').trim(), SPEECH_MAX);

/**
 * Records a line in the run's speech. Returns the entry, or null when there is nothing to say. A line equal to the
 * agent's last one only refreshes its time; a line of the agent's own within SPEECH_GAP_SECONDS of its last replaces it.
 */
export function addSpeech(run, { step = null, agent = null, by = 'agent', text, state = null, at = now() }) {
  const line = speechLine(text);
  if (!line || !run) return null;
  const who = BY.includes(by) ? by : 'agent';
  const list = (run.speech ??= []);
  const last = [...list].reverse().find(x => x.agent === agent && x.step === step);
  if (last && last.by === who && last.text === line) {
    last.at = at;
    return last;
  }
  const entry = { id: randomUUID().slice(0, 8), at, step, agent, by: who, text: line, ...(STATES.includes(state) ? { state } : {}) };
  if (who === 'agent' && last?.by === 'agent' && Date.parse(at) - Date.parse(last.at) < SPEECH_GAP_SECONDS * 1000) list.splice(list.indexOf(last), 1, entry);
  else list.push(entry);
  if (list.length > SPEECH_KEEP) list.splice(0, list.length - SPEECH_KEEP);
  return entry;
}

/** Who asked a step for its task, for the first line of its bubble: the team lead, the manager or the owner. Null for none. */
export function askedBy(run, step) {
  if (!step || step.review || step.role) return null;
  if (step.by === 'lead') return { by: 'lead', text: step.part };
  // The run's first crew step carries what was asked of the run.
  const first = (run.steps ?? []).find(s => !s.role);
  if (step !== first || run.kind === 'mission') return null;
  const by = ['manager', 'owner-request'].includes(run.origin) ? 'manager' : ['app', 'plan', 'cli'].includes(run.origin) ? 'owner' : null;
  return by ? { by, text: run.title || run.instruction } : null;
}

/** The automatic line of an agent at work, from what it is doing now (doingNow in src/runs.mjs). */
export const autoLine = (doing, lang) => (doing ? t("I'm {doing}.", { doing }, lang) : t("I'm at work.", {}, lang));

/**
 * What the bubble of a run going on shows now: { step, agent, text, by, at, auto, state }.
 * live: { step, agent, doing, held, lastAt, since } (held: the step waits for the owner; lastAt: its latest action).
 */
export function speechNow(run, live, nowMs = Date.now(), lang) {
  const { step = null, agent = null, doing = null, held = false } = live ?? {};
  const latest = (run?.speech ?? []).filter(x => x.step === step && x.agent === agent).at(-1) ?? null;
  const quietSince = Date.parse(live?.lastAt ?? live?.since ?? '') || nowMs;
  const state = held ? 'waiting' : step && nowMs - quietSince > STUCK_MINUTES * 60_000 ? 'stuck' : 'working';
  const fresh = latest && nowMs - Date.parse(latest.at) < SPEECH_FRESH_MINUTES * 60_000;
  // A line about waiting stays while the step waits; while it works, a line older than the waiting is passed over.
  if (latest && (held ? latest.state === 'waiting' : fresh && latest.state !== 'waiting')) {
    return { step, agent, text: latest.text, by: latest.by, at: latest.at, auto: latest.by === 'auto', state };
  }
  return { step, agent, text: autoLine(doing, lang), by: 'auto', at: live?.lastAt ?? live?.since ?? null, auto: true, state };
}

/** The app's view of a run's speech: the bubble now (for a run going on) and its latest lines, newest last. */
export function speechView(run, live = null, nowMs = Date.now(), lang) {
  return { now: live ? speechNow(run, live, nowMs, lang) : null, lines: (run?.speech ?? []).slice(-SPEECH_SHOWN) };
}

/** The crew's rule on speaking, for the step's prompt (crewRules in src/runs.mjs). */
export const speechRule = (command, ownerLanguage, owner) => `- Keep ${owner} posted through your speech bubble in the app: \`${command} say "<one short line>"\`, in ${ownerLanguage}, in the first person and plain words, at most ${SPEECH_MAX} characters (for example: "I'm adjusting the Decisions screen; all good so far", "Just finishing the tests; one failed and I'm fixing it", "Stopped: the plan's week hit its limit"). Speak when you start, when you move to another relevant stage, when you hit a problem or change course, when the manager or ${owner} asks you something, and when you finish. No chatter: at most one line every few minutes, and only when there is something new. When you say nothing, Chiefmate shows what you are doing, marked as automatic.`;
