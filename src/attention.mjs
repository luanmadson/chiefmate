// What needs the owner, in three levels, for the whole app: urgent (act now), important (decide soon) and info
// (good to know). A notice fades when marked as seen and goes to the archive when it no longer needs the owner: its
// cause ended, its pull request was merged or closed (or its local branch merged or deleted), or, for an info
// notice, once seen or a day old. Work merged outside Chiefmate marks its run as merged, so its board item is done;
// a pull request closed or a local branch deleted without a known merge sends its item back to the owner's decision.
// Nothing is lost: the archive keeps the last ARCHIVE_MAX. In data/state.json: the seen marks ("attention_seen"), the
// notices shown last time ("attention_shown") and the archive ("attention_archive").
import { formatDateTime, formatPercent, t } from './i18n.mjs';
import { loginWarning } from './claude.mjs';
import { RAM_LOW, availableResets, current, loginText } from './plan.mjs';
import { restoreSteps } from './quarantine.mjs';
import { readState, saveState, settleRunOutside } from './store.mjs';
import { LOGIN_MINUTES, readerSettings, readerStatus, signInNeeded } from './usagepage.mjs';
import { ROOT } from './util.mjs';
import { baseBranch, localBranchState, run as exec } from './workspace.mjs';

export const LEVELS = ['urgent', 'important', 'info'];
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const FAILED_FOR = 3 * DAY; // a failed run asks for attention for 3 days...
const PR_FOR = 7 * DAY; // ...a pull request for a week...
const DONE_FOR = DAY; // ...a finished task and an installed update for a day
export const STALE_AFTER = 12 * HOUR; // a delivery with no merge or discard by then is stalled...
const STALE_FOR = 30 * DAY; // ...and stays so for a month at most
const ARCHIVE_MAX = 500;
const CHECK_EVERY = 5 * 60_000; // a pull request's state on GitHub is asked at most every 5 minutes
const WINDOWS = [
  ['five_hour', () => t('The 5-hour window')],
  ['seven_day', () => t("The plan's week")],
];

const ago = (iso, span) => iso && Date.now() - Date.parse(iso) <= span;

/**
 * A push of the main branch as a notice: who asks ("title") and what it carries, at a glance ("text": "main of ATLAS:
 * 3 commit(s), 12 file(s), 1 migration(s)").
 */
export const mainPushNotice = (p, config) => ({
  title: p.session ? t('{session} asks to push the main branch', { session: p.sessionName ?? p.session }) : t('The manager asks to push the main branch'),
  text: t('{branch} of {project}: {count} commit(s), {files} file(s), {migrations} migration(s)', {
    branch: p.branch, project: config?.projects?.[p.project]?.name ?? p.project ?? p.repo, count: p.count ?? 0, files: p.fileCount ?? 0, migrations: p.migrationCount ?? 0,
  }),
});

/**
 * The notices now, most urgent first: { id, level, kind, title, text, view, project, run, at, seen, seenable }.
 * "view" is the app's place that deals with it; a request of a step carries what its buttons need ("I did it", or a question's options).
 */
