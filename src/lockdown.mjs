// The emergency lockdown, for the exceptional case: something atypical happens and the owner's data and projects come
// first. Engaged by the owner (the app's red button, "cli.mjs lockdown") or by the automatic detection (checkSignals),
// it stops the runs, the queue, the manager's answer, the live sessions' turns and the crew's browsers at once, and
// refuses pushes, merges, new repositories, external actions and the remote access until the owner releases it, on this
// computer only (never through the remote access, never from a step, the manager or a command with no terminal).
// The state is one file (data/security/lockdown.json), read by every process: the server, the guard's hook and the
// command line. The detection's signals come from those processes too (data/security/signals.jsonl), one line each;
// the server weighs them every few seconds. The detection is conservative: it warns the owner first, and locks at
// once only for what is grave.
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { formatDateTime, t } from './i18n.mjs';
import { clip, DATA, ensureDir, readJson, writeJson } from './util.mjs';

export const SECURITY_DIR = path.join(DATA, 'security');
const lockFile = (dir = SECURITY_DIR) => path.join(dir, 'lockdown.json');
const signalsFile = (dir = SECURITY_DIR) => path.join(dir, 'signals.jsonl');
const createdFile = (dir = SECURITY_DIR) => path.join(dir, 'created.jsonl');
const incidentsFile = (dir = SECURITY_DIR) => path.join(dir, 'incidents.jsonl');

// The signals the detection weighs, with how many within WINDOW_MINUTES warn the owner and how many lock Chiefmate.
export const RULES = {
  // A push, merge, pull request or new repository refused to the crew or the manager.
  publish_refused: { warn: 3, lock: 6 },
  // An agent's command reaching into Chiefmate's protected folders (protectedFolders): grave.
  protected_access: { warn: 1, lock: 1 },
  // A recursive deletion of a whole drive, the home folder or one of its folders, a folder above the agent's own,
  // Chiefmate itself or a protected folder: grave.
  wide_delete: { warn: 1, lock: 1 },
  // A recursive deletion outside the agent's own folder (the system's temporary folder aside), or of all of it.
  mass_delete: { warn: 1, lock: 5 },
  // Requests to the app refused for their address or origin (another website, an unknown host).
  unknown_origin: { warn: 5, lock: 100 },
  // Requests through the remote access without an allowed login.
  login_failed: { warn: 3, lock: 10 },
};
export const WINDOW_MINUTES = 15;
const KEEP_SIGNALS = 1000; // lines kept when the file is trimmed
const TRIM_AT = 512 * 1024;
const KEEP_HISTORY = 20;
const KEEP_NOTES = 20;

/**
 * The lockdown's state: { active, since, by, from, reason, evidence, stopped, notes, sentinel, warnings, warned,
 * history }. notes: the owner's notes on this alarm; sentinel: the emergency watch's review (src/sentinel.mjs).
 */
export const readLockdown = dir => readJson(lockFile(dir), {});
export const isLocked = dir => readLockdown(dir).active === true;
const saveLockdown = (state, dir) => writeJson(lockFile(dir), state);

/** Refuses an action while Chiefmate is locked down. "what" names the action, for the message. */
export function refuseWhileLocked(what, dir) {
  if (!isLocked(dir)) return;
  throw new Error(t('Refused: Chiefmate is in emergency lockdown ({what}). Only the owner can release it, in the app or the command line on this computer.', { what }));
}

/**
 * The folders no agent may reach: the owner's browser profile (data/browser-profile), the crew's browser profiles
 * (data/browsers) and those listed in "security.protected_folders" of the settings.
 */
export function protectedFolders(config = loadConfig(), data = DATA) {
  const extra = [config?.security?.protected_folders ?? []].flat().map(x => String(x ?? '').trim()).filter(Boolean);
  return [path.join(data, 'browser-profile'), path.join(data, 'browsers'), ...extra.map(p => path.resolve(p))];
}

