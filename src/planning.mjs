// The owner's planning board: items by project, with a priority and a status, kept in data/plan.json.
// An item linked to a run follows it: queued, in progress, then done (or waiting for the owner, with a pull request
// to approve), or back to "to do" when the run fails or is canceled.
// Proposals: the crew proposes items (proposed), the manager triages them (triaged: waiting for the owner's decision,
// with a recommendation), and the owner decides: "do" (approved: it becomes a task for its agent, one per project at a
// time, in the owner's order), "later" (future) or "discard" (discarded, with a reason; it can come back).
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig, projectCrew } from './config.mjs';
import { reportEvent } from './news.mjs';
import { onRunSaved, readRun, stepsOf } from './store.mjs';
import { clip, DATA, now, readJson, writeJson } from './util.mjs';

const BOARD_FILE = path.join(DATA, 'plan.json');
// The manager's board from before this one: a Markdown table, imported once when data/plan.json does not exist yet.
const LEGACY_FILE = path.join(DATA, 'manager', 'plan.md');

export const PRIORITIES = ['high', 'medium', 'low'];
export const STATUSES = ['proposed', 'triaged', 'approved', 'future', 'todo', 'queued', 'in_progress', 'waiting_owner', 'done', 'discarded'];
// The board's order within a priority: what needs the owner first, what is done or discarded last.
const STATUS_ORDER = ['waiting_owner', 'triaged', 'in_progress', 'queued', 'approved', 'todo', 'proposed', 'future', 'done', 'discarded'];
// Closed items: out of the open list (done, or discarded by the manager or the owner).
export const CLOSED = ['done', 'discarded'];
export const RECOMMENDATIONS = ['now', 'later', 'discard'];

const plain = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9#]+/g, ' ').trim();

const PRIORITY_WORDS = {
  high: ['high', 'h', '1', 'alta', 'a'],
  medium: ['medium', 'med', 'm', '2', 'media'],
  low: ['low', 'l', '3', 'baixa', 'b'],
};
const STATUS_WORDS = {
  proposed: ['proposed', 'proposal', 'proposto', 'proposta'],
  triaged: ['triaged', 'decision', 'triado', 'decisao', 'aguardando voce'],
  approved: ['approved', 'aprovado'],
  discarded: ['discarded', 'discard', 'descartado'],
  future: ['future', 'later', 'someday', 'futuro', 'depois'],
  todo: ['todo', 'to do', 'open', 'a fazer', 'fazer'],
  queued: ['queued', 'queue', 'na fila', 'fila'],
  in_progress: ['in progress', 'progress', 'doing', 'running', 'em andamento', 'andamento'],
  waiting_owner: ['waiting owner', 'waiting', 'owner', 'aguardando o dono', 'aguardando', 'dono'],
  done: ['done', 'finished', 'completed', 'concluido', 'feito'],
};

function exact(words, text) {
  const s = plain(text);
  for (const [key, list] of Object.entries(words)) if (s === plain(key) || list.includes(s)) return key;
  return null;
}

/** "alta", "High", "1": the priority's key, or an error listing the valid ones. */
export function parsePriority(text) {
  const p = exact(PRIORITY_WORDS, text);
  if (!p) throw new Error(`Unknown priority "${text}". Use: ${PRIORITIES.join(', ')}.`);
  return p;
}

/** "em andamento", "in_progress", "done": the status's key, or an error listing the valid ones. */
export function parseStatus(text) {
  const s = exact(STATUS_WORDS, text);
  if (!s) throw new Error(`Unknown status "${text}". Use: ${STATUSES.join(', ')}.`);
  return s;
}

const RECOMMEND_WORDS = {
  now: ['now', 'do', 'do now', 'fazer', 'fazer agora', 'agora'],
  later: ['later', 'depois'],
  discard: ['discard', 'drop', 'descartar'],
};

/** "fazer agora", "now", "depois", "descartar": the manager's recommendation, or an error listing the valid ones. */
export function parseRecommendation(text) {
  const r = exact(RECOMMEND_WORDS, text);
  if (!r) throw new Error(`Unknown recommendation "${text}". Use: ${RECOMMENDATIONS.join(', ')}.`);
  return r;
}

