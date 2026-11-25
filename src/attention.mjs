// What needs the owner, in three levels, for the whole app: urgent (act now), important (decide soon) and info
// (good to know). A notice fades when marked as seen and goes to the archive when it no longer needs the owner: its
// cause ended, its pull request was merged or closed (or its branch merged in the owner's clone), or, for an info
// notice, once seen or a day old. Nothing is lost: the archive keeps the last ARCHIVE_MAX. In data/state.json: the
// seen marks ("attention_seen"), the notices shown last time ("attention_shown") and the archive ("attention_archive").
import { formatDateTime, formatPercent, t } from './i18n.mjs';
import { RAM_LOW, availableResets, current } from './plan.mjs';
import { readState, saveState } from './store.mjs';
import { readerSettings, readerStatus } from './usagepage.mjs';
import { ROOT } from './util.mjs';
import { baseBranch, run as exec } from './workspace.mjs';

export const LEVELS = ['urgent', 'important', 'info'];
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const FAILED_FOR = 3 * DAY; // a failed run asks for attention for 3 days...
const PR_FOR = 7 * DAY; // ...a pull request for a week...
const DONE_FOR = DAY; // ...a finished task and an installed update for a day
const ARCHIVE_MAX = 500;
const CHECK_EVERY = 5 * 60_000; // a pull request's state on GitHub is asked at most every 5 minutes
const WINDOWS = [
  ['five_hour', () => t('The 5-hour window')],
  ['seven_day', () => t("The plan's week")],
];

const ago = (iso, span) => iso && Date.now() - Date.parse(iso) <= span;

/**
 * The notices now, most urgent first: { id, level, kind, title, text, view, project, run, at, seen, seenable }.
 * "view" is the app's place that deals with it; a request of a step carries what "Mark as done" needs.
 */
