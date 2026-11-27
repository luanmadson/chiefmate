// Optional, and off by default: reads your account's usage page on claude.ai, in the browser's reading profile, Chiefmate's own
// (never in git and never read by the crew). You sign in once with "node src/cli.mjs claude-login";
// from then on the server, never an agent, opens that one page at most once every few hours, with no window, and only reads
// it: it never clicks anything on the account and never applies a reset. It drives Microsoft Edge or Google Chrome
// through their DevTools protocol (what Playwright does underneath), so Chiefmate keeps having no dependencies.
// The sign-in window never stays open for good: past LOGIN_MINUTES the server closes it (data/usage-login.json keeps
// which one it is), reads once more, and the app keeps a single "Sign in to claude.ai" card with a button to reopen it.
// A page a step asks the owner to see (needs-you, src/needs.mjs) opens in a window on the same profile, with the same
// time limit: both warn WARN_MINUTES before closing, and wait while the owner is using them.
import { execFile, spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { loadConfig, saveConfig } from './config.mjs';
import { t } from './i18n.mjs';
import { isLocked } from './lockdown.mjs';
import { notify } from './notify.mjs';
import { readState } from './store.mjs';
import { DATA, ensureDir, now, readJson, writeJson } from './util.mjs';

export const PROFILE_DIR = path.join(DATA, 'browser-profile');
const STATUS_FILE = path.join(DATA, 'usage-page.json');
const LOGIN_FILE = path.join(DATA, 'usage-login.json');
const OWNER_FILE = path.join(DATA, 'owner-window.json');
const USAGE_PAGE = 'https://claude.ai/settings/usage';
const LOGIN_PAGE = 'https://claude.ai/login';
export const LOGIN_MINUTES = 10;
export const WARN_MINUTES = 2;
const IN_USE_MS = 2 * 60_000; // the owner's last input, with the window in front, that still counts as using it
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Why a reading failed ("cause" in the status): the app's notice keeps one id per cause, so a seen notice stays seen.
// "no_data": the page opened, signed in, but showed no limit to read (it changed, or didn't finish loading).
const CAUSES = ['no_browser', 'not_signed_in', 'profile_open', 'no_start', 'signed_out', 'no_data', 'other'];
const SIGN_IN_CAUSES = ['not_signed_in', 'signed_out'];
// What only the owner can fix: while they are away, the reading waits for their return to try again.
const OWNER_CAUSES = ['no_browser', 'not_signed_in', 'signed_out', 'profile_open'];
const failure = (cause, message) => Object.assign(new Error(message), { readerCause: cause });

/** "usage_reader": { "enabled": false, "every_hours": 4, "browser": "<path to msedge.exe or chrome.exe>" } */
export const readerSettings = (config = loadConfig()) => ({
  enabled: config.usage_reader?.enabled === true,
  everyHours: Math.max(2, Number(config.usage_reader?.every_hours) || 4),
});

/** What the latest reading found: { attempted, ok, read_at, five_hour, seven_day, grants, excerpt, error, warning }. */
export const readerStatus = () => readJson(STATUS_FILE, {});
export const signedIn = () => existsSync(PROFILE_DIR);

export function browserPath(config) {
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
  if (!browser) throw failure('no_browser', t('No Microsoft Edge or Google Chrome found. Set "usage_reader": { "browser": "<path>" } in the settings.'));
  return browser;
}

// ---------- The sign-in window ----------

/** The sign-in window opened last: { pid, image, opened, closed, timed_out }. */
export const loginState = () => readJson(LOGIN_FILE, {});
const loginOpen = (login = loginState()) => !!login.pid && !login.closed;

function startWindow(browser, args) {
  const child = spawn(browser, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
  return child.pid ?? null;
}

/** The window's process still runs, under the browser's own name (a number Windows gave to another program is not it). */
function windowAlive({ pid, image }) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform !== 'win32') return true;
  const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
  return String(r.stdout ?? '').toLowerCase().includes(`"${image}"`);
}

/**
 * Closes the window as its close button does, and forces it only when it doesn't close within a few seconds. Only while
 * the reading profile is in use: once it isn't, the window is gone and its number may already be the owner's own browser.
 */
async function closeWindow(login) {
  if (!profileInUse()) return;
  spawnSync('taskkill', ['/PID', String(login.pid), '/T'], { windowsHide: true });
  for (let i = 0; i < 20 && windowAlive(login); i++) await sleep(250);
  if (windowAlive(login) && profileInUse()) spawnSync('taskkill', ['/PID', String(login.pid), '/T', '/F'], { windowsHide: true });
}

