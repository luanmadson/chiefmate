// The prompt builder: a Markdown document of blocks, kept outside the repository, from which each step's project
// instructions are put together. "# Heading 1" opens a section, "## Heading 2" a block. The document's order is the
// prompt's order. Lines starting with "//" set the section's or block's options:
//   // selection: one | several | automatic | combinations | ignore
//                    (in Portuguese: seleção: uma | várias | automática | combinações | ignorar)
//   // label: Project                          a section's prefix for its blocks' headings (rótulo)
//   // tags: code, docs                         which tags the block carries
//   // access: browser, trello                  services the block needs signed in (acessos); they are joined into {ACESSOS}
//   // requires: code | book                    the block can only be chosen when these blocks or tags are chosen (requer)
//   // include with: code, docs                 when an automatic block comes in (incluir com)
//   // NAME = value                             a variable; "NAME = value" on a line of its own works too
// In "requires" and "include with", a comma asks for every item and a vertical bar for any of them; "always" (sempre)
// holds for any choice and "access" (acessos) when a chosen block needs a sign-in. {NAME} in the text is replaced by
// the variable's value, and a value can hold other variables: of the block, of its section or of the other blocks
// chosen. A section of combinations lists ready choices, one per line: "Name = Block + Block + Block".
// A step gets the project's block (projects.<id>.prompt_block), the environment (prompt_builder.environment), the
// optional modules (projects.<id>.prompt_modules, or --modules on a task) and the automatic blocks their choice brings,
// except those the project turned off (projects.<id>.prompt_exclude). Each block's details say how it came in.
// Lines that conflict with the crew's rules are adapted, and the adaptation is recorded: Chiefmate's rules prevail. A
// live session (src/sessions.mjs) gets the blocks its profile names, put together the same way, without the
// adaptation. The app's "Prompt builder" screen (#builder) works with the whole document through composeChoice.
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { t } from './i18n.mjs';
import { DATA, now, readJson, ROOT, WORKSPACES, writeJson } from './util.mjs';

export const SYNC_FILE = path.join(DATA, 'prompt-builder.json');
// The last choice made in the app's prompt builder, per project.
const CHOICES_FILE = path.join(DATA, 'prompt-builder-choices.json');
// A copy older than this is shown as old.
export const STALE_DAYS = 7;

/**
 * "prompt_builder": { "library_file": "<library>/<path>", "file": "data/manager/montador/PROMPTS_MONTADOR.md",
 * "doc_id": "...", "environment": "Home" }. The document is read from the library's copy (library_file) when there is
 * one; "file" is used without it, or while the library's copy is not there yet. "origin" says where "Reload" takes it
 * from: the library (git), Google Docs (doc_id) or the file on this computer, as it is.
 */
export function builderSettings(config) {
  const b = config.prompt_builder ?? {};
  const own = b.file ? path.resolve(ROOT, b.file) : null;
  const library = libraryFile(config, b.library_file);
  const file = library && (existsSync(library.file) || !own) ? library.file : own;
  const docId = b.doc_id ?? null;
  const origin = library ? 'library' : docId ? 'google' : 'file';
  return { file, docId, environment: b.environment ?? null, configured: !!file, library, origin };
}

/** "<library>/<path>" in the library's copy (workspaces/.library/<id>), or null. */
function libraryFile(config, raw) {
  const [id, ...rest] = String(raw ?? '').split(/[\\/]/).filter(Boolean);
  if (!id || !rest.length || rest.includes('..')) return null;
  const source = config.library?.[id];
  const dir = path.join(WORKSPACES, '.library', id);
  return { id, name: source?.name ?? id, known: !!source?.repository, path: rest.join('/'), dir, file: path.join(dir, ...rest) };
}

// When the library's copy was last brought up to date from GitHub: its last fetch, or its clone.
function libraryRefreshed(dir) {
  for (const name of ['FETCH_HEAD', 'HEAD']) {
    const file = path.join(dir, '.git', name);
    if (existsSync(file)) return statSync(file).mtime.toISOString();
  }
  return null;
}

