// The crew's browsers (Playwright's MCP server, in a step or a live session): each project has a profile of its own in
// data/browsers/<project> (its sign-ins stay there, never in the owner's browser), the window is named after the project
// and the task, and the browser's frame takes the project's color. The app lists the ones open (src/server.mjs) and
// Chiefmate closes those whose task is over, unless the task left a request open for the owner (a sign-in under way).
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { t } from './i18n.mjs';
import { processes, SUPPORTED } from './machine.mjs';
import { activeRun, liveOf } from './runs.mjs';
import { readSession } from './sessions.mjs';
import { readRun } from './store.mjs';
import { clip, DATA, ensureDir, readJson, writeJson } from './util.mjs';

export const BROWSERS = path.join(DATA, 'browsers');
const LAUNCHES = path.join(BROWSERS, 'launches.json');
const LAUNCHES_MAX = 80;
const MARK = '--chiefmate-browser=';

// One color per project, in the order of the projects in the settings, unless the project sets its own ("color").
export const PALETTE = ['#3b6ea5', '#a5603b', '#4a8a5a', '#7d5aa5', '#a58a3b', '#3b8f8f', '#a54a6a', '#6a7d3b', '#5a6aa5', '#8f5a3b'];
const NEUTRAL = '#6b7280';

/** The color of a project: its own "color" (#rrggbb), else the palette's, by its place among the projects. */
export function projectColor(config, id) {
  const own = config.projects?.[id]?.color;
  if (/^#[0-9a-f]{6}$/i.test(String(own ?? ''))) return String(own).toLowerCase();
  const index = Object.keys(config.projects ?? {}).indexOf(id);
  return index < 0 ? NEUTRAL : PALETTE[index % PALETTE.length];
}

/** Up to two letters for a name: "Atlas Público" → "AP", "Chiefmate" → "CH". */
export function initials(name) {
  const words = String(name ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!words.length) return '?';
  return (words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)).toUpperCase();
}

/** How a project's browser looks: { id, name, color, initials }. Without a project (a session of a folder), neutral. */
export function projectLook(config, id, fallbackName = null) {
  const name = (id && config.projects?.[id]?.name) || fallbackName || id || t('No project');
  return { id: id ?? null, name, color: projectColor(config, id), initials: initials(name) };
}