export function attentionItems({ config, runs = [], needs = [], usage = {}, machine, items = [], update = {} }) {
  const list = [];
  const add = item => list.push({ project: null, run: null, at: null, seenable: true, ...item });

  // Urgent: a step or a live session waits for the owner (a session's permission asked included).
  for (const n of needs) {
    add({
      id: `needs:${n.run ?? n.session}:${n.id}`, level: 'urgent', kind: 'needs', title: n.kind === 'permission' ? t('Asks your permission') : t('Needs you'),
      text: t('{task}: {what}', { task: n.title, what: n.what }), view: 'operations', project: n.project ?? null, run: n.run ?? null, at: n.at, seenable: false,
      request: { id: n.id, kind: n.kind ?? null, run: n.run ?? null, session: n.session ?? null, url: n.url ?? null, openError: n.openError ?? null, agent: n.agent ?? null },
    });
  }
  // Urgent: a run failed (until a newer run of the same work starts, or 3 days go by).
  for (const r of runs) {
    if (r.status !== 'failed' || !ago(r.ended ?? r.created, FAILED_FOR)) continue;
    const redone = runs.some(x => x !== r && x.created > r.created && x.project === r.project && (x.mission ? x.mission === r.mission : x.title === r.title));
    if (redone) continue;
    add({ id: `failed:${r.id}`, level: 'urgent', kind: 'failed', title: t('Run failed'), text: t('{title}: {error}', { title: r.title, error: String(r.result ?? '').slice(0, 180) || '—' }), view: 'log', project: r.project, run: r.id, at: r.ended ?? r.created });
  }
  // The account: urgent from 90%, important from 70%.
  for (const [key, name] of WINDOWS) {
    const w = usage[key];
    if (!current(w) || w.used < 0.7) continue;
    const step = w.used >= 0.9 ? 0.9 : 0.7;
    add({
      id: `usage:${key}:${w.resets ?? ''}:${step}`, level: step === 0.9 ? 'urgent' : 'important', kind: 'usage', title: t('Account usage at {percent}', { percent: formatPercent(w.used) }),
      text: t('{window} of your account is at {percent}.', { window: name(), percent: formatPercent(w.used) }) + (w.resets ? ` ${t('It resets {when}.', { when: formatDateTime(w.resets) })}` : ''),
      view: 'usage', at: usage.updated ?? null,
    });
  }
  // Urgent: this computer is low on memory.
  if (machine?.memory?.total && machine.memory.free / machine.memory.total < RAM_LOW) {
    const top = (machine.projects ?? []).filter(p => p.ram > 0).slice(0, 3).map(p => p.name);
    add({
      id: 'memory:low', level: 'urgent', kind: 'memory', title: t('Low memory on this computer'),
      text: t('Only {percent} of the memory is free.', { percent: formatPercent(machine.memory.free / machine.memory.total) }) + (top.length ? ` ${t('Using the most: {list}.', { list: top.join(', ') })}` : ''),
      view: 'projects',
    });
  }
  // The plan's free resets: urgent when one expires within a day, important within 3 days or when it's time to use one.
  const resets = availableResets(config);
  for (const g of resets) {
    const left = g.expires ? Date.parse(g.expires) - Date.now() : Infinity;
    if (left > 3 * DAY) continue;
    const step = left <= DAY ? '1d' : '3d';
    add({
      id: `reset:${g.expires}:${g.note ?? ''}:${step}`, level: step === '1d' ? 'urgent' : 'important', kind: 'reset', title: t('Free reset expiring'),
      text: t('A free reset of your plan expires {when}, still unused.', { when: formatDateTime(g.expires) }) + (g.note ? ` (${g.note})` : ''), view: 'usage',
    });
  }
  const week = usage.seven_day;
  if (resets.length && current(week) && week.used >= 0.9) {
    add({ id: `reset-suggest:${week.resets ?? ''}`, level: 'important', kind: 'reset', title: t('Free reset available'), text: t('The week is almost used up: a good time to use a free reset.'), view: 'usage' });
  }
  // Important: the reading of the account's usage page fails (the usage shown may be stale).
  const reader = readerStatus();
  if (readerSettings(config).enabled && reader.error) {
    add({ id: `reader:${reader.error}`, level: 'important', kind: 'reader', title: t('Usage reading failed'), text: t('Reading claude.ai: {problem}', { problem: reader.error }), view: 'usage' });
  }
  // Important: the board's items waiting for the owner: a pull request to approve, an item waiting for their action,
  // or a crew proposal the manager triaged ("decision": the Planning view decides it in its Decide block).
  const waiting = items.filter(i => !i.archived && i.status === 'waiting_owner');
  for (const i of waiting) {
    add({
      id: `plan:${i.id}:${i.pr ?? ''}`, level: 'important', kind: i.pr ? 'pr' : 'proposal', title: i.pr ? t('Pull request waiting for your approval') : t('Waiting for your action'),
      text: `#${i.id} ${i.title}`, view: 'planning', project: i.project || null, at: i.updated ?? null, url: i.pr ?? null,
    });
  }
  for (const i of items.filter(i => !i.archived && i.status === 'triaged')) {
    add({
      id: `decide:${i.id}`, level: 'important', kind: 'decision', title: t('Waiting for your decision'),
      text: `#${i.id} ${i.title}`, view: 'planning', project: i.project || null, at: i.triaged_at ?? i.updated ?? null,
    });
  }
  // Important: a pull request of the last week not on the board.
  const onBoard = new Set(waiting.map(i => i.pr).filter(Boolean));
  for (const r of runs) {
    if (r.status !== 'done' || !r.pullRequest || r.merged || onBoard.has(r.pullRequest) || !ago(r.ended, PR_FOR)) continue;
    add({ id: `pr:${r.id}`, level: 'important', kind: 'pr', title: t('Pull request waiting for your approval'), text: r.title, view: 'log', project: r.project, run: r.id, at: r.ended, url: r.pullRequest });
  }
  // Important: an approved update that could not be installed.
  if (update.waiting && update.blocked) {
    add({ id: `update:${update.blocked}`, level: 'important', kind: 'update', title: t('Update blocked'), text: t('An approved update of Chiefmate was not installed. See why under the manager.'), view: 'manager' });
  }
  // Info: a task finished in the last day (without a pull request: that one is above), an update installed.
  for (const r of runs) {
    if (r.status !== 'done' || r.pullRequest || !ago(r.ended, DONE_FOR)) continue;
    add({ id: `done:${r.id}`, level: 'info', kind: 'done', title: t('Task finished'), text: r.title, view: 'log', project: r.project, run: r.id, at: r.ended });
  }
  const state = readState();
  const installed = state.last_update;
  if (installed && ago(installed.at, DONE_FOR)) {
    add({ id: `updated:${installed.at}`, level: 'info', kind: 'updated', title: t('Update installed'), text: installed.changes?.length ? installed.changes.join('; ') : t('The improvements you approved are installed.'), view: 'manager', at: installed.at });
  }

  // The archive: what no longer needs the owner leaves the list. A seen notice fades; the marks of notices gone are forgotten.
  const seen = state.attention_seen ?? {};
  const shown = state.attention_shown ?? {};
  const archive = { ...(state.attention_archive ?? {}) };
  const ids = new Set(list.map(i => i.id));
  let changed = false;
  const toArchive = (i, reason) => {
    archive[i.id] = { ...compact(i), archived: new Date().toISOString(), reason };
    changed = true;
  };
  const active = [];
  for (const i of list) {
    const kept = archive[i.id];
    if (kept?.reason === 'resolved') {
      // Archived because its cause ended, and back: it needs the owner again.
      delete archive[i.id];
      changed = true;
    } else if (kept) continue;
    const settled = resolution(i, runs, items);
    if (settled) toArchive(i, settled);
    else if (i.level === 'info' && (seen[i.id] || (i.at && !ago(i.at, DONE_FOR)))) toArchive(i, seen[i.id] ? 'seen' : 'expired');
    else active.push(i);
  }
  // Shown last time and gone now: its cause ended (for an info notice, its day).
  for (const [id, i] of Object.entries(shown)) if (!ids.has(id) && !archive[id]) toArchive(i, i.level === 'info' ? 'expired' : 'resolved');
  const keptSeen = Object.fromEntries(Object.entries(seen).filter(([id]) => ids.has(id) && !archive[id]));
  const nowShown = Object.fromEntries(active.map(i => [i.id, compact(i)]));
  if (changed || Object.keys(keptSeen).length !== Object.keys(seen).length || !sameKeys(nowShown, shown)) {
    const newest = Object.values(archive).sort((a, b) => b.archived.localeCompare(a.archived)).slice(0, ARCHIVE_MAX);
    saveState({ ...readState(), attention_seen: keptSeen, attention_shown: nowShown, attention_archive: Object.fromEntries(newest.map(i => [i.id, i])) });
  }
  if (!process.env.CHIEFMATE_SMOKE) checkLater(pullRequestTargets(active, runs, items), config);
  const rank = i => LEVELS.indexOf(i.level);
  return active
    .map(i => ({ ...i, seen: !!keptSeen[i.id] && i.seenable }))
    .sort((a, b) => a.seen - b.seen || rank(a) - rank(b) || String(b.at ?? '').localeCompare(String(a.at ?? '')));
}

