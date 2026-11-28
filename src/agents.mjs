// The agents as entities (docs/agents.md): each one with a name, a base agent (its role, from agents/*.md), the
// projects it works in, a specialty, a rank, a status, its own memory in each project and its record. Three kinds:
// - "agent": one of the settings' "agents" ({ name, base, projects, specialty, instructions, model, effort, tool, rank,
//   status, hired_at }), with its own id;
// - "role": an agent of agents/*.md, the general crew, in every project without a crew of its own;
// - "member": a member of a project's own crew (projects.<id>.crew), known as "<member>@<project>".
// Without "agents" in the settings, the roles and the projects' crews are the agents, as before.
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { EFFORTS, explicitAgent, loadAgents, loadConfig, memberSpecs, projectCrew, reservedAgentId, saveConfig } from './config.mjs';
import { readDefects } from './defects.mjs';
import { effortSource, setEffort } from './effort.mjs';
import { t } from './i18n.mjs';
import { LEAD, takeBlock } from './leads.mjs';
import { listRuns, stepsOf } from './store.mjs';
import { agentTool, cleanRecord, localDay, readQuality, stepRecords, sumRecords, TOOLS, toolModel } from './tools.mjs';
import { clip, DATA, ensureDir, now } from './util.mjs';

/** The ranks, from the first to the highest: more autonomy and responsibility as they go up (docs/agents.md). */
export const RANKS = ['junior', 'mid', 'senior', 'lead'];
export const RANK_DEFAULT = 'mid';
export const STATUSES = ['active', 'inactive'];
/** How many of an agent's latest tasks its rank weighs. */
export const RANK_WINDOW = 20;
/**
 * When the record suggests a promotion (up) or a demotion (down), over the latest RANK_WINDOW tasks: at least "tasks"
 * of them, the share approved with no correction at least (up) or under (down) "clean", and at most (up) or at least
 * (down) "failed" failures. Only a suggestion: the manager proposes, the owner decides.
 */
export const RANK_RULES = {
  junior: { up: { tasks: 5, clean: 0.7, failed: 0 } },
  mid: { up: { tasks: 10, clean: 0.8, failed: 1 }, down: { tasks: 5, clean: 0.5, failed: 3 } },
  senior: { up: { tasks: 20, clean: 0.85, failed: 1 }, down: { tasks: 5, clean: 0.6, failed: 3 } },
  lead: { down: { tasks: 5, clean: 0.7, failed: 3 } },
};
/** An agent's memory in a project, at most this many characters: past it, only the start is kept. */
export const MEMORY_MAX = 4000;

const agentsDir = () => path.join(DATA, 'agents');
const historyFile = () => path.join(agentsDir(), 'history.jsonl');

/** A rank in the owner's words. */
export const rankName = rank => ({ junior: t('Junior'), mid: t('Mid-level'), senior: t('Senior'), lead: t('Team lead') })[rank] ?? rank;

const rankOf = a => (RANKS.includes(a?.rank) ? a.rank : RANK_DEFAULT);
const statusOf = a => (a?.status === 'inactive' ? 'inactive' : 'active');

// ---------- Who the agents are ----------

function entry({ key, id, kind, member, projects, source }) {
  return {
    key, id, kind, source, projects, member,
    name: member.name ?? id, base: member.base ?? id, title: member.title ?? null, specialty: member.specialty || member.role || null,
    rank: rankOf(member), status: statusOf(member), hired_at: member.hired_at ?? null,
  };
}

/**
 * Every agent, explicit or not: [{ key, id (its id in a project's crew), kind, name, base, title, specialty, rank,
 * status, hired_at, projects, source (where its settings are), member (the crew member as built) }]. The manager and
 * the team leads are not among them: the manager is global, each lead is its project's (docs/agents.md).
 */
