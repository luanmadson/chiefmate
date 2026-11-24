// Optional, and off by default: reads your account's usage page on claude.ai, in a browser profile of Chiefmate's own
// (data/browser-profile, never in git and never read by the crew). You sign in once with "node src/cli.mjs claude-login";
// from then on the server, never an agent, opens that one page at most once every few hours, with no window, and only reads
// it: it never clicks anything on the account and never applies a reset. It drives Microsoft Edge or Google Chrome
// through their DevTools protocol (what Playwright does underneath), so Chiefmate keeps having no dependencies.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { loadConfig, saveConfig } from './config.mjs';
import { t } from './i18n.mjs';
import { DATA, ensureDir, now, readJson, writeJson } from './util.mjs';

export const PROFILE_DIR = path.join(DATA, 'browser-profile');
const STATUS_FILE = path.join(DATA, 'usage-page.json');
const USAGE_PAGE = 'https://claude.ai/settings/usage';
const LOGIN_PAGE = 'https://claude.ai/login';
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** "usage_reader": { "enabled": false, "every_hours": 4, "browser": "<path to msedge.exe or chrome.exe>" } */
export const readerSettings = (config = loadConfig()) => ({
  enabled: config.usage_reader?.enabled === true,
  everyHours: Math.max(2, Number(config.usage_reader?.every_hours) || 4),
});

/** What the latest reading found: { attempted, ok, read_at, five_hour, seven_day, grants, excerpt, error, warning }. */
export const readerStatus = () => readJson(STATUS_FILE, {});
export const signedIn = () => existsSync(PROFILE_DIR);

function browserPath(config) {
  if (config.usage_reader?.browser) return config.usage_reader.browser;
  const env = process.env;
  return [
    path.join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(env.ProgramFiles ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].find(p => existsSync(p)) ?? null;
}

function needBrowser(config) {
  const browser = browserPath(config);
  if (!browser) throw new Error(t('No Microsoft Edge or Google Chrome found. Set "usage_reader": { "browser": "<path>" } in the settings.'));
  return browser;
}

/** Opens a visible browser window with Chiefmate's own profile, for you to sign in to claude.ai. */
export function openLogin(config = loadConfig()) {
  const browser = needBrowser(config);
  ensureDir(PROFILE_DIR);
  spawn(browser, [`--user-data-dir=${PROFILE_DIR}`, '--no-first-run', '--no-default-browser-check', LOGIN_PAGE], { detached: true, stdio: 'ignore' }).unref();
}

/** While the browser runs on the profile (the sign-in window, say), Windows keeps its lockfile from being removed. */
function profileInUse() {
  const lock = path.join(PROFILE_DIR, 'lockfile');
  if (!existsSync(lock)) return false;
  try {
    rmSync(lock);
    return false;
  } catch {
    return true;
  }
}

/** A DevTools connection: send(method, params) answers with the result. */
function devtools(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const waiting = new Map();
    let id = 0;
    socket.onopen = () =>
      resolve({
        send: (method, params = {}) =>
          new Promise((ok, fail) => {
            waiting.set(++id, { ok, fail });
            socket.send(JSON.stringify({ id, method, params }));
          }),
        close: () => socket.close(),
      });
    socket.onerror = () => reject(new Error('DevTools connection failed'));
    socket.onmessage = event => {
      const message = JSON.parse(String(event.data));
      const w = waiting.get(message.id);
      if (!w) return;
      waiting.delete(message.id);
      if (message.error) w.fail(new Error(message.error.message));
      else w.ok(message.result);
    };
    socket.onclose = () => {
      for (const w of waiting.values()) w.fail(new Error('DevTools connection closed'));
      waiting.clear();
    };
  });
}

async function waitFor(check, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) {
    const value = check();
    if (value) return value;
  }
  return null;
}