// Windows' own calls: the process of the window in front, and the time since the owner last typed or moved the mouse.
const IN_USE_SCRIPT = [
  "Add-Type -Namespace ChiefmateWin -Name Input -MemberDefinition '[DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid); [StructLayout(LayoutKind.Sequential)] public struct Last { public uint size; public uint tick; } [DllImport(\"user32.dll\")] public static extern bool GetLastInputInfo(ref Last last);'",
  '$p = 0; [void][ChiefmateWin.Input]::GetWindowThreadProcessId([ChiefmateWin.Input]::GetForegroundWindow(), [ref]$p)',
  '$l = New-Object ChiefmateWin.Input+Last; $l.size = 8; [void][ChiefmateWin.Input]::GetLastInputInfo([ref]$l)',
  '$now = [long][Environment]::TickCount -band 4294967295',
  '"$p $((($now - $l.tick) + 4294967296) % 4294967296)"',
].join('; ');

/** The owner is using the window now: it is in front and they used the computer within IN_USE_MS. Never while away. */
function windowInUse(win) {
  if (process.platform !== 'win32' || readState().away) return Promise.resolve(false);
  return new Promise(resolve =>
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', IN_USE_SCRIPT], { windowsHide: true, timeout: 15_000 }, (error, stdout) => {
      const [front, idle] = String(error ? '' : stdout).trim().split(/\s+/).map(Number);
      resolve(front === win.pid && idle < IN_USE_MS);
    }),
  );
}

const WINDOWS = {
  login: { file: LOGIN_FILE, target: 'chiefmate:usage', title: () => t('The claude.ai sign-in window closes soon') },
  owner: { file: OWNER_FILE, target: 'chiefmate:operations', title: () => t("The window opened for a step's request closes soon") },
};

const warnOwner = kind => () =>
  notify(WINDOWS[kind].title(), t("It closes in {minutes} minutes, so the usage reading can use the browser's reading profile. While you are using it, it stays open.", { minutes: WARN_MINUTES }), WINDOWS[kind].target);

/**
 * Starts the browser on the reading profile with an address, and notes its window so the server closes it after
 * LOGIN_MINUTES. Opened again while it is still open, it only brings it forward; "restart" gives it the full time again.
 */
function openWindow(kind, url, config, { start = startWindow, alive = windowAlive, restart = false } = {}) {
  const { file } = WINDOWS[kind];
  const browser = needBrowser(config);
  ensureDir(PROFILE_DIR);
  const before = readJson(file, {});
  const already = loginOpen(before) && alive(before);
  const pid = start(browser, [`--user-data-dir=${PROFILE_DIR}`, '--no-first-run', '--no-default-browser-check', url]);
  if (already) {
    if (!restart) return before;
    const again = { ...before, opened: now(), warned: null };
    writeJson(file, again);
    return again;
  }
  if (!pid) throw failure('no_start', t("The browser didn't start."));
  const opened = { pid, image: path.basename(browser).toLowerCase(), opened: now() };
  writeJson(file, opened);
  return opened;
}

/** A window for you to sign in to claude.ai. "start" and "alive" stand in for the browser and Windows in the tests. */
export const openLogin = (config = loadConfig(), stand = {}) => openWindow('login', LOGIN_PAGE, config, stand);

/** A page a step asks you to see (needs-you): each new one gives the window the full time again. */
export const openOwnerPage = (url, config = loadConfig(), stand = {}) => openWindow('owner', url, config, { ...stand, restart: true });

/** The page window opened last for a step's request: { pid, image, opened, warned, closed, timed_out }. */
export const ownerWindowState = () => readJson(OWNER_FILE, {});

const minding = new Map();

/**
 * Called by the watch: notes a window closed by you; WARN_MINUTES before its time limit, tells you it will close; past
 * the limit, and at least WARN_MINUTES after that warning, closes it, unless you are using it right now (then it waits
 * for the next check). Returns "open", "warned", "closed" or "timed_out", or null with no window open.
 * "alive", "close", "inUse" and "warn" stand in for Windows and its notifications in the tests.
 */
function mindWindow(kind, { at = Date.now(), alive = windowAlive, close = closeWindow, inUse = windowInUse, warn = warnOwner(kind) } = {}) {
  const { file } = WINDOWS[kind];
  const win = readJson(file, {});
  if (!loginOpen(win)) return Promise.resolve(null);
  if (minding.has(kind)) return minding.get(kind);
  const when = new Date(at).toISOString();
  const work = (async () => {
    if (!alive(win)) {
      writeJson(file, { ...win, closed: when, timed_out: false });
      return 'closed';
    }
    const limit = Date.parse(win.opened) + LOGIN_MINUTES * 60_000;
    const warned = Date.parse(win.warned ?? '') || 0;
    if (!warned) {
      if (at < limit - WARN_MINUTES * 60_000) return 'open';
      warn(win);
      writeJson(file, { ...win, warned: when });
      return 'warned';
    }
    if (at < Math.max(limit, warned + WARN_MINUTES * 60_000)) return 'open';
    if (await (async () => inUse(win))().catch(() => false)) return 'open';
    await close(win);
    writeJson(file, { ...win, closed: when, timed_out: true });
    return 'timed_out';
  })().finally(() => minding.delete(kind));
  minding.set(kind, work);
  return work;
}

export const checkLogin = stand => mindWindow('login', stand);
export const checkOwnerWindow = stand => mindWindow('owner', stand);