/** A free-form status from the old Markdown board ("Aguarda Luan ver a tela", "Depende do item 1"), by its words. */
function guessStatus(text, owner) {
  const s = plain(text);
  const known = exact(STATUS_WORDS, s);
  if (known) return { status: known, exact: true };
  const has = (...words) => words.some(w => s.includes(w));
  let status = 'todo';
  if (has('conclu', 'feito', 'done', 'finish')) status = 'done';
  else if (has('andamento', 'progress')) status = 'in_progress';
  else if (has('fila', 'queue')) status = 'queued';
  else if (has('aguard', 'decis', 'aprova', 'precisa', 'dono', 'owner', 'waiting') || (owner && s.includes(plain(owner)))) status = 'waiting_owner';
  else if (has('futur', 'depende', 'depends', 'later', 'bloque', 'blocked')) status = 'future';
  return { status, exact: false };
}

/** The project's id in the settings when the text names one (by id or name, or the start of one), else the text. */
function matchProject(text, projects) {
  const s = plain(text).replace(/ /g, '');
  if (!s) return '';
  const entries = Object.entries(projects ?? {}).map(([id, p]) => [id, [plain(id).replace(/ /g, ''), plain(p.name).replace(/ /g, '')]]);
  const same = entries.find(([, names]) => names.includes(s));
  if (same) return same[0];
  const starts = entries.filter(([, names]) => names.some(n => n && n.startsWith(s)));
  return starts.length === 1 ? starts[0][0] : String(text).trim();
}

/** The rows of the Markdown table (#, Project, Item, Priority, Status), as items. */
export function importMarkdown(text, config = {}) {
  const rows = String(text ?? '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.startsWith('|'))
    .map(l => l.replace(/^\||\|$/g, '').split('|').map(c => c.trim()));
  if (!rows.length) return [];
  const header = rows[0].map(plain);
  const find = (...names) => header.findIndex(h => names.includes(h));
  const isHeader = find('#', 'projeto', 'project', 'item', 'prioridade', 'priority', 'situacao', 'status') >= 0;
  const col = isHeader
    ? { n: find('#', 'n', 'id'), project: find('projeto', 'project'), title: find('item', 'title', 'titulo'), priority: find('prioridade', 'priority'), status: find('situacao', 'status') }
    : { n: 0, project: 1, title: 2, priority: 3, status: 4 };
  const at = (row, i) => (i >= 0 ? row[i] ?? '' : '');
  const stamp = now();
  const items = [];
  for (const row of rows.slice(isHeader ? 1 : 0)) {
    if (row.every(c => /^:?-*:?$/.test(c))) continue; // the line under the header
    const title = clip(at(row, col.title), 200);
    if (!title) continue;
    const { status, exact: known } = guessStatus(at(row, col.status), config.owner);
    let priority = 'medium';
    try {
      priority = parsePriority(at(row, col.priority));
    } catch {
      // an unknown priority stays medium
    }
    const n = Number(at(row, col.n).replace(/\D/g, ''));
    const statusText = at(row, col.status);
    items.push({
      id: Number.isInteger(n) && n > 0 && !items.some(i => i.id === n) ? n : null,
      project: matchProject(at(row, col.project), config.projects),
      title,
      description: !known && statusText ? `Imported status: ${statusText}` : '',
      priority, status, created: stamp, updated: stamp, run: null, pr: null, run_status: null, archived: null,
    });
  }
  let next = Math.max(0, ...items.map(i => i.id ?? 0)) + 1;
  for (const item of items) if (!item.id) item.id = next++;
  return items;
}

/** The board: { next, items }. The first time, it starts from data/manager/plan.md when there is one. */
export function readBoard() {
  if (existsSync(BOARD_FILE)) {
    const board = readJson(BOARD_FILE, null);
    if (board && Array.isArray(board.items)) return board;
  }
  let items = [];
  let imported = null;
  if (existsSync(LEGACY_FILE)) {
    try {
      items = importMarkdown(readFileSync(LEGACY_FILE, 'utf8'), loadConfig());
      imported = now();
    } catch (error) {
      console.error('Planning: could not import data/manager/plan.md:', error.message);
    }
  }
  const board = { next: Math.max(0, ...items.map(i => i.id)) + 1, items, ...(imported ? { imported_from: 'data/manager/plan.md', imported_at: imported } : {}) };
  writeJson(BOARD_FILE, board);
  return board;
}

const saveBoard = board => writeJson(BOARD_FILE, board);

const rankOf = i => i.rank ?? Number.MAX_SAFE_INTEGER;
const byBoardOrder = (a, b) =>
  PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority) || STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || rankOf(a) - rankOf(b) || a.id - b.id;
