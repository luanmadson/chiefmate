// When a step needs the owner: signing in somewhere, confirming something, doing what only a person can do.
// The agent runs "node <chiefmate>/src/cli.mjs needs-you "<what to do>" [--url <address>] [--wait]". Chiefmate records
// the request in the run, shows it in the app (a band at the top, the window's icon and title) and in a Windows
// notification, and opens the address in the owner's browser. With --wait, the command returns when the owner clicks
// "I did it" (or a check the agent gave succeeds), or answers it from the agent's panel (the command hands the answer
// over). A question (--options "A|B", --recommend, --why) always waits, with one button per option. While it waits,
// the step's time limit stands still; past the longest wait, the command returns and the request stays open: the run
// is never canceled for it.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { loadConfig } from './config.mjs';
import { t } from './i18n.mjs';
import { reportEvent } from './news.mjs';
import { notify } from './notify.mjs';
import { activeRun, liveOf } from './runs.mjs';
import { listRuns, readRun, saveRun, stepsOf } from './store.mjs';
import { agentSays } from './talk.mjs';
import { browserPath, PROFILE_DIR } from './usagepage.mjs';
import { clip, ensureDir, now } from './util.mjs';

const OPTIONS_MAX = 6; // as the manager's questions (src/decisions.mjs)

/** "needs_you": { "max_wait_minutes": 120 }: the longest a step waits for you before it goes on without you. */
export const needsSettings = (config = loadConfig()) => ({ maxWaitMinutes: Math.max(1, Number(config.needs_you?.max_wait_minutes) || 120) });

// A run going on lives in memory (its steps save it as they go): requests are written to that same object.
const runFor = id => activeRun(id) ?? readRun(id);

let ownerBrowser = null;

/**
 * Opens an address for the owner, without touching the tabs already open:
 * with "browser_cdp" (your own browser, signed in, with remote debugging on), in a new tab of it;
 * without it, in a visible browser with Chiefmate's own profile (data/browser-profile, which the crew can't read),
 * through Playwright when playwright-core is installed, else by starting Edge or Chrome on that profile.
 */
