// The settings (config/chiefmate.json, created from config/example.json on the first run) and the crew (agents/*.md).
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DATA, languageName, now, readJson, ROOT, writeJson } from './util.mjs';

export const CONFIG_FILE = path.join(ROOT, 'config', 'chiefmate.json');
const EXAMPLE_FILE = path.join(ROOT, 'config', 'example.json');
const AGENTS_DIR = path.join(ROOT, 'agents');

export function loadConfig() {
  if (!existsSync(CONFIG_FILE) && existsSync(EXAMPLE_FILE)) copyFileSync(EXAMPLE_FILE, CONFIG_FILE);
  const config = readJson(CONFIG_FILE, null);
  if (!config) throw new Error(`Settings not found or invalid: ${CONFIG_FILE}`);
  return config;
}

export function saveConfig(config) {
  writeJson(CONFIG_FILE, config);
  backupConfig(config);
}

/** Where the full copy of the settings stays: Chiefmate's own data folder, on this computer only and never in git. */
export const FULL_BACKUP_DIR = path.join(DATA, 'config-backup');
/** The copies of the settings failing now (backupConfig), for the app's notice, the manager and the watch in src/plan.mjs. */
export const BACKUP_PROBLEMS = path.join(DATA, 'backup-problems.json');

/**
 * With "backup_dir" or "full_backup_dir" in the settings, keeps up-to-date copies of the settings, on every save and
 * whenever Chiefmate starts. In "backup_dir" (a folder of your own, such as one in a private repository), a redacted
 * one (redactConfig), since that folder is usually pushed somewhere. The full copy goes to FULL_BACKUP_DIR, on this
 * computer only, and to "full_backup_dir" when set (a private folder off this computer, such as a synced cloud one).
 * A copy refused or failing is kept in "problems" (backupProblems) by its place and cause, never with the settings'
 * values, from the first time ("since") while that cause lasts; it leaves once the copy works or is no longer asked for.
 */
export function backupConfig(config = loadConfig(), { fullDir = FULL_BACKUP_DIR, problems = BACKUP_PROBLEMS } = {}) {
  const failed = [];
  const copy = (target, dir, value) => {
    const problem = writeIfChanged(dir, value);
    if (problem) failed.push({ target, ...problem, log: `${target === 'local' ? 'the full copy on this computer' : target}: ${problem.log}` });
  };
  if (config.backup_dir || config.full_backup_dir) {
    if (config.backup_dir) copy('backup_dir', config.backup_dir, redactConfig(config));
    copy('local', fullDir, config);
    const refused = config.full_backup_dir && refusedFullDir(config.full_backup_dir, config.backup_dir);
    if (refused) failed.push({ target: 'full_backup_dir', ...refused, log: `full_backup_dir ${refused.log}, so the full copy is not written there.` });
    else if (config.full_backup_dir) copy('full_backup_dir', config.full_backup_dir, config);
  }
  recordProblems(failed, problems);
}

/** Why "full_backup_dir" may not take the full copy, or null: not a path, backup_dir's own folder, or inside git. */
function refusedFullDir(dir, redactedDir) {
  if (typeof dir !== 'string') return { cause: 'invalid', log: 'is not a folder path' };
  // path.relative ignores the case on Windows, where "C:\Backup" and "c:\backup" are the same folder
  if (typeof redactedDir === 'string' && redactedDir && path.relative(redactedDir, dir) === '') return { cause: 'same_folder', log: 'is the same folder as backup_dir' };
  // a git working tree: the folder or a parent has ".git" (a folder, or a file in a worktree or submodule)
  for (let at = path.resolve(dir); ; at = path.dirname(at)) {
    if (existsSync(path.join(at, '.git'))) return { cause: 'in_git', log: `is inside a git repository (${at})` };
    if (path.dirname(at) === at) return null;
  }
}