/**
 * The copy on this computer: where it comes from, whether it exists, when it was brought up to date (for a library,
 * its last update from GitHub; else the last download or when the file was written), the document's last commit in
 * the library (recorded by src/promptsync.mjs) and the last reload.
 */
export function builderStatus(config) {
  const { file, docId, environment, configured, library, origin } = builderSettings(config);
  const exists = !!file && existsSync(file);
  const sync = readJson(SYNC_FILE, {});
  const modified = exists ? statSync(file).mtime.toISOString() : null;
  const fromLibrary = !!library && file === library.file;
  const copied = fromLibrary ? libraryRefreshed(library.dir) ?? modified : [sync.synced_at, modified].filter(Boolean).sort().at(-1) ?? null;
  const stale = !!copied && Date.now() - Date.parse(copied) > STALE_DAYS * 86_400_000;
  const commit = fromLibrary && sync.commit?.file === library.file ? sync.commit : null;
  return {
    configured, docId: !!docId, origin, environment, exists, modified, copied, stale, staleDays: STALE_DAYS, sync,
    source: fromLibrary ? 'library' : file ? 'file' : null,
    library: library ? { id: library.id, name: library.name, path: library.path, known: library.known } : null,
    file: fromLibrary ? null : file, commit,
  };
}

const norm = s =>
  String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