const compact = ({ id, level, kind, title, text, view, project, run, url, at }) => ({ id, level, kind, title, text, view, project, run, url: url ?? null, at });
const sameKeys = (a, b) => Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => k in b);

/** The archive, the most recently archived first: { id, level, kind, title, text, ..., archived, reason }. */
export function attentionArchive() {
  return Object.values(readState().attention_archive ?? {}).sort((a, b) => String(b.archived).localeCompare(String(a.archived)));
}

// ---------- The pull requests and branches already merged ----------
// Asked in the background (gh and git), at most every CHECK_EVERY, and kept in memory: "merged" and "closed" are final.

const prStates = new Map(); // url -> { state: 'open' | 'merged' | 'closed' | null, checked }
const branchStates = new Map(); // "project branch" -> { merged, checked }
let checking = null;
let lastCheck = 0;

const branchKey = r => `${r.project} ${r.branch}`;
const final = state => state === 'merged' || state === 'closed';

/** The run behind a pull request or board notice ("pr:<run>", or "plan:<n>:<url>" with the item's run). */
function noticeRun(i, runs, items) {
  if (i.id.startsWith('pr:')) return runs.find(r => r.id === i.run) ?? null;
  if (!i.id.startsWith('plan:')) return null;
  const item = items.find(x => i.id.startsWith(`plan:${x.id}:`));
  return item?.run ? (runs.find(r => r.id === item.run) ?? null) : null;
}