/**
 * Notes a signal for the detection: { at, kind, detail, who, ...facts }. Never throws: a signal never gets in the way of
 * the command that raised it. who: 'step', 'manager', 'session', 'app', 'remote' or 'cli'. facts, for the emergency
 * watch (src/sentinel.mjs): run, step, session (who ran it), cwd, command (the whole command), refused (whether the
 * guard refused it), target (a deletion's folder) and existed (whether that folder existed before the command).
 */
export function recordSignal(kind, detail, { who = null, dir, at = new Date().toISOString(), ...facts } = {}) {
  if (!RULES[kind]) return null;
  const signal = { at, kind, detail: clip(String(detail ?? ''), 300), who };
  for (const key of ['run', 'step', 'session', 'cwd', 'target']) if (facts[key]) signal[key] = clip(String(facts[key]), 300);
  if (facts.command) signal.command = clip(String(facts.command), 1000);
  for (const key of ['refused', 'existed']) if (typeof facts[key] === 'boolean') signal[key] = facts[key];
  try {
    ensureDir(dir ?? SECURITY_DIR);
    appendFileSync(signalsFile(dir), `${JSON.stringify(signal)}\n`);
  } catch {
    return null;
  }
  return signal;
}

/**
 * Notes the folders an agent's command creates outside its own folder ({ at, path, run, step, session, who }), so the
 * emergency watch knows a folder deleted later was the same step's. Never throws.
 */
export function recordCreated(paths, { who = null, run = null, step = null, session = null, dir, at = new Date().toISOString() } = {}) {
  if (!paths?.length) return;
  try {
    ensureDir(dir ?? SECURITY_DIR);
    const file = createdFile(dir);
    appendFileSync(file, paths.map(p => `${JSON.stringify({ at, path: String(p), run, step, session, who })}\n`).join(''));
    if (statSync(file).size > TRIM_AT) writeFileSync(file, `${readLines(file).slice(-KEEP_SIGNALS).join('\n')}\n`);
  } catch {
    // noting never gets in the way of the command
  }
}

const readLines = file => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);
const parseLines = lines => lines.flatMap(line => {
  try {
    return [JSON.parse(line)];
  } catch {
    return [];
  }
});

/** The folders the agents' commands created (see recordCreated), oldest first. */
export const readCreated = dir => parseLines(readLines(createdFile(dir)).slice(-KEEP_SIGNALS));

/** The incidents, oldest first: one line per lockdown released, with its evidence, notes and the watch's review. */
export const readIncidents = dir => parseLines(readLines(incidentsFile(dir)).slice(-200));

function recordIncident(entry, dir) {
  try {
    ensureDir(dir ?? SECURITY_DIR);
    appendFileSync(incidentsFile(dir), `${JSON.stringify(entry)}\n`);
  } catch (error) {
    console.error('Lockdown: the incident was not recorded:', error.message);
  }
}

function readSignals(dir) {
  const file = signalsFile(dir);
  const lines = readLines(file);
  if (lines.length && statSync(file).size > TRIM_AT) writeFileSync(file, `${lines.slice(-KEEP_SIGNALS).join('\n')}\n`);
  return parseLines(lines.slice(-KEEP_SIGNALS));
}

/**
 * What the signals call for, with no side effect: { lock: { kind, count, evidence } | null, warnings: [{ kind, count,
 * evidence }] }. Only the signals of the last WINDOW_MINUTES count, and none from before the last release; a kind
 * already warned within the window is not warned again.
 */
export function weigh(signals, state = {}, at = Date.now()) {
  const lastRelease = Date.parse(state.history?.at(-1)?.until ?? '') || 0;
  const since = Math.max(at - WINDOW_MINUTES * 60_000, lastRelease);
  const byKind = new Map();
  for (const s of signals) {
    const when = Date.parse(s.at);
    if (!RULES[s.kind] || !(when > since) || when > at + 60_000) continue;
    byKind.set(s.kind, [...(byKind.get(s.kind) ?? []), s]);
  }
  let lock = null;
  const warnings = [];
  for (const [kind, list] of byKind) {
    const rule = RULES[kind];
    const evidence = list.slice(-10);
    if (list.length >= rule.lock) {
      if (!lock || RULES[lock.kind].lock > rule.lock) lock = { kind, count: list.length, evidence };
    } else if (list.length >= rule.warn && !(Date.parse(state.warned?.[kind] ?? '') > since)) {
      warnings.push({ kind, count: list.length, evidence });
    }
  }
  return { lock, warnings };
}