export function roster(config = loadConfig(), agents = loadAgents(config)) {
  const projects = Object.keys(config.projects ?? {});
  const own = projects.filter(p => config.projects[p]?.crew);
  const list = [];
  for (const [id, member] of Object.entries(agents)) {
    if (id !== 'manager') list.push(entry({ key: id, id, kind: 'role', member, projects: projects.filter(p => !own.includes(p)), source: `crew.${id}` }));
  }
  for (const p of own) {
    const team = projectCrew(config, p, agents, { inactive: true });
    for (const [m] of memberSpecs(config.projects[p].crew)) {
      const member = team[m];
      // An agent of the settings with that id took its place in the project.
      if (member && !member.explicit && m !== LEAD && m !== 'manager') list.push(entry({ key: `${m}@${p}`, id: m, kind: 'member', member, projects: [p], source: `projects.${p}.crew.${m}` }));
    }
  }
  for (const id of Object.keys(config.agents ?? {})) {
    const member = explicitAgent(config, id, agents);
    if (member) list.push(entry({ key: id, id, kind: 'agent', member, projects: member.projects.filter(p => config.projects?.[p]), source: `agents.${id}` }));
  }
  return list;
}

/** The agent behind a member of a project's crew (a step's "agent"): its key, or null for the manager and the team lead. */
export function agentKey(config, projectId, memberId) {
  const id = String(memberId ?? '');
  if (!id || id === 'manager' || id === LEAD) return null;
  if ((config.agents?.[id]?.projects ?? []).includes(projectId)) return id;
  const crew = config.projects?.[projectId]?.crew;
  if (crew && memberSpecs(crew).some(([m]) => m === id)) return `${id}@${projectId}`;
  return id;
}

/**
 * The agent a person names: its key ("ana", "writer", "generalist@site"), a member's id with its project, or, when only
 * one agent has it, a name or a member id. null when none (or more than one) fits.
 */
export function findAgent(config, name, project = null, list = roster(config)) {
  const asked = String(name ?? '').trim();
  if (!asked) return null;
  const key = project && !asked.includes('@') ? agentKey(config, project, asked) : asked;
  const found = list.find(a => a.key === key);
  if (found) return found;
  const like = list.filter(a => a.id === asked || a.name.toLowerCase() === asked.toLowerCase());
  return like.length === 1 ? like[0] : null;
}

// ---------- Its memory in each project: data/agents/<key>/memory/<project>.md ----------

const safeName = id => String(id).replace(/[^\w.@-]/g, '_').replace(/^\.+/, '_');
export const agentMemoryFile = (key, projectId) => path.join(agentsDir(), safeName(key), 'memory', `${safeName(projectId)}.md`);
/** Whether the crew keeps a memory ("agent_memory": false turns it off). */
export const memoryOn = config => config?.agent_memory !== false;

export function readAgentMemory(key, projectId) {
  try {
    return readFileSync(agentMemoryFile(key, projectId), 'utf8').trim();
  } catch {
    return '';
  }
}

/** Its size and last save, for the app and the manager; null when there is none yet. */
export function agentMemoryInfo(key, projectId) {
  try {
    const file = agentMemoryFile(key, projectId);
    const text = readFileSync(file, 'utf8').trim();
    return text ? { chars: text.length, lines: text.split('\n').length, updated: statSync(file).mtime.toISOString() } : null;
  } catch {
    return null;
  }
}

/** The memory within its ceiling: whole lines from the start, with a note that it was cut, so the agent condenses it. */
export function trimMemory(text, max = MEMORY_MAX) {
  const body = String(text ?? '').trim();
  if (body.length <= max) return { text: body, trimmed: false };
  const note = `\n(cut at ${max} characters: condense it)`;
  let kept = '';
  for (const line of body.split('\n')) {
    if ((kept ? kept.length + 1 : 0) + line.length > max - note.length) break;
    kept += (kept ? '\n' : '') + line;
  }
  return { text: (kept || body.slice(0, max - note.length)) + note, trimmed: true };
}

/** Saves an agent's memory in a project, within its ceiling: { chars, trimmed }. */
export function saveAgentMemory(key, projectId, text) {
  const { text: body, trimmed } = trimMemory(text);
  const file = agentMemoryFile(key, projectId);
  ensureDir(path.dirname(file));
  writeFileSync(file, `${body}\n`);
  return { chars: body.length, trimmed };
}