/**
 * The reading needs you to sign in: never signed in, signed out, or the sign-in window closed by its time limit with
 * no reading since. Not while the window is open: it is there for that.
 */
export function signInNeeded(status = readerStatus(), login = loginState()) {
  if (loginOpen(login)) return false;
  if (!signedIn()) return true;
  if (status.ok === false && SIGN_IN_CAUSES.includes(status.cause)) return true;
  return !!login.timed_out && (Date.parse(login.closed) || 0) > (Date.parse(status.attempted ?? '') || 0);
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
  if (!signedIn()) throw failure('not_signed_in', t('Not signed in yet. Run: node src/cli.mjs claude-login'));
  if (profileInUse()) throw failure('profile_open', t('The browser with the reading profile is open (the sign-in window?). Close it and try again.'));
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
    if (!active) throw failure('no_start', t("The browser didn't start."));
    const [port, browserSocket] = active;
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const target = targets.find(x => x.type === 'page');
    if (!target) throw failure('no_start', t("The browser didn't start."));
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
      if (!m) continue;
      const share = Math.min(1, Number(m[1].replace(',', '.')) / 100);
      return /remaining|left|restante/i.test(lines[j]) ? 1 - share : share; // "60% remaining" is 40% used
    }
    return null;
  };
  const five_hour = percentAfter(/current session|sess[ãa]o atual|5[- ]hour|5 horas/i);
  const seven_day = percentAfter(/weekly|this week|all models|semanal|esta semana|todos os modelos/i);
  // A line with a percentage is about a limit ("Resets in 3 hr · 40% remaining"), never about free resets.
  const grantAt = lines.findIndex(l =>
    !/%/.test(l) &&
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

/**
 * Reads the page now (one reading at a time). Keeps the latest values when it fails, and a page with no limit to read
 * is a failure too ("no_data"). "open" stands in for the browser in the tests.
 */
export function readUsagePage(config = loadConfig(), { open = browse } = {}) {
  if (isLocked()) return Promise.reject(new Error(t('Refused: Chiefmate is in emergency lockdown ({what}). Only the owner can release it, in the app or the command line on this computer.', { what: t('reading claude.ai') })));
  reading ??= (async () => {
    const before = readerStatus();
    const status = { ...before, attempted: now() };
    try {
      const page = await open(config);
      if (/\/(login|signin|logout)\b/.test(new URL(page.url || USAGE_PAGE).pathname)) {
        throw failure('signed_out', t('The reading profile is signed out of claude.ai. Run: node src/cli.mjs claude-login'));
      }
      const found = parseUsagePage(page.text);
      if (found.five_hour === null && found.seven_day === null) {
        const address = new URL(page.url || USAGE_PAGE).pathname;
        throw failure('no_data', t("The usage page ({address}) opened but showed no limit: no percentage and no reset. It may have changed or not finished loading; the usage shown may be out of date.", { address }));
      }
      Object.assign(status, { ok: true, error: null, cause: null, failing_since: null, read_at: now(), ...found });
      status.warning = !found.grants ? t("The page didn't show free resets: the record you keep by hand stays.") : null;
      if (found.grants) applyGrants(found.grants, status.read_at);
    } catch (error) {
      Object.assign(status, failed(before, error, status.attempted));
    }
    writeJson(STATUS_FILE, status);
    return status;
  })().finally(() => (reading = null));
  return reading;
}

/** A failed reading: its message, its cause and since when that cause lasts (kept while the cause stays the same). */
export function failed(before, error, at) {
  const cause = CAUSES.includes(error.readerCause) ? error.readerCause : 'other';
  const same = before.ok === false && before.cause === cause && before.failing_since;
  return { ok: false, error: error.message, cause, failing_since: same ? before.failing_since : at };
}

export const isReading = () => !!reading;

/**
 * Whether a reading is due: every "everyHours"; once, a minute after the sign-in window closed, away or not (it tells
 * whether you signed in); and, while you are away, never after a failure only you can fix (it waits for your return).
 */
export function readingDue({ status = {}, login = {}, everyHours, away = false, at = Date.now() }) {
  const last = Date.parse(status.attempted ?? '') || 0;
  const closed = Date.parse(login.closed ?? '') || 0;
  if (closed > last) return at - closed >= 60_000;
  if (away && status.ok === false && OWNER_CAUSES.includes(status.cause)) return false;
  return at - last >= everyHours * 3600_000;
}

/**
 * Called by the watch every few seconds: minds the windows on the reading profile (no reading while one is open: it
 * can't use the profile), and reads when the reading is on and its time has come.
 */
export function readWhenDue(config) {
  const open = [loginOpen() && checkLogin(), loginOpen(ownerWindowState()) && checkOwnerWindow()].filter(Boolean);
  for (const check of open) check.catch(error => console.error('Browser window:', error.message));
  if (open.length) return;
  const { enabled, everyHours } = readerSettings(config);
  if (!enabled || reading || !signedIn()) return;
  if (readingDue({ status: readerStatus(), login: loginState(), everyHours, away: !!readState().away })) readUsagePage(config).catch(() => {});
}