/** Why a pull request or board notice no longer needs the owner, from what was checked: "merged", "closed" or "branch". */
function resolution(i, runs, items) {
  if (!i.id.startsWith('pr:') && !i.id.startsWith('plan:')) return null;
  const state = i.url ? prStates.get(i.url)?.state : null;
  if (final(state)) return state;
  const r = noticeRun(i, runs, items);
  return r?.branch && branchStates.get(branchKey(r))?.merged ? 'branch' : null;
}

/** What to check for the notices shown: the pull requests' addresses and the runs whose branch may be merged. */
export function pullRequestTargets(list, runs, items) {
  return list
    .filter(i => i.id.startsWith('pr:') || i.id.startsWith('plan:'))
    .map(i => ({ url: i.url ?? null, run: noticeRun(i, runs, items) }))
    .filter(x => x.url || x.run?.branch);
}

function checkLater(targets, config) {
  if (!targets.length || checking || Date.now() - lastCheck < CHECK_EVERY) return;
  checking = checkPullRequests(targets, config)
    .catch(error => console.error('Pull requests:', error.message))
    .finally(() => (checking = null));
}

/** A pull request's state on GitHub ("open", "merged", "closed"), or null when gh can't tell. */
async function ghState(url) {
  const r = await exec('gh', ['pr', 'view', url, '--json', 'state', '-q', '.state'], ROOT, { maxMinutes: 1 });
  // stdout and stderr come together: gh may add an upgrade notice after the state.
  const state = r.code === 0 ? (r.output.trim().split(/\s+/)[0] ?? '').toLowerCase() : '';
  return ['open', 'merged', 'closed'].includes(state) ? state : null;
}

/** Whether the run's branch is already in the base branch of the owner's clone (null when there is no way to tell). */
async function branchMerged(run, config) {
  const project = config?.projects?.[run.project];
  if (!project?.local_clone || !run.branch) return null;
  const git = (...args) => exec('git', args, project.local_clone, { maxMinutes: 1 });
  const base = await baseBranch(project).catch(() => null);
  if (!base) return null;
  for (const ref of [run.branch, `origin/${run.branch}`]) {
    if ((await git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`)).code !== 0) continue;
    for (const into of [base, `origin/${base}`]) if ((await git('merge-base', '--is-ancestor', ref, into)).code === 0) return true;
    return false;
  }
  return null;
}

/**
 * Checks the pull requests and branches of the notices ("targets": { url, run }), one at a time, skipping what is
 * final or was checked in the last CHECK_EVERY. "ask" stands in for gh and git in the tests.
 */
export async function checkPullRequests(targets, config, ask = { pr: ghState, branch: branchMerged }) {
  lastCheck = Date.now();
  const fresh = entry => entry && (final(entry.state) || entry.merged || Date.now() - entry.checked < CHECK_EVERY);
  for (const { url, run } of targets) {
    if (url && !fresh(prStates.get(url))) prStates.set(url, { state: await ask.pr(url), checked: Date.now() });
    if (final(url ? prStates.get(url)?.state : null) || !run?.branch) continue;
    const key = branchKey(run);
    if (!fresh(branchStates.get(key))) branchStates.set(key, { merged: (await ask.branch(run, config)) === true, checked: Date.now() });
  }
}

/** The summary the app draws first: how many of each level are not seen yet, and the highest of them. */
export function attentionSummary(items) {
  const counts = Object.fromEntries(LEVELS.map(l => [l, items.filter(i => i.level === l && !i.seen).length]));
  return { counts, top: LEVELS.find(l => counts[l]) ?? null };
}

/** Marks notices as seen ("ids"), or every notice that can be ("all" with the current list). */
export function markSeen(ids) {
  const state = readState();
  const seen = (state.attention_seen ??= {});
  for (const id of ids ?? []) if (typeof id === 'string' && id) seen[id] = new Date().toISOString();
  saveState(state);
  return Object.keys(seen).length;
}