/** The memory a step returned, taken out of its report: { memory (or null), report }. */
export function takeAgentMemory(report) {
  const { body, report: rest } = takeBlock(report, 'agent-memory');
  return { memory: body, report: rest };
}

/** A crew member's part of the prompt (src/runs.mjs, promptParts): its memory in this project, and how to return it. */
export function agentMemoryLines({ memory, name, projectName, max = MEMORY_MAX }) {
  return [
    '',
    `## Your memory in this project (${name}'s own; ${memory.length} of ${max} characters)`,
    memory || '(empty: start it at the end of this task)',
    '',
    'At the very end of your last message, after your report, return this memory whole and updated, in a block fenced exactly like this:',
    '~~~agent-memory',
    '<your whole memory for this project>',
    '~~~',
    `Keep in it only short, lasting lessons for your next tasks in ${projectName}, one line each: what worked, the owner's preferences, the project's pitfalls. The most important first; merge what repeats and drop what no longer helps, so it stays under ${max} characters (past that, only the start is kept). Never secrets, passwords or personal data. Chiefmate keeps it for you in this project only and takes the block out of your report. With nothing new to keep, return it unchanged.`,
  ];
}

// ---------- Its record: the steps register (src/tools.mjs, data/manager/tools-quality.jsonl) ----------

const made = new Map(); // run id: { updated, records } made from the run itself

/**
 * Every crew step's record (src/tools.mjs, stepRecords) with the agent behind it ("who"): the register's, and for the
 * runs that ended before every step was recorded, records made from the run itself (kept in memory, never written).
 */
export function agentRecords({ config = loadConfig(), runs = listRuns(), records = readQuality(), agents = loadAgents(config) } = {}) {
  const full = records.filter(r => r.v === 2);
  const covered = new Set(full.map(r => r.run));
  const known = new Set(runs.map(r => r.id));
  const names = {};
  const namesOf = p => (names[p] ??= Object.fromEntries(Object.entries(projectCrew(config, p, agents, { inactive: true })).map(([id, m]) => [id, m.name ?? id])));
  const fromRun = run => {
    const hit = made.get(run.id);
    if (hit && hit.updated === run.updated) return hit.records;
    const list = stepRecords(run, run.review?.commits ?? [], { names: config.projects?.[run.project] ? namesOf(run.project) : {} });
    made.set(run.id, { updated: run.updated, records: list });
    return list;
  };
  // The older records (steps on Codex or Grok only) count when their run is gone; else the run itself is read.
  const older = records.filter(r => r.v !== 2 && !covered.has(r.run) && !known.has(r.run));
  const rest = runs.filter(r => ['done', 'failed'].includes(r.status) && !covered.has(r.id)).flatMap(fromRun);
  return [...older, ...full, ...rest].map(r => (r.who ? r : { ...r, who: agentKey(config, r.project, r.agent) }));
}

const when = r => String(r.ended ?? r.at ?? '');

function sumUp(list) {
  const s = sumRecords(list);
  return { ...s, rate: s.count ? s.clean / s.count : null, last: list.reduce((m, r) => (when(r) > m ? when(r) : m), '') || null };
}

/**
 * One agent's record from its steps' records: all of them, the latest RANK_WINDOW (what its rank weighs), by project,
 * the latest five and how many defects of Chiefmate it reported.
 */
export function agentPerformance(list, defects = 0) {
  const sorted = [...list].sort((a, b) => when(a).localeCompare(when(b)));
  const projects = [...new Set(sorted.map(r => r.project))];
  return {
    all: sumUp(sorted), recent: sumUp(sorted.slice(-RANK_WINDOW)), defects,
    byProject: Object.fromEntries(projects.map(p => [p, sumUp(sorted.filter(r => r.project === p))])),
    latest: sorted.slice(-5).reverse().map(r => ({
      run: r.run, project: r.project, task: r.task, status: r.status, clean: cleanRecord(r), corrected: r.corrected ?? null, note: r.note || '', at: when(r) || null, durationMs: r.durationMs ?? null, tool: r.tool ?? 'claude',
    })),
  };
}

