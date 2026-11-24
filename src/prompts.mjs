// The prompt builder: a Markdown document of blocks, kept outside the repository, from which each step's project
// instructions are put together. "# Heading 1" opens a section, "## Heading 2" a block. Lines starting with "//" set
// the section's or block's options:
//   // selection: one | several | automatic     (in Portuguese: seleção: uma | várias | automática)
//   // tags: code, docs                         which tags the block carries
//   // access: browser, trello                  what the block needs (acessos)
//   // requires: <block>, <access>              blocks it brings along, or accesses it needs (requer)
//   // include with: <block>, <block>           an automatic block that comes with these blocks (incluir com)
//   // NAME = value                             a variable; "NAME = value" on a line of its own works too
// and {NAME} in the text is replaced by the variable's value.
// A step gets the project's block (projects.<id>.prompt_block), the environment (prompt_builder.environment), the
// optional modules of a "several" section (projects.<id>.prompt_modules, or --modules on a task) and the automatic
// blocks that match their tags, accesses or names. Lines that conflict with the crew's rules are adapted, and the
// adaptation is recorded: Chiefmate's rules prevail.
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { DATA, ROOT, readJson } from './util.mjs';

export const SYNC_FILE = path.join(DATA, 'prompt-builder.json');

/** "prompt_builder": { "file": "data/manager/montador/PROMPTS_MONTADOR.md", "doc_id": "...", "environment": "Home" } */
export function builderSettings(config) {
  const b = config.prompt_builder ?? {};
  const file = b.file ? path.resolve(ROOT, b.file) : null;
  return { file, docId: b.doc_id ?? null, environment: b.environment ?? null, configured: !!file };
}

/** The copy on this computer: where it is, whether it exists, when it was written and the last synchronization. */
export function builderStatus(config) {
  const { file, docId, environment, configured } = builderSettings(config);
  const exists = !!file && existsSync(file);
  return {
    configured, docId: !!docId, environment, exists,
    modified: exists ? statSync(file).mtime.toISOString() : null,
    sync: readJson(SYNC_FILE, {}),
  };
}

const norm = s =>
  String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
