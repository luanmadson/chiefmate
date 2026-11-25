// The file viewer, read only: the folders it may open (its roots), the files it never opens, a folder's list, a file's
// facts and its content as bytes, text or a table, from the disk or from a run's branch. Nothing here writes, moves or
// deletes a file.
import { execFile } from 'node:child_process';
import { closeSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { t } from './i18n.mjs';
import { projectClone } from './sessions.mjs';
import { decodeText, parseCsv, readXlsx } from './sheets.mjs';
import { DATA, ROOT, WORKSPACES } from './util.mjs';

export const MAX_FILE = 50 * 1024 ** 2; // the largest file read or sent
export const MAX_TEXT = 2 * 1024 ** 2; // the largest text shown
export const MAX_ROWS = 5000; // the rows of a table's preview
const MAX_ENTRIES = 2000; // the entries of a folder's list
const MAX_RUN_FILES = 500;

const EXTENSIONS = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'],
  pdf: ['pdf'],
  markdown: ['md', 'markdown'],
  table: ['csv', 'tsv', 'xlsx', 'xlsm'],
  text: ['txt', 'log', 'json', 'jsonl', 'yml', 'yaml', 'xml', 'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'vue', 'svelte', 'py', 'ps1', 'psm1',
    'sh', 'bat', 'cmd', 'vbs', 'ini', 'toml', 'cfg', 'conf', 'sql', 'java', 'kt', 'c', 'h', 'cpp', 'cs', 'go', 'rs', 'rb', 'php', 'lua', 'r', 'tex', 'srt',
    'vtt', 'gitignore', 'gitattributes', 'editorconfig', 'webmanifest', 'map'],
};
const KIND_OF = new Map(Object.entries(EXTENSIONS).flatMap(([kind, list]) => list.map(ext => [ext, kind])));
const TEXT_NAMES = new Set(['license', 'readme', 'dockerfile', 'makefile', 'procfile', 'changelog', 'notice', 'authors']);

const extension = name => (path.extname(name).slice(1) || (name.startsWith('.') ? name.slice(1) : '')).toLowerCase();

/** What the viewer does with a file, by its name: image, pdf, markdown, table, text or other. */
export function kindOf(name) {
  return KIND_OF.get(extension(name)) ?? (TEXT_NAMES.has(String(name).toLowerCase()) ? 'text' : 'other');
}

// The types sent as they are; anything else goes as a download. SVG is an image only inside <img> (see rawHeaders).
const INLINE_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
  svg: 'image/svg+xml', pdf: 'application/pdf',
};

/**
 * The headers of a file's bytes. Never run in the app's context: a sandbox with no script for anything opened in a tab,
 * no use by other sites (Cross-Origin-Resource-Policy), no cache (the owner may open it on someone else's computer).
 * A PDF may be framed by the app (its viewer), and is not sandboxed, as browsers refuse to show a PDF in a sandbox.
 * HTML, SVG opened outside <img>, and every other type go as a download.
 */
export function rawHeaders(name, { dest = '', head = null } = {}) {
  const ext = extension(name);
  let type = INLINE_TYPES[ext] ?? (['text', 'markdown'].includes(kindOf(name)) && !['html', 'htm', 'xml'].includes(ext) ? 'text/plain; charset=utf-8' : null);
  if (ext === 'svg' && dest !== 'image') type = null;
  if (ext === 'pdf' && head && head.subarray(0, 5).toString('latin1') !== '%PDF-') type = null;
  const filename = `filename*=UTF-8''${encodeURIComponent(path.basename(name))}`;
  const pdf = type === 'application/pdf';
  return {
    'content-type': type ?? 'application/octet-stream',
    'content-disposition': `${type ? 'inline' : 'attachment'}; ${filename}`,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
    'cache-control': 'no-store',
    'cross-origin-resource-policy': 'same-origin',
    'content-security-policy': pdf ? "frame-ancestors 'self'" : "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox; frame-ancestors 'none'",
    'x-frame-options': pdf ? 'SAMEORIGIN' : 'DENY',
  };
}