/** How many defects of Chiefmate each agent reported (src/defects.mjs) from a step of a run: { key: count }. */
export function defectsBy(config, runs, defects = readDefects()) {
  const byRun = new Map(runs.map(r => [r.id, r]));
  const count = {};
  for (const d of defects) {
    const keys = new Set();
    for (const s of d.reporters ?? []) {
      const run = s.kind === 'step' ? byRun.get(s.id) : null;
      const step = run && stepsOf(run)[Number(s.step) - 1];
      const key = step && agentKey(config, run.project, step.agent);
      if (key) keys.add(key);
    }
    for (const k of keys) count[k] = (count[k] ?? 0) + 1;
  }
  return count;
}

/**
 * What the record suggests for the rank (RANK_RULES), or null: { move: promote | demote, to, count, clean, failed }.
 * recent: the record of the latest RANK_WINDOW tasks.
 */
export function rankAdvice(rank, recent) {
  const at = RANKS.indexOf(rankOf({ rank }));
  const { up, down } = RANK_RULES[RANKS[at]];
  const { count = 0, clean = 0, failed = 0 } = recent ?? {};
  const rate = count ? clean / count : 0;
  const facts = { count, clean, failed };
  if (down && count >= down.tasks && (rate < down.clean || failed >= down.failed)) return { move: 'demote', to: RANKS[at - 1], ...facts };
  if (up && count >= up.tasks && rate >= up.clean && failed <= up.failed) return { move: 'promote', to: RANKS[at + 1], ...facts };
  return null;
}

// ---------- Changes: hiring, adjusting, deactivating ----------

const ID = /^[a-z][a-z0-9_-]{1,31}$/;
const MAX_TEXT = { name: 40, specialty: 160, instructions: 4000, model: 60 };
/** What may be changed, with "agents set" and the app's "Adjust". */
export const AGENT_FIELDS = ['name', 'base', 'projects', 'specialty', 'instructions', 'model', 'effort', 'tool', 'rank', 'status', 'max_minutes'];
const OWNER_FIELDS = ['rank', 'status'];
// Where a field is kept for each kind (the rest under its own name).
const STORED = { agent: {}, role: { instructions: 'extra_instructions' }, member: { instructions: 'extra_instructions', base: 'agent' } };

/** The changes recorded, oldest first (data/agents/history.jsonl). agent: only that agent's. */
export function agentHistory({ agent = null, file = historyFile() } = {}) {
  if (!existsSync(file)) return [];
  const list = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    try {
      if (line.trim()) list.push(JSON.parse(line));
    } catch {
      // a broken line is skipped
    }
  }
  return agent ? list.filter(e => e.agent === agent) : list;
}

function record(entry, file = historyFile()) {
  ensureDir(path.dirname(file));
  appendFileSync(file, `${JSON.stringify({ at: now(), ...entry })}\n`);
}

/** A field as written by a person; null clears it ("" or "default": back to the base's), undefined leaves it. */
function fieldValue(field, value, { config, agents }) {
  if (value === undefined) return undefined;
  if (field === 'projects') {
    const list = (Array.isArray(value) ? value : String(value ?? '').split(',')).map(x => String(x).trim()).filter(Boolean);
    for (const p of list) if (!config.projects?.[p]) throw new Error(t('Unknown project: {id}', { id: p }));
    return [...new Set(list)];
  }
  const text = String(value ?? '').trim();
  if (!text || text.toLowerCase() === 'default') return null;
  const one = (list, error) => {
    if (!list.includes(text)) throw new Error(error);
    return text;
  };
  switch (field) {
    case 'base': return one(Object.keys(agents).filter(id => id !== 'manager'), t('The base must be one of the agents: {list}.', { list: Object.keys(agents).filter(id => id !== 'manager').join(', ') }));
    case 'effort': return one(EFFORTS, t('Unknown effort "{level}". Use: {list}.', { level: text, list: EFFORTS.join(', ') }));
    case 'tool': return one(TOOLS, t('Unknown tool "{tool}". Use: {list}.', { tool: text, list: TOOLS.join(', ') }));
    case 'rank': return one(RANKS, t('Unknown rank "{rank}". Use: {list}.', { rank: text, list: RANKS.join(', ') }));
    case 'status': return one(STATUSES, t('Unknown status "{status}". Use: {list}.', { status: text, list: STATUSES.join(', ') }));
    case 'max_minutes': {
      const n = Number(text);
      if (!Number.isInteger(n) || n < 5 || n > 1440) throw new Error(t('The time limit is a whole number of minutes, from 5 to 1440.'));
      return n;
    }
    default:
      if (text.length > (MAX_TEXT[field] ?? 200)) throw new Error(t('The {field} is too long: at most {count} characters.', { field, count: MAX_TEXT[field] ?? 200 }));
      return field === 'instructions' ? text : text.replace(/\s+/g, ' ');
  }
}

