// Copies the prompt builder's document from Google Docs to this computer ("prompts-sync"). It connects to your own
// browser ("browser_cdp", signed in to Google, with remote debugging on) and asks for the document's Markdown export
// with that browser's session. It only reads: it never changes the document, and it never opens, closes or touches a tab.
// It needs playwright-core, an optional dependency: npm install --no-save playwright-core
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { t } from './i18n.mjs';
import { builderSettings, SYNC_FILE } from './prompts.mjs';
import { ensureDir, now, readJson, writeJson } from './util.mjs';

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

/** Synchronizes now (one at a time) and records the result in data/prompt-builder.json. */
export function syncPrompts(config = loadConfig()) {
  syncing ??= (async () => {
    const status = { ...readJson(SYNC_FILE, {}), attempted: now() };
    try {
      const { bytes } = await download(config);
      Object.assign(status, { ok: true, error: null, synced_at: now(), bytes });
    } catch (error) {
      Object.assign(status, { ok: false, error: error.message });
    }
    writeJson(SYNC_FILE, status);
    return status;
  })().finally(() => (syncing = null));
  return syncing;
}