const values = raw => String(raw ?? '').split(/[,;]/).map(v => v.trim()).filter(Boolean);
// Google Docs escapes some characters when it exports Markdown.
const unescape = s => s.replace(/\\([\\{}=#*_\-.[\]()!>+|`~])/g, '$1');
const heading = s => unescape(s).replace(/\{#[^}]*\}\s*$/, '').replace(/^[*_]+|[*_]+$/g, '').trim();

const OPTION = {
  selecao: 'selection', selection: 'selection', select: 'selection',
  tags: 'tags', tag: 'tags',
  requer: 'requires', requires: 'requires', require: 'requires',
  'incluir com': 'includeWith', 'include with': 'includeWith',
  acessos: 'access', acesso: 'access', access: 'access',
};

function selectionKind(raw) {
  const v = norm(raw);
  if (/^(uma|unica|one|single)/.test(v)) return 'one';
  if (/^(varias|multiplas|several|multiple|many|opcional)/.test(v)) return 'several';
  if (/^(automatica|auto|sempre|always)/.test(v)) return 'automatic';
  return v || null;
}

/** Reads the document into sections and blocks. */
export function parseBlocks(text) {
  const sections = [];
  let section = null;
  let block = null;
  const target = () => block ?? section;
  for (const raw of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const h = raw.match(/^(#{1,2})\s+(.*)$/);
    if (h) {
      if (h[1] === '#') {
        section = { name: heading(h[2]), selection: null, tags: [], access: [], requires: [], includeWith: [], vars: {}, blocks: [] };
        sections.push(section);
        block = null;
      } else {
        if (!section) sections.push((section = { name: '', selection: null, tags: [], access: [], requires: [], includeWith: [], vars: {}, blocks: [] }));
        block = { name: heading(h[2]), section: section.name, selection: null, tags: [], access: [], requires: [], includeWith: [], vars: {}, lines: [] };
        section.blocks.push(block);
      }
      continue;
    }
    const directive = raw.match(/^\s*\/\/\s*(.*)$/);
    const line = directive ? unescape(directive[1]) : unescape(raw);
    const variable = line.match(/^\s*([A-Z][A-Z0-9_]+)\s*=\s*(.*)$/);
    if (variable && target()) {
      target().vars[variable[1]] = variable[2].trim();
      continue;
    }
    if (directive) {
      const option = line.match(/^\s*([^:=]+?)\s*[:=]\s*(.*)$/);
      const key = option && OPTION[norm(option[1])];
      if (key && target()) {
        if (key === 'selection') target().selection = selectionKind(option[2]);
        else target()[key].push(...values(option[2]));
      }
      continue; // other "//" lines are comments
    }
    if (block) block.lines.push(raw.replace(/\\\{/g, '{').replace(/\\\}/g, '}'));
  }
  for (const s of sections) {
    for (const b of s.blocks) {
      b.selection ??= s.selection;
      b.text = b.lines.join('\n').trim();
      b.sectionVars = s.vars;
      delete b.lines;
    }
  }
  return sections;
}

// What the crew's rules forbid: pushing, opening pull requests, creating or switching branches, merging.
const CONFLICT = /\bgit push\b|\bpush\b|pull request|\bPR\b|\bmerge\b|(cri(e|ar|a)|abr(a|ir)|new|create|novo)\s+(um\s+|a\s+)?(novo\s+|new\s+)?branch|checkout -b|switch -c|(troque|mude|trocar|mudar|switch)\s+(de\s+)?branch/i;
const NEGATED = /\b(sem|nao|nunca|never|no|without|don't|do not|jamais)\b[^.]{0,40}(push|pull request|\bPR\b|merge|branch)/i;

/** Adapts the sentences that conflict with the crew's rules and returns the text, with the record of each adaptation. */
function adapt(block, text) {
  const adaptations = [];
  const lines = text.split('\n').map(line =>
    line
      .split(/(?<=[.!?;])\s+/)
      .map(sentence => {
        if (!CONFLICT.test(sentence) || NEGATED.test(norm(sentence))) return sentence;
        adaptations.push({ block: block.name, line: sentence.trim() });
        return `[Adapted by Chiefmate: "${sentence.trim()}" conflicts with the crew's rules (commit only on the run's branch; no push, no other branches, no pull requests). Chiefmate's rules prevail.]`;
      })
      .join(' '),
  );
  return { text: lines.join('\n'), adaptations };
}

/**
 * Puts the instructions together. Returns { text, blocks, adaptations, missing } or null when the project has no block.
 * blockName (the project's block), environment, modules (optional blocks by name).
 */
export function assemble(sections, { blockName, environment, modules = [] }) {
  if (!blockName) return null;
  const all = sections.flatMap(s => s.blocks);
  const find = (name, prefer) => {
    const n = norm(name);
    const matches = all.filter(b => norm(b.name) === n);
    return matches.find(b => !prefer || b.selection === prefer) ?? matches[0] ?? null;
  };
  const missing = [];
  const chosen = new Set();
  const pick = (name, prefer, what) => {
    const b = find(name, prefer);
    if (b) chosen.add(b);
    else missing.push(`${what}: ${name}`);
    return b;
  };
  const project = pick(blockName, 'one', 'project block');
  if (!project) return { text: '', blocks: [], adaptations: [], missing };
  if (environment) pick(environment, 'one', 'environment');
  for (const m of modules) pick(m, 'several', 'module');

  // Automatic blocks: those that come with a chosen block, or share a tag or an access with them; with no condition, always.
  // Required blocks come along too, until nothing new comes in.
  for (let grew = true; grew; ) {
    grew = false;
    const names = new Set([...chosen].map(b => norm(b.name)));
    const marks = new Set([...chosen].flatMap(b => [...b.tags, ...b.access, ...b.requires]).map(norm));
    for (const b of all) {
      if (chosen.has(b)) continue;
      let take = false;
      if (b.selection === 'automatic') {
        const conditions = b.includeWith.length + b.tags.length + b.access.length;
        take = !conditions || b.includeWith.some(n => names.has(norm(n))) || [...b.tags, ...b.access].some(x => marks.has(norm(x)));
      }
      if (!take && [...chosen].some(c => c.requires.some(r => norm(r) === norm(b.name)))) take = true;
      if (take) {
        chosen.add(b);
        grew = true;
      }
    }
  }

  // Variables: the project's block first, then the environment, the modules and the rest; section variables last.
  const ordered = [project, ...[...chosen].filter(b => b !== project)];
  const vars = {};
  for (const b of ordered) for (const [k, v] of Object.entries(b.vars)) vars[k] ??= v;
  for (const b of ordered) for (const [k, v] of Object.entries(b.sectionVars ?? {})) vars[k] ??= v;
  const fill = s => s.replace(/\{([A-Z][A-Z0-9_]+)\}/g, (whole, k) => (k in vars ? vars[k] : whole));

  const adaptations = [];
  const parts = [];
  for (const b of all.filter(x => chosen.has(x))) {
    const adapted = adapt(b, fill(b.text));
    adaptations.push(...adapted.adaptations);
    parts.push(`## ${b.name}\n\n${adapted.text}`.trim());
  }
  return { text: parts.join('\n\n'), blocks: all.filter(x => chosen.has(x)).map(b => b.name), adaptations, missing };
}

/**
 * The project's instructions from the prompt builder, or null when it doesn't apply (no file, no block for the
 * project): then the project's "notes" are used, as before.
 */
export function projectInstructions(config, project, extraModules = []) {
  const { file, environment } = builderSettings(config);
  if (!file || !project.prompt_block || !existsSync(file)) return null;
  const modules = [...new Set([...(project.prompt_modules ?? []), ...extraModules])];
  const built = assemble(parseBlocks(readFileSync(file, 'utf8')), { blockName: project.prompt_block, environment, modules });
  return built && built.blocks.length ? { ...built, file } : null;
}