/** Where an agent's own settings are kept, made when missing: agents.<id>, crew.<id> or projects.<p>.crew.<m>. */
function settingsOf(config, a) {
  if (a.kind === 'agent') return config.agents[a.id];
  if (a.kind === 'role') {
    config.crew ??= {};
    return (config.crew[a.id] ??= {});
  }
  const project = config.projects[a.projects[0]];
  // A crew written as a list becomes the same crew as an object, so a member can have settings of its own.
  if (Array.isArray(project.crew)) {
    project.crew = Object.fromEntries(memberSpecs(project.crew).map(([id, spec]) => {
      const { id: _id, ...rest } = spec && typeof spec === 'object' ? spec : {};
      return [id, rest];
    }));
  }
  return (project.crew[a.id] ??= {});
}

/**
 * Hires, adjusts, deactivates or activates an agent. action: add | set | deactivate | activate. key: the new agent's id
 * (add) or the agent's key. fields: { name, base, projects, specialty, instructions, model, effort, tool, rank, status,
 * max_minutes } ("" or "default" clears one, back to its base's). by: owner or manager; hiring, the status and the rank
 * are the owner's (the manager proposes a rank: rankProposal). The effort goes through src/effort.mjs, so its history
 * records it. Each change is recorded in data/agents/history.jsonl. save, file and effortFile: for the tests.
 * Returns { agent, action, changes: { field: { from, to } } }.
 */