/** null once the copy is in "dir", else { cause, code, log }: the cause from the error's code, the log with its message. */
function writeIfChanged(dir, value) {
  if (typeof dir !== 'string') return { cause: 'invalid', code: null, log: 'not a folder path.' };
  try {
    const target = path.join(dir, 'chiefmate.json');
    const text = `${JSON.stringify(value, null, 2)}\n`;
    if (existsSync(target) && readFileSync(target, 'utf8') === text) return null;
    mkdirSync(dir, { recursive: true });
    writeFileSync(target, text);
    return null;
  } catch (error) {
    return { cause: backupCause(error), code: error.code ?? null, log: error.message };
  }
}

// A missing drive and a name Windows doesn't allow both give ENOENT; a file where the folder should be, EEXIST or ENOTDIR.
const CAUSES = {
  invalid: ['ENOENT', 'ENOTDIR', 'EEXIST', 'EISDIR', 'EINVAL', 'ENAMETOOLONG'],
  no_access: ['EACCES', 'EPERM', 'EROFS'],
  disk_full: ['ENOSPC', 'EDQUOT'],
};

/** A failed write's cause, in a word the notices explain: "invalid", "no_access", "disk_full", else "failed" (with its code). */
export const backupCause = error => Object.keys(CAUSES).find(cause => CAUSES[cause].includes(error?.code)) ?? 'failed';

// The problems this process already wrote in its log: once per cause, not again at each retry while it lasts.
const logged = new Set();
const problemKey = p => `${p.target}:${p.cause}`;

/** Keeps the problems found now, each with its first time ("since") and whether the owner was told, in "file". */
function recordProblems(failed, file) {
  try {
    const before = backupProblems(file);
    const at = now();
    const list = failed.map(f => {
      const old = before.find(p => problemKey(p) === problemKey(f));
      return { target: f.target, cause: f.cause, code: f.code ?? null, since: old?.since ?? at, told: old?.told ?? null };
    });
    for (const f of failed.filter(f => !logged.has(problemKey(f)))) {
      logged.add(problemKey(f));
      console.error(`Settings backup: ${f.log}`);
    }
    for (const key of logged) if (!failed.some(f => problemKey(f) === key)) logged.delete(key);
    if (JSON.stringify(list) !== JSON.stringify(before) && (list.length || existsSync(file))) writeJson(file, list);
  } catch (error) {
    console.error('Settings backup:', error.message); // a backup never gets in the way of a save or of the start
  }
}

/** The copies of the settings failing now: [{ target: "backup_dir" | "local" | "full_backup_dir", cause, code, since, told }]. */
export function backupProblems(file = BACKUP_PROBLEMS) {
  const list = readJson(file, []);
  return Array.isArray(list) ? list : [];
}

/** Marks these problems as told to the owner (src/plan.mjs): each cause is told once while it lasts. */
export function markBackupTold(told, file = BACKUP_PROBLEMS) {
  const at = now();
  const list = backupProblems(file);
  const marked = list.map(p => (told.some(x => problemKey(x) === problemKey(p) && x.since === p.since) ? { ...p, told: p.told ?? at } : p));
  if (JSON.stringify(marked) !== JSON.stringify(list)) writeJson(file, marked);
}