const values = raw => String(raw ?? '').split(/[,;]/).map(v => v.trim()).filter(Boolean);
// "a, b | c": every comma-separated group must hold, and a group holds when any of its "|" items does.
const condition = raw => values(raw).map(group => group.split('|').map(v => v.trim()).filter(Boolean)).filter(g => g.length);
const conditionText = groups => groups.map(g => g.join(' | ')).join(', ');
// Google Docs escapes some characters when it exports Markdown.
const unescape = s => s.replace(/\\([\\{}=#*_\-.[\]()!>+|`~:])/g, '$1');
const heading = s => unescape(s).replace(/\{#[^}]*\}\s*$/, '').replace(/^[*_]+|[*_]+$/g, '').trim();
const VARIABLE = /\{([A-Z][A-Z0-9_]*)\}/g;
// In the text, a variable escaped by the export ("\{REPO\_NOME\}") is read as {REPO_NOME}; nothing else is changed.
const placeholders = line => line.replace(/\\?\{([A-Z][A-Z0-9_\\]*)\\?\}/g, (whole, name) => `{${name.replace(/\\/g, '')}}`);

const OPTION = {
  selecao: 'selection', selection: 'selection', select: 'selection',
  rotulo: 'label', label: 'label',
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
  if (/^(combinac|combination|combos|atalho|shortcut)/.test(v)) return 'combinations';
  if (/^(ignorar|ignore|skip)/.test(v)) return 'ignore';
  return v || null;
}

const newSection = name => ({ name, selection: null, label: null, tags: [], access: [], requires: [], includeWith: [], vars: {}, blocks: [], combinations: [] });

/** Reads the document into sections and blocks; a section of combinations gets its "combinations". */
export function parseBlocks(text) {
  const sections = [];
  let section = null;
  let block = null;
  const target = () => block ?? section;
  for (const raw of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const h = raw.match(/^(#{1,2})\s+(.*)$/);
    if (h) {
      if (h[1] === '#') {
        sections.push((section = newSection(heading(h[2]))));
        block = null;
      } else {
        if (!section) sections.push((section = newSection('')));
        block = { name: heading(h[2]), section: section.name, selection: null, tags: [], access: [], requires: [], includeWith: [], vars: {}, lines: [] };
        section.blocks.push(block);
      }
      continue;
    }
    const directive = raw.match(/^\s*\/\/\s*(.*)$/);
    const line = directive ? unescape(directive[1]) : unescape(raw);
    if (!directive && !block && section?.selection === 'combinations') {
      const combo = line.match(/^\s*(.+?)\s*=\s*(.+)$/);
      if (combo) section.combinations.push({ name: combo[1].trim(), blocks: combo[2].split('+').map(b => b.trim()).filter(Boolean) });
      continue;
    }
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
        else if (key === 'label') target().label = option[2].trim() || null;
        else if (key === 'requires' || key === 'includeWith') target()[key].push(...condition(option[2]));
        else target()[key].push(...values(option[2]));
      }
      continue; // other "//" lines are comments
    }
    if (block) block.lines.push(placeholders(raw));
  }
  for (const s of sections) {
    for (const b of s.blocks) {
      b.selection ??= s.selection;
      b.label = s.label;
      b.text = b.lines.join('\n').trim();
      b.sectionVars = s.vars;
      delete b.lines;
    }
  }
  return sections;
}

/** The ready choices of the document's combinations sections: [{ name, blocks }]. */
export const combinations = sections => sections.flatMap(s => s.combinations ?? []);

// What the crew's rules forbid: pushing, opening pull requests, creating or switching branches, merging.
const CONFLICT = /\bgit push\b|\bpush\b|pull request|\bPR\b|\bmerge\b|(cri(e|ar|a)|abr(a|ir)|new|create|novo)\s+(um\s+|a\s+)?(novo\s+|new\s+)?branch|checkout -b|switch -c|(troque|mude|trocar|mudar|switch)\s+(de\s+)?branch/i;
const NEGATED = /\b(sem|nao|nunca|never|no|without|don't|do not|jamais)\b[^.]{0,40}(push|pull request|\bPR\b|merge|branch)/i;

/** Adapts the sentences that conflict with the crew's rules and returns the text, with the record of each adaptation. */
export function adaptText(text, blockName = '') {
  const adaptations = [];
  const lines = String(text ?? '').split('\n').map(line =>
    line
      .split(/(?<=[.!?;])\s+/)
      .map(sentence => {
        if (!CONFLICT.test(sentence) || NEGATED.test(norm(sentence))) return sentence;
        adaptations.push({ block: blockName, line: sentence.trim() });
        return `[Adapted by Chiefmate: "${sentence.trim()}" conflicts with the crew's rules (commit only on the run's branch; no push, no other branches, no pull requests). Chiefmate's rules prevail.]`;
      })
      .join(' '),
  );
  return { text: lines.join('\n'), adaptations };
}

function blockFinder(sections) {
  const all = sections.filter(s => !['ignore', 'combinations'].includes(s.selection)).flatMap(s => s.blocks);
  const find = (name, prefer) => {
    const n = norm(name);
    const matches = all.filter(b => norm(b.name) === n);
    return matches.find(b => !prefer || b.selection === prefer) ?? matches[0] ?? null;
  };
  return { all, find };
}

/** What a choice of blocks offers to the conditions: their names, tags and accesses, and whether any needs a sign-in. */
function marksOf(chosen) {
  const list = [...chosen];
  return { marks: new Set(list.flatMap(b => [b.name, ...b.tags, ...b.access]).map(norm)), access: list.some(b => b.access.length) };
}

/** Whether a "requires" or "include with" holds for a choice: every group, by any of its items. */
function holds(groups, { marks, access }) {
  return groups.every(group => group.some(item => {
    const n = norm(item);
    if (n === 'sempre' || n === 'always') return true;
    if (n === 'acessos' || n === 'access' || n === 'accesses') return access || marks.has(n);
    return marks.has(n);
  }));
}

/**
 * Whether an automatic block comes in: by its "include with"; with none, by sharing a tag or an access with the
 * blocks chosen (as older documents do); with no condition at all, always.
 */
function automaticOn(b, context) {
  if (b.includeWith.length) return holds(b.includeWith, context);
  const own = [...b.tags, ...b.access];
  return own.length ? own.some(x => context.marks.has(norm(x))) : true;
}

/**
 * The blocks a choice ends up with: the ones chosen and the automatic ones it brings (unless turned off), until nothing
 * new comes in. Returns { chosen (a Set), automatic (the blocks brought), unmet (chosen blocks whose "requires" fails) }.
 */
function resolveChoice(all, picked, off = new Set()) {
  const chosen = new Set(picked);
  const automatic = new Set();
  for (let grew = true; grew; ) {
    grew = false;
    const context = marksOf(chosen);
    for (const b of all) {
      if (chosen.has(b) || off.has(b) || b.selection !== 'automatic') continue;
      if (automaticOn(b, context) && holds(b.requires, context)) {
        chosen.add(b);
        automatic.add(b);
        grew = true;
      }
    }
  }
  const context = marksOf(chosen);
  const unmet = [...chosen].filter(b => !holds(b.requires, context));
  return { chosen, automatic, unmet, context };
}

/**
 * How an automatic block came in: by its "include with", by sharing a tag or an access with the choice (older
 * documents), by its "requires" alone (no other condition), or always. { how, condition }.
 */
function automaticReason(b) {
  if (b.includeWith.length) return { how: 'include-with', condition: conditionText(b.includeWith) };
  const own = [...b.tags, ...b.access];
  if (own.length) return { how: 'tags', condition: own.join(', ') };
  if (b.requires.length) return { how: 'requires', condition: conditionText(b.requires) };
  return { how: 'always', condition: '' };
}

/** The variables of a choice, from the first block (it takes precedence) to the sections; {ACESSOS} joins the accesses. */
function variablesOf(all, first, chosen, language) {
  const ordered = [first, ...all.filter(b => chosen.has(b) && b !== first)].filter(Boolean);
  const vars = {};
  const access = [...new Set(ordered.flatMap(b => b.access))];
  if (access.length) {
    let joined;
    try {
      joined = new Intl.ListFormat(language || 'en', { type: 'conjunction' }).format(access);
    } catch {
      joined = access.join(', ');
    }
    vars.ACESSOS = vars.ACCESS = joined;
  }
  for (const b of ordered) for (const [k, v] of Object.entries(b.vars)) vars[k] ??= v;
  for (const b of ordered) for (const [k, v] of Object.entries(b.sectionVars ?? {})) vars[k] ??= v;
  return vars;
}

/** Fills the variables in, again inside their values (up to 10 levels, so a loop stops); unknown ones stay as {NAME}. */
function filler(vars) {
  const fill = (text, depth = 0) => text.replace(VARIABLE, (whole, k) => (k in vars && depth < 10 ? fill(vars[k], depth + 1) : whole));
  return fill;
}

/**
 * The text of a resolved choice: each block, in the document's order, under "## <label>: <block>" (or "## <block>"),
 * variables filled in and, with adaptToCrew, the lines that conflict with the crew's rules adapted.
 * Returns { text, blocks, details, adaptations, unresolved }; "details" has each block's own text and how it came in
 * ("roles": why each chosen block was chosen; the automatic ones say it themselves).
 */
function render(all, first, chosen, { adaptToCrew = false, language, automatic = new Set(), roles = new Map() } = {}) {
  const fill = filler(variablesOf(all, first, chosen, language));
  const adaptations = [];
  const parts = [];
  const details = [];
  const blocks = all.filter(x => chosen.has(x));
  for (const b of blocks) {
    const filled = fill(b.text);
    const adapted = adaptToCrew ? adaptText(filled, b.name) : { text: filled, adaptations: [] };
    adaptations.push(...adapted.adaptations);
    const part = `## ${b.label ? `${b.label}: ` : ''}${b.name}\n\n${adapted.text}`.trim();
    parts.push(part);
    const why = automatic.has(b) ? automaticReason(b) : { how: 'chosen', condition: '', role: roles.get(b) ?? null };
    details.push({ name: b.name, section: b.section, ...why, adapted: adapted.adaptations.length, text: part });
  }
  const text = parts.join('\n\n');
  const unresolved = [...new Set([...text.matchAll(VARIABLE)].map(m => m[1]))];
  return { text, blocks: blocks.map(b => b.name), details, adaptations, unresolved };
}

/**
 * Puts a step's instructions together. Returns { text, blocks, adaptations, missing, unresolved } or null when the
 * project has no block. blockName (the project's block), environment, modules (optional blocks by name).
 */
export function assemble(sections, { blockName, environment, modules = [], off = [], language } = {}) {
  if (!blockName) return null;
  const { all, find } = blockFinder(sections);
  const missing = [];
  const picked = new Set();
  const roles = new Map();
  const pick = (name, prefer, what) => {
    const b = find(name, prefer);
    if (b) {
      picked.add(b);
      if (!roles.has(b)) roles.set(b, what);
    } else missing.push(`${what}: ${name}`);
    return b;
  };
  const project = pick(blockName, 'one', 'project block');
  if (!project) return { text: '', blocks: [], details: [], adaptations: [], missing, unresolved: [], off: [] };
  if (environment) pick(environment, 'one', 'environment');
  for (const m of modules) pick(m, 'several', 'module');
  // The automatic blocks the project turned off ("prompt_exclude"): they don't come in by themselves.
  const offSet = new Set(off.map(n => find(n)).filter(b => b && !picked.has(b)));
  const { chosen, automatic, unmet } = resolveChoice(all, picked, offSet);
  for (const b of unmet) missing.push(`requirement of "${b.name}": ${conditionText(b.requires)}`);
  return { ...render(all, project, chosen, { adaptToCrew: true, language, automatic, roles }), missing, off: [...offSet].map(b => b.name) };
}

/**
 * Blocks chosen by name, in any section (a live session's "prompt_blocks"), with the automatic blocks they bring and
 * their variables filled in, as for a step. Nothing is adapted: in a session the owner is there.
 * Returns { text, blocks, adaptations: [], missing, unresolved }.
 */
export function assembleBlocks(sections, names = [], { language, off = [] } = {}) {
  const { all, find } = blockFinder(sections);
  const missing = [];
  const picked = new Set();
  const roles = new Map();
  let first = null;
  for (const name of names) {
    const b = find(name);
    if (!b) missing.push(`block: ${name}`);
    else {
      first ??= b;
      picked.add(b);
      roles.set(b, 'profile');
    }
  }
  if (!first) return { text: '', blocks: [], details: [], adaptations: [], missing, unresolved: [] };
  const offSet = new Set(off.map(n => find(n)).filter(b => b && !picked.has(b)));
  const { chosen, automatic, unmet } = resolveChoice(all, picked, offSet);
  for (const b of unmet) missing.push(`requirement of "${b.name}": ${conditionText(b.requires)}`);
  return { ...render(all, first, chosen, { language, automatic, roles }), missing };
}

/**
 * The app's prompt builder: a choice made by hand. "chosen" are the blocks marked (automatic ones included, when marked
 * by hand), "off" the automatic blocks turned off. Returns the text (nothing adapted: it is the owner's own prompt),
 * the blocks it ended up with, which came in by themselves, which can't be chosen now ("requires" not met), the
 * requirements not met among the chosen, and the variables left unfilled.
 */
export function composeChoice(sections, { chosen = [], off = [], language } = {}) {
  const { all, find } = blockFinder(sections);
  const missing = [];
  const picked = [];
  for (const name of chosen) {
    const b = find(name);
    if (b) picked.push(b);
    else missing.push(name);
  }
  const offSet = new Set(off.map(n => find(n)).filter(Boolean));
  const { chosen: result, automatic, unmet, context } = resolveChoice(all, picked, offSet);
  const rendered = render(all, picked[0] ?? null, result, { language, automatic });
  return {
    ...rendered,
    automatic: [...automatic].map(b => b.name),
    off: [...offSet].map(b => b.name),
    unavailable: all.filter(b => !result.has(b) && !holds(b.requires, context)).map(b => b.name),
    unmet: unmet.map(b => ({ block: b.name, requires: conditionText(b.requires) })),
    missing,
  };
}

/** The document for the app: its sections and blocks (options and text), and its combinations. */
export function builderDocument(sections) {
  return {
    sections: sections.filter(s => s.selection !== 'ignore' && s.selection !== 'combinations' && s.blocks.length).map(s => ({
      name: s.name, selection: s.selection ?? 'several', label: s.label,
      blocks: s.blocks.map(b => ({
        name: b.name, selection: b.selection ?? 'several', tags: b.tags, access: b.access,
        requires: conditionText(b.requires), includeWith: conditionText(b.includeWith), text: b.text,
      })),
    })),
    combinations: combinations(sections),
  };
}

/** Reads the configured document, or null when there is no copy on this computer. */
export function readBuilder(config) {
  const { file } = builderSettings(config);
  return file && existsSync(file) ? parseBlocks(readFileSync(file, 'utf8')) : null;
}

/**
 * What the app's prompt builder shows for a project ("" for none): the copy's state, the document, the project's
 * block, the choice it starts with when there is no last one (the project's block, the environment and its modules)
 * and the last choice made for it.
 */
export function builderPage(config, projectId = '') {
  const project = projectId ? config.projects?.[projectId] : null;
  if (projectId && !project) throw new Error(t('Unknown project: {id}', { id: projectId }));
  const sections = readBuilder(config);
  const { environment } = builderSettings(config);
  const defaults = project?.prompt_block ? [project.prompt_block, environment, ...(project.prompt_modules ?? [])].filter(Boolean) : [];
  return {
    status: builderStatus(config), document: sections ? builderDocument(sections) : null,
    project: projectId, projectBlock: project?.prompt_block ?? null, defaults, defaultsOff: defaults.length ? project.prompt_exclude ?? [] : [], last: lastChoice(projectId),
  };
}

/** The app's choice put together, from the copy on this computer; remembered for the project. */
export function composeFromApp(config, { project = '', chosen = [], off = [], remember = true } = {}) {
  const sections = readBuilder(config);
  if (!sections) throw new Error(t('There is no copy of the prompt builder on this computer ("prompt_builder.file").'));
  const list = v => (Array.isArray(v) ? v.map(String) : []);
  const result = composeChoice(sections, { chosen: list(chosen), off: list(off), language: config.language });
  if (remember) rememberChoice(project, { chosen: list(chosen), off: list(off) });
  return result;
}

/** The last choice made in the app's prompt builder for a project ("" when none was chosen), or null. */
export const lastChoice = project => readJson(CHOICES_FILE, {})[String(project ?? '')] ?? null;

export function rememberChoice(project, { chosen = [], off = [] }) {
  const all = readJson(CHOICES_FILE, {});
  all[String(project ?? '')] = { chosen, off, at: now() };
  writeJson(CHOICES_FILE, all);
}

/**
 * The project's instructions from the prompt builder, or null when it doesn't apply (no file, no block for the
 * project): then the project's "notes" are used, as before.
 */
export function projectInstructions(config, project, extraModules = []) {
  const { file, environment } = builderSettings(config);
  if (!file || !project.prompt_block || !existsSync(file)) return null;
  const modules = [...new Set([...(project.prompt_modules ?? []), ...extraModules])];
  const built = assemble(parseBlocks(readFileSync(file, 'utf8')), { blockName: project.prompt_block, environment, modules, off: project.prompt_exclude ?? [], language: config.language });
  return built && built.blocks.length ? { ...built, file } : null;
}

/** A prompt written in the app's prompt builder, sent with a task: it replaces the one put together for the steps. */
export function writtenInstructions(text) {
  const adapted = adaptText(String(text ?? '').trim(), 'prompt builder (app)');
  const unresolved = [...new Set([...adapted.text.matchAll(VARIABLE)].map(m => m[1]))];
  return { text: adapted.text, blocks: ['(written in the app)'], adaptations: adapted.adaptations, missing: [], unresolved, file: '(the prompt sent with the task, from the app)' };
}