export function attentionItems({ config, runs = [], needs = [], usage = {}, machine, items = [], update = {}, questions = [], pushes = [], repos = [], lockdown = null, login = loginWarning(), quarantine = [] }) {
  const list = [];
  const add = item => list.push({ project: null, run: null, at: null, seenable: true, ...item });
  // Urgent: the emergency lockdown (src/lockdown.mjs), until the owner releases it, and the security warnings of the day.
  if (lockdown?.active) {
    add({ id: `lockdown:${lockdown.since}`, level: 'urgent', kind: 'lockdown', title: t('Emergency lockdown'), text: lockdown.reason ?? '', view: 'operations', at: lockdown.since, seenable: false });
  }
  for (const w of lockdown?.warnings ?? []) {
    add({ id: `security:${w.id}`, level: 'urgent', kind: 'security', title: t('Security warning'), text: w.text, view: 'operations', at: w.at });
  }
  // Someone else reviews the project's work ("merge_by_owner": false): its pull requests only inform, until merged or closed.
  const byOther = project => config?.projects?.[project]?.merge_by_owner === false;
  const prNotice = (project, title) => (byOther(project)
    ? { level: 'info', title: t('Waiting for a third-party review'), lasting: true }
    : { level: 'important', title });

  // Urgent: a step or a live session waits for the owner (a session's permission asked included).
  for (const n of needs) {
    add({
      id: `needs:${n.run ?? n.session}:${n.id}`, level: 'urgent', kind: 'needs', title: n.kind === 'permission' ? t('Asks your permission') : n.options ? t('Asks you') : t('Needs you'),
      text: t('{task}: {what}', { task: n.title, what: n.explain?.summary ?? n.what }), view: 'operations', project: n.project ?? null, run: n.run ?? null, at: n.at, seenable: false,
      request: { id: n.id, kind: n.kind ?? null, run: n.run ?? null, session: n.session ?? null, url: n.url ?? null, openError: n.openError ?? null, agent: n.agent ?? null, explain: n.explain ?? null, options: n.options ?? null, recommend: n.recommend ?? null, why: n.why ?? null },
    });
  }
  // Urgent: a file of a working copy the antivirus probably took (src/quarantine.mjs): its project's queue waits for it.
  for (const q of quarantine) {
    add({
      id: `quarantine:${q.project}:${q.since}`, level: 'urgent', kind: 'quarantine', title: t('Antivirus probably quarantined a file'),
      text: `${t('{path}. The queue of {project} waits for it.', { path: q.file, project: config?.projects?.[q.project]?.name ?? q.project })} ${restoreSteps(q.file)}`,
      view: 'operations', project: q.project, run: q.run ?? null, at: q.since, seenable: false,
    });
  }
  // Urgent: a push the manager tried, for the owner to allow once or refuse (its card, src/decisions.mjs). The main
  // branch, by the manager or a "Work now" session, only while its project lets it go through a card.
  for (const p of pushes) {
    if (p.main && config?.projects?.[p.project]?.main_push !== 'card') continue;
    const main = p.main ? mainPushNotice(p, config) : null;
    add({ id: `push:${p.id}`, level: 'urgent', kind: 'push', title: main?.title ?? t('The manager asks to push'), text: main?.text ?? t('Branch {branch} to {repo}', { branch: p.branch, repo: p.repo }), view: 'manager', project: main ? p.project ?? null : null, at: p.at, seenable: false });
  }
  // Urgent: a private repository the manager asks to create from a folder (its card, src/decisions.mjs).
  for (const r of repos) {
    add({ id: `repo:${r.id}`, level: 'urgent', kind: 'repo', title: t('The manager asks to create a repository'), text: t('Private repository {repo}', { repo: r.repo }), view: 'manager', at: r.at, seenable: false });
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
  // Claude Code's sign-in on this computer (src/claude.mjs): important from 3 days before its earliest end (3 days
  // before the expiry Claude Code reports); urgent, and until it is renewed, from the day before that and once expired.
  if (login) {
    add({ id: `login:${login.expires}:${login.step}`, level: login.step === '3d' ? 'important' : 'urgent', kind: 'login', ...loginText(login), view: 'usage', seenable: login.step === '3d' });
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
  // Important: the reading of the account's usage page needs you to sign in (one card, with the button that opens the
  // window), or fails otherwise (the usage shown may be stale). One id per cause: seen, it stays seen while the cause
  // lasts, and comes back once a day ("remind").
  const reader = readerStatus();
  if (readerSettings(config).enabled && signInNeeded(reader)) {
    add({
      id: 'reader:login', level: 'important', kind: 'reader-login', title: t('Sign in to claude.ai'), view: 'usage', at: reader.failing_since ?? null, remind: DAY,
      text: t('The usage reading needs you to sign in to claude.ai, in a window of its own. Open it when you can: it closes by itself after {minutes} minutes.', { minutes: LOGIN_MINUTES }),
    });
  } else if (readerSettings(config).enabled && reader.error) {
    add({ id: `reader:${reader.cause ?? 'other'}`, level: 'important', kind: 'reader', title: t('Usage reading failed'), text: t('Reading claude.ai: {problem}', { problem: reader.error }), view: 'usage', at: reader.failing_since ?? reader.attempted ?? null, remind: DAY });
  }
  // Important: the board's items waiting for the owner: a pull request to approve, an item waiting for their action,
  // or a crew proposal the manager triaged ("decision": the Planning view decides it in its Decide block).
  const waiting = items.filter(i => !i.archived && i.status === 'waiting_owner');
  for (const i of waiting) {
    const delivery = runs.find(r => r.id === i.run && r.delivered && !r.pullRequest);
    const url = delivery ? null : i.pr ?? null;
    add({
      id: `plan:${i.id}:${delivery?.id ?? url ?? ''}`, level: 'important', kind: url ? 'pr' : 'proposal', title: url ? t('Pull request waiting for your approval') : t('Waiting for your action'),
      text: `#${i.id} ${i.title}`, view: 'planning', project: i.project || null, at: i.updated ?? null, url, run: delivery?.id ?? null,
      ...(url || i.run ? prNotice(i.project, url ? t('Pull request waiting for your approval') : t('Waiting for your action')) : {}),
    });
  }
  for (const i of items.filter(i => !i.archived && i.status === 'triaged')) {
    add({
      id: `decide:${i.id}`, level: 'important', kind: 'decision', title: t('Waiting for your decision'),
      text: `#${i.id} ${i.title}`, view: 'planning', project: i.project || null, at: i.triaged_at ?? i.updated ?? null,
    });
  }
  // Important: a pull request (or a branch delivered to the owner's clone) of the last week not on the board.
  const onBoard = new Set(waiting.flatMap(i => [i.pr, i.run]).filter(Boolean));
  for (const r of runs) {
    if (r.status !== 'done' || !(r.pullRequest || r.delivered) || r.merged || r.discarded || onBoard.has(r.pullRequest) || onBoard.has(r.id) || !ago(r.ended, PR_FOR)) continue;
    const title = r.pullRequest ? t('Pull request waiting for your approval') : t('Branch waiting for your approval');
    add({ id: `pr:${r.id}`, kind: 'pr', text: r.title, view: 'log', project: r.project, run: r.id, at: r.ended, url: r.pullRequest ?? null, ...prNotice(r.project, title) });
  }
  // Important: a delivery stalled, past STALE_AFTER with no merge or discard (only info when someone else reviews it).
  for (const { run: r } of pendingDeliveries(runs).filter(d => d.stale)) {
    add({
      id: `stale:${r.id}`, level: byOther(r.project) ? 'info' : 'important', kind: 'stale', lasting: true, title: t('Delivery stalled for over 12 hours'),
      text: t('{title}: waiting since {when}, neither merged nor discarded.', { title: r.title, when: formatDateTime(r.ended) }), view: 'log', project: r.project, run: r.id, at: r.ended, url: r.pullRequest ?? null,
    });
  }
  // Important: a question the manager asked the owner (cli.mjs ask-owner), answered with one click on its card.
  for (const q of questions) {
    add({ id: `question:${q.id}`, level: 'important', kind: 'question', title: t('Question from the manager'), text: q.question, view: 'manager', project: q.project ?? null, at: q.at });
  }
  // Important: an approved update that could not be installed.
  if (update.waiting && update.blocked) {
    add({ id: `update:${update.blocked}`, level: 'important', kind: 'update', title: t('Update blocked'), text: t('An approved update of Chiefmate was not installed. See why under the manager.'), view: 'manager' });
  }
  // Info: a task finished in the last day (without a pull request or branch to approve: that one is above), an update installed.
  for (const r of runs) {
    if (r.status !== 'done' || r.pullRequest || list.some(i => i.id === `pr:${r.id}`) || !ago(r.ended, DONE_FOR)) continue;
    add({ id: `done:${r.id}`, level: 'info', kind: 'done', title: t('Task finished'), text: r.title, view: 'log', project: r.project, run: r.id, at: r.ended });
  }
  const state = readState();
  const installed = state.last_update;
  if (installed && ago(installed.at, DONE_FOR)) {
    add({ id: `updated:${installed.at}`, level: 'info', kind: 'updated', title: t('Update installed'), text: installed.changes?.length ? installed.changes.join('; ') : t('The improvements you approved are installed.'), view: 'manager', at: installed.at });
  }

  // The archive: what no longer needs the owner leaves the list. A seen notice fades; the marks of notices gone are forgotten.
  // A notice with "remind" (ms) counts as seen only for that long after it was marked.
  const seen = state.attention_seen ?? {};
  const isSeen = i => !!seen[i.id] && (!i.remind || Date.now() - Date.parse(seen[i.id]) < i.remind);
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
    else if (i.level === 'info' && (isSeen(i) || (!i.lasting && i.at && !ago(i.at, DONE_FOR)))) toArchive(i, isSeen(i) ? 'seen' : 'expired');
    else active.push(i);
  }
  for (const i of list) {
    const reason = archive[i.id]?.reason;
    if (final(reason)) settleRunOutside(noticeRun(i, runs, items), reason, i.url);
  }
  // Shown last time and gone now: its cause ended (for an info notice, its day).
  for (const [id, i] of Object.entries(shown)) {
    if (ids.has(id) || archive[id]) continue;
    const run = i.run && runs.find(r => r.id === i.run);
    const reason = run?.merged?.by === 'outside' && run.merged.how === 'local' ? 'branch'
      : run?.discarded?.by === 'outside' && run.discarded.how === 'local' ? 'deleted' : null;
    toArchive(i, reason ?? (i.level === 'info' ? 'expired' : 'resolved'));
  }
  const keptSeen = Object.fromEntries(Object.entries(seen).filter(([id]) => ids.has(id) && !archive[id]));
  const nowShown = Object.fromEntries(active.map(i => [i.id, compact(i)]));
  if (changed || Object.keys(keptSeen).length !== Object.keys(seen).length || !sameKeys(nowShown, shown)) {
    const newest = Object.values(archive).sort((a, b) => b.archived.localeCompare(a.archived)).slice(0, ARCHIVE_MAX);
    saveState({ ...readState(), attention_seen: keptSeen, attention_shown: nowShown, attention_archive: Object.fromEntries(newest.map(i => [i.id, i])) });
  }
  if (!process.env.CHIEFMATE_SMOKE) checkLater(pullRequestTargets(active, runs, items), config);
  const rank = i => LEVELS.indexOf(i.level);
  return active
    .map(i => ({ ...i, seen: !!keptSeen[i.id] && isSeen(i) && i.seenable }))
    .sort((a, b) => a.seen - b.seen || rank(a) - rank(b) || String(b.at ?? '').localeCompare(String(a.at ?? '')));
}

const compact = ({ id, level, kind, title, text, view, project, run, url, at }) => ({ id, level, kind, title, text, view, project, run, url: url ?? null, at });
const sameKeys = (a, b) => Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => k in b);

