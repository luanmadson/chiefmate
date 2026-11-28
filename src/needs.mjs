// When a step needs the owner: signing in somewhere, confirming something, doing what only a person can do.
// The agent runs "node <chiefmate>/src/cli.mjs needs-you "<what to do>" [--url <address>] [--wait]". Chiefmate records
// the request in the run, shows it in the app (a band at the top, the window's icon and title) and in a Windows
// notification, and opens the address in the owner's browser. With --wait, the command returns when the owner clicks
// "I did it" (or a check the agent gave succeeds), or answers it from the agent's panel (the command hands the answer
// over). A question (--options "A|B", --recommend, --why) always waits, with one button per option and a field where
// the owner writes an explanation with the option, or an answer of their own instead. While it waits,
// the step's time limit stands still. The wait ends without an answer (endWait) past the longest wait, at once in away
// mode, or when the owner says "Not now" (deferRequest): the command returns, the step goes on with what it can and
// the request stays open. Any open request closes when the run ends. The owner's click to a step waiting on it reaches
// the step after the undo window (UNDO_GRACE_MS, src/store.mjs), and the owner can take it back until then (undoDecision
// in src/decisions.mjs); so can a "Not now", while the call is open.
// The manager handles the open calls too ("cli.mjs calls"): it marks one done on the owner's own words in its
// conversation (confirmByOwnerWords), and parks a run that waits for the owner (parkRun), freeing its project's turn
// for the next run in the queue; a parked run resumes first once the owner answers. In away mode, a call that still
// holds its step parks its run by itself (parkWaitingWhileAway). The on-call outside the app (callOnDuty) is off.
import { randomUUID } from 'node:crypto';
import { loadConfig, saveConfig } from './config.mjs';
import { t } from './i18n.mjs';
import { reportEvent } from './news.mjs';
import { notify } from './notify.mjs';
import { activeRun, liveOf, liveRuns, noteLive, pauseLive } from './runs.mjs';
import { listRuns, readRun, readState, recordDecision, runEnded, saveRun, stepsOf, UNDO_GRACE_MS } from './store.mjs';
import { addSpeech } from './speech.mjs';
import { agentSays } from './talk.mjs';
import { openOwnerPage } from './usagepage.mjs';
import { clip, now } from './util.mjs';

const OPTIONS_MAX = 6; // as the manager's questions (src/decisions.mjs)

/** The longest a step waits for the owner, in minutes, unless "max_wait_minutes" says otherwise. */
export const WAIT_MINUTES = 30;
/** The waits the app offers, in minutes. */
export const WAIT_CHOICES = [5, 10, 15, 30, 60, 120];

/**
 * "needs_you": { "max_wait_minutes": 30, "park_after_minutes": 15, "on_call": false }: the longest a step waits for
 * you while you are here (in away mode it doesn't wait); in away mode, how long a call that still holds its step waits
 * before its run is parked (0: never); the on-call outside the app (callOnDuty), off.
 */
export function needsSettings(config = loadConfig()) {
  const park = Number(config.needs_you?.park_after_minutes ?? 15);
  return {
    maxWaitMinutes: Math.max(1, Number(config.needs_you?.max_wait_minutes) || WAIT_MINUTES),
    parkAfterMinutes: Number.isFinite(park) && park >= 0 ? park : 15,
    onCall: config.needs_you?.on_call === true,
  };
}

/** The owner's away mode ({ since }) or null. */
const awayNow = () => readState().away ?? null;

// A run going on lives in memory (its steps save it as they go): requests are written to that same object.
const runFor = id => activeRun(id) ?? readRun(id);

/**
 * Opens an address for the owner, without touching the tabs already open:
 * with "browser_cdp" (your own browser, signed in, with remote debugging on), in a new tab of it;
 * without it, in a visible Edge or Chrome on the browser's reading profile (which the crew can't read). With the usage
 * reading on, that window has the sign-in window's time limit (src/usagepage.mjs), so it never keeps the reading out for long.
 */
