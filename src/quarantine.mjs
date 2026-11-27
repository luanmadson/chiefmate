// A file of a project's working copy that vanishes or can't be read right after it was written: most likely the
// antivirus put it in quarantine. The step that finds it says so, with the path; the project's queue waits instead of
// failing its next runs, checks the file again every few minutes and goes on by itself once it can be read again.
// The owner's notice (src/attention.mjs) and the manager's news carry the steps to restore the file.
import { closeSync, openSync, readSync } from 'node:fs';
import path from 'node:path';
import { t } from './i18n.mjs';
import { reportEvent } from './news.mjs';
import { notify } from './notify.mjs';
import { DATA, ensureDir, now, readJson, writeJson } from './util.mjs';

/** How often a held project's file is checked again. */
export const CHECK_MINUTES = 2;
// A file being scanned can be locked for a moment: it is looked at again after this pause before it counts.
const SETTLE_MS = 3000;

const holdsFile = () => path.join(ensureDir(DATA), 'quarantine.json');
/** The projects waiting for a file: { <project>: { project, file, state, since, run, step, agent, checked } }. */
export const readHolds = () => readJson(holdsFile(), {});
const saveHolds = holds => writeJson(holdsFile(), holds);
export const quarantineHold = project => readHolds()[project] ?? null;
export const quarantineList = () => Object.values(readHolds());

/** "ok", "missing" or "unreadable": whether a file can be opened and read. */
export function fileState(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
    readSync(fd, Buffer.alloc(1), 0, 1, 0);
    return 'ok';
  } catch (error) {
    if (error.code === 'EISDIR') return 'ok';
    return ['ENOENT', 'ENOTDIR'].includes(error.code) ? 'missing' : 'unreadable';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const inside = (dir, file) => {
  const rel = path.relative(path.resolve(dir), path.resolve(dir, file));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

// What git, Node or Windows print when a file is blocked or can't be opened: the path, when the message names one.
const PATTERNS = [
  /unable to (?:create|index|stat|read|open)(?: file)?\s+(?:'([^'\r\n]+)'|([^':\r\n]+?))\s*:\s*(?:permission denied|invalid argument|operation not permitted|no such file)/i,
  /(?:open|stat|lstat)\(\s*"([^"\r\n]+)"\s*\)\s*:\s*(?:permission denied|invalid argument|operation not permitted)/i,
  /\b(?:EPERM|EACCES|EBUSY|ENOENT)\b[^,\r\n]*,\s*\w+\s+'([^'\r\n]+)'/i,
  /'([^'\r\n]+)'[^\r\n]*(?:contains a virus|potentially unwanted software)/i,
];

/** The paths an error's text names as blocked or unreadable, inside the working copy (dir). */
export function blockedPaths(text, dir) {
  const found = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    for (const pattern of PATTERNS) {
      const m = line.match(pattern);
      const name = (m?.[1] ?? m?.[2])?.trim();
      if (name && inside(dir, name)) found.push(path.resolve(dir, name));
    }
  }
  return [...new Set(found)];
}

const settle = () => new Promise(resolve => setTimeout(resolve, SETTLE_MS));

/**
 * The first file that is gone or can't be read, looked at twice (a scan can hold a file for a moment): { file, state },
 * or null. files: absolute paths.
 */
export async function lostFile(files, { wait = settle } = {}) {
  const suspects = files.filter(f => fileState(f) !== 'ok');
  if (!suspects.length) return null;
  await wait();
  for (const file of suspects) {
    const state = fileState(file);
    if (state !== 'ok') return { file, state };
  }
  return null;
}

/** A git or tool error that names a file of the working copy now gone or unreadable: { file, state }, or null. */
export const quarantinedBy = (error, dir, options) => (dir ? lostFile(blockedPaths(error?.message ?? error, dir), options) : Promise.resolve(null));

// A later command that can remove or move files on purpose (git's included): what was written before it doesn't count.
const REMOVING = /\b(?:git\s+(?:checkout|reset|clean|stash|restore|rm|mv|switch|rebase|merge|cherry-pick|revert|apply)|rm|rmdir|del|erase|rd|mv|move|ren|rename|remove-item|move-item|rename-item|unlink)\b/i;

