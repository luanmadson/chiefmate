// The settings (config/chiefmate.json, created from config/example.json on the first run) and the crew (agents/*.md).
import { copyFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
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
 * {{owner}} and {{language}} in the instructions are filled in from the settings.
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
    agents[id] = { id, ...parseHeader(parts[1]), instructions: fill(parts[2].trim()), file: `agents/${file}` };
  }
  return Object.fromEntries(Object.entries(agents).sort(([, a], [, b]) => (a.order ?? 99) - (b.order ?? 99)));
}
