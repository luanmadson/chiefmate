// What Chiefmate keeps: runs, account usage, the conversation with the manager, notifications and the schedule state.
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { DATA, ensureDir, now, readJson, RUNS, writeJson } from './util.mjs';

ensureDir(RUNS);
const USAGE_FILE = path.join(DATA, 'usage.json');
const STATE_FILE = path.join(DATA, 'state.json');
const CONVERSATION_FILE = path.join(DATA, 'manager', 'conversation.json');
const PENDING_FILE = path.join(DATA, 'manager', 'pending.json');
const NOTIFICATIONS_FILE = path.join(DATA, 'notifications.json');

// ---------- Runs (missions and tasks) ----------

export const runFile = id => path.join(RUNS, `${id}.json`);
export const runDir = id => ensureDir(path.join(RUNS, id));
export const runEnded = run => ['done', 'failed', 'canceled'].includes(run.status);

function closeRunRequests(run) {
  if (run && runEnded(run)) {
    for (const request of run.requests ?? []) {
      if (request.status === 'open') Object.assign(request, { status: 'closed', closed: run.ended ?? run.updated ?? null });
    }
  }
  return run;
}

// Older runs can have open requests on disk. Normalize them on read, including before a resume.
export const readRun = id => closeRunRequests(readJson(runFile(id), null));

// Called after every save of a run (the planning board follows the runs its items are linked to).
const runListeners = [];
export const onRunSaved = listener => runListeners.push(listener);

export function saveRun(run) {
  run.updated = now();
  closeRunRequests(run);
  writeJson(runFile(run.id), run);
  for (const listener of runListeners) {
    try {
      listener(run);
    } catch (error) {
      console.error('After saving a run:', error.message);
    }
  }
  return run;
}

/** Records a merge or closure observed outside Chiefmate using the latest run on disk. */
export function settleRunOutside(listed, reason, url) {
  const run = listed && readRun(listed.id);
  if (!run || run.status !== 'done' || run.merged || run.discarded) return run;
  const local = reason === 'branch' || reason === 'deleted';
  if (local ? !run.branch || run.branch !== listed.branch || (reason === 'deleted' && run.pullRequest) : run.pullRequest !== url) return null;
  const discarded = reason === 'closed' || reason === 'deleted';
  run[discarded ? 'discarded' : 'merged'] = { at: now(), by: 'outside', how: local ? 'local' : 'pr' };
  return saveRun(run);
}

export function listRuns() {
  return readdirSync(RUNS)
    .filter(f => f.endsWith('.json'))
    .map(f => readRun(f.slice(0, -5)))
    .filter(Boolean)
    .sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''));
}

/** The steps of a run, with the final review last. */
export const stepsOf = run => [...(run.steps ?? []), ...(run.review ? [run.review] : [])];

// ---------- Account usage (the plan's 5-hour and 7-day windows) ----------

export const readUsage = () => readJson(USAGE_FILE, {});

/** Keeps what Claude Code reports in the rate_limit_event of every run. */
export function recordUsage(info) {
  const windows = info?.unifiedWindows ?? {};
  const window = w => w && { used: w.utilization, resets: w.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : null, status: w.status };
  writeJson(USAGE_FILE, {
    updated: now(),
    status: info?.status,
    five_hour: window(windows.five_hour),
    seven_day: window(windows.seven_day),
    overage: info?.isUsingOverage ?? false,
  });
}

// ---------- State (schedule, reminders already sent, the manager's session) ----------

export const readState = () => readJson(STATE_FILE, { schedule: {}, reminders_sent: {}, manager: {} });
export const saveState = state => writeJson(STATE_FILE, state);

// ---------- The owner's decisions on record (data/manager/decision-log.json) ----------
// Every decision from a card, a request or the board: who, when, from where, from what to what, and what undoing it
// needs ("undo"; none when it can't be undone, "final"). The undoing itself is in src/decisions.mjs (undoDecision).

const DECISION_LOG_FILE = path.join(DATA, 'manager', 'decision-log.json');
const DECISION_LOG_MAX = 300;
export const readDecisionLog = () => readJson(DECISION_LOG_FILE, []);
export const saveDecisionLog = list => writeJson(DECISION_LOG_FILE, list.slice(-DECISION_LOG_MAX));

/**
 * Records a decision: { kind (seen, plan, question, push, repo, request, merge), ref, label, title, from, to, answer,
 * by (owner, manager, autopilot), via (app, remote, cli), undo (what reverses it) or final, news (the ref of its news) }.
 */
export function recordDecision({ kind, ref, label = '', title = '', from = '', to = '', answer = null, by = 'owner', via = 'app', undo = null, news = null, undoes = null }) {
  ensureDir(path.dirname(DECISION_LOG_FILE));
  const list = readDecisionLog();
  const entry = {
    id: `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, at: now(), kind, ref: String(ref ?? ''),
    label: String(label).slice(0, 160), title: String(title).slice(0, 240), from, to, by, via,
    ...(answer ? { answer: String(answer).slice(0, 300) } : {}), ...(undo ? { undo } : { final: true }), ...(news ? { news } : {}), ...(undoes ? { undoes } : {}),
  };
  saveDecisionLog([...list, entry]);
  return entry;
}

// ---------- The conversation with the manager ----------

export const readConversation = () => readJson(CONVERSATION_FILE, []);

/** who: "you", "manager" or "system". */
export function addMessage(who, text, extra = {}) {
  const conversation = readConversation();
  conversation.push({ who, text, at: now(), ...extra });
  writeJson(CONVERSATION_FILE, conversation.slice(-400));
}

/** The messages waiting for the manager to finish its answer: [{ id, text, at, queued, edited }], oldest first. */
export const readPending = () => readJson(PENDING_FILE, []);
export const savePending = list => writeJson(PENDING_FILE, list);

// ---------- Notifications sent to Windows ----------

export const readNotifications = () => readJson(NOTIFICATIONS_FILE, []);

export function recordNotification(title, text, level = null) {
  const list = readNotifications();
  list.push({ title, text, at: now(), ...(level ? { level } : {}) });
  writeJson(NOTIFICATIONS_FILE, list.slice(-100));
}