/** The archive, the most recently archived first: { id, level, kind, title, text, ..., archived, reason }. */
export function attentionArchive() {
  return Object.values(readState().attention_archive ?? {}).sort((a, b) => String(b.archived).localeCompare(String(a.archived)));
}

// ---------- The deliveries waiting for the owner ----------

/**
 * The finished runs whose delivery (a pull request or a local branch) was neither merged nor discarded, of the last
 * month, oldest first: { run, waited (ms), stale (past STALE_AFTER) }. "project" keeps one project's only.
 */
export function pendingDeliveries(runs, { project = null } = {}) {
  return runs
    .filter(r => r.status === 'done' && (r.pullRequest || r.delivered) && !r.merged && !r.discarded && (!project || r.project === project) && ago(r.ended, STALE_FOR))
    .map(r => {
      const waited = Date.now() - Date.parse(r.ended);
      return { run: r, waited, stale: waited > STALE_AFTER };
    })
    .sort((a, b) => b.waited - a.waited);
}

/** Where a delivery waits, in a few words for the manager and the agent in charge. */
export const deliveryPlace = r => (r.pullRequest ? `pull request ${r.pullRequest}` : `branch ${r.branch ?? '?'} in ${r.delivered}`);

/** For the manager's situation: the stalled deliveries, or '' when none; "config" tells the ones someone else reviews. */
export function staleLine(runs, owner = 'the owner', config = null) {
  const stale = pendingDeliveries(runs).filter(d => d.stale);
  if (!stale.length) return '';
  const hours = ms => `${Math.floor(ms / HOUR)} h`;
  const who = r => (config?.projects?.[r.project]?.merge_by_owner === false ? 'someone else reviews it' : `level ${r.level ?? '?'}`);
  return `Stalled deliveries (over ${STALE_AFTER / HOUR} hours with no merge and no discard; each is also an alert in the app; settle the level 1 ones when a standing authorization of ${owner}'s covers them, else remind ${owner} when it fits that its card in Decisions waits for Approve or Discard): ${stale.slice(0, 10).map(({ run: r, waited }) => `[${r.id}] ${r.title} (project ${r.project}, ${who(r)}, ${deliveryPlace(r)}, waiting for ${hours(waited)})`).join('; ')}${stale.length > 10 ? `; and ${stale.length - 10} more` : ''}.`;
}