// ---------- The roots and what is never opened ----------

const windows = process.platform === 'win32';
const key = p => (windows ? p.toLowerCase() : p);
const trimEnd = p => (p.length > 1 && /[\\/]$/.test(p) && !/^[a-z]:[\\/]$/i.test(p) ? p.slice(0, -1) : p);

/** Whether "child" is "parent" or inside it (case-insensitive on Windows). */
export function within(child, parent) {
  const c = key(trimEnd(path.resolve(child)));
  const p = key(trimEnd(path.resolve(parent)));
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

const realOf = p => {
  try {
    return realpathSync.native(p);
  } catch {
    return null;
  }
};

const statOf = p => {
  try {
    return statSync(p);
  } catch {
    return null;
  }
};

// Names never opened, at any depth inside a root: git's folder, installed packages, environment files, keys, and
// folders or files named for secrets.
const BLOCKED_NAME = /^(\.git|node_modules|\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.npmrc|\.netrc|\.pypirc|\.git-credentials|\.env(\..*)?|.*\.env)$|\.(pem|key|p12|pfx|kdbx|keystore|jks|ppk)$|^id_(rsa|dsa|ecdsa|ed25519)|secret|segredo/i;
export const blockedName = name => BLOCKED_NAME.test(String(name).replace(/[. ]+$/, ''));

/** Chiefmate's own records and settings: never opened, even inside a root (such as Chiefmate's own clone). */
export function blockedPlaces() {
  const list = [DATA, path.join(ROOT, 'data'), path.join(ROOT, 'config', 'chiefmate.json')];
  return [...new Set([...list, ...list.map(realOf).filter(Boolean)])];
}

/** The viewer's settings ("viewer": { "extra_roots": [] }); the smoke test's temporary Chiefmate takes its own. */
export function viewerSettings(config) {
  const settings = process.env.CHIEFMATE_SMOKE ? JSON.parse(process.env.CHIEFMATE_VIEWER || 'null') : config?.viewer;
  return { extra_roots: [settings?.extra_roots ?? []].flat().filter(x => typeof x === 'string' && path.isAbsolute(x)) };
}

/**
 * The folders the viewer may open, existing ones only: each project's working copy (workspaces/<id>) and your own clone
 * of it, the reference libraries (workspaces/.library) and the extra folders of the settings. Each: { dir, real, kind,
 * label, project }.
 */
export function viewerRoots(config, { workspaces = WORKSPACES } = {}) {
  const roots = [];
  const add = (dir, kind, label, project = null) => {
    const real = dir && realOf(dir);
    if (real && statOf(real)?.isDirectory() && !roots.some(r => key(r.real) === key(real))) roots.push({ dir: path.resolve(dir), real, kind, label, project });
  };
  for (const [id, p] of Object.entries(config?.projects ?? {})) {
    add(path.join(workspaces, id), 'workspace', p.name ?? id, id);
    add(projectClone(p), 'clone', p.name ?? id, id);
  }
  add(path.join(workspaces, '.library'), 'library', '.library');
  for (const dir of viewerSettings(config).extra_roots) add(dir, 'extra', path.basename(dir) || dir);
  return roots;
}

class Refused extends Error {
  constructor(message, code = 403) {
    super(message);
    this.code = code;
  }
}

const outside = () => new Refused(t('This file is outside the folders the viewer may open.'));
const guarded = () => new Refused(t('This file is protected: the viewer never opens it.'));

/** Whether a path (inside "root") goes through a protected name or place. */
function protectedPath(p, root, blocked) {
  const rel = path.relative(root, p);
  return rel.split(/[\\/]/).some(n => n && blockedName(n)) || blocked.some(b => within(p, b));
}

/**
 * The real path of "input" (absolute), once it is inside a root and not protected: { real, root }. Refused: a relative
 * path, a device or network path, a stream (file:stream), anything outside the roots, before and after links and
 * junctions are followed, and anything protected. Nothing outside the roots is looked at on the disk.
 */
export function checkPath(input, roots, { blocked = blockedPlaces() } = {}) {
  const raw = String(input ?? '');
  if (!raw || raw.includes('\0') || /^[\\/]{2}/.test(raw) || !path.isAbsolute(raw) || (windows && raw.replace(/^[a-z]:/i, '').includes(':'))) throw outside();
  const lexical = path.resolve(raw);
  const near = roots.find(r => within(lexical, r.dir) || within(lexical, r.real));
  if (!near) throw outside();
  if (protectedPath(lexical, within(lexical, near.dir) ? near.dir : near.real, blocked)) throw guarded();
  const real = realOf(lexical);
  if (!real) throw new Refused(t('File not found.'), 404);
  const root = roots.find(r => within(real, r.real));
  if (!root) throw outside();
  if (protectedPath(real, root.real, blocked)) throw guarded();
  return { real, root };
}

// ---------- The disk ----------

/** The first bytes of a file, to tell text from binary and a real PDF from a renamed file. */
function head(file, size = 4096) {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size);
    return buf.subarray(0, readSync(fd, buf, 0, size, 0));
  } finally {
    closeSync(fd);
  }
}