export function changeAgent({ action, key, project = null, fields = {}, by = 'owner', proposal = null }, { config = loadConfig(), save = saveConfig, file = historyFile(), effortFile } = {}) {
  const asked = Object.fromEntries(Object.entries(fields ?? {}).filter(([k, v]) => AGENT_FIELDS.includes(k) && v !== undefined));
  if (action === 'deactivate' || action === 'activate') {
    Object.assign(asked, { status: action === 'deactivate' ? 'inactive' : 'active' });
  } else if (action !== 'add' && action !== 'set') throw new Error(t('Unknown action: {action}', { action }));
  if (by !== 'owner' && (action !== 'set' || OWNER_FIELDS.some(f => f in asked))) {
    throw new Error(t('Hiring, deactivating and changing a rank are the owner\'s: the manager proposes a rank with "agents propose".'));
  }
  const agents = loadAgents(config);
  const next = structuredClone(config);
  const changes = {};
  if (action === 'add') {
    const id = String(key ?? '').trim();
    if (!ID.test(id)) throw new Error(t('An agent\'s id has 2 to 32 characters: lowercase letters, digits, "-" or "_", starting with a letter.'));
    if (reservedAgentId(id, agents)) throw new Error(t('{id} is the id of a base agent, the manager or the team lead: choose another.', { id }));
    if (config.agents?.[id]) throw new Error(t('There is already an agent {id}.', { id }));
    const spec = {};
    for (const f of AGENT_FIELDS) {
      const v = fieldValue(f, asked[f], { config, agents });
      if (v != null) spec[f] = v;
    }
    if (!spec.base) throw new Error(t('Say which agent it is based on: --base <agent>.'));
    const hired = {
      name: spec.name ?? id.charAt(0).toUpperCase() + id.slice(1), base: spec.base, projects: spec.projects ?? [], ...spec,
      rank: spec.rank ?? 'junior', status: 'active', hired_at: localDay(),
    };
    next.agents = { ...(next.agents ?? {}), [id]: hired };
    for (const [f, v] of Object.entries(hired)) changes[f] = { from: null, to: v };
    save(next);
    record({ by, agent: id, action, changes }, file);
    return { agent: id, action, changes };
  }
  const a = findAgent(config, key, project);
  if (!a) throw new Error(t('Unknown agent: {id}', { id: key ?? '' }));
  if (!Object.keys(asked).length) throw new Error(t('Nothing to change: give a field, such as --specialty or --model.'));
  if (a.kind !== 'agent' && 'projects' in asked) {
    throw new Error(a.kind === 'role'
      ? t('An agent of the general crew works in every project without a crew of its own: to choose its projects, add an agent of your own (agents add).')
      : t("A member of a project's own crew works in that project only."));
  }
  if (a.kind === 'role' && 'base' in asked) throw new Error(t('An agent of the general crew is its own base.'));
  const own = settingsOf(next, a);
  const mapped = STORED[a.kind];
  let effort;
  for (const [f, raw] of Object.entries(asked)) {
    const v = fieldValue(f, raw, { config, agents });
    if (f === 'effort') {
      effort = v ?? 'default';
      continue;
    }
    const k = mapped[f] ?? f;
    const from = own[k] ?? null;
    // An agent of the general crew or a project's member is active by default: "active" leaves no setting.
    const to = f === 'status' && v === 'active' && a.kind !== 'agent' ? null : v;
    if (JSON.stringify(from) === JSON.stringify(to)) continue;
    if (to == null) delete own[k];
    else own[k] = to;
    changes[f] = { from, to };
  }
  if (a.kind === 'role' && !Object.keys(own).length) delete next.crew[a.id];
  if (Object.keys(changes).length) save(next);
  if (effort) {
    const e = setEffort({ member: a.id, level: effort, project: a.kind === 'member' ? a.projects[0] : null, by, config: Object.keys(changes).length ? next : config, save, ...(effortFile ? { file: effortFile } : {}) });
    if (e.changed) changes.effort = { from: e.from, to: e.to };
  }
  if (Object.keys(changes).length) record({ by, agent: a.key, action, changes, ...(proposal ? { proposal } : {}) }, file);
  return { agent: a.key, action, changes };
}

// ---------- The manager's proposals of a rank, decided by the owner ----------

/**
 * The manager's proposal to change an agent's rank, as the fields of the owner's question card (addQuestion in
 * src/decisions.mjs): its first option applies it once the owner answers (settleRank). open: the questions open, to
 * refuse a second proposal for the same agent. stats: the agent's recent record, said on the card.
 */
export function rankProposal(a, to, why, { stats = null, by = 'manager', open = [] } = {}) {
  if (!RANKS.includes(to)) throw new Error(t('Unknown rank "{rank}". Use: {list}.', { rank: to, list: RANKS.join(', ') }));
  if (a.status === 'inactive') throw new Error(t('{name} is inactive.', { name: a.name }));
  if (to === a.rank) throw new Error(t('{name} is already {rank}.', { name: a.name, rank: rankName(to) }));
  const waiting = open.find(q => q.status === 'open' && q.rank?.agent === a.key);
  if (waiting) throw new Error(t('A proposal for {name} already waits for the owner: question #{id}.', { name: a.name, id: waiting.id }));
  const reason = String(why ?? '').replace(/\s+/g, ' ').trim().slice(0, 400);
  if (!reason) throw new Error(t('Say why, in one sentence: --why "<reason>".'));
  const up = RANKS.indexOf(to) > RANKS.indexOf(a.rank);
  const names = { name: a.name, from: rankName(a.rank), to: rankName(to) };
  const facts = stats?.count ? t('Record: {clean} of the latest {count} task(s) approved with no correction, {failed} failed.', { clean: stats.clean, count: stats.count, failed: stats.failed }) : t('No task recorded yet.');
  return {
    question: up ? t('Promote {name} from {from} to {to}?', names) : t('Move {name} down from {from} to {to}?', names),
    context: `${reason} ${facts}`,
    options: [t('Approve'), t('Keep as is')],
    recommend: t('Approve'),
    project: a.projects.length === 1 ? a.projects[0] : null,
    level: 2,
    rank: { agent: a.key, name: a.name, from: a.rank, to, why: reason, by },
  };
}

