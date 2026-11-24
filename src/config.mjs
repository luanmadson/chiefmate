// The settings (config/chiefmate.json, created from config/example.json on the first run) and the crew (agents/*.md).
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { languageName, readJson, ROOT, writeJson } from './util.mjs';

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

/**
 * With "backup_dir" in the settings (a folder of your own, such as one in a private repository),
 * keeps an up-to-date copy of the settings there: on every save and whenever Chiefmate starts.
 */
export function backupConfig(config = loadConfig()) {
  if (!config.backup_dir) return;
  try {
    const target = path.join(config.backup_dir, 'chiefmate.json');
    const text = `${JSON.stringify(config, null, 2)}\n`;
    if (existsSync(target) && readFileSync(target, 'utf8') === text) return;
    mkdirSync(config.backup_dir, { recursive: true });
    writeFileSync(target, text);
  } catch (error) {
    console.error('Settings backup:', error.message);
  }
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
    const instructions = fill(parts[2].trim()) + (extra ? `\n\n## Notes for this installation\n\n${fill(extra)}` : '');
    agents[id] = { id, ...parseHeader(parts[1]), ...settings, instructions, file: `agents/${file}` };
  }
  return Object.fromEntries(Object.entries(agents).sort(([, a], [, b]) => (a.order ?? 99) - (b.order ?? 99)));
}

/** A project's "crew" setting as [member id, settings] pairs: a list of agent ids, or { "<member id>": { ... } }. */
function memberSpecs(crew) {
  if (Array.isArray(crew)) return crew.map(x => (typeof x === 'string' ? [x, {}] : [x?.id ?? x?.agent, x ?? {}])).filter(([id]) => id);
  return Object.entries(crew ?? {}).map(([id, spec]) => [id, spec ?? {}]);
}

/**
 * The crew of one project. With "projects.<id>.crew", only its members (plus the manager, who stays global):
 * { "<member id>": { "agent": "<base agent, the member id by default>", "name": "...", "extra_instructions": "...",
 * "model": "...", "max_minutes": 60, "mcp": ["playwright"] } } or simply ["generalist", "designer"].
 * Without it, the general crew. Each member keeps its base agent's face and instructions.
 */
export function projectCrew(config = loadConfig(), projectId, agents = loadAgents(config)) {
  const project = config.projects?.[projectId];
  if (!project?.crew) return agents;
  const team = agents.manager ? { manager: agents.manager } : {};
  for (const [id, spec] of memberSpecs(project.crew)) {
    const baseId = spec.agent ?? id;
    const base = agents[baseId];
    if (!base || baseId === 'manager') continue;
    const { agent: _base, id: _id, extra_instructions: extra, ...settings } = spec;
    const instructions = base.instructions + (extra ? `\n\n## Notes for this project's crew (${project.name ?? projectId})\n\n${extra}` : '');
    team[id] = { ...base, ...settings, id, base: baseId, project: projectId, instructions };
  }
  return team;
}

/** Whether a project has a crew of its own. */
export const hasOwnCrew = (config, projectId) => !!config.projects?.[projectId]?.crew;
