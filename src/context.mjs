// A project's context, visible and controllable (the Context tab of the project's page, and "project-context" on the
// command line). For each member of the project's crew, its team lead and the manager's final review: everything the
// step gets, put together by the same code the runs use (promptParts and stepTools in src/runs.mjs, the agents'
// instructionParts in src/config.mjs, the prompt builder in src/prompts.mjs), in the real order, with where each part
// comes from and its approximate size in tokens. Then the first message of each live session of the project, and what
// changed since the last real run (against the .context.md files the steps wrote). The owner's changes from the app
// (the prompt builder's blocks, extra instructions and notes) are previewed before they are saved, and each saving is
// kept in data/projects/<id>/context-history.jsonl.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { instructionFiles, stepAccess, stepMcp } from './access.mjs';
import { loadAgents, loadConfig, projectCrew, saveConfig } from './config.mjs';
import { t } from './i18n.mjs';
import { LEAD, leadReviewStep, markReview, memoryFile } from './leads.mjs';
import { projectOf } from './projects.mjs';
import { builderSettings, builderStatus, projectInstructions, readBuilder } from './prompts.mjs';
import { libraryIds, promptParts, stepTool, stepTools } from './runs.mjs';
import { managerAddress, planSession, sessionProfiles, withManager } from './sessions.mjs';
import { listRuns, stepsOf } from './store.mjs';
import { toolModel } from './tools.mjs';
import { ensureDir, now, RUNS, WORKSPACES } from './util.mjs';
import { projectDir, runBranch } from './workspace.mjs';

/** About 4 characters per token: an estimate, enough to compare the parts. */
export const tokens = text => Math.ceil(String(text ?? '').length / 4);

// In the preview, what only a real run knows.
const RUN_TITLE = "(the run's title)";
const TASK = '(the task given to this step)';
const REVIEW_TASK = '(what the manager is asked to review)';
const CHANGES = '(the files the run changed)';

const historyFile = id => path.join(path.dirname(memoryFile(id)), 'context-history.jsonl');

// How Claude Code treats each of the repository's instruction files (src/access.mjs lists them).
function fileKind(file) {
  const name = path.posix.basename(file);
  if (['CLAUDE.md', 'CLAUDE.local.md', '.claude/CLAUDE.md'].includes(file) || (file.startsWith('.claude/rules/') && file.endsWith('.md'))) return 'start';
  if (name === 'CLAUDE.md') return 'folder';
  if (name === 'AGENTS.md') return 'agents';
  if (file === '.mcp.json') return 'ignored';
  if (file.startsWith('.claude/settings')) return 'settings';
  return 'other';
}

/** The repository's instruction files in a folder, each with how it is used and, for the text ones, its size. */
function repositoryFiles(dir) {
  if (!dir || !existsSync(dir)) return { dir, exists: false, files: [] };
  const files = instructionFiles(dir).map(file => {
    const kind = fileKind(file);
    let text = null;
    if (['start', 'folder', 'agents'].includes(kind)) {
      try {
        text = readFileSync(path.join(dir, file), 'utf8');
      } catch {
        text = null;
      }
    }
    return { file, kind, text, tokens: text == null ? 0 : tokens(text) };
  });
  return { dir, exists: true, files };
}

/** The libraries a run would prepare, where they would be (nothing is downloaded for a preview). */
function previewLibraries(config, project) {
  return [...new Set(libraryIds(project))].filter(id => config.library?.[id]).map(id => ({
    id, name: config.library[id].name ?? id, about: config.library[id].about ?? '', dir: path.join(WORKSPACES, '.library', id),
  }));
}

const previewBase = project =>
  project.main_branch && project.main_branch !== 'current' ? project.main_branch : project.main_branch === 'current' ? '(the branch checked out in your clone)' : '(the base branch)';