/** The signal's kind in plain words, for the owner. */
export const signalName = kind => ({
  publish_refused: t('publications refused to the agents'),
  protected_access: t("an agent reaching into Chiefmate's protected folders"),
  wide_delete: t('an agent deleting a whole drive, a personal folder or Chiefmate'),
  mass_delete: t("an agent deleting folders outside its own"),
  unknown_origin: t('requests to the app from an unknown address or origin'),
  login_failed: t('remote access attempts without an allowed login'),
}[kind] ?? kind);

// What the lockdown does around it, given by the server's start (src/cli.mjs): stopping the work, resuming it after a
// release and telling the owner and the manager (tell: { kind, title, text in the owner's language, news for the
// manager }). The tests and the smoke test give made-up ones, or none.
const hooks = { stopAll: async () => ({}), resume: () => {}, tell: () => {} };
export const setLockdownHooks = h => Object.assign(hooks, h);

/**
 * Engages the lockdown. Written first, so everything refuses from that moment; then the work going on is stopped.
 * by: 'owner' or 'auto'; from: 'app', 'remote', 'cli' or 'detection'. Engaging it again adds the evidence and stops
 * again whatever started meanwhile. Returns the state.
 */
export async function engage({ reason = '', by = 'owner', from = 'app', evidence = [] } = {}, { dir, h = hooks } = {}) {
  const state = readLockdown(dir);
  const again = state.active === true;
  const at = new Date().toISOString();
  saveLockdown({
    ...state,
    active: true,
    since: again ? state.since : at,
    by: again ? state.by : by,
    from: again ? state.from : from,
    reason: again ? state.reason : clip(String(reason ?? '').trim(), 500) || t('Engaged by the owner'),
    evidence: [...(again ? state.evidence ?? [] : []), ...evidence].slice(-30),
    stopped: again ? state.stopped ?? {} : {},
  }, dir);
  let stopped;
  try {
    stopped = (await h.stopAll()) ?? {};
  } catch (error) {
    stopped = { error: clip(error.message, 300) };
  }
  const now = readLockdown(dir);
  const sum = { ...now.stopped };
  // Counts add up; lists (runIds: the runs stopped, which the emergency watch may resume) are joined.
  for (const [k, v] of Object.entries(stopped)) {
    sum[k] = typeof v === 'number' ? (sum[k] ?? 0) + v : Array.isArray(v) ? [...new Set([...(sum[k] ?? []), ...v])] : v;
  }
  saveLockdown({ ...now, stopped: sum }, dir);
  if (!again) {
    const automatic = now.by === 'auto' && now.from === 'detection';
    const text = automatic
      ? t('Emergency lockdown: {reason}. Everything was stopped. The emergency watch is checking whether it is a false alarm; if it is not sure, it stays locked for you.', { reason: now.reason })
      : t('Emergency lockdown: {reason}. Everything was stopped; pushes, merges, new repositories, external actions and the remote access are refused until you release it on this computer.', { reason: now.reason });
    try {
      const news = `Chiefmate is in emergency lockdown since ${now.since} (${now.by === 'auto' ? 'engaged by the detection' : `engaged by the ${now.by}`}): ${now.reason}. Everything was stopped. Don't queue or retry anything; tell the owner only what they need to review before releasing it on the computer.${automatic ? ' The emergency watch (Sentinel) is reviewing it now; you will get its report.' : ''}`;
      h.tell({ kind: 'lockdown', title: t('Emergency lockdown'), text, news });
    } catch {
      // telling never gets in the way of the lockdown
    }
    // The emergency watch (src/sentinel.mjs) reviews what the detection engaged; never what a person engaged.
    if (automatic) Promise.resolve().then(() => h.review?.(readLockdown(dir))).catch(error => console.error('Emergency watch:', error.message));
  }
  return readLockdown(dir);
}