/**
 * The owner's answer to a rank proposal (a question card with "rank"): its first option applies it; another option, a
 * discard or words alone keep the rank. Returns { applied, agent, name, from, to }.
 */
export function settleRank(q, { config = loadConfig(), save = saveConfig, file = historyFile() } = {}) {
  const p = q.rank;
  if (q.status !== 'answered' || q.answer !== q.options?.[0]) {
    record({ by: 'owner', agent: p.agent, action: 'rank-kept', changes: { rank: { from: p.from, to: p.from } }, proposal: q.id, ...(q.note ? { note: q.note } : {}) }, file);
    return { applied: false, ...p };
  }
  const a = findAgent(config, p.agent);
  if (!a) throw new Error(t('{agent} is no longer one of the agents.', { agent: p.agent }));
  changeAgent({ action: 'set', key: a.key, fields: { rank: p.to }, by: 'owner', proposal: q.id }, { config, save, file });
  return { applied: true, ...p };
}

// ---------- What the app and the manager see ----------

/**
 * The agents for the app (state.agents): each one's facts, tool, model and effort, record, the rank the record suggests,
 * the manager's proposal waiting for the owner and its memory in each project (size only: the text is read apart).
 */
export function agentsView({ config = loadConfig(), runs = listRuns(), agents = loadAgents(config), records = readQuality(), defects = readDefects(), questions = [] } = {}) {
  const all = agentRecords({ config, runs, records, agents });
  const mine = new Map();
  for (const r of all) if (r.who) mine.set(r.who, [...(mine.get(r.who) ?? []), r]);
  const found = defectsBy(config, runs, defects);
  const proposals = questions.filter(q => q.status === 'open' && q.rank);
  return {
    memoryOn: memoryOn(config), memoryMax: MEMORY_MAX, ranks: RANKS, rules: RANK_RULES, window: RANK_WINDOW,
    list: roster(config, agents).map(a => {
      const m = a.member;
      const choice = agentTool(config, m);
      const perf = agentPerformance(mine.get(a.key) ?? [], found[a.key] ?? 0);
      const open = proposals.find(q => q.rank.agent === a.key);
      return {
        key: a.key, id: a.id, kind: a.kind, name: a.name, base: a.base, title: a.title, specialty: a.specialty, rank: a.rank, status: a.status,
        hired_at: a.hired_at, projects: a.projects, source: a.source,
        model: choice.tool === 'claude' ? m.model ?? config.default_model ?? null : toolModel(choice.tool, m.model),
        tool: choice.tool, toolAsked: choice.asked, toolUntil: choice.until, toolReason: choice.reason,
        effort: m.effort ?? null, effortFrom: effortSource(config, a.kind === 'member' ? a.projects[0] : null, m), maxMinutes: m.max_minutes ?? null,
        color: m.color ?? null, face: m.face ?? null,
        // Instructions of its own, besides its base's (the agent's, the project crew's or the installation's).
        own: (m.instructionParts ?? []).some(p => ['agent-own', 'project-member', 'installation'].includes(p.key)),
        record: perf, advice: a.status === 'active' ? rankAdvice(a.rank, perf.recent) : null,
        proposal: open ? { question: open.id, card: `question:${open.id}`, from: open.rank.from, to: open.rank.to, why: open.rank.why, at: open.at, options: open.options } : null,
        memory: Object.fromEntries(a.projects.map(p => [p, agentMemoryInfo(a.key, p)])),
      };
    }),
  };
}

