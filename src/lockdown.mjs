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
/** The owner's local key (src/owner.mjs): only the server and the owner's command line read it. */
export const ownerKeyFile = (dir = SECURITY_DIR) => path.join(dir, 'owner-key');

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

/** The lockdown's state: { active, since, by, from, reason, evidence, stopped, warnings, warned, history }. */
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
 * (data/browsers), the owner's local key and those listed in "security.protected_folders" of the settings.
 */
export function protectedFolders(config = loadConfig(), data = DATA) {
  const extra = [config?.security?.protected_folders ?? []].flat().map(x => String(x ?? '').trim()).filter(Boolean);
  return [path.join(data, 'browser-profile'), path.join(data, 'browsers'), ownerKeyFile(path.join(data, 'security')), ...extra.map(p => path.resolve(p))];
}

/**
 * Notes a signal for the detection: { at, kind, detail, who }. Never throws: a signal never gets in the way of the
 * command that raised it. who: 'step', 'manager', 'session', 'app', 'remote' or 'cli'.
 */
export function recordSignal(kind, detail, { who = null, dir, at = new Date().toISOString() } = {}) {
  if (!RULES[kind]) return null;
  const signal = { at, kind, detail: clip(String(detail ?? ''), 300), who };
  try {
    ensureDir(dir ?? SECURITY_DIR);
    appendFileSync(signalsFile(dir), `${JSON.stringify(signal)}\n`);
  } catch {
    return null;
  }
  return signal;
}

function readSignals(dir) {
  const file = signalsFile(dir);
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  if (statSync(file).size > TRIM_AT) writeFileSync(file, `${lines.slice(-KEEP_SIGNALS).join('\n')}\n`);
  return lines.slice(-KEEP_SIGNALS).flatMap(line => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
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
  for (const [k, v] of Object.entries(stopped)) sum[k] = typeof v === 'number' ? (sum[k] ?? 0) + v : v;
  saveLockdown({ ...now, stopped: sum }, dir);
  if (!again) {
    const text = t('Emergency lockdown: {reason}. Everything was stopped; pushes, merges, new repositories, external actions and the remote access are refused until you release it on this computer.', { reason: now.reason });
    try {
      const news = `Chiefmate is in emergency lockdown since ${now.since} (${now.by === 'auto' ? 'engaged by the detection' : `engaged by the ${now.by}`}): ${now.reason}. Everything was stopped. Don't queue or retry anything; tell the owner only what they need to review before releasing it on the computer.`;
      h.tell({ kind: 'lockdown', title: t('Emergency lockdown'), text, news });
    } catch {
      // telling never gets in the way of the lockdown
    }
  }
  return readLockdown(dir);
}

/**
 * Releases the lockdown: only the owner, on this computer (from: 'app' or 'cli'; never 'remote'). The summary of what
 * triggered it goes to the history. Returns the state.
 */
export function release({ by = 'owner', from = 'app' } = {}, { dir, h = hooks } = {}) {
  if (from === 'remote') throw new Error(t('The lockdown is released only on the computer where Chiefmate runs, not through the remote access.'));
  if (by !== 'owner') throw new Error(t('Only the owner releases the lockdown.'));
  const state = readLockdown(dir);
  if (state.active !== true) throw new Error(t('Chiefmate is not locked down.'));
  const at = new Date().toISOString();
  const entry = { since: state.since, until: at, by: state.by, from: state.from, reason: state.reason, evidence: (state.evidence ?? []).length, stopped: state.stopped ?? {}, releasedFrom: from };
  const next = { ...state, active: false, released: at, evidence: [], stopped: {}, history: [...(state.history ?? []), entry].slice(-KEEP_HISTORY) };
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
    warnings: (state.warnings ?? []).filter(w => Date.parse(w.at) > day),
    last: state.history?.at(-1) ?? null,
  };
}