/**
 * The files a step wrote (through its file tools) that are gone or unreadable at its end. A file a later shell command
 * names, or written before a command that can remove or move files, doesn't count (done on purpose).
 * writes: [{ file, seq }]; commands: [{ text, seq }].
 */
export function writtenSuspects(writes, commands, dir) {
  const last = new Map();
  for (const w of writes) if (w.file && inside(dir, w.file)) last.set(path.resolve(dir, w.file), w.seq);
  return [...last].filter(([file, seq]) => {
    const name = path.basename(file).toLowerCase();
    return !commands.some(c => c.seq > seq && (String(c.text ?? '').toLowerCase().includes(name) || REMOVING.test(String(c.text ?? ''))));
  }).map(([file]) => file);
}

/** What the owner does to get the file back, in order. */
export const restoreSteps = file => t('1. Open Windows Security, then Virus & threat protection, then Protection history. 2. Find the item that names {path}. 3. If you trust it, choose Actions, then Restore (or Allow on device). Chiefmate checks again every few minutes and the project\'s queue goes on by itself once the file can be read.', { path: file });

/**
 * Holds a project's queue for a file the antivirus probably took: recorded once per project (a second file only
 * updates it), the owner told at once with the steps, the manager told through its news.
 */
export function holdForQuarantine({ project, file, state, run = null, step = null, agent = null, title = null }) {
  const holds = readHolds();
  const known = holds[project];
  holds[project] = { project, file, state, since: known?.since ?? now(), run, step, agent, checked: now() };
  saveHolds(holds);
  if (known?.file === file) return holds[project];
  notify(t('Antivirus probably quarantined a file'), t('{path}. The queue of {project} waits for it.', { path: file, project }), 'chiefmate:operations', { urgent: true });
  reportEvent('quarantine', `A file of the working copy of project ${project} ${state === 'missing' ? 'vanished' : 'became unreadable'} right after it was written${run ? ` (run ${run}${title ? ` "${title}"` : ''}${step ? `, step ${step}` : ''}${agent ? ` by ${agent}` : ''})` : ''}: probably the antivirus quarantined it. Path: ${file}. The project's queue waits (its next runs are not failed), checks the file every ${CHECK_MINUTES} minutes and goes on once it can be read. Steps for the owner: open Windows Security > Virus & threat protection > Protection history, find the item that names that path and, if they trust it, Restore (or Allow on device). If the file is not coming back, the hold is lifted with "node src/cli.mjs quarantine release ${project}".`, { urgent: true });
  return holds[project];
}

let lastCheck = 0;

/**
 * Looks at each held project's file again, at most every CHECK_MINUTES (force: now): a file readable again lifts the
 * hold, and the owner and the manager are told. Returns the projects released.
 */
export function checkQuarantine({ force = false } = {}) {
  if (!force && Date.now() - lastCheck < CHECK_MINUTES * 60_000) return [];
  lastCheck = Date.now();
  const holds = readHolds();
  const released = [];
  for (const [project, hold] of Object.entries(holds)) {
    if (fileState(hold.file) === 'ok') {
      delete holds[project];
      released.push(project);
      notify(t('The file is back'), t('{path} can be read again: the queue of {project} goes on.', { path: hold.file, project }));
      reportEvent('quarantine', `The file ${hold.file} of project ${project} can be read again: its queue goes on by itself.`);
    } else hold.checked = now();
  }
  if (Object.keys(holds).length || released.length) saveHolds(holds);
  return released;
}

/** Lifts a project's hold without the file (the owner, or the manager on the owner's word). Returns the hold lifted. */
export function releaseQuarantine(project, by = 'owner') {
  const holds = readHolds();
  const hold = holds[project];
  if (!hold) throw new Error(t('{project} is not waiting for a quarantined file.', { project }));
  delete holds[project];
  saveHolds(holds);
  reportEvent('quarantine', `The hold of project ${project} for ${hold.file} was lifted by the ${by}: its queue goes on without waiting for the file.`);
  return { ...hold, released: now(), by };
}