// The owner's order for decisions and approved items: the rank (set by the manager's triage or by dragging), then the board's.
export const byRank = (a, b) => rankOf(a) - rankOf(b) || byBoardOrder(a, b);

/** Every item, in the board's order: priority, then what needs the owner, then the number. */
export const planItems = () => [...readBoard().items].sort(byBoardOrder);

function findIn(board, id) {
  const item = board.items.find(i => i.id === Number(String(id ?? '').replace(/^#/, '')));
  if (!item) throw new Error(`Item ${id} not found on the planning board.`);
  return item;
}

export const planItem = id => findIn(readBoard(), id);

// ---------- Following the linked run ----------

/** The item's status for the run's: done with a pull request (or a branch delivered locally) waits for the owner. */
function statusForRun(run) {
  switch (run.status) {
    case 'queued':
    case 'waiting':
    case 'paused':
      return 'queued';
    case 'running':
      return 'in_progress';
    case 'done':
      return run.pullRequest || run.delivered ? 'waiting_owner' : 'done';
    case 'failed':
    case 'canceled':
      return 'todo';
    default:
      return null;
  }
}

/** Applies the run's status to the item when it changed since the last time; true when the item changed. */
function follow(item, run) {
  let changed = false;
  if (run.pullRequest && item.pr !== run.pullRequest) [item.pr, changed] = [run.pullRequest, true];
  if (item.run_status !== run.status) {
    item.run_status = run.status;
    const status = statusForRun(run);
    if (status) item.status = status;
    changed = true;
  }
  if (changed) item.updated = now();
  return changed;
}

/** Called on every save of a run: links the item it was queued for, and moves the items linked to it. */
function syncRun(run) {
  if (!existsSync(BOARD_FILE)) return;
  const board = readJson(BOARD_FILE, null);
  if (!board?.items) return;
  let changed = false;
  let freed = false;
  for (const item of board.items) {
    if (run.plan != null && item.id === Number(run.plan) && item.run !== run.id) {
      Object.assign(item, { run: run.id, run_status: null });
      changed = true;
    }
    if (item.run === run.id && !item.archived && follow(item, run)) {
      changed = true;
      // An approved item's run ended: the project's next approved item may start.
      if (item.approved_at && !ACTIVE.includes(item.status)) freed = true;
    }
  }
  if (changed) saveBoard(board);
  if (freed) startApproved().catch(error => console.error('Planning:', error.message));
}
onRunSaved(syncRun);

// ---------- Changes (the app, the command line) ----------

const RUN_ID = /^[\w.-]{1,80}$/;
// An approved item whose run waits or goes on: at most one per project (startApproved).
const ACTIVE = ['queued', 'in_progress'];

/** The crew members of a project that take tasks (not the manager, not the team lead). */
function taskMembers(project, config = loadConfig()) {
  return config.projects?.[project] ? Object.keys(projectCrew(config, project)).filter(id => id !== 'manager' && id !== 'lead') : null;
}

/** The member who will do the item: one of the project's crew (any name for a project not in the settings). */
function checkAgent(project, agent) {
  const id = clip(agent, 60);
  if (!id) return null;
  const members = taskMembers(project);
  if (members && !members.includes(id)) throw new Error(`${id} is not in the crew of ${project}. Use: ${members.join(', ')}.`);
  return id;
}

/** Checks and applies the fields given: project, title, description, priority, status, agent, run, pr. */
function applyFields(item, fields) {
  const has = key => fields[key] !== undefined && fields[key] !== null;
  if (has('project')) {
    const project = clip(fields.project, 60);
    if (!project) throw new Error('The project is missing.');
    item.project = matchProject(project, loadConfig().projects);
  }
  if (has('title')) {
    item.title = clip(fields.title, 200);
    if (!item.title) throw new Error('The title is missing.');
  }
  if (has('description')) item.description = String(fields.description).trim().slice(0, 4000);
  if (has('priority')) item.priority = parsePriority(fields.priority);
  if (has('agent')) item.agent = checkAgent(item.project, fields.agent);
  if (has('status')) {
    const status = parseStatus(fields.status);
    // Approved by hand: it waits its turn like one approved with "do" (an agent is needed for its task).
    if (status === 'approved' && item.status !== 'approved') {
      if (!item.agent) throw new Error(`Item #${item.id} has no agent to do it: set one first (--agent).`);
      item.approved_at = now();
    }
    if (status === 'discarded' && item.status !== 'discarded') item.discarded_at = now();
    if (status !== 'discarded') item.discarded_at = null;
    item.status = status;
  }
  if (has('pr')) {
    const pr = String(fields.pr).trim();
    item.pr = !pr ? null : /^\d+$/.test(pr) ? `#${pr}` : pr.slice(0, 300);
  }
  if (has('run')) {
    const id = String(fields.run).trim();
    if (!id) Object.assign(item, { run: null, run_status: null });
    else if (id !== item.run) {
      // Only a new link counts: the same run again, as the app's edit form sends it, changes nothing.
      if (!RUN_ID.test(id)) throw new Error(`Invalid run id "${id}".`);
      const run = readRun(id);
      if (!run) throw new Error(`Run ${id} not found.`);
      Object.assign(item, { run: id, run_status: null });
      // The status given now wins; otherwise the item takes the run's.
      if (has('status')) item.run_status = run.status;
      else follow(item, run);
      if (run.pullRequest) item.pr = run.pullRequest;
    }
  }
}

export function addItem(fields) {
  const board = readBoard();
  const stamp = now();
  const item = { id: board.next, project: '', title: '', description: '', priority: 'medium', status: 'todo', created: stamp, updated: stamp, run: null, pr: null, run_status: null, archived: null };
  applyFields(item, fields); // without a status given, an item linked to a run takes the run's
  if (!item.project) throw new Error('The project is missing.');
  if (!item.title) throw new Error('The title is missing.');
  board.items.push(item);
  board.next = Math.max(board.next, item.id) + 1;
  saveBoard(board);
  if (item.status === 'approved') startApproved().catch(error => console.error('Planning:', error.message));
  return item;
}

export function updateItem(id, fields) {
  const board = readBoard();
  const item = findIn(board, id);
  applyFields(item, fields);
  item.updated = now();
  saveBoard(board);
  if (item.status === 'approved') startApproved().catch(error => console.error('Planning:', error.message));
  return item;
}

/** Archived items leave the board (they stay in the file, and can come back). */
export function archiveItem(id, archived = true) {
  const board = readBoard();
  const item = findIn(board, id);
  item.archived = archived ? now() : null;
  item.updated = now();
  saveBoard(board);
  return item;
}

// ---------- Proposals: the crew proposes, the manager triages, the owner decides ----------

const isOpen = i => !i.archived && !CLOSED.includes(i.status);

/**
 * Who proposes: the step of a run that runs the command (its agent, from the run's record), or else the name given
 * ("manager", "owner"). { run, step } come from the step's CHIEFMATE_RUN and CHIEFMATE_STEP.
 */
export function proposer({ run, step, by } = {}) {
  if (run) {
    const record = RUN_ID.test(String(run)) ? readRun(String(run)) : null;
    const agent = record && stepsOf(record)[Number(step) - 1]?.agent;
    if (agent) return { by: agent, run: record.id };
  }
  return { by: clip(by, 60) || 'owner', run: null };
}

/**
 * A proposal for the board: { project, title, summary, agent (the member suggested), priority, by, run }. Refused when
 * an open item of the project has the same title. The manager hears of it (grouped with the others within a minute),
 * unless it proposed it itself.
 */
export function proposeItem({ project, title, summary, agent, priority, by, run } = {}) {
  const board = readBoard();
  const name = plain(title);
  const target = matchProject(clip(project, 60), loadConfig().projects);
  const same = board.items.find(i => isOpen(i) && i.project === target && plain(i.title) === name);
  if (name && same) throw new Error(`Already on the board as #${same.id} (${same.status}): add to that item instead of proposing it again.`);
  const stamp = now();
  const item = {
    id: board.next, project: '', title: '', description: '', priority: 'medium', status: 'proposed', created: stamp, updated: stamp,
    run: null, pr: null, run_status: null, archived: null, agent: null, proposed_by: clip(by, 60) || 'owner', proposed_run: run ?? null,
  };
  applyFields(item, { project, title, description: summary ?? '', priority: priority || undefined, agent: agent || undefined });
  if (!item.project) throw new Error('The project is missing.');
  if (!item.title) throw new Error('The title is missing.');
  board.items.push(item);
  board.next = Math.max(board.next, item.id) + 1;
  saveBoard(board);
  if (item.proposed_by !== 'manager') {
    reportEvent('plan_proposed', `New proposal on the planning board: #${item.id} ${item.project}: "${item.title}" (proposed by ${item.proposed_by}${item.proposed_run ? ` in run ${item.proposed_run}` : ''}${item.agent ? `, suggested agent ${item.agent}` : ''}, ${item.priority} priority)${item.description ? `. ${clip(item.description, 200)}` : ''}`);
  }
  return item;
}

/** Puts the item at a position (from 1) of the owner's order: the items waiting for a decision or approved. */
function placeAt(board, item, position) {
  const list = board.items.filter(i => i !== item && isOpen(i) && ['triaged', 'approved'].includes(i.status)).sort(byRank);
  list.splice(Math.max(0, Math.min(list.length, Math.floor(Number(position) || 1) - 1)), 0, item);
  list.forEach((i, n) => (i.rank = n + 1));
}

const TRIAGE_FROM = ['proposed', 'triaged', 'future', 'todo'];

/**
 * The manager's triage: { priority, agent, recommend (now | later | discard), note (one line on why), order (a position
 * in the owner's list) }. The item then waits for the owner's decision.
 */
export function triageItem(id, { priority, agent, recommend, note, order } = {}) {
  const board = readBoard();
  const item = findIn(board, id);
  if (item.archived || !TRIAGE_FROM.includes(item.status)) throw new Error(`Item #${item.id} is ${item.archived ? 'archived' : item.status}: only proposed, future or to-do items are triaged.`);
  if (recommend == null || recommend === '') throw new Error(`Recommend something: --recommend ${RECOMMENDATIONS.join('|')}.`);
  applyFields(item, { priority: priority || undefined, agent: agent || undefined });
  if (!item.agent) throw new Error(`Say which agent would do item #${item.id}: --agent <member>.`);
  Object.assign(item, { recommend: parseRecommendation(recommend), recommend_note: clip(note, 200) || item.recommend_note || '', triaged_at: now(), status: 'triaged', updated: now() });
  placeAt(board, item, order != null && order !== '' ? order : item.rank ?? Number.MAX_SAFE_INTEGER);
  saveBoard(board);
  return item;
}

/**
 * A decision on an item: "approve" (it becomes a task for its agent, in the owner's order, one per project at a time),
 * "later" (future) or "discard" (with a reason; "restore" brings it back). by: who decided, the owner, the manager
 * (which discards proposals that make no sense or repeat another) or the autopilot (src/autopilot.mjs).
 */
export async function decideItem(id, decision, { reason, by = 'owner' } = {}) {
  const board = readBoard();
  const item = findIn(board, id);
  if (item.archived) throw new Error(`Item #${item.id} is archived: restore it first.`);
  const stamp = now();
  if (decision === 'approve') {
    if (!TRIAGE_FROM.includes(item.status)) throw new Error(`Item #${item.id} is ${item.status}: there is nothing to approve.`);
    if (!item.agent) throw new Error(`Item #${item.id} has no agent to do it: the manager's triage sets one (plan triage ${item.id} --agent <member>).`);
    if (!loadConfig().projects?.[item.project]) throw new Error(`${item.project} is not a project in the settings: its task can't be queued.`);
    checkAgent(item.project, item.agent);
    Object.assign(item, { status: 'approved', approved_at: stamp, decided_by: by });
    placeAt(board, item, item.rank ?? Number.MAX_SAFE_INTEGER);
  } else if (decision === 'later') {
    if (CLOSED.includes(item.status) || ACTIVE.includes(item.status) || item.status === 'waiting_owner') throw new Error(`Item #${item.id} is ${item.status}: it can't wait for later.`);
    Object.assign(item, { status: 'future', decided_by: by, rank: null, approved_at: null });
  } else if (decision === 'discard') {
    if (item.status === 'discarded') throw new Error(`Item #${item.id} is already discarded.`);
    if (ACTIVE.includes(item.status)) throw new Error(`Item #${item.id} has a run ${item.status === 'queued' ? 'waiting' : 'going on'}: cancel the run first.`);
    Object.assign(item, { status: 'discarded', discarded_at: stamp, discard_reason: clip(reason, 200) || '', decided_by: by, rank: null });
  } else throw new Error(`Unknown decision "${decision}". Use: approve, later, discard.`);
  item.updated = stamp;
  saveBoard(board);
  if (decision === 'approve') await startApproved();
  return planItem(item.id);
}

/** A discarded item comes back: to the owner's decision when it was triaged, else to the proposals. */
export function restoreDiscarded(id) {
  const board = readBoard();
  const item = findIn(board, id);
  if (item.status !== 'discarded') throw new Error(`Item #${item.id} is not discarded.`);
  Object.assign(item, { status: item.triaged_at ? 'triaged' : 'proposed', discarded_at: null, archived: null, updated: now() });
  if (item.status === 'triaged') placeAt(board, item, Number.MAX_SAFE_INTEGER);
  saveBoard(board);
  return item;
}

/** The owner's order, dragged in the app: the ids given go first, in that order; the others keep theirs after them. */
export function reorderItems(ids) {
  const board = readBoard();
  const wanted = (Array.isArray(ids) ? ids : []).map(id => findIn(board, id));
  if (!wanted.length) throw new Error('Which items, in which order?');
  const rest = board.items.filter(i => !wanted.includes(i) && i.rank != null && isOpen(i)).sort(byRank);
  [...wanted, ...rest].forEach((i, n) => (i.rank = n + 1));
  saveBoard(board);
  return wanted;
}

/** The instruction of an approved item's task. */
function taskInstruction(item) {
  return [
    `Planning board item #${item.id}, approved by the owner: ${item.title}`,
    item.description,
    item.recommend_note ? `The manager's note: ${item.recommend_note}` : '',
    'Do this item only. Fixes it needs are part of it; anything else you find goes in your report, or as a proposal.',
  ].filter(Boolean).join('\n\n');
}

let startChain = Promise.resolve();
/**
 * Starts the approved items' tasks: in each project with no approved item queued or going on, the first approved one
 * in the owner's order becomes a task for its agent (with the manager's review), linked to the item. The rest wait.
 */
export function startApproved() {
  // One at a time: two calls close together would otherwise start the same item twice.
  const next = startChain.then(startNext);
  startChain = next.catch(() => {});
  return next;
}

async function startNext() {
  const config = loadConfig();
  const open = readBoard().items.filter(i => !i.archived);
  const busy = new Set(open.filter(i => i.approved_at && ACTIVE.includes(i.status)).map(i => i.project));
  const next = new Map();
  for (const item of open.filter(i => i.status === 'approved').sort(byRank)) {
    if (!busy.has(item.project) && !next.has(item.project)) next.set(item.project, item);
  }
  if (!next.size) return [];
  const { createRun } = await import('./runs.mjs'); // here, not at the top: runs.mjs is heavy and the board is read alone too
  const started = [];
  for (const item of next.values()) {
    try {
      if (!config.projects?.[item.project]) throw new Error(`${item.project} is not a project in the settings`);
      started.push(createRun({ kind: 'task', projectId: item.project, agent: item.agent, instruction: taskInstruction(item), review: true, origin: 'plan', plan: item.id }));
    } catch (error) {
      // Back to "to do", with the reason, so it doesn't hold the project's turn.
      console.error(`Planning: item #${item.id} could not start:`, error.message);
      updateItem(item.id, { status: 'todo', description: `${item.description ? `${item.description}\n\n` : ''}Could not start its task: ${error.message}` });
    }
  }
  return started;
}

/** The app's commands: { action: add | set | archive | restore | propose | triage | approve | later | discard | reorder, id, ...fields }. */
export async function changePlan(body = {}) {
  const fields = Object.fromEntries(['project', 'title', 'description', 'priority', 'status', 'agent', 'run', 'pr'].filter(k => body[k] !== undefined).map(k => [k, body[k]]));
  switch (body.action) {
    case 'add':
      return addItem(fields);
    case 'set':
      return updateItem(body.id, fields);
    case 'archive':
      return archiveItem(body.id, true);
    case 'restore':
      return planItem(body.id).status === 'discarded' ? restoreDiscarded(body.id) : archiveItem(body.id, false);
    case 'propose': {
      const who = proposer({ run: body.run, step: body.step, by: body.by });
      return proposeItem({ project: body.project, title: body.title, summary: body.summary ?? body.description, agent: body.agent, priority: body.priority, by: who.by, run: who.run });
    }
    case 'triage':
      return triageItem(body.id, { priority: body.priority, agent: body.agent, recommend: body.recommend, note: body.note, order: body.order });
    case 'approve':
      // The manager's approval for the owner, within the autopilot's limits only.
      if (body.autopilot) return (await import('./autopilot.mjs')).autopilotApprove(body.id);
    // falls through
    case 'later':
    case 'discard':
      return decideItem(body.id, body.action, { reason: body.reason, by: body.by === 'manager' ? 'manager' : 'owner' });
    case 'reorder':
      return reorderItems(body.ids);
    default:
      throw new Error('Unknown planning action.');
  }
}

// ---------- For the manager ----------

const short = i => `#${i.id} ${i.project}: ${clip(i.title, 90)}`;
const PROPOSAL_STAGES = ['proposed', 'triaged', 'approved'];

/**
 * A short summary for the manager's situation: the proposals waiting for its triage, the decisions waiting for the
 * owner, the approved items waiting their turn, the open high-priority items and the pull requests waiting for the owner.
 */
export function planningLine(owner = 'the owner') {
  const open = planItems().filter(isOpen);
  if (!open.length) return 'Planning board: no open items (node src/cli.mjs plan add ... to add one).';
  const high = open.filter(i => i.priority === 'high' && i.status !== 'waiting_owner' && !PROPOSAL_STAGES.includes(i.status));
  const waiting = open.filter(i => i.status === 'waiting_owner');
  const proposed = open.filter(i => i.status === 'proposed');
  const deciding = open.filter(i => i.status === 'triaged').sort(byRank);
  const approved = open.filter(i => i.status === 'approved').sort(byRank);
  const more = (items, max) => (items.length > max ? `; and ${items.length - max} more` : '');
  const list = (items, max) => `${items.slice(0, max).map(short).join('; ')}${more(items, max)}`;
  const label = s => s.replace('_', ' ');
  const parts = [`Planning board (node src/cli.mjs plan): ${open.length} open item(s)`];
  parts.push(proposed.length
    ? `proposals waiting for your triage (plan triage, or plan discard): ${proposed.slice(0, 10).map(i => `${short(i)} (by ${i.proposed_by ?? '?'}${i.agent ? `, for ${i.agent}` : ''}, ${i.priority}${i.description ? `: ${clip(i.description, 120)}` : ''})`).join('; ')}${more(proposed, 10)}`
    : 'no proposal waiting for your triage');
  if (deciding.length) parts.push(`triaged, waiting for ${owner}'s decision, in order: ${deciding.slice(0, 8).map(i => `${short(i)} (recommended: ${i.recommend}, for ${i.agent})`).join('; ')}${more(deciding, 8)}`);
  if (approved.length) parts.push(`approved by ${owner}, waiting their turn (one task per project at a time): ${list(approved, 8)}`);
  parts.push(high.length ? `high priority: ${high.slice(0, 8).map(i => `${short(i)} (${label(i.status)})`).join('; ')}${more(high, 8)}` : 'no high-priority item open');
  parts.push(waiting.length ? `waiting for ${owner}: ${list(waiting, 8)}` : `nothing waiting for ${owner}`);
  return `${parts.join('. ')}.`;
}