/** The prompt builder for the project: whether it is used, its result, and the blocks the project can turn on or off. */
function builderFor(config, id, project) {
  const status = builderStatus(config);
  const info = { configured: status.configured, exists: status.exists, copied: status.copied, stale: status.stale, block: project.prompt_block ?? null,
    environment: builderSettings(config).environment, modules: project.prompt_modules ?? [], exclude: project.prompt_exclude ?? [], used: false, built: null, error: null, options: null };
  if (!status.configured || !status.exists || !project.prompt_block) return info;
  try {
    info.built = projectInstructions(config, project);
    info.used = !!info.built;
    const sections = readBuilder(config);
    const active = new Map((info.built?.details ?? []).map(d => [d.name, d]));
    const blocks = (sections ?? []).filter(s => !['ignore', 'combinations'].includes(s.selection)).flatMap(s => s.blocks);
    info.options = {
      modules: blocks.filter(b => (b.selection ?? 'several') === 'several').map(b => ({ name: b.name, section: b.section, on: info.modules.includes(b.name), active: active.has(b.name) })),
      automatic: blocks.filter(b => b.selection === 'automatic').map(b => ({ name: b.name, section: b.section, off: info.exclude.includes(b.name), active: active.has(b.name), how: active.get(b.name)?.how ?? null })),
    };
  } catch (error) {
    info.error = error.message;
  }
  return info;
}

const text = lines => lines.join('\n').replace(/^\n+/, '');

/** Everything one member of the project's crew gets, in order. */
function memberContext({ config, id, project, team, memberId, builder, libraries, repository }) {
  const agent = team[memberId];
  const kind = memberId === 'manager' ? 'manager' : memberId === LEAD ? 'lead' : 'member';
  const finalReview = kind === 'manager';
  const step = kind === 'lead' ? leadReviewStep() : { agent: memberId, part: finalReview ? REVIEW_TASK : TASK, status: 'running' };
  // The lead's review as in a level 1 run: the final one when the project delegates it (src/leads.mjs).
  if (kind === 'lead') markReview({ project: id, level: 1, review: { status: 'pending' } }, step, config);
  const run = { id: '(run id)', kind: 'task', project: id, title: RUN_TITLE, branch: runBranch(project, '(run id)', 'title'), instruction: null, steps: [step], lead: null };
  const access = stepAccess({ config, projectId: id, project, libraries, manager: finalReview });
  const mcp = stepMcp(config, project, agent);
  const { tools, disallowed } = stepTools(agent, mcp, { denied: [] });
  const parts = promptParts({
    run, step, project, previous: [], finalReview, changes: CHANGES, config, libraries, base: previewBase(project), access, built: builder.built, agents: team,
  });
  const system = (agent.instructionParts ?? [{ key: 'agent', source: agent.file, text: agent.instructions }]).map(p => ({
    key: p.key, source: p.source, text: p.text.replace(/^\n+/, ''), tokens: tokens(p.text),
  }));
  const prompt = parts.map(p => {
    const part = { key: p.key, source: p.source, text: text(p.lines), tokens: tokens(p.lines.join('\n')) };
    if (p.key === 'builder' && builder.built) {
      Object.assign(part, {
        blocks: builder.built.details.map(d => ({ ...d, tokens: tokens(d.text) })),
        missing: builder.built.missing, unresolved: builder.built.unresolved, adaptations: builder.built.adaptations, off: builder.built.off ?? [],
      });
    }
    return part;
  });
  const sum = list => list.reduce((n, p) => n + p.tokens, 0);
  const repo = repository.files.filter(f => f.kind === 'start');
  const total = { system: sum(system), repository: sum(repo), prompt: sum(prompt) };
  const { tool } = stepTool(config, agent, finalReview, { project });
  return {
    id: memberId, name: agent.name ?? memberId, base: agent.base ?? null, kind, role: kind === 'lead' ? 'review' : finalReview ? 'final review' : 'task',
    tool,
    model: tool === 'claude' ? agent.model ?? config.default_model ?? null : toolModel(tool, agent.model), effort: agent.effort ?? null, maxMinutes: agent.max_minutes ?? 60,
    system, repository, prompt,
    access: {
      workingCopy: projectDir(id), addDirs: access.addDirs, deniedPaths: access.denied, docs: access.docs,
      tools, deniedTools: disallowed, mcp: mcp.names, mcpServers: mcp.servers, mcpUnknown: mcp.unknown,
    },
    tokens: { ...total, total: total.system + total.repository + total.prompt },
    // The texts as they are sent, for the comparison with the last run.
    sent: { system: agent.instructions, prompt: parts.flatMap(p => p.lines).join('\n') },
  };
}