const looksText = buf => !buf.includes(0);

/** A file's facts: { ref, name, size, mtime, kind, folder, gallery } (gallery: the images of its folder, for an image). */
function diskInfo(real, roots, blocked) {
  const s = statOf(real);
  if (!s) throw new Refused(t('File not found.'), 404);
  const name = path.basename(real);
  if (s.isDirectory()) return { ref: { path: real }, name, folder: real, dir: true, kind: 'folder' };
  let kind = kindOf(name);
  if (kind === 'other' && s.size <= MAX_TEXT && looksText(head(real))) kind = 'text';
  const info = { ref: { path: real }, name, size: s.size, mtime: s.mtime.toISOString(), kind, folder: path.dirname(real) };
  if (kind === 'image') {
    info.gallery = listFolder(path.dirname(real), roots, { blocked }).entries.filter(e => e.kind === 'image').slice(0, 300).map(e => ({ path: e.path, name: e.name }));
  }
  return info;
}

/**
 * A folder's list: { path, root, parent, entries: [{ name, path, dir, size, mtime, kind }], more }, folders first, with
 * protected entries and links that lead outside the roots left out. "parent" is null at the root.
 */
export function listFolder(input, roots, { blocked = blockedPlaces() } = {}) {
  const { real, root } = checkPath(input, roots, { blocked });
  if (!statOf(real)?.isDirectory()) throw new Refused(t('This is not a folder.'), 400);
  const entries = [];
  let more = false;
  for (const d of readdirSync(real, { withFileTypes: true })) {
    if (blockedName(d.name)) continue;
    const full = path.join(real, d.name);
    let target = full;
    if (d.isSymbolicLink()) {
      try {
        target = checkPath(full, roots, { blocked }).real;
      } catch {
        continue;
      }
    } else if (blocked.some(b => within(full, b))) continue;
    const s = statOf(target);
    if (!s) continue;
    if (entries.length >= MAX_ENTRIES) {
      more = true;
      break;
    }
    entries.push({ name: d.name, path: full, dir: s.isDirectory(), size: s.isDirectory() ? null : s.size, mtime: s.mtime.toISOString(), kind: s.isDirectory() ? 'folder' : kindOf(d.name) });
  }
  entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  const atRoot = key(real) === key(root.real);
  return { path: real, root: { path: root.real, kind: root.kind, label: root.label, project: root.project }, parent: atRoot ? null : path.dirname(real), entries, more };
}

// ---------- A run's files ----------