export async function openForOwner(url, config = loadConfig()) {
  if (config.browser_cdp) {
    const base = String(config.browser_cdp).replace(/\/+$/, '');
    const r = await fetch(`${base}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
    if (!r.ok) throw new Error(t("Your browser at {address} didn't open the tab ({status}).", { address: base, status: r.status }));
    return 'browser_cdp';
  }
  openOwnerPage(url, config);
  return 'browser';
}

const same = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

/**
 * A question's options ("A|B" or a list), each once, and the recommended one among them. Without options, the request
 * is an action the owner takes outside the app (answered with "I did it").
 */
function questionOf(options, recommend) {
  const list = (Array.isArray(options) ? options : String(options ?? '').split('|')).map(o => clip(o, 60)).filter(Boolean);
  const choices = list.filter((o, i) => list.findIndex(x => same(x, o)) === i);
  if (!choices.length) return null;
  if (choices.length < 2 || choices.length > OPTIONS_MAX) throw new Error(`Give 2 to ${OPTIONS_MAX} options, separated by "|".`);
  const recommended = recommend ? choices.find(o => same(o, recommend)) : null;
  if (recommend && !recommended) throw new Error(`The recommendation must be one of the options: ${choices.join(', ')}.`);
  return { options: choices, recommend: recommended ?? null };
}

/** Records a request from a step and lets the owner know. Returns the request, with the longest wait. */
export async function askOwner({ run: runId, step, what, url, wait = false, check = null, options = null, recommend = null, why = null }) {
  const text = String(what ?? '').trim();
  if (!text) throw new Error(t('Say what the owner should do.'));
  if (url && !/^https?:\/\//i.test(String(url))) throw new Error(t('The address must start with http:// or https://.'));
  const question = questionOf(options, recommend);
  const run = runId ? runFor(String(runId)) : null;
  if (!run) throw new Error(t('Only a step of a run can ask for you: no run was given.'));
  if (runEnded(run)) throw new Error(t('This run has already ended.'));
  const n = Number(step) || null;
  let request = {
    id: randomUUID().slice(0, 8), step: n, agent: (n && stepsOf(run)[n - 1]?.agent) || liveOf(run.id)?.agent || null, what: clip(text, 500),
    // A question always waits: its answer is what the step needs.
    url: url ? String(url) : null, wait: !!wait || !!question, check: check ? clip(check, 300) : null, status: 'open', at: now(),
    ...(question ? { ...question, why: why ? clip(String(why).trim(), 300) : null } : {}),
  };
  // In away mode, nothing waits: the request stays open and the step goes on with what it can.
  const away = !!awayNow();
  if (request.wait && away) request.waitEnded = { at: request.at, why: 'away' };
  (run.requests ??= []).push(request);
  // The request is also part of the direct conversation: the owner can answer it from the agent's panel.
  agentSays(run, { step: n, agent: request.agent, text: request.what, kind: 'request', request: request.id });
  // And the agent's speech bubble calls the owner while the step waits for them (src/speech.mjs).
  const said = { step: n, agent: request.agent, by: 'auto' };
  addSpeech(run, request.wait && !away
    ? { ...said, state: 'calling', text: t('I need you: {what}', { what: request.what }) }
    : { ...said, text: away ? t("You're away: I left you a request and I'm going on with what I can: {what}", { what: request.what }) : t("I left you a request and I'm going on meanwhile: {what}", { what: request.what }) });
  saveRun(run);
  notify(t('Needs you: {title}', { title: run.title }), request.what, 'chiefmate:operations', { urgent: true });
  const waits = !request.wait ? '. The step goes on meanwhile.'
    : away ? '. The owner is away: the step does not wait for them and goes on with what it can; the request stays open.'
    : request.options ? '. The step waits for the owner to choose in the app.' : '. The step waits until the owner clicks "I did it" in the app.';
  reportEvent('needs_you', `${request.agent ?? 'A step'} in run ${run.id} "${run.title}" (project ${run.project}) needs the owner: ${request.what}${request.options ? ` (options: ${request.options.join(' | ')}${request.recommend ? `; recommends ${request.recommend}` : ''})` : ''}${request.url ? ` (address: ${request.url}, opened in the owner's browser)` : ''}${waits}`);
  if (away) callOnDuty(run, request, 'away');
  if (request.url) {
    const browser = await openForOwner(request.url).then(opened => ({ opened }), error => ({ openError: error.message }));
    // The run can finish while the browser is opening. Save the result on its current record.
    const current = runFor(run.id);
    const saved = current?.requests?.find(r => r.id === request.id);
    if (saved) {
      request = Object.assign(saved, browser);
      saveRun(current);
    }
  }
  return { ...request, run: run.id, maxWaitMinutes: needsSettings().maxWaitMinutes, away };
}

const findRequest = (runId, id) => {
  const run = runFor(String(runId ?? ''));
  const request = run?.requests?.find(r => r.id === id);
  if (!request) throw new Error(t('Request not found.'));
  return { run, request };
};

/** Whether the run is parked (or being parked) on this request. */
const parkedOn = (run, id) => run.parked?.request === id && (liveOf(run.id)?.pauseRequest === 'park' || run.status === 'paused');

/**
 * The waiting command asks every few seconds: while it does, within the longest wait, the step's clock stands still.
 * The wait ends without an answer when the owner said "Not now" ("later"), is away ("away") or the longest wait passed
 * ("timeout"): the command then returns and the step goes on with what it can.
 */
export function pollRequest(runId, id, { away = !!awayNow() } = {}) {
  const { run, request } = findRequest(runId, id);
  const waited = Date.now() - Date.parse(request.at);
  const max = needsSettings().maxWaitMinutes * 60_000;
  const going = liveOf(run.id);
  // An answer clicked in the app waits out its undo window ("undo_until", finishRequest) before the agent gets it: until
  // then it can be taken back, and the step keeps waiting. A message from the agent's panel that answers it goes at once.
  const settling = settlingNow(request);
  const status = settling ? 'open' : request.status;
  const parked = status === 'open' && !settling && parkedOn(run, id);
  const open = status === 'open' && !parked;
  const ended = !open || settling ? null : request.deferred ? 'later' : away ? 'away' : waited >= max ? 'timeout' : null;
  if (ended) endWait(run, request, ended);
  else if (open) {
    // Waiting again (the owner is back, or the step asked to wait once more): the call is a call again.
    if (request.waitEnded && !settling) {
      delete request.waitEnded;
      saveRun(run);
    }
    if (going) going.heldUntil = Date.now() + 20_000;
  }
  // The agent has the answer now: from here, the owner can no longer take it back (requestUndoBlock).
  if (status === 'done') markRead(run, request);
  const given = status === 'done' ? request : {};
  return {
    status, by: given.by ?? null, answer: given.answer ?? null, note: given.note ?? null, ownerSaid: given.ownerSaid ?? null, parked,
    question: !!request.options?.length, waitedMinutes: Math.floor(waited / 60_000), maxWaitMinutes: max / 60_000,
    ended, timedOut: ended === 'timeout', away: ended === 'away', later: ended === 'later',
  };
}

/** Whether the owner's answer is still in its undo window: done, but not handed to the agent yet. */
export const settlingNow = request => request?.status === 'done' && Date.parse(request.undo_until ?? '') > Date.now();

/** The agent has the owner's answer (its waiting command, or the sign-in wait of src/runs.mjs): no longer undone. */
export function markRead(run, request) {
  if (request.read) return;
  request.read = now();
  saveRun(run);
}

/** Records why a step stopped waiting without an answer, once, with a line in its bubble; past the wait, the on-call. */
function endWait(run, request, why) {
  if (request.waitEnded?.why === why) return;
  request.waitEnded = { at: now(), why };
  const text = {
    later: t("You said not now: I'm going on with what I can, and the request stays open for later."),
    away: t("You're away: I left you the request and I'm going on with what I can."),
    timeout: t("No answer in {minutes} min: I'm going on with what I can, and the request stays open.", { minutes: needsSettings().maxWaitMinutes }),
  }[why];
  addSpeech(run, { step: request.step, agent: request.agent, by: 'auto', text });
  saveRun(run);
  if (why !== 'later') callOnDuty(run, request, why);
}

/** A call's decision on record (recordDecision, src/store.mjs): the run, what the step asked and from what. */
const requestRecord = (run, request) => ({ kind: 'request', ref: `${run.id}:${request.id}`, label: run.title ?? run.id, title: request.what, from: 'open' });

/**
 * "Not now": the owner can't see to a call now. It stays open (out of the call bar, among what waits for them), and the
 * step waiting on it stops waiting at its next check and goes on with what it can; a run parked on it goes back to the
 * queue, ahead of its project's other runs, to go on without the answer. On record: undone (reopenRequest), the call is
 * back in the bar, unless its run was parked on it.
 */
export function deferRequest(runId, id, { via = 'app' } = {}) {
  const { run, request } = findRequest(runId, id);
  if (request.status !== 'open' || request.deferred) return request;
  request.deferred = now();
  if (run.parked?.request === request.id && run.status === 'paused' && !liveOf(run.id)) {
    Object.assign(run, { status: 'queued', resumeFirst: true, note: t("You left the call for later: it resumes first in its project's queue, without your answer.") });
  }
  saveRun(run);
  const logged = recordDecision({ ...requestRecord(run, request), to: 'later', via, undo: run.parked?.request === request.id ? null : { run: run.id, request: request.id } });
  return { ...request, logged: logged.final ? null : logged.id };
}

/** Whether the owner's decision on a call can still be taken back: null when it can, else why not. */
export function requestUndoBlock(entry) {
  const run = runFor(String(entry.undo?.run ?? ''));
  const request = run?.requests?.find(r => r.id === entry.undo?.request);
  if (!request) return 'gone';
  if (runEnded(run)) return 'ended';
  if (entry.to === 'later') return request.status === 'open' && request.deferred ? null : 'changed';
  if (request.status !== 'done') return 'changed';
  return request.read ? 'read' : null;
}

/**
 * Takes the owner's decision on a call back: an answer the agent has not read yet (the request is open again, the
 * answer out of the talk), or a "Not now" (the call is back in the bar; a step that already went on stays on its way).
 */
export function reopenRequest(entry) {
  const why = requestUndoBlock(entry);
  if (why) throw new Error(why === 'read' ? t('The agent already read your answer: it can no longer be changed.') : t('This decision can no longer be undone.'));
  const { run, request } = findRequest(entry.undo.run, entry.undo.request);
  if (entry.to === 'later') delete request.deferred;
  else {
    for (const key of ['done', 'by', 'answer', 'note', 'undo_until']) delete request[key];
    request.status = 'open';
    run.talk = (run.talk ?? []).filter(m => !(m.via === 'request' && m.request === request.id));
  }
  saveRun(run);
  return request;
}

/**
 * "I did it": the owner did it (or the agent's check succeeded); for a question, the option the owner chose and/or
 * what they wrote ("note": an explanation with the option, an answer of their own instead of one, or their answer to
 * a request to act, written in the call bar). The owner's click to a step still waiting on it reaches the step after
 * the undo window (UNDO_GRACE_MS, pollRequest) and can be taken back until then (reopenRequest); anywhere else it goes at once.
 */
export function finishRequest(runId, id, by = 'owner', answer = null, note = null, { ownerSaid = null, via = 'app' } = {}) {
  const { run, request } = findRequest(runId, id);
  const given = answer == null || String(answer).trim() === '' ? null : answer;
  const choice = given == null ? null : request.options?.find(o => same(o, given));
  if (given != null && !choice) throw new Error(t('Answer with one of the options.'));
  if (request.status !== 'open') return request;
  const written = by === 'owner' ? clip(String(note ?? '').trim(), 2000) : '';
  Object.assign(request, { status: 'done', done: now(), by }, choice ? { answer: choice } : {}, written ? { note: written } : {}, ownerSaid ? { ownerSaid } : {});
  // A step still at work that no longer waits on the request (it never waited, or its wait ended) hears the answer at
  // its next safe point, as a message from the owner (src/talk.mjs); a run parked on it hears it as it resumes (pauseAbout).
  const l = liveOf(run.id);
  const late = by !== 'check' && !!l?.talking && l.step === request.step && (!request.wait || !!request.waitEnded) && run.parked?.request !== request.id;
  // A step still waiting on it gets the owner's click once the undo window is over; delivered late or to a parked run, at once.
  const waiting = by === 'owner' && !late && request.wait && !request.waitEnded && !request.deferred && run.parked?.request !== request.id;
  if (waiting) request.undo_until = new Date(Date.now() + UNDO_GRACE_MS).toISOString();
  // The owner's answer stays in the run's conversation (the agent's panel, the step's report, the manager).
  if (choice || written || ownerSaid || late) {
    const said = ownerSaid ? t('Told the manager in the conversation: "{words}"', { words: ownerSaid }) : [choice, written].filter(Boolean).join(' — ');
    const text = late ? t('About your request "{what}": {answer}', { what: clip(request.what, 200), answer: said || t('I did it') }) : said;
    (run.talk ??= []).push({
      id: randomUUID().slice(0, 8), at: now(), who: 'owner', step: request.step, agent: request.agent, text, via: ownerSaid ? 'manager' : 'request', request: request.id,
      ...(late ? { status: 'pending' } : { status: 'delivered', delivered: now() }),
    });
    if (late) l.process?.interrupt?.();
  }
  if (ownerSaid) noteLive(run.id, t('The manager marked "{what}" done on your word in the conversation: "{words}"', { what: clip(request.what, 120), words: ownerSaid }));
  // Parked on this request: back to the queue, ahead of the project's other runs.
  if (run.parked?.request === request.id && run.status === 'paused' && !liveOf(run.id)) {
    Object.assign(run, { status: 'queued', resumeFirst: true, note: t("You answered: it resumes first in its project's queue.") });
  }
  saveRun(run);
  if (by === 'check') return request;
  // On record, the owner's and the manager's on the owner's word; only an answer still in its window can be undone.
  const logged = recordDecision({
    ...requestRecord(run, request), to: choice || written || ownerSaid ? 'answered' : 'done', answer: [choice, written, ownerSaid].filter(Boolean).join(' — ') || null,
    by, via: by === 'manager' ? 'cli' : via, undo: waiting ? { run: run.id, request: request.id } : null,
  });
  return { ...request, logged: logged.final ? null : logged.id };
}

// ---------- The manager's handling of the calls ----------

// The owner's words are looked for in their messages to the manager of the last day.
const WORDS_HOURS = 24;
const plain = text => String(text ?? '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ')
  .replace(/^[\s"'\u201c\u201d\u2018\u2019\u00ab\u00bb]+|[\s"'\u201c\u201d\u2018\u2019\u00ab\u00bb.!?\u2026]+$/g, '');

/**
 * The owner's message (of the last day) where the words the manager quotes appear, or null.
 * conversation: [{ who, text, at }] as kept by src/store.mjs ("you" is the owner).
 */
export function ownerWordsFound(words, conversation, at = Date.now()) {
  const wanted = plain(words);
  if (wanted.length < 2) return null;
  const since = at - WORDS_HOURS * 3_600_000;
  return [...conversation].reverse().find(m => m.who === 'you' && Date.parse(m.at) >= since && plain(m.text).includes(wanted)) ?? null;
}

/**
 * The manager marks a call done on the owner's word in its conversation ("calls done <run> <id> --owner-said"): only
 * while the manager is answering, never for a step, and only with words the owner actually wrote to it. Recorded in the
 * request, the step's log and the run's conversation.
 */
export function confirmByOwnerWords(runId, id, words, { conversation = [], answering = false } = {}) {
  if (!answering) throw new Error(t("Only the manager, while it answers the owner, marks a call done on the owner's word."));
  const said = clip(String(words ?? '').trim(), 500);
  if (!said) throw new Error(t("Give the owner's own words with --owner-said."));
  const { run, request } = findRequest(runId, id);
  if (request.status !== 'open') throw new Error(t('This call is no longer open.'));
  if (!ownerWordsFound(said, conversation)) throw new Error(t("These words are not in the owner's messages to you of the last day: quote them as the owner wrote them."));
  return { run: run.id, ...finishRequest(run.id, request.id, 'manager', null, null, { ownerSaid: said }) };
}

/**
 * Parks a run that waits for the owner: its step pauses at a safe point (its work committed on its branch), the run
 * leaves the queue's turn to the project's next run, and it resumes first once the request is answered. by: "manager",
 * "owner" or "away" (the away mode's own). request: the call it waits on (the latest open one that waits, by default).
 */
export function parkRun(runId, { by = 'manager', request: requestId = null } = {}) {
  const run = runFor(String(runId ?? ''));
  if (!run) throw new Error(t('Run not found.'));
  if (run.parked && run.status === 'paused') return { run: run.id, request: run.parked.request, parked: run.parked, already: true };
  if (!liveOf(run.id)) throw new Error(t('Only a run going on can be parked.'));
  // A call whose step stopped waiting (away mode, "Not now", the longest wait) holds nothing: its step went on.
  const request = (run.requests ?? []).filter(r => r.status === 'open' && r.wait && !r.waitEnded && !r.deferred && (!requestId || r.id === requestId)).at(-1);
  if (!request) throw new Error(t('This run is not waiting for you: nothing to park.'));
  // Held while the call is open; "Not now" while it parks sends it back to the queue at its safe point.
  const open = () => {
    const r = runFor(run.id)?.requests?.find(x => x.id === request.id);
    return r?.status === 'open' && !r.deferred;
  };
  if (!pauseLive(run.id, 'park', { holdWhile: open })) throw new Error(t('This run is already pausing or stopping.'));
  run.parked = { request: request.id, at: now(), by };
  request.parked = now();
  saveRun(run);
  if (by !== 'manager') reportEvent('run_parked', `Run ${run.id} "${run.title}" (project ${run.project}) was parked${by === 'away' ? ' by away mode' : ' by the owner'}: it waited for the owner (${request.what}). Its project's next run takes the turn; it resumes first once the owner answers.`);
  return { run: run.id, request: request.id, parked: run.parked };
}

let lastAwayCheck = 0;

/**
 * In away mode, the runs whose call has held its step past "park_after_minutes" are parked, so their projects' queues
 * go on. A step that stopped waiting (away mode, "Not now", the longest wait) went on: it is never parked here.
 * Checked at most once a minute (force: now). Returns the runs parked.
 */
export function parkWaitingWhileAway({ away = readState().away, settings = needsSettings(), at = Date.now(), force = false } = {}) {
  if (!away || !settings.parkAfterMinutes) return [];
  if (!force && at - lastAwayCheck < 60_000) return [];
  lastAwayCheck = at;
  const parked = [];
  for (const l of liveRuns()) {
    const run = activeRun(l.run);
    if (!run || l.pauseRequest || l.cancelRequest) continue;
    const old = (run.requests ?? []).filter(r => r.status === 'open' && r.wait && !r.waitEnded && !r.deferred && at - Date.parse(r.at) >= settings.parkAfterMinutes * 60_000).at(-1);
    if (!old) continue;
    try {
      parked.push(parkRun(run.id, { by: 'away', request: old.id }));
    } catch (error) {
      console.error('Away mode:', error.message);
    }
  }
  return parked;
}

/** The open calls of the runs not ended, oldest first, with whether each run is parked: for the manager and the summary. */
export function openCalls(runs = listRuns()) {
  return openRequests(runs).filter(r => r.run).reverse();
}

/**
 * Whether a call still holds its step and until when: it asked to wait, nothing ended the wait (away mode, "Not now",
 * the longest wait) and its run is not parked on it. { waiting, until }.
 */
function waitOf(r, { maxWaitMinutes }, { away, parked, at = Date.now() }) {
  if (!r.wait || r.waitEnded || r.deferred || parked) return { waiting: false, until: null };
  const until = Date.parse(r.at) + maxWaitMinutes * 60_000;
  return until > at && !away ? { waiting: true, until: new Date(until).toISOString() } : { waiting: false, until: null };
}

/**
 * The open requests of every run, newest first, for the app: each with its run, whether the run is parked on it and
 * whether it still holds its step (waitOf).
 */
export function openRequests(runs = listRuns(), { settings = needsSettings(), away = !!awayNow() } = {}) {
  const list = [];
  for (const stored of runs) {
    const run = activeRun(stored.id) ?? stored;
    for (const r of run.requests ?? []) {
      if (r.status !== 'open') continue;
      const parked = run.parked?.request === r.id && run.status === 'paused';
      list.push({ ...r, run: run.id, title: run.title, project: run.project, runStatus: run.status, parked, ...waitOf(r, settings, { away, parked }) });
    }
  }
  return list.sort((a, b) => b.at.localeCompare(a.at));
}

// ---------- The on-call: calling the owner outside the app ----------
// An extension point, off. A channel outside the app (the owner's Telegram bot of src/escalation.mjs is the one
// planned) would get the calls the owner can't see in the app: made while they are away, or left without an answer past
// the longest wait. It acts only with "needs_you.on_call": true and a channel plugged in through setOnCall; neither is
// the case yet, so nothing leaves the computer. A channel must call refuseWhileLocked (src/lockdown.mjs) before it sends.

let onCallChannel = null;

/** Plugs in the on-call's channel, fn({ run, title, project, request, why }) (why: "away" or "timeout"); null unplugs it. */
export function setOnCall(fn) {
  onCallChannel = typeof fn === 'function' ? fn : null;
}

/** Hands a call to the on-call, once, when it is on and has a channel. Returns whether it did. */
export function callOnDuty(run, request, why, settings = needsSettings()) {
  if (!settings.onCall || !onCallChannel || request.onDuty) return false;
  request.onDuty = now();
  saveRun(run);
  const [channel, call] = [onCallChannel, { run: run.id, title: run.title, project: run.project, request: { ...request }, why }];
  Promise.resolve().then(() => channel(call)).catch(error => console.error('On-call:', error.message));
  return true;
}

/** The calls' settings, for the app: the longest wait, the waits offered and the on-call (on, and with a channel). */
export function callsView(config = loadConfig()) {
  const settings = needsSettings(config);
  return { maxWaitMinutes: settings.maxWaitMinutes, choices: WAIT_CHOICES, onCall: { enabled: settings.onCall, channel: !!onCallChannel } };
}

/** The owner's change to the longest wait, from the app (1 to 240 minutes). Returns callsView. */
export function setMaxWait(minutes, config = loadConfig()) {
  const value = Number(minutes);
  if (!Number.isInteger(value) || value < 1 || value > 240) throw new Error(t('The wait must be a whole number of minutes, from 1 to 240.'));
  config.needs_you = { ...config.needs_you, max_wait_minutes: value };
  saveConfig(config);
  return callsView(config);
}