// Free text written by the owner (notes, instructions, descriptions): it is where personal data ends up, so the
// redacted copy drops it whole, wherever it is (projects, their crews and leads, the crew, missions, libraries).
const FREE_TEXT_KEYS = new Set(['about', 'notes', 'agent_notes', 'extra_instructions', 'description', 'part', 'note']);
// What names a secret: a setting's key, a command's flag ("--api-key") or an address's parameter ("?token=").
const SECRET = String.raw`token|secret|passw(?:or)?d|api[_-]?key|access[_-]?key|private[_-]?key|auth(?:orization)?(?![a-z])|cookie|credential|(?<![a-z])pin(?![a-z])`;
const SECRET_KEY = new RegExp(SECRET, 'i');
const SECRET_FLAG = new RegExp(String.raw`^--?[\w-]*(?:${SECRET})[\w-]*$`, 'i');
const MARK = { text: '[removed from this copy]', secret: '[secret]', id: '[id]', login: '[login]' };
// What is left in the other strings: secrets (a login inside an address, the value after a flag, parameter or header
// named like one, known token formats), then e-mails (not "git@host" nor "package@1.2.3"), Brazilian documents,
// phone numbers and amounts of money.
const PATTERNS = [
  [/(\/\/)[^\s/@:]+:[^\s/@]+@/g, '$1[secret]@'],
  [new RegExp(String.raw`((?:(?:${SECRET})[\w-]*(?:=|:\s*)|--?[\w-]*(?:${SECRET})[\w-]*\s+(?!-))['"]?(?:(?:Bearer|Basic)\s+)?)[^\s&#"']+`, 'gi'), '$1[secret]'],
  [/\b(?:(?:gh[pousr]|github_pat|sk_live|sk_test|rk_live|sbp)_|(?:sk|xai|glpat|xox[abprs])-)[\w-]{16,}|\bAKIA[0-9A-Z]{16}\b|\bAIza[\w-]{35}\b/g, '[secret]'],
  [/(?<![\w.+-])(?!git@)[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}\b/gi, '[email]'],
  [/\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b|\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g, '[document]'],
  [/(\+\d{2}\s?)?\(?\b\d{2}\)?\s?9?\d{4}-\d{4}\b/g, '[phone]'],
  [/(R\$|US\$|U\$|€|£|\$)\s?\d[\d.,]*|\b\d[\d.]*,\d{2}\b|\b\d[\d.,]*\s?(mil\s)?(reais|real|d[oó]lares|euros)\b/gi, '[amount]'],
];
const scrub = text => PATTERNS.reduce((t, [re, mark]) => t.replace(re, mark), text);

/**
 * The settings without personal data, for a copy kept in a repository: the free text becomes a marker, secrets
 * (in MCP servers' env and headers, under any key named like a secret, or after such a flag in a list of arguments),
 * remote logins and document ids are masked, and what PATTERNS finds in the other strings is replaced. The structure
 * stays, enough to rebuild the installation with the full local copy at hand.
 */
export function redactConfig(config) {
  // "mark": what every string or number inside becomes, once a key on the way says it is free text or a secret.
  const walk = (value, key = '', mark = null) => {
    mark ??= FREE_TEXT_KEYS.has(key) ? MARK.text : SECRET_KEY.test(key) ? MARK.secret : null;
    if (Array.isArray(value)) return value.map((v, i) => walk(v, key, mark ?? (i > 0 && SECRET_FLAG.test(value[i - 1]) ? MARK.secret : null)));
    if (value && typeof value === 'object') {
      const inner = mark ?? (key === 'env' || key === 'headers' ? MARK.secret : null);
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, k, inner)]));
    }
    if (value === '' || (typeof value !== 'string' && typeof value !== 'number')) return value;
    if (mark) return mark;
    if (typeof value === 'number') return value;
    if (key === 'logins') return MARK.login;
    if (key === 'doc_id') return MARK.id;
    return scrub(value);
  };
  return {
    backup_note: 'Redacted copy: notes, instructions, secrets and personal data are replaced by markers. The full copy stays on the computer, in data/config-backup/chiefmate.json of the installation, and in full_backup_dir when set.',
    ...walk(config),
  };
}

/** Reads an agent's header: "key: value", "key: [a, b]" or a list of "- item" lines. */
function parseHeader(text) {
  const header = {};
  let openList = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && openList) {
      header[openList].push(parseValue(item[1]));
      continue;
    }
    const pair = line.match(/^([\w-]+):\s*(.*)$/);
    if (!pair) continue;
    const [, key, raw] = pair;
    if (raw === '') {
      header[key] = [];
      openList = key;
    } else {
      header[key] = raw.startsWith('[') ? raw.slice(1, -1).split(',').map(parseValue).filter(v => v !== '') : parseValue(raw);
      openList = null;
    }
  }
  return header;
}