function git(dir, args, { buffer = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-c', 'core.quotepath=false', ...args], { cwd: dir, encoding: buffer ? 'buffer' : 'utf8', maxBuffer: MAX_FILE + 1024, windowsHide: true, timeout: 20_000 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });
}

/** The copy that has the run's branch: the crew's working copy, else your clone (a local delivery). */
async function runRepo(run, config) {
  const project = config?.projects?.[run?.project];
  if (!project || !run.branch || run.branch.startsWith('-')) return null;
  for (const dir of [path.join(WORKSPACES, run.project), project.local_clone].filter(Boolean)) {
    try {
      await git(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${run.branch}`]);
      return { dir, project };
    } catch {
      // not in this copy
    }
  }
  return null;
}

const runCache = new Map();

/**
 * What a run created or changed, from its branch: { files: [{ file, status, size, kind }], branch, more }. "status": A
 * (added), M (changed), D (deleted) and so on. From the commit the run started on ("baseCommit") or, for older runs,
 * from where the branch left its base. Read again at most every 15 seconds.
 */
export async function runFiles(run, config) {
  const cached = runCache.get(run.id);
  if (cached && Date.now() - cached.at < 15_000) return cached.value;
  const repo = await runRepo(run, config);
  let value = { files: [], branch: run.branch ?? null, more: false, available: false };
  if (repo) {
    const base = run.baseCommit ? [run.baseCommit, run.branch] : [`origin/${run.base ?? repo.project.main_branch ?? 'main'}...${run.branch}`];
    const diff = await git(repo.dir, ['diff', '--name-status', '--no-renames', '-z', ...base, '--']).catch(() => '');
    const parts = diff.split('\0').filter(Boolean);
    const changed = [];
    for (let i = 0; i + 1 < parts.length; i += 2) changed.push({ status: parts[i][0], file: parts[i + 1] });
    const sizes = new Map();
    if (changed.length) {
      const tree = await git(repo.dir, ['ls-tree', '-r', '-l', '-z', run.branch]).catch(() => '');
      for (const line of tree.split('\0')) {
        const m = line.match(/^\d+ blob [0-9a-f]+\s+(\d+)\t(.+)$/);
        if (m) sizes.set(m[2], Number(m[1]));
      }
    }
    const visible = changed.filter(c => !c.file.split('/').some(blockedName));
    value = {
      files: visible.slice(0, MAX_RUN_FILES).map(c => ({ file: c.file, status: c.status, size: sizes.get(c.file) ?? null, kind: kindOf(path.posix.basename(c.file)) })),
      branch: run.branch, more: visible.length > MAX_RUN_FILES, available: true, dir: repo.dir,
    };
  }
  runCache.set(run.id, { at: Date.now(), value });
  return value;
}

/** A run's file: { run, file, repo, name, size, kind }, only one the run's branch lists as created or changed. */
async function runSource(run, file, config) {
  const rel = String(file ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!rel || rel.startsWith('/') || rel.includes(':') || rel.includes('\0') || rel.split('/').some(p => !p || p === '.' || p === '..')) throw outside();
  if (rel.split('/').some(blockedName)) throw guarded();
  const list = await runFiles(run, config);
  const entry = list.files.find(f => f.file === rel && f.status !== 'D');
  if (!entry) throw new Refused(t('File not found.'), 404);
  return { run: run.id, file: rel, dir: list.dir, branch: list.branch, name: path.posix.basename(rel), size: entry.size, kind: entry.kind };
}

// ---------- References, facts and content ----------

/**
 * Where a reference leads: { path } on the disk, or { run, file } in a run's branch. A path may be absolute or relative,
 * with a ":line" at the end; a relative one is looked for in the run's files, then in the project's folders (or every
 * root, with no project), the first that exists.
 */
async function resolveRef(params, config, roots, blocked, readRun) {
  const run = params.run ? readRun(String(params.run)) : null;
  if (params.run && !run) throw new Refused(t('Run not found.'), 404);
  if (run && params.file) return { source: await runSource(run, params.file, config) };
  const asked = String(params.path ?? '').trim().replace(/^["'`]+|["'`]+$/g, '').replace(/:\d+(?:[-:]\d+)?$/, '');
  if (!asked) throw new Refused(t('File not found.'), 404);
  if (/^[a-z]:[\\/]/i.test(asked) || /^[\\/]/.test(asked)) return { real: checkPath(asked, roots, { blocked }).real };
  const rel = asked.replace(/\\/g, '/').replace(/^\.\//, '');
  if (rel.split('/').some(p => p === '..')) throw outside();
  if (run) {
    const list = await runFiles(run, config);
    if (list.files.some(f => f.file === rel && f.status !== 'D')) return { source: await runSource(run, rel, config) };
  }
  const project = params.project || run?.project;
  const places = project ? roots.filter(r => r.project === project) : roots;
  // A library's files: workspaces/.library/<library>/<path>.
  const tries = places.flatMap(r => (r.kind === 'library' ? readdirSync(r.real, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => path.join(r.real, d.name, rel)) : [path.join(r.real, rel)]));
  for (const candidate of tries) {
    try {
      const { real } = checkPath(candidate, roots, { blocked });
      return { real };
    } catch (error) {
      if (error.code !== 404) throw error;
    }
  }
  throw new Refused(t('File not found.'), 404);
}

/**
 * The viewer's reading of a file, by its reference ({ path } or { run, file }, with "project" for a relative path):
 * its facts (info), its bytes (raw), its text (text) or its table (table, with "sheet"). readRun reads a run's record.
 */
export async function viewFile(what, params, { config, readRun, dest = '' }) {
  const roots = viewerRoots(config);
  const blocked = blockedPlaces();
  const found = await resolveRef(params, config, roots, blocked, readRun);
  if (what === 'info') {
    if (found.real) return diskInfo(found.real, roots, blocked);
    const s = found.source;
    return { ref: { run: s.run, file: s.file }, name: s.name, size: s.size, mtime: null, kind: s.kind, folder: null };
  }
  const name = found.real ? path.basename(found.real) : found.source.name;
  const size = found.real ? statOf(found.real)?.size ?? 0 : found.source.size ?? 0;
  if (found.real && statOf(found.real)?.isDirectory()) throw new Refused(t('This is a folder.'), 400);
  if (size > MAX_FILE) throw new Refused(t('This file is too large to open here ({size} MB; at most {max} MB).', { size: Math.round(size / 1024 ** 2), max: MAX_FILE / 1024 ** 2 }), 413);
  const bytes = found.real ? readFileSync(found.real) : await git(found.source.dir, ['cat-file', 'blob', `${found.source.branch}:${found.source.file}`], { buffer: true });
  if (what === 'raw') return { body: bytes, headers: rawHeaders(name, { dest, head: bytes.subarray(0, 8) }) };
  if (what === 'text') {
    if (!looksText(bytes.subarray(0, 8192))) throw new Refused(t('This file is not text.'), 415);
    const text = decodeText(bytes.subarray(0, MAX_TEXT + 4));
    return { name, kind: kindOf(name), text: text.slice(0, MAX_TEXT), truncated: bytes.length > MAX_TEXT };
  }
  if (what === 'table') {
    const ext = extension(name);
    try {
      if (ext === 'xlsx' || ext === 'xlsm') return { name, ...readXlsx(bytes, { sheet: Number(params.sheet) || 0, maxRows: MAX_ROWS }), max: MAX_ROWS };
      if (ext === 'csv' || ext === 'tsv') return { name, sheets: [name], sheet: 0, ...parseCsv(decodeText(bytes), { delimiter: ext === 'tsv' ? '\t' : null, maxRows: MAX_ROWS }), max: MAX_ROWS };
    } catch (error) {
      throw new Refused(t("Couldn't read this table: {error}", { error: error.message }), 422);
    }
    throw new Refused(t('This file is not a table.'), 415);
  }
  throw new Refused('not found', 404);
}

/** The roots for a project's folder browser: the project's own first, then the libraries and the extra folders. */
export function rootsFor(config, project) {
  const roots = viewerRoots(config).filter(r => !r.project || r.project === project);
  return roots.sort((a, b) => Number(b.project === project) - Number(a.project === project)).map(r => ({ path: r.real, kind: r.kind, label: r.label, project: r.project }));
}