/** The incident's entry for the history and data/security/incidents.jsonl: its whole evidence, notes and review. */
function incidentEntry(state, { until, releasedBy, releasedFrom }) {
  return {
    since: state.since, until, by: state.by, from: state.from, reason: state.reason,
    evidence: state.evidence ?? [], stopped: state.stopped ?? {}, notes: state.notes ?? [], sentinel: state.sentinel ?? null,
    releasedBy, releasedFrom,
  };
}

/**
 * The owner's note on the alarm going on (the field of the lockdown's screen, on this computer or the phone): kept in
 * the alarm's record and handed to the manager as the owner's message, with the event. Only while it is on: when it is
 * over, a note would no longer be about this alarm. Returns the state.
 */
export function addNote(text, { from = 'app' } = {}, { dir, h = hooks } = {}) {
  const note = clip(String(text ?? '').trim(), 2000);
  if (!note) throw new Error(t('Write a note.'));
  const state = readLockdown(dir);
  if (state.active !== true) throw new Error(t('Chiefmate is not locked down.'));
  const entry = { at: new Date().toISOString(), text: note, from: from === 'remote' ? 'remote' : from === 'cli' ? 'cli' : 'app' };
  const next = { ...state, notes: [...(state.notes ?? []), entry].slice(-KEEP_NOTES) };
  saveLockdown(next, dir);
  try {
    h.ownerNote?.(note, next);
  } catch {
    // the note stays in the record
  }
  return next;
}

/**
 * Releases the lockdown: only the owner, on this computer (from: 'app' or 'cli'; never 'remote'). The summary of what
 * triggered it goes to the history. Returns the state.
 */
export function release({ by = 'owner', from = 'app', note = '' } = {}, { dir, h = hooks } = {}) {
  if (from === 'remote') throw new Error(t('The lockdown is released only on the computer where Chiefmate runs, not through the remote access.'));
  if (by !== 'owner') throw new Error(t('Only the owner releases the lockdown.'));
  if (readLockdown(dir).active !== true) throw new Error(t('Chiefmate is not locked down.'));
  // The owner's note that goes with the release: in the record, and to the manager as their message.
  if (String(note ?? '').trim()) addNote(note, { from }, { dir, h });
  const state = readLockdown(dir);
  const at = new Date().toISOString();
  const entry = incidentEntry(state, { until: at, releasedBy: 'owner', releasedFrom: from });
  recordIncident(entry, dir);
  const next = { ...state, active: false, released: at, evidence: [], stopped: {}, notes: [], sentinel: null, history: [...(state.history ?? []), entry].slice(-KEEP_HISTORY) };
  saveLockdown(next, dir);
  try {
    h.resume();
    h.tell({
      kind: 'lockdown', title: t('Lockdown released'),
      text: t('The owner released the emergency lockdown (it began {since}: {reason}). The queue goes on.', { since: formatDateTime(state.since), reason: state.reason }),
      news: `The owner released the emergency lockdown (it began ${state.since}: ${state.reason}). The queue goes on; the runs it stopped stay canceled until resumed.`,
    });
  } catch {
    // the release stands
  }
  return next;
}

/**
 * Keeps the emergency watch's review (src/sentinel.mjs) in the alarm's state, for the app: { status: 'reviewing',
 * 'escalated' or 'released', ... }. Only for the alarm it reviews (since). Returns the state, or null when that alarm
 * is over.
 */
export function saveReview(since, review, dir) {
  const state = readLockdown(dir);
  if (state.active !== true || state.since !== since) return null;
  const next = { ...state, sentinel: review };
  saveLockdown(next, dir);
  return next;
}

/**
 * The emergency watch's release (src/sentinel.mjs), the one exception to the owner's: only the alarm it reviewed
 * (since), engaged by the detection, and only when its review decided so. The app, the command line and the remote
 * access never reach it. The incident is recorded with the review; the queue, the manager and the sessions go on
 * (the runs to resume are the watch's). Returns the state, or null when that alarm is no longer the one on.
 */
