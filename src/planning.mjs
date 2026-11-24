// The owner's planning board: items by project, with a priority and a status, kept in data/plan.json.
// An item linked to a run follows it: queued, in progress, then done (or waiting for the owner, with a pull request
// to approve), or back to "to do" when the run fails or is canceled.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { onRunSaved, readRun } from './store.mjs';
import { clip, DATA, now, readJson, writeJson } from './util.mjs';

const BOARD_FILE = path.join(DATA, 'plan.json');
// The manager's board from before this one: a Markdown table, imported once when data/plan.json does not exist yet.
const LEGACY_FILE = path.join(DATA, 'manager', 'plan.md');

export const PRIORITIES = ['high', 'medium', 'low'];
export const STATUSES = ['future', 'todo', 'queued', 'in_progress', 'waiting_owner', 'done'];
// The board's order within a priority: what needs the owner first, what is done last.
const STATUS_ORDER = ['waiting_owner', 'in_progress', 'queued', 'todo', 'future', 'done'];

const plain = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9#]+/g, ' ').trim();

const PRIORITY_WORDS = {
  high: ['high', 'h', '1', 'alta', 'a'],
  medium: ['medium', 'med', 'm', '2', 'media'],
  low: ['low', 'l', '3', 'baixa', 'b'],
};
const STATUS_WORDS = {
  future: ['future', 'later', 'someday', 'futuro'],
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

const byBoardOrder = (a, b) =>
  PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority) || STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || a.id - b.id;

/** Every item, in the board's order: priority, then what needs the owner, then the number. */
export const planItems = () => [...readBoard().items].sort(byBoardOrder);

function findIn(board, id) {
  const item = board.items.find(i => i.id === Number(String(id ?? '').replace(/^#/, '')));
  if (!item) throw new Error(`Item ${id} not found on the planning board.`);
  return item;
}

export const planItem = id => findIn(readBoard(), id);

// ---------- Following the linked run ----------

/** The item's status for the run's: done with a pull request waits for the owner to approve it. */
function statusForRun(run) {
  switch (run.status) {
    case 'queued':
    case 'waiting':
    case 'paused':
      return 'queued';
    case 'running':
      return 'in_progress';
    case 'done':
      return run.pullRequest ? 'waiting_owner' : 'done';
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
  for (const item of board.items) {
    if (run.plan != null && item.id === Number(run.plan) && item.run !== run.id) {
      Object.assign(item, { run: run.id, run_status: null });
      changed = true;
    }
    if (item.run === run.id && !item.archived) changed = follow(item, run) || changed;
  }
  if (changed) saveBoard(board);
}
onRunSaved(syncRun);

// ---------- Changes (the app, the command line) ----------

const RUN_ID = /^[\w.-]{1,80}$/;

/** Checks and applies the fields given: project, title, description, priority, status, run, pr. */
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
  if (has('status')) item.status = parseStatus(fields.status);
  if (has('pr')) {
    const pr = String(fields.pr).trim();
    item.pr = !pr ? null : /^\d+$/.test(pr) ? `#${pr}` : pr.slice(0, 300);
  }
  if (has('run')) {
    const id = String(fields.run).trim();
    if (!id) Object.assign(item, { run: null, run_status: null });
    else {
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
  applyFields(item, { priority: 'medium', status: 'todo', ...fields });
  if (!item.project) throw new Error('The project is missing.');
  if (!item.title) throw new Error('The title is missing.');
  board.items.push(item);
  board.next = Math.max(board.next, item.id) + 1;
  saveBoard(board);
  return item;
}

export function updateItem(id, fields) {
  const board = readBoard();
  const item = findIn(board, id);
  applyFields(item, fields);
  item.updated = now();
  saveBoard(board);
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

/** The app's commands: { action: add | set | archive | restore, id, ...fields }. */
export function changePlan(body = {}) {
  const fields = Object.fromEntries(['project', 'title', 'description', 'priority', 'status', 'run', 'pr'].filter(k => body[k] !== undefined).map(k => [k, body[k]]));
  switch (body.action) {
    case 'add':
      return addItem(fields);
    case 'set':
      return updateItem(body.id, fields);
    case 'archive':
    case 'restore':
      return archiveItem(body.id, body.action === 'archive');
    default:
      throw new Error('Unknown planning action.');
  }
}

// ---------- For the manager ----------

const short = i => `#${i.id} ${i.project}: ${clip(i.title, 90)}`;

/** A short summary for the manager's situation: the open high-priority items and the ones waiting for the owner. */
export function planningLine(owner = 'the owner') {
  const open = planItems().filter(i => !i.archived && i.status !== 'done');
  if (!open.length) return 'Planning board: no open items (node src/cli.mjs plan add ... to add one).';
  const high = open.filter(i => i.priority === 'high' && i.status !== 'waiting_owner');
  const waiting = open.filter(i => i.status === 'waiting_owner');
  const list = (items, max) => `${items.slice(0, max).map(short).join('; ')}${items.length > max ? `; and ${items.length - max} more` : ''}`;
  const label = s => s.replace('_', ' ');
  const parts = [`Planning board (node src/cli.mjs plan): ${open.length} open item(s)`];
  parts.push(high.length ? `high priority: ${high.slice(0, 8).map(i => `${short(i)} (${label(i.status)})`).join('; ')}${high.length > 8 ? `; and ${high.length - 8} more` : ''}` : 'no high-priority item open');
  parts.push(waiting.length ? `waiting for ${owner}: ${list(waiting, 8)}` : `nothing waiting for ${owner}`);
  return `${parts.join('. ')}.`;
}