// ---------- The pull requests and branches already merged ----------
// Asked in the background (gh and git), at most every CHECK_EVERY, and kept in memory.

const prStates = new Map(); // url -> { state: 'open' | 'merged' | 'closed' | null, checked }
const branchStates = new Map(); // run id -> { state: 'branch' | 'deleted' | null, checked }
let checking = null;
let lastCheck = 0;

const final = state => ['merged', 'closed', 'branch', 'deleted'].includes(state);

// The notices about a delivery: a pull request or branch, a board item waiting for the owner, a stalled delivery.
const isDelivery = i => /^(pr|plan|stale):/.test(i.id);

/** The run behind a pull request, stalled delivery or board notice. */
function noticeRun(i, runs, items) {
  if (i.id.startsWith('pr:') || i.id.startsWith('stale:')) return runs.find(r => r.id === i.run) ?? null;
  if (!i.id.startsWith('plan:')) return null;
  const item = items.find(x => i.id.startsWith(`plan:${x.id}:`));
  return item?.run ? (runs.find(r => r.id === item.run) ?? null) : null;
}

/** Why a pull request or board notice no longer needs the owner, from what was checked. */
function resolution(i, runs, items) {
  if (!isDelivery(i)) return null;
  const state = i.url ? prStates.get(i.url)?.state : null;
  if (final(state)) return state;
  const r = noticeRun(i, runs, items);
  return r?.branch ? branchStates.get(r.id)?.state ?? null : null;
}

