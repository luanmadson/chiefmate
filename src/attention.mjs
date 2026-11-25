// What needs the owner, in three levels, for the whole app: urgent (act now), important (decide soon) and info
// (good to know). Each notice goes away when the owner acts (its cause ends) and fades when marked as seen; a seen
// info notice goes away. The seen marks are kept in data/state.json ("attention_seen").
import { formatDateTime, formatPercent, t } from './i18n.mjs';
import { RAM_LOW, availableResets, current } from './plan.mjs';
import { readState, saveState } from './store.mjs';
import { readerSettings, readerStatus } from './usagepage.mjs';

export const LEVELS = ['urgent', 'important', 'info'];
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const FAILED_FOR = 3 * DAY; // a failed run asks for attention for 3 days...
const PR_FOR = 7 * DAY; // ...a pull request for a week...
const DONE_FOR = DAY; // ...a finished task and an installed update for a day
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

  // Urgent: a step or a live session waits for the owner.
  for (const n of needs) {
    add({
      id: `needs:${n.run ?? n.session}:${n.id}`, level: 'urgent', kind: 'needs', title: t('Needs you'), text: t('{task}: {what}', { task: n.title, what: n.what }),
      view: 'operations', project: n.project ?? null, run: n.run ?? null, at: n.at, seenable: false,
      request: { id: n.id, run: n.run ?? null, session: n.session ?? null, url: n.url ?? null, openError: n.openError ?? null, agent: n.agent ?? null },
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
  // Important: the board's items waiting for the owner: a pull request to approve, or a proposal to decide.
  const waiting = items.filter(i => !i.archived && i.status === 'waiting_owner');
  for (const i of waiting) {
    add({
      id: `plan:${i.id}:${i.pr ?? ''}`, level: 'important', kind: i.pr ? 'pr' : 'proposal', title: i.pr ? t('Pull request waiting for your approval') : t('Waiting for your decision'),
      text: `#${i.id} ${i.title}`, view: 'planning', project: i.project || null, at: i.updated ?? null, url: i.pr ?? null,
    });
  }
  // Important: a pull request of the last week not on the board.
  const onBoard = new Set(waiting.map(i => i.pr).filter(Boolean));
  for (const r of runs) {
    if (r.status !== 'done' || !r.pullRequest || onBoard.has(r.pullRequest) || !ago(r.ended, PR_FOR)) continue;
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

  // The seen marks: a seen info notice goes away, the others fade. Marks of notices gone are forgotten.
  const seen = state.attention_seen ?? {};
  const ids = new Set(list.map(i => i.id));
  const kept = Object.fromEntries(Object.entries(seen).filter(([id]) => ids.has(id)));
  if (Object.keys(kept).length !== Object.keys(seen).length) saveState({ ...state, attention_seen: kept });
  const rank = i => LEVELS.indexOf(i.level);
  return list
    .map(i => ({ ...i, seen: !!kept[i.id] && i.seenable }))
    .filter(i => !(i.seen && i.level === 'info'))
    .sort((a, b) => a.seen - b.seen || rank(a) - rank(b) || String(b.at ?? '').localeCompare(String(a.at ?? '')));
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