export function sentinelRelease(since, review, { dir, h = hooks } = {}) {
  const state = readLockdown(dir);
  if (state.active !== true || state.since !== since || state.by !== 'auto' || state.from !== 'detection' || review?.decision?.release !== true) return null;
  const at = new Date().toISOString();
  const reviewed = { ...state, sentinel: { ...review, status: 'released', at } };
  const entry = incidentEntry(reviewed, { until: at, releasedBy: 'sentinel', releasedFrom: 'sentinel' });
  recordIncident(entry, dir);
  const next = { ...reviewed, active: false, released: at, evidence: [], stopped: {}, notes: [], sentinel: null, history: [...(state.history ?? []), entry].slice(-KEEP_HISTORY) };
  saveLockdown(next, dir);
  try {
    h.resume();
  } catch {
    // the release stands
  }
  return next;
}

/**
 * Weighs the signals and acts: a grave case locks Chiefmate (engage, by 'auto'), the others warn the owner once per
 * window (kept in "warnings" for the app, and told). Returns { locked, warnings }.
 */
export async function checkSignals({ dir, at = Date.now(), h = hooks } = {}) {
  const state = readLockdown(dir);
  const { lock, warnings } = weigh(readSignals(dir), state, at);
  if (warnings.length) {
    const iso = new Date(at).toISOString();
    const warned = { ...state.warned };
    const list = [...(state.warnings ?? [])];
    for (const w of warnings) {
      warned[w.kind] = iso;
      const text = t('{what}: {count} in {minutes} minutes. Last: {detail}', { what: signalName(w.kind), count: w.count, minutes: WINDOW_MINUTES, detail: w.evidence.at(-1)?.detail || '—' });
      list.push({ id: `${w.kind}-${at}`, at: iso, kind: w.kind, count: w.count, text });
      try {
        h.tell({ kind: 'security_warning', title: t('Security warning'), text, news: `Security warning sent to the owner (${w.kind}, ${w.count} in ${WINDOW_MINUTES} minutes; Chiefmate locks itself down only if it goes on): ${w.evidence.at(-1)?.detail ?? ''}` });
      } catch {
        // telling never gets in the way
      }
    }
    saveLockdown({ ...readLockdown(dir), warned, warnings: list.slice(-KEEP_HISTORY) }, dir);
  }
  if (lock && !isLocked(dir)) {
    const reason = t('{what} ({count} in {minutes} minutes)', { what: signalName(lock.kind), count: lock.count, minutes: WINDOW_MINUTES });
    await engage({ reason, by: 'auto', from: 'detection', evidence: lock.evidence }, { dir, h });
    return { locked: true, warnings };
  }
  return { locked: false, warnings };
}

/** The server's watch over the signals: weighed every few seconds, only when the file changed. */
export function startLockdownWatch({ every = 3000 } = {}) {
  let seen = '';
  const look = () => {
    let mark = '';
    try {
      const s = statSync(signalsFile());
      mark = `${s.size}:${s.mtimeMs}`;
    } catch {
      return;
    }
    if (mark === seen) return;
    seen = mark;
    checkSignals().catch(error => console.error('Lockdown:', error.message));
  };
  look();
  return setInterval(look, every);
}

/** What the app shows: the state, with the warnings of the last day. */
export function lockdownView(state = readLockdown()) {
  const day = Date.now() - 24 * 3600_000;
  return {
    active: state.active === true,
    since: state.since ?? null,
    by: state.by ?? null,
    from: state.from ?? null,
    reason: state.reason ?? null,
    evidence: (state.evidence ?? []).slice(-10).map(e => ({ ...e, what: signalName(e.kind) })),
    stopped: state.stopped ?? {},
    notes: state.notes ?? [],
    // The emergency watch's review of this alarm (src/sentinel.mjs): reviewing, or escalated to the owner with why.
    sentinel: state.sentinel ?? null,
    warnings: (state.warnings ?? []).filter(w => Date.parse(w.at) > day),
    last: lastView(state.history?.at(-1)),
  };
}

/** The last alarm, as the app shows it: who released it, and the watch's report when it did. */
function lastView(entry) {
  if (!entry) return null;
  const { evidence, stopped, notes, sentinel, ...rest } = entry;
  return { ...rest, evidence: Array.isArray(evidence) ? evidence.length : evidence ?? 0, notes: notes ?? [], sentinel: sentinel ?? null };
}