/** What to check for the notices shown: the pull requests' addresses and the runs whose branch may be merged. */
export function pullRequestTargets(list, runs, items) {
  return list
    .filter(isDelivery)
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

/** A pull request's branch can also be merged in the owner's clone. */
async function branchState(run, config) {
  if (!run.pullRequest) return localBranchState(run, config);
  const project = config?.projects?.[run.project];
  if (!project?.local_clone || !run.branch) return null;
  const git = (...args) => exec('git', args, project.local_clone, { maxMinutes: 1 });
  const base = await baseBranch(project).catch(() => null);
  if (!base) return null;
  for (const ref of [run.branch, `origin/${run.branch}`]) {
    if ((await git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`)).code !== 0) continue;
    for (const into of [base, `origin/${base}`]) if ((await git('merge-base', '--is-ancestor', ref, into)).code === 0) return 'branch';
    return null;
  }
  return null;
}

/**
 * Checks the pull requests and branches of the notices ("targets": { url, run }), one at a time, skipping what is
 * final or was checked in the last CHECK_EVERY. "ask" stands in for gh and git in the tests.
 */
export async function checkPullRequests(targets, config, ask = { pr: ghState, branch: branchState }) {
  lastCheck = Date.now();
  const fresh = entry => entry && (final(entry.state) || Date.now() - entry.checked < CHECK_EVERY);
  for (const { url, run } of targets) {
    if (url && !fresh(prStates.get(url))) prStates.set(url, { state: await ask.pr(url), checked: Date.now() });
    if (final(url ? prStates.get(url)?.state : null) || !run?.branch) continue;
    if (!fresh(branchStates.get(run.id))) branchStates.set(run.id, { state: await ask.branch(run, config), checked: Date.now() });
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