/**
 * An agent's own settings, as the app's "Adjust" shows them: { key, kind, name, settings: { name, base, projects,
 * specialty, instructions, model, effort, tool, rank, max_minutes } }, each one its own (null: its base's).
 */
export function agentSettings(config, key) {
  const a = findAgent(config, key);
  if (!a) throw new Error(t('Unknown agent: {id}', { id: key ?? '' }));
  const own = (a.kind === 'agent' ? config.agents?.[a.id]
    : a.kind === 'role' ? config.crew?.[a.id]
      : memberSpecs(config.projects?.[a.projects[0]]?.crew).find(([m]) => m === a.id)?.[1]) ?? {};
  const stored = STORED[a.kind];
  const settings = Object.fromEntries(AGENT_FIELDS.filter(f => f !== 'status').map(f => [f, own[stored[f] ?? f] ?? null]));
  if (a.kind === 'member' && !settings.base) settings.base = a.base;
  return { key: a.key, kind: a.kind, name: a.name, base: a.base, rank: a.rank, projects: a.projects, settings };
}

/** An agent's memory in one of its projects, for the app's card: { text, info }. */
export function agentMemoryText(config, key, projectId) {
  const a = findAgent(config, key);
  if (!a) throw new Error(t('Unknown agent: {id}', { id: key ?? '' }));
  if (!config.projects?.[projectId]) throw new Error(t('Unknown project: {id}', { id: projectId ?? '' }));
  return { agent: a.key, project: projectId, text: readAgentMemory(a.key, projectId), info: agentMemoryInfo(a.key, projectId) };
}

const percent = s => (s.count ? `${Math.round((s.clean / s.count) * 100)}%` : '-');

/** The manager's lines about the agents (its situation): the team by project with names, ranks and records, and the proposals. */
export function teamLines(config, view, owner = 'the owner') {
  const line = a => `${a.name} [${a.key}] (${a.kind === 'role' ? '' : `based on ${a.base}, `}${a.rank}${a.kind === 'agent' && a.specialty ? `, "${clip(a.specialty, 70)}"` : ''}; ${a.record.all.count ? `${a.record.all.count} task(s), ${percent(a.record.all)} with no correction` : 'no task yet'})`;
  const active = view.list.filter(a => a.status === 'active');
  const lines = [`Agents by project (each keeps its own memory in each project and a record; \`node src/cli.mjs agents [show <key>]\`; in task, ask and plan use the key, or the id before "@" with its project):`];
  const roles = active.filter(a => a.kind === 'role');
  const general = roles[0]?.projects ?? [];
  if (roles.length && general.length) lines.push(`- General crew, in ${general.join(', ')}: ${roles.map(line).join(', ')}.`);
  for (const p of Object.keys(config.projects ?? {})) {
    const team = active.filter(a => a.kind !== 'role' && a.projects.includes(p));
    if (team.length) lines.push(`- Project ${p}${config.projects[p].crew ? ' (only these take its tasks)' : ', besides the general crew'}: ${team.map(line).join(', ')}.`);
  }
  const off = view.list.filter(a => a.status === 'inactive');
  if (off.length) lines.push(`- Inactive, taking no new work: ${off.map(a => `${a.name} [${a.key}]`).join(', ')}.`);
  const waiting = view.list.filter(a => a.proposal);
  if (waiting.length) lines.push(`- Your rank proposals waiting for ${owner}'s card: ${waiting.map(a => `#${a.proposal.question} ${a.name} [${a.key}] ${a.proposal.from} to ${a.proposal.to}`).join('; ')}.`);
  const advised = active.filter(a => a.advice && !a.proposal);
  if (advised.length) {
    lines.push(`- The record meets the criteria (docs/agents.md) to ${advised.map(a => `${a.advice.move} ${a.name} [${a.key}] to ${a.advice.to} (${a.advice.clean} of the latest ${a.advice.count} approved with no correction, ${a.advice.failed} failed)`).join('; ')}. When you agree, propose it: \`node src/cli.mjs agents propose <key> --rank <rank> --why "<one sentence>"\`.`);
  }
  return lines;
}