/** Opens the usage page with no window and returns its address and text. */
async function browse(config) {
  if (typeof WebSocket !== 'function') throw new Error(t('This version of Node.js has no WebSocket. Update to Node.js 22 or newer.'));
  const browser = needBrowser(config);
  if (!signedIn()) throw new Error(t('Not signed in yet. Run: node src/cli.mjs claude-login'));
  if (profileInUse()) throw new Error(t('The browser with the reading profile is open (the sign-in window?). Close it and try again.'));
  const portFile = path.join(PROFILE_DIR, 'DevToolsActivePort');
  rmSync(portFile, { force: true });
  const child = spawn(
    browser,
    ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${PROFILE_DIR}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio', 'about:blank'],
    { stdio: 'ignore', windowsHide: true },
  );
  child.on('error', () => {});
  try {
    const active = await waitFor(() => {
      const lines = existsSync(portFile) ? readFileSync(portFile, 'utf8').split(/\r?\n/) : [];
      return Number(lines[0]) && lines[1] ? lines : null;
    }, 20_000);
    if (!active) throw new Error(t("The browser didn't start."));
    const [port, browserSocket] = active;
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const target = targets.find(x => x.type === 'page');
    if (!target) throw new Error(t("The browser didn't start."));
    const page = await devtools(target.webSocketDebuggerUrl);
    let seen = { url: '', text: '' };
    try {
      const agent = (await page.send('Runtime.evaluate', { expression: 'navigator.userAgent', returnByValue: true })).result.value;
      if (/HeadlessChrome/.test(agent)) await page.send('Network.setUserAgentOverride', { userAgent: agent.replace('HeadlessChrome', 'Chrome') });
      await page.send('Page.navigate', { url: USAGE_PAGE });
      // Reads the text until it stops changing (the page fills in after it loads). Nothing on the page is ever clicked.
      for (let i = 0, stable = 0; i < 45 && stable < 2; i++) {
        await sleep(1000);
        const r = await page.send('Runtime.evaluate', { expression: 'JSON.stringify([location.href, document.body ? document.body.innerText : ""])', returnByValue: true });
        const [url, text] = JSON.parse(r.result.value);
        stable = /\d\s*%/.test(text) && text === seen.text ? stable + 1 : 0;
        seen = { url, text };
        if (/\/(login|signin|logout)\b/.test(new URL(url).pathname)) break;
      }
    } finally {
      page.close();
    }
    const control = await devtools(`ws://127.0.0.1:${port}${browserSocket}`).catch(() => null);
    await control?.send('Browser.close').catch(() => {});
    control?.close();
    return seen;
  } finally {
    await waitFor(() => child.exitCode !== null, 5000);
    if (child.exitCode === null && child.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  }
}

/**
 * Finds the account's limits and free resets in the page's text. The page has no fixed format to rely on, so this looks
 * for the usual words, in English and Portuguese, and keeps the lines it relied on so you can check them.
 */
export function parseUsagePage(text) {
  const lines = String(text ?? '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const percentAfter = pattern => {
    const i = lines.findIndex(l => pattern.test(l));
    for (let j = i; i >= 0 && j < Math.min(lines.length, i + 8); j++) {
      const m = lines[j].match(/(\d{1,3}(?:[.,]\d+)?)\s*%/);
      if (m) return Math.min(1, Number(m[1].replace(',', '.')) / 100);
    }
    return null;
  };
  const five_hour = percentAfter(/current session|sess[ãa]o atual|5[- ]hour|5 horas/i);
  const seven_day = percentAfter(/weekly|this week|all models|semanal|esta semana|todos os modelos/i);
  const grantAt = lines.findIndex(l =>
    /(free|gratuit|gr[áa]tis|bonus|b[ôo]nus).{0,40}(reset|redefini)|(reset|redefini)\w*.{0,40}(available|dispon[íi]ve|remaining|restante)/i.test(l),
  );
  let grants = null;
  if (grantAt >= 0) {
    const around = lines.slice(grantAt, grantAt + 3).join(' ');
    const count = Number(around.match(/\b(\d{1,2})\s+(?:free|gratuit|reset|redefini|bonus|b[ôo]nus)/i)?.[1] ?? 1);
    const when = around.match(/(?:expires?|expira(?:m)?|valid until|v[áa]lid[ao]s? at[ée]|until|at[ée])\s*(?:on|em)?\s*([^.;|]{4,40})/i)?.[1];
    const expires = when && !Number.isNaN(Date.parse(when)) ? new Date(Date.parse(when)).toISOString() : null;
    grants = { count, expires };
  }
  return { five_hour, seven_day, grants, excerpt: lines.filter(l => /%|reset|redefini|expir|venc/i.test(l)).slice(0, 12) };
}

/** The page's count of free resets wins: entries read before are replaced; the ones you recorded by hand are kept. */
function applyGrants(grants, at) {
  const config = loadConfig();
  const list = config.plan_resets ?? [];
  const kept = list.filter(g => g.source !== 'claude.ai' || g.used);
  const manual = kept.filter(g => !g.used && (!g.expires || Date.parse(g.expires) > Date.now())).length;
  const added = Array.from({ length: Math.max(0, grants.count - manual) }, () => ({
    kind: 'full', expires: grants.expires, used: false, note: 'Read on claude.ai', source: 'claude.ai', read_at: at,
  }));
  config.plan_resets = [...kept, ...added];
  saveConfig(config);
}

let reading = null;

/** Reads the page now (one reading at a time). Keeps the latest values when it fails. */
export function readUsagePage(config = loadConfig()) {
  reading ??= (async () => {
    const before = readerStatus();
    const status = { ...before, attempted: now() };
    try {
      const page = await browse(config);
      if (/\/(login|signin|logout)\b/.test(new URL(page.url || USAGE_PAGE).pathname)) {
        throw new Error(t('The reading profile is signed out of claude.ai. Run: node src/cli.mjs claude-login'));
      }
      const found = parseUsagePage(page.text);
      Object.assign(status, { ok: true, error: null, read_at: now(), ...found });
      status.warning = found.five_hour === null && found.seven_day === null ? t("The page didn't show the account's limits.") : !found.grants ? t("The page didn't show free resets: the record you keep by hand stays.") : null;
      if (found.grants) applyGrants(found.grants, status.read_at);
    } catch (error) {
      Object.assign(status, { ok: false, error: error.message });
    }
    writeJson(STATUS_FILE, status);
    return status;
  })().finally(() => (reading = null));
  return reading;
}

export const isReading = () => !!reading;

/** Called by the watch every minute or so: reads when the reading is on and its time has come. */
export function readWhenDue(config) {
  const { enabled, everyHours } = readerSettings(config);
  if (!enabled || reading || !signedIn()) return;
  const last = Date.parse(readerStatus().attempted ?? '') || 0;
  if (Date.now() - last >= everyHours * 3600_000) readUsagePage(config).catch(() => {});
}
