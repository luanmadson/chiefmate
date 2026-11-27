// The owner's local key: what tells the owner's own requests to the app's API (the app on this computer, the owner's
// terminal) from any other program here, the agents' scripts included. It is made once, kept in a file of
// data/security that the agents' file tools can't read and the guard refuses to reach (protectedFolders), and is
// never put in an environment: the server and the owner's command line read the file themselves. The app gets it
// when its window opens: the server opens it with a one-time pairing code, which the app trades for the key and keeps
// in this browser's storage for the app's own address.
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { ownerKeyFile, SECURITY_DIR } from './lockdown.mjs';
import { ensureDir } from './util.mjs';

/** The header that carries the key. */
export const OWNER_HEADER = 'x-chiefmate-owner';

const cached = new Map();

/** The key, made the first time it is asked for. */
export function ownerKey(dir = SECURITY_DIR) {
  if (cached.has(dir)) return cached.get(dir);
  const file = ownerKeyFile(dir);
  let key = '';
  try {
    key = readFileSync(file, 'utf8').trim();
  } catch {
    // made below
  }
  if (!key) {
    ensureDir(dir);
    try {
      writeFileSync(file, `${randomBytes(32).toString('base64url')}\n`, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error; // another process made it at the same time: its key wins
    }
    try {
      chmodSync(file, 0o600);
    } catch {
      // not every system keeps these permissions
    }
    key = readFileSync(file, 'utf8').trim();
  }
  cached.set(dir, key);
  return key;
}

/** Whether a request carries the owner's key. */
export function isOwner(headers = {}, dir = SECURITY_DIR) {
  const given = Buffer.from(String(headers[OWNER_HEADER] ?? ''));
  const key = Buffer.from(ownerKey(dir));
  return given.length === key.length && timingSafeEqual(given, key);
}

/** Whether this process runs for an agent: a step, the manager, a live session or the watchdog's rescuer. */
export const forAgent = (env = process.env) => !!(env.CHIEFMATE_RUN || env.CHIEFMATE_MANAGER || env.CHIEFMATE_SESSION || env.CHIEFMATE_RESCUER);

/** The headers the command line adds: the key on the owner's terminal, nothing when an agent runs it. */
export const ownerHeaders = (env = process.env, dir = SECURITY_DIR) => (forAgent(env) ? {} : { [OWNER_HEADER]: ownerKey(dir) });

// ---------- Pairing the app ----------

const CODE_MINUTES = 2;
const codes = new Map();

/** A pairing code, good once and for two minutes. */
export function pairingCode(at = Date.now()) {
  for (const [code, until] of codes) if (until < at) codes.delete(code);
  const code = randomBytes(18).toString('base64url');
  codes.set(code, at + CODE_MINUTES * 60_000);
  return code;
}

/** The key for a pairing code, which is then spent; null for an unknown, spent or expired one. */
export function redeemCode(code, { at = Date.now(), dir = SECURITY_DIR } = {}) {
  const until = codes.get(String(code ?? ''));
  if (until === undefined) return null;
  codes.delete(String(code));
  return until >= at ? ownerKey(dir) : null;
}

const WINDOW_GAP_MS = 15_000;
let lastWindow = 0;

/**
 * Opens the app in a window of its own on this computer (Edge or Chrome, "browser"), with a pairing code, at most once
 * every 15 seconds. "section": the app's section to show (letters only). Without a browser it opens nothing, and
 * scripts/open.vbs opens the app as before. The smoke test's temporary Chiefmate opens nothing: { dryRun: true }.
 */
export function openAppWindow({ port, section = '', browser = null, at = Date.now(), dryRun = !!process.env.CHIEFMATE_SMOKE } = {}) {
  if (at - lastWindow < WINDOW_GAP_MS) return { opened: false, wait: true };
  const hash = /^[a-z]{1,20}$/.test(section) ? `#${section}` : '';
  if (dryRun) return { opened: false, dryRun: true };
  if (!browser) return { opened: false };
  lastWindow = at;
  const url = `http://localhost:${port}/?pair=${pairingCode(at)}${hash}`;
  const child = spawn(browser, [`--app=${url}`, '--window-size=1480,940'], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
  return { opened: true };
}