export async function openForOwner(url, config = loadConfig()) {
  if (config.browser_cdp) {
    const base = String(config.browser_cdp).replace(/\/+$/, '');
    const r = await fetch(`${base}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
    if (!r.ok) throw new Error(t("Your browser at {address} didn't open the tab ({status}).", { address: base, status: r.status }));
    return 'browser_cdp';
  }
  ensureDir(PROFILE_DIR);
  let playwright = null;
  try {
    playwright = await import('playwright-core');
  } catch {
    // optional: without it, the browser is started directly on the same profile
  }
  if (playwright) {
    if (!ownerBrowser) {
      ownerBrowser = await playwright.chromium.launchPersistentContext(PROFILE_DIR, { headless: false, executablePath: browserPath(config) ?? undefined, viewport: null });
      ownerBrowser.on('close', () => (ownerBrowser = null));
    }
    const page = await ownerBrowser.newPage();
    page.goto(url).catch(() => {});
    return 'playwright';
  }
  const browser = browserPath(config);
  if (!browser) throw new Error(t('No Microsoft Edge or Google Chrome found. Set "usage_reader": { "browser": "<path>" } in the settings.'));
  spawn(browser, [`--user-data-dir=${PROFILE_DIR}`, '--no-first-run', '--no-default-browser-check', url], { detached: true, stdio: 'ignore' }).unref();
  return 'browser';
}

const same = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

/**
 * A question's options ("A|B" or a list), each once, and the recommended one among them. Without options, the request
 * is an action the owner takes outside the app (answered with "I did it").
 */
function questionOf(options, recommend) {
  const list = (Array.isArray(options) ? options : String(options ?? '').split('|')).map(o => clip(o, 60)).filter(Boolean);
  const choices = list.filter((o, i) => list.findIndex(x => same(x, o)) === i);
  if (!choices.length) return null;
  if (choices.length < 2 || choices.length > OPTIONS_MAX) throw new Error(`Give 2 to ${OPTIONS_MAX} options, separated by "|".`);
  const recommended = recommend ? choices.find(o => same(o, recommend)) : null;
  if (recommend && !recommended) throw new Error(`The recommendation must be one of the options: ${choices.join(', ')}.`);
  return { options: choices, recommend: recommended ?? null };
}

/** Records a request from a step and lets the owner know. Returns the request, with the longest wait. */
export async function askOwner({ run: runId, step, what, url, wait = false, check = null, options = null, recommend = null, why = null }) {
  const text = String(what ?? '').trim();
  if (!text) throw new Error(t('Say what the owner should do.'));
  if (url && !/^https?:\/\//i.test(String(url))) throw new Error(t('The address must start with http:// or https://.'));
  const question = questionOf(options, recommend);
  const run = runId ? runFor(String(runId)) : null;
  if (!run) throw new Error(t('Only a step of a run can ask for you: no run was given.'));
  const n = Number(step) || null;
  const request = {
    id: randomUUID().slice(0, 8), step: n, agent: (n && stepsOf(run)[n - 1]?.agent) || liveOf(run.id)?.agent || null, what: clip(text, 500),
    // A question always waits: its answer is what the step needs.
    url: url ? String(url) : null, wait: !!wait || !!question, check: check ? clip(check, 300) : null, status: 'open', at: now(),
    ...(question ? { ...question, why: why ? clip(String(why).trim(), 300) : null } : {}),
  };
  (run.requests ??= []).push(request);
  // The request is also part of the direct conversation: the owner can answer it from the agent's panel.
  agentSays(run, { step: n, agent: request.agent, text: request.what, kind: 'request', request: request.id });
  saveRun(run);
  notify(t('Needs you: {title}', { title: run.title }), request.what, 'chiefmate:operations', { urgent: true });
  reportEvent('needs_you', `${request.agent ?? 'A step'} in run ${run.id} "${run.title}" (project ${run.project}) needs the owner: ${request.what}${request.options ? ` (options: ${request.options.join(' | ')}${request.recommend ? `; recommends ${request.recommend}` : ''})` : ''}${request.url ? ` (address: ${request.url}, opened in the owner's browser)` : ''}${request.wait ? (request.options ? '. The step waits for the owner to choose in the app.' : '. The step waits until the owner clicks "I did it" in the app.') : '. The step goes on meanwhile.'}`);
  if (request.url) {
    try {
      request.opened = await openForOwner(request.url);
    } catch (error) {
      request.openError = error.message;
    }
    saveRun(run);
  }
  return { ...request, run: run.id, maxWaitMinutes: needsSettings().maxWaitMinutes };
}

const findRequest = (runId, id) => {
  const run = runFor(String(runId ?? ''));
  const request = run?.requests?.find(r => r.id === id);
  if (!request) throw new Error(t('Request not found.'));
  return { run, request };
};

/** The waiting command asks every few seconds: while it does, within the longest wait, the step's clock stands still. */
export function pollRequest(runId, id) {
  const { run, request } = findRequest(runId, id);
  const waited = Date.now() - Date.parse(request.at);
  const max = needsSettings().maxWaitMinutes * 60_000;
  const going = liveOf(run.id);
  if (request.status === 'open' && waited < max && going) going.heldUntil = Date.now() + 20_000;
  return { status: request.status, by: request.by ?? null, answer: request.answer ?? null, waitedMinutes: Math.floor(waited / 60_000), maxWaitMinutes: max / 60_000, timedOut: waited >= max };
}

/** "I did it": the owner did it (or the agent's check succeeded); for a question, the option the owner chose. */
export function finishRequest(runId, id, by = 'owner', answer = null) {
  const { run, request } = findRequest(runId, id);
  const choice = answer == null ? null : request.options?.find(o => same(o, answer));
  if (answer != null && !choice) throw new Error(t('Answer with one of the options.'));
  if (request.status === 'open') Object.assign(request, { status: 'done', done: now(), by }, choice ? { answer: choice } : {});
  saveRun(run);
  return request;
}

/** The open requests of every run, newest first, for the app. */
export function openRequests(runs = listRuns()) {
  const list = [];
  for (const stored of runs) {
    const run = activeRun(stored.id) ?? stored;
    for (const r of run.requests ?? []) {
      if (r.status === 'open') list.push({ ...r, run: run.id, title: run.title, project: run.project, runStatus: run.status });
    }
  }
  return list.sort((a, b) => b.at.localeCompare(a.at));
}