/** The window's name, in the taskbar and Alt+Tab: "<Project> · <short task>". */
export function windowName(projectName, task) {
  const clean = text => clip(String(text ?? '').replace(/[\u0000-\u001f"]/g, ' '), 48);
  return [clean(projectName), clean(task)].filter(Boolean).join(' · ');
}

const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const shade = (color, amount) => color.map(c => Math.round(c * (1 - amount)));

/** A theme extension with the project's color on the frame and a darker toolbar. */
export function themeManifest(look) {
  const base = rgb(look.color);
  const white = [255, 255, 255];
  return {
    manifest_version: 3, name: `Chiefmate: ${look.name}`, version: '1.0', description: `The color of ${look.name} in the crew's browser.`,
    theme: {
      colors: {
        frame: base, frame_inactive: shade(base, 0.3), frame_incognito: base, toolbar: shade(base, 0.55), tab_text: white, tab_background_text: white,
        tab_background_text_inactive: [220, 220, 220], bookmark_text: white, toolbar_button_icon: white, omnibox_background: shade(base, 0.75), omnibox_text: white,
        ntp_background: shade(base, 0.55), ntp_text: white,
      },
    },
  };
}

/**
 * The browser's own color setting ("Customize Chrome" in recent Chrome), seeded in the profile: Chrome and Edge may
 * ignore the theme extension (recent branded builds refuse --load-extension), the window still gets the color.
 */
function seedColor(profile, color) {
  const file = path.join(profile, 'Default', 'Preferences');
  let prefs = {};
  if (existsSync(file)) {
    try {
      prefs = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return; // the browser's own file, unreadable now: left as it is
    }
  }
  const value = (0xff000000 | parseInt(color.slice(1), 16)) | 0; // an SkColor, as Chrome stores it (a signed integer)
  const theme = prefs.browser?.theme ?? {};
  if (theme.user_color === value && theme.user_color2 === value) return;
  prefs.browser = { ...prefs.browser, theme: { ...theme, user_color: value, user_color2: value } };
  ensureDir(path.dirname(file));
  writeFileSync(file, JSON.stringify(prefs));
}

const safeName = text => String(text ?? '').replace(/[^\w.-]+/g, '-').slice(0, 80) || 'other';

/** The arguments of the browser: its window's name, the theme and Chiefmate's mark (Chromium ignores switches it doesn't know). */
export function launchArgs({ name, theme, owner }) {
  return [`--window-name=${name}`, `--disable-extensions-except=${theme}`, `--load-extension=${theme}`, `${MARK}${owner}`];
}

function remember(owner, entry) {
  const all = readJson(LAUNCHES, {});
  all[owner] = entry;
  writeJson(LAUNCHES, Object.fromEntries(Object.entries(all).sort((a, b) => String(b[1].at).localeCompare(String(a[1].at))).slice(0, LAUNCHES_MAX)));
}

/**
 * Prepares a project's browser for a step or a session: its profile, its theme and the configuration Playwright's MCP
 * server reads (--config). who: { project, owner: "run:<id>" or "session:<id>", task, name (without a project) }.
 * Returns the configuration's path.
 */
export function prepareBrowser(config, who) {
  const look = projectLook(config, who.project, who.name);
  const dir = path.join(BROWSERS, safeName(who.project ?? 'other'));
  const profile = path.join(dir, 'profile');
  const theme = path.join(dir, 'theme');
  ensureDir(profile);
  ensureDir(theme);
  writeFileSync(path.join(theme, 'manifest.json'), JSON.stringify(themeManifest(look), null, 2));
  seedColor(profile, look.color);
  const file = path.join(dir, `launch-${safeName(who.owner)}.json`);
  const name = windowName(look.name, who.task);
  writeJson(file, { browser: { userDataDir: profile, launchOptions: { args: launchArgs({ name, theme, owner: who.owner }) } } });
  remember(who.owner, { project: who.project ?? null, name: look.name, task: clip(who.task ?? '', 120), at: new Date().toISOString() });
  // The configurations of older tasks go after a week.
  for (const f of readdirSync(dir).filter(x => x.startsWith('launch-') && x.endsWith('.json'))) {
    const full = path.join(dir, f);
    if (Date.now() - statSync(full).mtimeMs > 7 * 86_400_000) rmSync(full, { force: true });
  }
  return file;
}

// Microsoft's server only (its package or its binary): others named alike, such as playwright-mcp-server, read no --config.
const PLAYWRIGHT = /@playwright\/mcp\b|(^|[\s\\/])mcp-server-playwright\b/i;
// Arguments with which the settings already chose the browser: those are left alone.
const OWN_CHOICE = /^--(config|user-data-dir|isolated|cdp-endpoint|extension|storage-state)\b/;

export const isPlaywright = server => PLAYWRIGHT.test([server?.command, ...(server?.args ?? [])].join(' '));

/**
 * The MCP servers of a step or a session, with Playwright's pointed at the project's browser (see prepareBrowser).
 * A server whose arguments already choose a profile or a browser is kept as the settings have it.
 */
export function browserServers(config, servers, who) {
  let file = null;
  return Object.fromEntries(Object.entries(servers ?? {}).map(([name, server]) => {
    const args = server?.args ?? [];
    if (!isPlaywright(server) || args.some(a => OWN_CHOICE.test(String(a)))) return [name, server];
    try {
      file ??= prepareBrowser(config, who);
    } catch (error) {
      console.error('Browser profile:', error.message);
      return [name, server];
    }
    return [name, { ...server, args: [...args, '--config', file] }];
  }));
}

// ---------- The browsers open ----------

/** Whether the task of a browser is still going on: a run in progress or in the queue, a live session open. */
function ownerState(owner) {
  const [kind, id] = String(owner ?? '').split(/:(.*)/s);
  if (kind === 'run') {
    const run = activeRun(id) ?? readRun(id);
    const running = !!liveOf(id) || ['running', 'queued', 'waiting'].includes(run?.status);
    return { known: !!run, running, request: (run?.requests ?? []).some(r => r.status === 'open'), title: run?.title ?? null };
  }
  if (kind === 'session') {
    const session = readSession(id);
    return { known: !!session, running: !!session && session.status !== 'ended', request: (session?.requests ?? []).some(r => r.status === 'open'), title: session?.name ?? null };
  }
  return { known: false, running: false, request: false, title: null };
}

/**
 * Whether Chiefmate closes a browser by itself: its task is known and over, and left no request open for the owner
 * (a step that asks for a sign-in keeps its browser until the request is answered).
 */
export const shouldClose = ({ known, running, request }) => known && !running && !request;

/** What the app shows of a browser: "running", "kept" (a request open), "done" (may close) or "unknown". */
export function browserState(s) {
  if (!s.known) return 'unknown';
  if (s.running) return 'running';
  return s.request ? 'kept' : 'done';
}

const time = b => Date.parse(b.since ?? '') || Number.MAX_SAFE_INTEGER;

// The browsers Playwright starts: Chrome, Edge, Chromium (a shell's command that only mentions the mark is not one).
const BROWSER_EXE = /^(chrome|msedge|chromium|chrome-headless-shell|brave)(\.exe)?$/i;

/**
 * The crew's browsers among the processes: the main process (no --type) of each browser with Chiefmate's mark, and
 * those of Playwright's MCP server on its default profile (opened before the projects had their own).
 */
export function findBrowsers(config, list, { launches = readJson(LAUNCHES, {}), state = ownerState } = {}) {
  return list
    .filter(p => BROWSER_EXE.test(p.name ?? '') && !/--type=/.test(p.cmd) && (p.cmd.includes(MARK) || /ms-playwright[\\/]+mcp-/i.test(p.cmd)))
    .map(p => {
      const owner = (p.cmd.match(/--chiefmate-browser=([\w:.-]+)/) ?? [])[1] ?? null;
      const launch = owner ? launches[owner] ?? {} : {};
      const fromDir = p.cmd.match(/[\\/]browsers[\\/]([\w.-]+)[\\/]profile/i)?.[1] ?? null;
      const project = launch.project ?? (fromDir && config.projects?.[fromDir] ? fromDir : null);
      const s = owner ? state(owner) : { known: false, running: false, request: false, title: null };
      return {
        pid: p.pid, owner, ...projectLook(config, project, launch.name), task: launch.task || s.title || null,
        since: p.started ?? launch.at ?? null, running: s.running, state: browserState(s), close: shouldClose(s), ram: p.ram ?? 0,
      };
    })
    .sort((a, b) => time(a) - time(b)); // oldest first, unknown last
}

// Browsers being closed now, not tried again for a while.
const closing = new Map();

function closePid(pid) {
  closing.set(pid, Date.now());
  if (process.platform !== 'win32') {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // gone already
    }
    return;
  }
  // First as a click on its close button (the browser saves its sign-ins), then forced if it is still there.
  spawnSync('taskkill', ['/PID', String(pid)], { windowsHide: true });
  setTimeout(() => {
    try {
      process.kill(pid, 0);
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    } catch {
      // closed
    }
  }, 8000).unref();
}

let lastSweep = 0;

/** Closes the browsers whose task is over (see shouldClose). Returns the pids closed. */
export function sweepBrowsers(config, list) {
  const done = [];
  for (const b of findBrowsers(config, list)) {
    if (!b.close || Date.now() - (closing.get(b.pid) ?? 0) < 60_000) continue;
    closePid(b.pid);
    done.push(b.pid);
  }
  return done;
}

/** The browsers open, from the latest reading of the processes (src/machine.mjs); a newer reading closes the finished ones. */
export function openBrowsers(config = loadConfig(), cache = null) {
  if (!SUPPORTED || !cache?.list) return [];
  if (cache.at > lastSweep) {
    lastSweep = cache.at;
    try {
      sweepBrowsers(config, cache.list);
    } catch (error) {
      console.error('Browsers:', error.message);
    }
  }
  return findBrowsers(config, cache.list).filter(b => Date.now() - (closing.get(b.pid) ?? 0) > 15_000);
}

/** After a run: its browser closes a few seconds later, once its MCP server had the time to close it itself. */
export function closeAfterRun() {
  if (!SUPPORTED) return;
  setTimeout(() => {
    processes(0)
      .then(cache => sweepBrowsers(loadConfig(), cache.list))
      .catch(error => console.error('Browsers:', error.message));
  }, 5000).unref();
}

/** A browser of the list, read again now: a pid that is no longer one of the crew's browsers is refused. */
async function browserOf(pid) {
  if (!SUPPORTED) throw new Error(t('The browsers are listed on Windows only.'));
  const { list } = await processes(0);
  const found = findBrowsers(loadConfig(), list).find(b => b.pid === Number(pid));
  if (!found) throw new Error(t('This browser is no longer open.'));
  return found;
}

/** Closes one browser of the list (the owner's button). */
export async function closeBrowser(pid) {
  const b = await browserOf(pid);
  closePid(b.pid);
  return b;
}

const FOCUS = pid => `
Add-Type -Namespace Chiefmate -Name Win -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c); [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);'
$h = (Get-Process -Id ${Number(pid)}).MainWindowHandle
if ($h -eq 0) { exit 3 }
if ([Chiefmate.Win]::IsIconic($h)) { [void][Chiefmate.Win]::ShowWindow($h, 9) }
[void](New-Object -ComObject WScript.Shell).AppActivate(${Number(pid)})
[void][Chiefmate.Win]::SetForegroundWindow($h)`;

/** Brings a browser of the list to the front (restored if minimized). */
export async function focusBrowser(pid) {
  const b = await browserOf(pid);
  const encoded = Buffer.from(FOCUS(b.pid), 'utf16le').toString('base64');
  await new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, timeout: 15_000 }, error =>
      error ? reject(new Error(error.code === 3 ? t('This browser has no window to show.') : error.message)) : resolve());
  });
  return b;
}