/** The first message of each live session profile of the project, as it would open now (nothing opens). */
function sessionsContext(config, id) {
  return sessionProfiles(config).filter(p => p.project === id).map(profile => {
    const base = { profile: profile.id, name: profile.name, tool: profile.tool, model: profile.model, auto: profile.auto, blocksAsked: profile.prompt_blocks };
    try {
      const { folder, prompt } = planSession(config, profile.id);
      const repository = profile.tool === 'claude' ? repositoryFiles(folder.dir) : { dir: folder.dir, exists: true, files: [] };
      // As openSession writes it: the manager's address at its end, or alone when the profile names no blocks (it then
      // goes with the owner's first message); the agent in charge gets none.
      const text = profile.charge ? (prompt.blocksGiven ? prompt.text : null)
        : prompt.blocksGiven ? withManager(prompt.text, config, '<session id>') : managerAddress(config, '<session id>');
      return {
        ...base, cwd: folder.dir, text, tokens: text == null ? 0 : tokens(text),
        blocks: (prompt.details ?? []).map(d => ({ ...d, tokens: tokens(d.text) })), missing: prompt.missing, unresolved: prompt.unresolved, repository,
      };
    } catch (error) {
      return { ...base, error: error.message };
    }
  });
}

// ---------- The last real run ----------

