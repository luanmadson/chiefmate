// Brings the prompt builder's document up to date ("prompts-sync", "Reload" in the app). With "library_file", it
// updates the library's copy from GitHub (git) and records the document's last commit there. Otherwise, with "doc_id",
// it copies the document from Google Docs to this computer: it connects to your own browser ("browser_cdp", signed in to Google, with remote debugging on) and asks for the document's Markdown export
// with that browser's session. It only reads: it never changes the document, and it never opens, closes or touches a tab.
// It needs playwright-core, an optional dependency: npm install --no-save playwright-core
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { t } from './i18n.mjs';
import { isLocked } from './lockdown.mjs';
import { builderSettings, SYNC_FILE } from './prompts.mjs';
import { ensureDir, now, readJson, writeJson } from './util.mjs';
import { libraryFileCommit, prepareLibrary } from './workspace.mjs';

let syncing = null;
export const isSyncing = () => !!syncing;

async function download(config) {
  const { file, docId } = builderSettings(config);
  if (!file || !docId) throw new Error(t('Set "prompt_builder": { "file": "...", "doc_id": "..." } in the settings.'));
  if (!config.browser_cdp) throw new Error(t('Set "browser_cdp" in the settings: the address of your browser with remote debugging on, such as http://127.0.0.1:9333.'));
  let playwright;
  try {
    playwright = await import('playwright-core');
  } catch {
    throw new Error(t('The synchronization needs playwright-core, which is not installed. In the Chiefmate folder, run: npm install --no-save playwright-core'));
  }
  const browser = await playwright.chromium.connectOverCDP(String(config.browser_cdp)).catch(error => {
    throw new Error(t("Couldn't reach your browser at {address}: {error}", { address: config.browser_cdp, error: error.message.split('\n')[0] }));
  });
  try {
    const context = browser.contexts()[0];
    if (!context) throw new Error(t('Your browser has no open window to borrow the session from.'));
    // The request goes with the browser's cookies, without opening a tab.
    const url = `https://docs.google.com/document/d/${encodeURIComponent(docId)}/export?format=md`;
    const response = await context.request.get(url, { timeout: 60_000 });
    const type = response.headers()['content-type'] ?? '';
    if (!response.ok()) throw new Error(t('Google answered {status}. Is this browser signed in to an account that can read the document?', { status: response.status() }));
    if (/text\/html/i.test(type)) throw new Error(t('Google sent a page instead of the document: the browser is probably not signed in.'));
    const text = await response.text();
    ensureDir(path.dirname(file));
    writeFileSync(file, text);
    return { bytes: Buffer.byteLength(text), file };
  } finally {
    // For a browser it connected to, this only disconnects: your browser and its tabs stay as they are.
    await browser.close().catch(() => {});
  }
}

/** Updates the library's copy and reads the document's last commit there. */
async function fromLibrary(config) {
  const { library } = builderSettings(config);
  const source = config.library?.[library.id];
  if (!source?.repository) throw new Error(t('Unknown library: {id}', { id: library.id }));
  await prepareLibrary(library.id, source);
  if (!existsSync(library.file)) throw new Error(t('The library {name} has no {path}.', { name: library.name, path: library.path }));
  const commit = await libraryFileCommit(library.dir, library.file, source.main_branch ?? 'main').catch(() => null);
  return { bytes: statSync(library.file).size, file: library.file, source: 'library', commit: commit ? { ...commit, file: library.file, head: headOf(library.dir) } : null };
}

/** Brings the document up to date now (one at a time) and records the result in data/prompt-builder.json. */
export function syncPrompts(config = loadConfig()) {
  if (isLocked()) return Promise.reject(new Error(t('Refused: Chiefmate is in emergency lockdown ({what}). Only the owner can release it, in the app or the command line on this computer.', { what: t('reloading the document') })));
  syncing ??= (async () => {
    const status = { ...readJson(SYNC_FILE, {}), attempted: now() };
    const { origin, file } = builderSettings(config);
    try {
      if (origin === 'library') {
        const { bytes, commit } = await fromLibrary(config);
        Object.assign(status, { ok: true, error: null, source: 'library', updated_at: now(), bytes, commit });
      } else if (origin === 'google') {
        const { bytes } = await download(config);
        Object.assign(status, { ok: true, error: null, source: 'google', synced_at: now(), bytes });
      } else {
        // Only the file on this computer: it is read again as it is.
        if (!file || !existsSync(file)) throw new Error(t('There is no copy of the prompt builder on this computer ("prompt_builder.file").'));
        Object.assign(status, { ok: true, error: null, source: 'file', bytes: statSync(file).size });
      }
    } catch (error) {
      Object.assign(status, { ok: false, error: error.message });
    }
    writeJson(SYNC_FILE, status);
    return status;
  })().finally(() => (syncing = null));
  return syncing;
}

/**
 * The document's last commit in the library, for the app's prompt builder: the one recorded at the last reload while
 * the library's copy stays at the same commit, else read again (and recorded).
 */
export async function documentCommit(config = loadConfig()) {
  const { library, file, origin } = builderSettings(config);
  if (origin !== 'library' || file !== library.file || !existsSync(file)) return null;
  const status = readJson(SYNC_FILE, {});
  const head = headOf(library.dir);
  if (status.commit?.file === file && status.commit.head === head) return status.commit;
  const source = config.library?.[library.id] ?? {};
  const commit = await libraryFileCommit(library.dir, file, source.main_branch ?? 'main').catch(() => null);
  if (!commit) return null;
  const recorded = { ...commit, file, head: headOf(library.dir) };
  writeJson(SYNC_FILE, { ...readJson(SYNC_FILE, {}), commit: recorded });
  return recorded;
}

// The commit the library's copy is at (its HEAD), read from .git without running git.
function headOf(dir) {
  try {
    const head = readFileSync(path.join(dir, '.git', 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) return head;
    const ref = head.slice(5);
    const loose = path.join(dir, '.git', ...ref.split('/'));
    if (existsSync(loose)) return readFileSync(loose, 'utf8').trim();
    const packed = readFileSync(path.join(dir, '.git', 'packed-refs'), 'utf8').split(/\r?\n/).find(l => l.endsWith(` ${ref}`));
    return packed?.split(' ')[0] ?? null;
  } catch {
    return null;
  }
}