function parseValue(raw) {
  const text = raw.trim().replace(/^["']|["']$/g, '');
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  return text;
}

/**
 * The crew: one agent per file in agents/, sorted by "order".
 * {{owner}} and {{language}} in the instructions are filled in from the settings, and "crew" in the settings
 * adjusts an agent for this installation only: { "writer": { "model": "...", "max_minutes": 90, "extra_instructions": "..." } }.
 */
export function loadAgents(config = loadConfig()) {
  const fill = text =>
    text.replaceAll('{{owner}}', config.owner || 'the owner').replaceAll('{{language}}', languageName(config.language || 'en'));
  const agents = {};
  for (const file of readdirSync(AGENTS_DIR).filter(f => f.endsWith('.md'))) {
    const text = readFileSync(path.join(AGENTS_DIR, file), 'utf8');
    const parts = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (!parts) continue;
    const id = file.replace(/\.md$/, '');
    const { extra_instructions: extra, ...settings } = config.crew?.[id] ?? {};
    // Each part of the instructions with where it comes from (the project's Context tab shows them); joined, they are
    // the instructions, as they are sent.
    const instructionParts = [{ key: 'agent', source: `agents/${file}`, text: fill(parts[2].trim()) }];
    if (extra) instructionParts.push({ key: 'installation', source: `crew.${id}.extra_instructions`, text: `\n\n## Notes for this installation\n\n${fill(extra)}` });
    agents[id] = { id, ...parseHeader(parts[1]), ...settings, instructions: joinParts(instructionParts), instructionParts, file: `agents/${file}` };
  }
  return Object.fromEntries(Object.entries(agents).sort(([, a], [, b]) => (a.order ?? 99) - (b.order ?? 99)));
}

const joinParts = parts => parts.map(p => p.text).join('');
/** An agent's instruction parts; an agent made elsewhere (without them) has one: its whole instructions. */
const partsOf = agent => agent.instructionParts ?? [{ key: 'agent', source: agent.file ?? `agents/${agent.id}.md`, text: agent.instructions ?? '' }];

// The effort levels Claude Code takes (--effort); see src/effort.mjs and docs/effort.md.
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** A project's own effort for its members: projects.<id>.effort, { "<member id>": "<level>" }. */
export function projectEfforts(config, projectId) {
  const map = config.projects?.[projectId]?.effort;
  return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
}

/** The members of a team with the project's own effort applied (effortFrom: 'project'). */
function withProjectEfforts(team, config, projectId) {
  const own = projectEfforts(config, projectId);
  if (!Object.keys(own).length) return team;
  return Object.fromEntries(Object.entries(team).map(([id, m]) => [id, EFFORTS.includes(own[id]) ? { ...m, effort: own[id], effortFrom: 'project' } : m]));
}

/** A project's "crew" setting as [member id, settings] pairs: a list of agent ids, or { "<member id>": { ... } }. */
function memberSpecs(crew) {
  if (Array.isArray(crew)) return crew.map(x => (typeof x === 'string' ? [x, {}] : [x?.id ?? x?.agent, x ?? {}])).filter(([id]) => id);
  return Object.entries(crew ?? {}).map(([id, spec]) => [id, spec ?? {}]);
}

/**
 * The crew of one project. With "projects.<id>.crew", only its members (plus the manager, who stays global):
 * { "<member id>": { "agent": "<base agent, the member id by default>", "name": "...", "extra_instructions": "...",
 * "model": "...", "effort": "high", "max_minutes": 60, "mcp": ["playwright"] } } or simply ["generalist", "designer"].
 * Without it, the general crew. Each member keeps its base agent's face and instructions.
 * "projects.<id>.effort" ({ "<member id>": "<level>" }) sets the effort of any member for this project only, the manager's
 * reviews of its runs included.
 */
export function projectCrew(config = loadConfig(), projectId, agents = loadAgents(config)) {
  const project = config.projects?.[projectId];
  const lead = projectLead(config, projectId, agents);
  if (!project?.crew) return withProjectEfforts(lead ? { ...agents, lead } : agents, config, projectId);
  const team = agents.manager ? { manager: agents.manager } : {};
  if (lead) team.lead = lead;
  for (const [id, spec] of memberSpecs(project.crew)) {
    const baseId = spec.agent ?? id;
    const base = agents[baseId];
    if (!base || baseId === 'manager' || id === 'lead') continue;
    const { agent: _base, id: _id, extra_instructions: extra, ...settings } = spec;
    const instructionParts = [
      ...partsOf(base),
      ...(extra ? [{ key: 'project-member', source: `projects.${projectId}.crew.${id}.extra_instructions`, text: `\n\n## Notes for this project's crew (${project.name ?? projectId})\n\n${extra}` }] : []),
    ];
    team[id] = { ...base, ...settings, id, base: baseId, project: projectId, instructions: joinParts(instructionParts), instructionParts };
  }
  return withProjectEfforts(team, config, projectId);
}

// The lead reads and judges; it never changes the project's files.
const LEAD_NO_EDIT = ['Edit', 'Write', 'NotebookEdit', 'MultiEdit'];

/**
 * A project's team lead, from "projects.<id>.lead": { "name": "...", "agent": "<base agent, manager by default>",
 * "extra_instructions": "...", "model": "...", "max_minutes": 30 }. It is a member of the project's crew with the id
 * "lead": it keeps the project's memory, plans the requests sent with "ask" and reviews the crew's work first
 * (src/leads.mjs). It sees only its project. null when the project has no lead.
 */
export function projectLead(config, projectId, agents = loadAgents(config)) {
  const project = config.projects?.[projectId];
  const spec = project?.lead === true ? {} : project?.lead;
  if (!spec || typeof spec !== 'object') return null;
  const { agent: baseId = 'manager', name, extra_instructions: extra, ...settings } = spec;
  const base = agents[baseId] ?? agents.manager;
  if (!base) return null;
  const projectName = project.name ?? projectId;
  const role = `In this run you work only as the team lead of the project ${projectName}: not as Chiefmate's manager, and not as any other agent the instructions above describe. You don't talk to ${config.owner || 'the owner'}, you don't queue work with Chiefmate's command line (proposing items for the planning board, as the crew's rules say, is fine) and you don't look at other projects: you see only this project, its working copy and its own documentation.
- You keep the project's memory: the decisions, the history, ${config.owner || 'the owner'}'s preferences in this project and what was tried. Chiefmate gives it to you in each prompt and saves the version you return.
- You plan each request sent to this project into a few tasks for the project's crew.
- You do the first review of the crew's work and write your opinion for the manager, who does the final review and talks with ${config.owner || 'the owner'}.
- You read, search and run commands that change nothing. You never edit, write or commit the project's files.`;
  const instructionParts = [
    ...partsOf(base),
    { key: 'lead-role', source: 'Chiefmate (src/config.mjs, projectLead)', text: `\n\n## Your role here: team lead of ${projectName}\n\n${role}` },
    ...(extra ? [{ key: 'lead-notes', source: `projects.${projectId}.lead.extra_instructions`, text: `\n\n## Notes for the team lead of ${projectName}\n\n${extra}` }] : []),
  ];
  return {
    ...base,
    ...settings,
    id: 'lead',
    name: name || 'Team lead',
    title: 'Team lead',
    role: "Keeps the project's memory, plans each request into tasks for the crew and reviews their work first.",
    base: base.id,
    project: projectId,
    lead: true,
    tools: (base.tools ?? []).filter(x => !LEAD_NO_EDIT.includes(x)),
    disallowed: [...new Set([...(base.disallowed ?? []), ...LEAD_NO_EDIT, 'Bash(git commit:*)'])],
    instructions: joinParts(instructionParts),
    instructionParts,
    ...(EFFORTS.includes(projectEfforts(config, projectId).lead) ? { effort: projectEfforts(config, projectId).lead, effortFrom: 'project' } : {}),
  };
}

/** Whether a project has a crew of its own. */
export const hasOwnCrew = (config, projectId) => !!config.projects?.[projectId]?.crew;