/** A recorded .context.md read into its sections ("## <title>": lines), the fenced texts kept whole. */
function sectionsOf(recorded) {
  const sections = {};
  let current = null;
  let fence = null;
  for (const line of String(recorded).replace(/\r\n?/g, '\n').split('\n')) {
    if (fence) {
      if (line === fence) fence = null;
      current?.push(line);
      continue;
    }
    const open = line.match(/^(`{3,})\w*$/);
    if (open) fence = open[1];
    const h = !open && line.match(/^## (.+)$/);
    if (h) {
      current = sections[h[1].trim()] = [];
      continue;
    }
    current?.push(line);
  }
  return sections;
}

const fencedText = lines => {
  if (!lines) return null;
  const start = lines.findIndex(l => /^`{3,}\w*$/.test(l));
  if (start < 0) return null;
  const fence = lines[start].match(/^`+/)[0];
  const end = lines.findIndex((l, i) => i > start && l === fence);
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
};
const codes = lines => (lines ?? []).map(l => l.match(/^- `([^`]+)`/)?.[1]).filter(Boolean);

/** What a step received, read back from its .context.md. */
export function readRecorded(recorded) {
  const s = sectionsOf(recorded);
  const head = String(recorded).match(/^- Model: `([^`]+)`(?:, effort `([^`]+)`)?/m);
  const builder = s['Prompt builder'] ?? [];
  return {
    model: head?.[1] ?? null, effort: head?.[2] ?? null,
    system: fencedText(s["System prompt (added to Claude Code's own)"]),
    prompt: fencedText(s.Prompt),
    addDirs: (s.Folders ?? []).map(l => l.match(/^- Also allowed \(--add-dir\): `([^`]+)`/)?.[1]).filter(Boolean),
    tools: codes(s['Tools allowed']),
    denied: codes(s['Tools and paths denied']),
    mcp: (s['External tools (MCP)'] ?? []).map(l => l.match(/^- `([^`]+)`:/)?.[1]).filter(Boolean),
    files: codes(s["The repository's instruction files"]),
    blocks: builder.find(l => l.startsWith('- Blocks: '))?.slice('- Blocks: '.length).split(', ').filter(Boolean) ?? null,
  };
}

/** The last step of this member that wrote its context, in the project's runs (newest first). */
function lastRecorded(projectId, memberId) {
  for (const run of listRuns().filter(r => r.project === projectId).slice(0, 60)) {
    const steps = stepsOf(run);
    for (let i = steps.length - 1; i >= 0; i--) {
      const s = steps[i];
      if (s.agent !== memberId) continue;
      if (memberId === LEAD && s.role !== 'review') continue;
      if ((memberId === 'manager') !== (s === run.review)) continue;
      const file = path.join(RUNS, run.id, `${String(i + 1).padStart(2, '0')}-${s.agent}.context.md`);
      if (existsSync(file)) {
        return { run: run.id, title: run.title, at: s.started ?? run.created, step: i + 1, written: !!run.builderPrompt, modules: run.modules ?? [], file: path.relative(path.dirname(RUNS), file).replaceAll('\\', '/'), text: readFileSync(file, 'utf8') };
      }
    }
  }
  return null;
}

/** The lines removed and added from one text to another (a longest common subsequence; whole sets when too big). */
export function lineDiff(before, after) {
  const a = String(before ?? '').split(/\r?\n/);
  const b = String(after ?? '').split(/\r?\n/);
  if (a.length * b.length > 4_000_000) {
    const sa = new Set(a);
    const sb = new Set(b);
    return { removed: a.filter(l => !sb.has(l)), added: b.filter(l => !sa.has(l)) };
  }
  const m = a.length;
  const n = b.length;
  const table = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const removed = [];
  const added = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) removed.push(a[i++]);
    else added.push(b[j++]);
  }
  removed.push(...a.slice(i));
  added.push(...b.slice(j));
  return { removed, added };
}

// The prompt's sections that belong to one run (its task, the reports before): never compared.
const RUN_SECTIONS = /^(Your part|What to do in this review|The request to plan|The request|The request this task is part of|What the previous steps did|Crew reports|Changed files|The team lead's plan|The team lead's opinion|The team lead's final reviews|The team lead's last review|The team lead sent the work back|The request this run is for|Open messages from your crew|The team lead's answers)\b/;

/** A prompt by its "## " sections, without the header (the run's title, date and branch) and the run's own sections. */
function promptSections(prompt) {
  const sections = new Map();
  let current = null;
  for (const line of String(prompt ?? '').split('\n')) {
    const h = line.match(/^## (.+)$/);
    if (h) {
      let name = h[1].trim();
      for (let n = 2; sections.has(name); n++) name = `${h[1].trim()} (${n})`;
      current = RUN_SECTIONS.test(name) ? null : name;
      if (current) sections.set(current, []);
      continue;
    }
    if (current) sections.get(current).push(line);
  }
  return new Map([...sections].map(([k, v]) => [k, v.join('\n').trim()]));
}

const listChange = (what, before, after) => {
  const added = after.filter(x => !before.includes(x));
  const removed = before.filter(x => !after.includes(x));
  return added.length || removed.length ? { what, status: 'changed', added, removed } : null;
};

/** What changed for a member since its last real run. null when it has none recorded. */
function diffWithLast(projectId, member) {
  const last = lastRecorded(projectId, member.id);
  if (!last) return null;
  const was = readRecorded(last.text);
  // The files may have Windows line ends (the agents' files in a working copy): they don't count as a change.
  const lf = s => String(s ?? '').replace(/\r\n?/g, '\n');
  const sent = { system: lf(member.sent.system), prompt: lf(member.sent.prompt) };
  const changes = [];
  if (was.model !== member.model || (was.effort ?? null) !== (member.effort ?? null)) {
    changes.push({ what: 'model', status: 'changed', before: [was.model, was.effort].filter(Boolean).join(', '), after: [member.model, member.effort].filter(Boolean).join(', ') });
  }
  if (was.system != null && was.system !== sent.system) changes.push({ what: 'system', status: 'changed', ...lineDiff(was.system, sent.system) });
  if (was.prompt != null) {
    const before = promptSections(was.prompt);
    const after = promptSections(sent.prompt);
    for (const [name, body] of after) {
      if (!before.has(name)) changes.push({ what: 'section', name, status: 'added', tokens: tokens(body) });
      else if (before.get(name) !== body) changes.push({ what: 'section', name, status: 'changed', ...lineDiff(before.get(name), body) });
    }
    for (const [name, body] of before) if (!after.has(name)) changes.push({ what: 'section', name, status: 'removed', tokens: tokens(body) });
  }
  if (was.blocks && member.prompt.find(p => p.key === 'builder')) {
    const current = member.prompt.find(p => p.key === 'builder').blocks.map(b => b.name);
    const c = listChange('blocks', was.blocks, current);
    if (c) changes.push(c);
  }
  for (const [what, before, after] of [
    ['folders', was.addDirs, member.access.addDirs], ['tools', was.tools, member.access.tools], ['denied', was.denied, [...member.access.deniedTools, ...member.access.deniedPaths]],
    ['mcp', was.mcp, member.access.mcp], ['files', was.files, member.repository.files.map(f => f.file)],
  ]) {
    // A working copy not there now (or not then) says nothing about its files.
    if (what === 'files' && !member.repository.exists) continue;
    const c = listChange(what, before, after);
    if (c) changes.push(c);
  }
  const { text: _text, ...run } = last;
  return { ...run, changes };
}

// ---------- The whole context ----------

/**
 * A project's context: { project, generated, tokensNote, builder, members, sessions, history }. member: only this one
 * (its id in the project's crew). The members come in the order of the crew, the team lead and the manager last.
 */
export function projectContext(config, id, { member = null, diffs = true, sent = false } = {}) {
  const project = projectOf(config, id);
  const team = projectCrew(config, id, loadAgents(config));
  if (member && !team[member]) throw new Error(t('{agent} is not in the crew of {project}.', { agent: member, project: id }));
  const builder = builderFor(config, id, project);
  const libraries = previewLibraries(config, project);
  const repository = repositoryFiles(projectDir(id));
  const order = [...Object.keys(team).filter(k => k !== 'manager' && k !== LEAD), ...(team[LEAD] ? [LEAD] : []), 'manager'].filter(k => team[k]);
  const members = order.filter(k => !member || k === member).map(memberId => {
    const m = memberContext({ config, id, project, team, memberId, builder, libraries, repository });
    m.diff = diffs ? diffWithLast(id, m) : null;
    if (sent) return m;
    const { sent: _sent, ...shown } = m;
    return shown;
  });
  const { built, ...builderInfo } = builder;
  return {
    project: { id, name: project.name ?? id }, generated: now(), tokensNote: 'about 4 characters per token',
    builder: builderInfo,
    settings: { notes: project.notes ?? '', agentNotes: project.agent_notes ?? {}, extra: extraOf(config, id, team), mainPush: project.main_push === 'card' },
    members, sessions: member ? [] : sessionsContext(config, id), history: member ? [] : readHistory(id),
  };
}

// ---------- Changes from the app ----------

/** Where each member's extra instructions live: { member: { text, scope, field } }. */
function extraOf(config, id, team) {
  const out = {};
  for (const memberId of Object.keys(team)) {
    const where = extraField(config, id, memberId);
    out[memberId] = { text: where.get(config) ?? '', scope: where.scope, field: where.field };
  }
  return out;
}

/** A member's extra instructions: the team lead's, the project crew member's, or the installation's for the agent. */
function extraField(config, id, memberId) {
  const project = config.projects[id];
  if (memberId === LEAD) {
    const lead = c => (typeof c.projects[id].lead === 'object' ? c.projects[id].lead : {});
    return {
      scope: 'lead', field: `projects.${id}.lead.extra_instructions`,
      get: c => lead(c).extra_instructions,
      set: (c, v) => {
        c.projects[id].lead = { ...lead(c), extra_instructions: v };
        if (!v) delete c.projects[id].lead.extra_instructions;
      },
    };
  }
  const crew = project.crew;
  const inCrew = Array.isArray(crew)
    ? crew.some(x => (typeof x === 'string' ? x : x?.id ?? x?.agent) === memberId)
    : !!crew && Object.hasOwn(crew, memberId);
  if (crew && inCrew && memberId !== 'manager') {
    const entry = c => {
      const list = c.projects[id].crew;
      if (!Array.isArray(list)) return (list[memberId] ??= {});
      const i = list.findIndex(x => (typeof x === 'string' ? x : x?.id ?? x?.agent) === memberId);
      if (typeof list[i] === 'string') list[i] = { id: list[i] };
      return list[i];
    };
    return {
      scope: 'project', field: `projects.${id}.crew.${memberId}.extra_instructions`,
      get: c => {
        const list = c.projects[id].crew;
        const x = Array.isArray(list) ? list.find(y => (typeof y === 'string' ? y : y?.id ?? y?.agent) === memberId) : list[memberId];
        return typeof x === 'object' ? x?.extra_instructions : undefined;
      },
      set: (c, v) => {
        const x = entry(c);
        if (v) x.extra_instructions = v;
        else delete x.extra_instructions;
      },
    };
  }
  // The general crew (and the manager): the agent's notes for this whole installation, every project included.
  return {
    scope: 'installation', field: `crew.${memberId}.extra_instructions`,
    get: c => c.crew?.[memberId]?.extra_instructions,
    set: (c, v) => {
      c.crew ??= {};
      c.crew[memberId] ??= {};
      if (v) c.crew[memberId].extra_instructions = v;
      else delete c.crew[memberId].extra_instructions;
      if (!Object.keys(c.crew[memberId]).length) delete c.crew[memberId];
    },
  };
}

const MAX_TEXT = 20_000;
const cleanText = v => {
  const s = String(v ?? '').replace(/\r\n?/g, '\n').trim();
  if (s.length > MAX_TEXT) throw new Error(t('A text is longer than {max} characters.', { max: MAX_TEXT }));
  return s;
};
const cleanList = v => [...new Set((Array.isArray(v) ? v : []).map(x => String(x).trim()).filter(Boolean))];
const shown = v => (Array.isArray(v) ? v.join(', ') : v ?? '');

/**
 * Applies the app's changes to a copy of the settings. changes: { modules: [...], exclude: [...], notes: "...",
 * agentNotes: { member: "..." }, extra: { member: "..." }, mainPush: true | false } (only what is given changes).
 * mainPush is "main_push": "card", the project's main branch going to GitHub through the owner's card (src/guard.mjs):
 * only the owner turns it on, since only the app and the owner's terminal reach this. Returns { config, changed },
 * "changed" listing each setting that really changes, with its value before and after.
 */
export function applyChanges(config, id, changes = {}) {
  projectOf(config, id);
  const next = structuredClone(config);
  const project = next.projects[id];
  const team = projectCrew(config, id, loadAgents(config));
  const changed = [];
  const record = (field, before, after) => {
    if (shown(before) !== shown(after)) changed.push({ field, before: shown(before), after: shown(after) });
  };
  const sections = readBuilder(config);
  const known = sections ? new Map(sections.filter(s => !['ignore', 'combinations'].includes(s.selection)).flatMap(s => s.blocks).map(b => [b.name, b.selection ?? 'several'])) : null;
  const checkBlocks = (list, kind) => {
    for (const name of list) if (known && known.get(name) !== kind) throw new Error(t('Not a block of the prompt builder that can be turned on or off here: {name}', { name }));
  };
  for (const [key, field, kind] of [['modules', 'prompt_modules', 'several'], ['exclude', 'prompt_exclude', 'automatic']]) {
    if (changes[key] === undefined) continue;
    const list = cleanList(changes[key]);
    // Only the names added are checked: one already there and no longer in the document may stay.
    checkBlocks(list.filter(name => !(project[field] ?? []).includes(name)), kind);
    record(`projects.${id}.${field}`, project[field] ?? [], list);
    if (list.length) project[field] = list;
    else delete project[field];
  }
  if (changes.notes !== undefined) {
    const v = cleanText(changes.notes);
    record(`projects.${id}.notes`, project.notes ?? '', v);
    if (v) project.notes = v;
    else delete project.notes;
  }
  if (changes.mainPush !== undefined) {
    const on = changes.mainPush === true || changes.mainPush === 'card';
    record(`projects.${id}.main_push`, project.main_push ?? '', on ? 'card' : '');
    if (on) project.main_push = 'card';
    else delete project.main_push;
  }
  for (const [memberId, value] of Object.entries(changes.agentNotes ?? {})) {
    if (!team[memberId]) throw new Error(t('{agent} is not in the crew of {project}.', { agent: memberId, project: id }));
    const v = cleanText(value);
    record(`projects.${id}.agent_notes.${memberId}`, project.agent_notes?.[memberId] ?? '', v);
    project.agent_notes ??= {};
    if (v) project.agent_notes[memberId] = v;
    else delete project.agent_notes[memberId];
    if (!Object.keys(project.agent_notes).length) delete project.agent_notes;
  }
  for (const [memberId, value] of Object.entries(changes.extra ?? {})) {
    if (!team[memberId]) throw new Error(t('{agent} is not in the crew of {project}.', { agent: memberId, project: id }));
    const v = cleanText(value);
    const where = extraField(next, id, memberId);
    record(where.field, where.get(next) ?? '', v);
    if (shown(where.get(next) ?? '') !== v) where.set(next, v);
  }
  return { config: next, changed };
}

/**
 * What the changes would do, saving nothing: the settings that change and, for each member and each live session of
 * the project, its size before and after and the lines that would leave and come in.
 */
export function previewChanges(id, changes, config = loadConfig()) {
  const { config: next, changed } = applyChanges(config, id, changes);
  const before = projectContext(config, id, { diffs: false, sent: true });
  const after = projectContext(next, id, { diffs: false, sent: true });
  const members = after.members.map(m => {
    const was = before.members.find(x => x.id === m.id);
    const system = lineDiff(was?.sent.system ?? '', m.sent.system);
    const prompt = lineDiff(was?.sent.prompt ?? '', m.sent.prompt);
    return { id: m.id, name: m.name, before: was?.tokens.total ?? 0, after: m.tokens.total, removed: [...system.removed, ...prompt.removed], added: [...system.added, ...prompt.added] };
  });
  const sessions = after.sessions.map(s => {
    const was = before.sessions.find(x => x.profile === s.profile);
    return { profile: s.profile, name: s.name, before: was?.tokens ?? 0, after: s.tokens ?? 0, ...lineDiff(was?.text ?? '', s.text ?? '') };
  });
  return { changed, members, sessions };
}

/** Saves the changes, records them in the project's history and returns the context as it is now. */
export function saveChanges(id, changes, { by = 'app', config = loadConfig(), save = saveConfig } = {}) {
  const { config: next, changed } = applyChanges(config, id, changes);
  if (!changed.length) throw new Error(t('Nothing changed.'));
  save(next);
  const file = historyFile(id);
  ensureDir(path.dirname(file));
  appendFileSync(file, `${JSON.stringify({ at: now(), by, changes: changed })}\n`);
  return { changed, context: projectContext(next, id) };
}

/** The project's history of changes to its context, newest first. */
export function readHistory(id, limit = 40) {
  try {
    return readFileSync(historyFile(id), 'utf8').split('\n').filter(Boolean).map(l => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    }).filter(Boolean).reverse().slice(0, limit);
  } catch {
    return [];
  }
}

// ---------- On the command line ----------

const PART_TITLES = {
  agent: "The agent's instructions", installation: 'Notes for this installation', 'project-member': "Notes for this project's crew",
  'lead-role': 'The team lead\'s role', 'lead-notes': 'Notes for the team lead', header: 'The run and the task', additions: 'Added by the manager', memory: 'Project memory',
  lead: 'How the team lead reviews', playbook: "The mission's playbook", builder: 'Project instructions (prompt builder)', notes: "The project's notes",
  'agent-notes': "The project's notes for this member", libraries: 'Libraries and personal documentation', review: 'The final review',
  'lead-review': "The team lead's plan and opinion", reports: 'The reports of the steps before', rules: "Chiefmate's rules for the crew",
};
const HOW = { chosen: 'chosen', 'include-with': 'by "include with"', tags: 'by a shared tag', requires: 'by "requires"', always: 'always' };
const FILE_KIND = { start: 'loaded at the start', folder: 'loaded when it works in that folder', agents: 'not loaded by Claude Code by itself (Codex reads it)', settings: 'settings', ignored: 'ignored (--strict-mcp-config)', other: 'available to the agent' };

/** The context as text, for "node src/cli.mjs project-context <project> [member]". */
export function contextText(context, { full = true } = {}) {
  const out = [];
  const n = x => `~${x.toLocaleString('en-US')} tokens`;
  const body = s => (full ? ['', s.trim(), ''] : []);
  out.push(`# Context of ${context.project.name} (${context.project.id})`, `Sizes in tokens are estimates (${context.tokensNote}). Claude Code's own system prompt and tool definitions are not counted.`, '');
  const b = context.builder;
  out.push(`Prompt builder: ${b.used ? `used, block "${b.block}"${b.environment ? `, environment "${b.environment}"` : ''}${b.modules.length ? `, modules: ${b.modules.join(', ')}` : ''}${b.exclude.length ? `, turned off: ${b.exclude.join(', ')}` : ''}` : `not used${b.error ? ` (${b.error})` : !b.configured ? ' (no "prompt_builder.file")' : !b.exists ? ' (no copy on this computer)' : ' (no "prompt_block" for the project)'}: the project's notes go instead`}`);
  for (const m of context.members) {
    out.push('', `## ${m.name} (${m.id}${m.base && m.base !== m.id ? `, based on ${m.base}` : ''}; ${m.role}): ${n(m.tokens.total)}`);
    out.push(`Model: ${m.model ?? '(default)'}${m.effort ? `, effort ${m.effort}` : ''}, time limit ${m.maxMinutes} min`);
    out.push('', `### 1. System prompt, added to Claude Code's own (${n(m.tokens.system)})`);
    for (const p of m.system) out.push(`- ${PART_TITLES[p.key] ?? p.key} [${p.source}] ${n(p.tokens)}`, ...body(p.text));
    out.push('', `### 2. The repository's instruction files (${n(m.tokens.repository)} loaded at the start)`);
    if (!m.repository.exists) out.push(`- The working copy (${m.repository.dir}) is created on the first run: none read yet.`);
    else if (!m.repository.files.length) out.push('- None.');
    for (const f of m.repository.files) out.push(`- ${f.file}: ${FILE_KIND[f.kind]}${f.text != null ? `, ${n(f.tokens)}` : ''}`);
    out.push('', `### 3. First message (${n(m.tokens.prompt)})`);
    for (const p of m.prompt) {
      out.push(`- ${PART_TITLES[p.key] ?? p.key} [${p.source}] ${n(p.tokens)}`);
      for (const x of p.blocks ?? []) out.push(`  - block "${x.name}" (${x.section}): ${x.how === 'chosen' ? `chosen${x.role ? `, ${x.role}` : ''}` : `${HOW[x.how]}${x.condition ? `: ${x.condition}` : ''}`}, ${n(x.tokens)}${x.adapted ? `, ${x.adapted} line(s) adapted` : ''}`);
      for (const x of p.missing ?? []) out.push(`  - not found: ${x}`);
      if (p.off?.length) out.push(`  - turned off for the project: ${p.off.join(', ')}`);
      out.push(...body(p.text));
    }
    const a = m.access;
    out.push('', '### 4. Folders, tools and external tools');
    out.push(`- Working copy: ${a.workingCopy}`, ...a.addDirs.map(d => `- Also allowed: ${d}`), `- Paths denied: ${a.deniedPaths.length} rule(s)${full ? `\n${a.deniedPaths.map(d => `  - ${d}`).join('\n')}` : ''}`);
    out.push(`- Tools allowed: ${a.tools.join(', ') || '(the agent\'s defaults)'}`, `- Tools denied: ${a.deniedTools.join(', ') || '(none)'}`, `- MCP servers: ${a.mcp.join(', ') || '(none)'}${a.mcpUnknown.length ? ` (released but not configured: ${a.mcpUnknown.join(', ')})` : ''}`);
    out.push('', '### 5. Since the last run');
    if (!m.diff) out.push('- No context recorded for this member in this project yet.');
    else {
      out.push(`- Compared with ${m.diff.file} (${m.diff.title}, ${m.diff.at})${m.diff.written ? ': that run had a prompt written in the app' : ''}`);
      if (!m.diff.changes.length) out.push('- Nothing changed.');
      for (const c of m.diff.changes) {
        const what = c.what === 'section' ? `section "${c.name}"` : c.what;
        if (c.status !== 'changed' || (!c.added && c.before == null)) out.push(`- ${what}: ${c.status}`);
        else if (c.before != null) out.push(`- ${what}: ${c.before} -> ${c.after}`);
        else out.push(`- ${what}: ${c.removed.length} line(s) out, ${c.added.length} in${full ? `\n${[...c.removed.map(l => `    - ${l}`), ...c.added.map(l => `    + ${l}`)].slice(0, 40).join('\n')}` : ''}`);
      }
    }
  }
  if (context.sessions.length) {
    out.push('', '## Live sessions of the project');
    for (const s of context.sessions) {
      if (s.error) {
        out.push(`- ${s.name} (${s.profile}): ${s.error}`);
        continue;
      }
      out.push(`- ${s.name} (${s.profile}, ${s.tool}) in ${s.cwd}: ${s.text == null ? 'no first message' : n(s.tokens)}`);
      for (const x of s.blocks) out.push(`  - block "${x.name}": ${x.how === 'chosen' ? 'chosen' : HOW[x.how]}${x.condition ? `: ${x.condition}` : ''}, ${n(x.tokens)}`);
      if (full && s.text) out.push('', s.text, '');
    }
  }
  if (context.history.length) {
    out.push('', '## Changes made from the app');
    for (const h of context.history) out.push(`- ${h.at} (${h.by}): ${h.changes.map(c => c.field).join(', ')}`);
  }
  return out.join('\n');
}
