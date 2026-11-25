// What each step may see: the project's working copy, the project's own personal documentation and the libraries the
// project lists. Everything else Chiefmate keeps (other projects, other personal documentation, its data/) is denied
// to the file tools by permission rules. The manager reviews with everything in sight, except Chiefmate's data/.
import { existsSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA, WORKSPACES } from './util.mjs';

/**
 * A path as Claude Code's permission rules write absolute paths: "//c/Users/..." on Windows, "//home/..." elsewhere.
 * Read rules cover every tool that reads files (Read, Glob, Grep); Edit rules, every tool that changes them.
 */
export function rulePath(p) {
  const posix = path.resolve(p).replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
  return `/${posix}`;
}

/** The rules that keep a folder (or a file) out of reach: neither read nor changed. */
export const denyRules = (p, folder = true) => {
  const target = folder ? `${rulePath(p)}/**` : rulePath(p);
  return [`Read(${target})`, `Edit(${target})`];
};

const list = dir => {
  try {
    return readdirSync(dir).map(name => {
      const full = path.join(dir, name);
      let folder = false;
      try {
        folder = statSync(full).isDirectory();
      } catch {
        // gone in the meantime
      }
      return { name, full, folder };
    });
  } catch {
    return [];
  }
};

// Folders of a library that belong to someone else's work: personal documentation of other projects, the book.
const PRIVATE_FOLDER = /^(Documentacoes|Aves ultimo 7$)/i;

/** The personal documentation folder of a project ("<library>/<folder>"), once its library is ready. */
export function docsDir(project, libraries) {
  if (!project.docs) return null;
  const [id, ...rest] = project.docs.split('/');
  const library = libraries.find(l => l.id === id);
  return library ? path.join(library.dir, ...rest) : null;
}

/**
 * The folders a step gets (--add-dir) and the permission rules that deny the rest.
 * config, projectId, project, libraries ({ id, dir } of every library prepared for the run), manager (the review step);
 * workspaces and data default to Chiefmate's own folders (the smoke test points them elsewhere).
 */
export function stepAccess({ config, projectId, project, libraries, manager = false, workspaces = WORKSPACES, data = DATA }) {
  const own = docsDir(project, libraries);
  const listed = new Set(project.library ?? []);
  const denied = [...denyRules(path.join(data, 'browser-profile'))];
  if (manager) {
    // The manager sees every library, and every project's working copy, but never Chiefmate's data/.
    return { addDirs: [...new Set([...libraries.map(l => l.dir), ...(own ? [own] : [])])], denied: [...denyRules(data)], docs: own };
  }
  denied.push(...denyRules(data));
  const addDirs = [];
  if (own) addDirs.push(own);
  for (const l of libraries) if (listed.has(l.id)) addDirs.push(l.dir);

  // Other projects' working copies, cloned or not yet.
  const others = new Set([...Object.keys(config.projects ?? {}), ...list(workspaces).filter(e => e.folder).map(e => e.name)]);
  for (const name of others) if (name !== projectId && name !== '.library') denied.push(...denyRules(path.join(workspaces, name)));

  // Libraries: the ones not listed are denied whole, except the folder of the project's own documentation.
  const libraryRoot = path.join(workspaces, '.library');
  for (const entry of list(libraryRoot).filter(e => e.folder)) {
    const holdsDocs = own && path.resolve(own).startsWith(path.resolve(entry.full) + path.sep);
    if (!listed.has(entry.name) && !holdsDocs) {
      denied.push(...denyRules(entry.full));
      continue;
    }
    for (const child of list(entry.full)) {
      if (child.name === '.git') continue;
      const isOwn = own && path.resolve(child.full) === path.resolve(own);
      const ownParent = own && path.resolve(own).startsWith(path.resolve(child.full) + path.sep);
      if (isOwn || ownParent) continue;
      if (listed.has(entry.name) ? PRIVATE_FOLDER.test(child.name) : true) denied.push(...denyRules(child.full, child.folder));
    }
  }
  return { addDirs: [...new Set(addDirs)], denied: [...new Set(denied)], docs: own };
}

/**
 * The external tools (MCP servers) of a step: only those in Chiefmate's settings ("mcp_servers"), released by the
 * project ("projects.<id>.mcp") or the agent ("mcp" in its file, in "crew" or in the project's crew).
 * Returns { servers, names, tools, unknown }.
 */
export function stepMcp(config, project, agent) {
  const wanted = [...new Set([...(project.mcp ?? []), ...(agent.mcp ?? [])])];
  const all = config.mcp_servers ?? {};
  const names = wanted.filter(n => all[n]);
  return {
    servers: Object.fromEntries(names.map(n => [n, all[n]])),
    names,
    tools: names.map(n => `mcp__${n}`),
    unknown: wanted.filter(n => !all[n]),
  };
}

/** The user's own Claude Code folder: its CLAUDE.md and rules never reach the crew. */
export const userClaudeExcludes = () => [`${path.join(os.homedir(), '.claude').replaceAll('\\', '/')}/**`];

// The repository's own instruction files, as Claude Code finds them.
const INSTRUCTION_FILES = ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', '.claude/CLAUDE.md', '.claude/settings.json', '.claude/settings.local.json', '.mcp.json'];
const INSTRUCTION_DIRS = ['.claude/agents', '.claude/skills', '.claude/commands', '.claude/rules', '.claude/hooks'];
const SKIP = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'vendor', '.venv', 'venv', '__pycache__']);

/** The instruction files present in the working copy: at the root, in .claude/, and CLAUDE.md or AGENTS.md in subfolders. */
export function instructionFiles(dir) {
  const found = INSTRUCTION_FILES.filter(f => existsSync(path.join(dir, f)));
  for (const d of INSTRUCTION_DIRS) for (const e of list(path.join(dir, d))) found.push(`${d}/${e.name}${e.folder ? '/' : ''}`);
  const walk = (folder, depth) => {
    if (depth > 3) return;
    for (const e of list(folder)) {
      if (!e.folder || SKIP.has(e.name) || e.name.startsWith('.')) continue;
      for (const f of ['CLAUDE.md', 'AGENTS.md']) if (existsSync(path.join(e.full, f))) found.push(path.relative(dir, path.join(e.full, f)).replaceAll('\\', '/'));
      walk(e.full, depth + 1);
    }
  };
  walk(dir, 1);
  return found;
}
