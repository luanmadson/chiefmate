// The watchdog: Chiefmate checked from outside its own process, every 10 minutes, by the Windows task
// "\Chiefmate\Watchdog" (scripts/install.ps1 creates it; it runs "node src/cli.mjs watch"). Being apart from Chiefmate,
// it sees Chiefmate stopped, hung or stuck, during and after its updates too. The checks use no AI (findProblems).
// Only when Chiefmate is stuck does it call the rescuer: Claude Code with a closed list of safe actions (restart
// Chiefmate, stop orphan processes, resume a run: "rescue" in src/cli.mjs); anything else is left for the owner.
// The owner hears of it in a Windows notification, and the manager through its news ("watchdog").
import { execFile, spawn } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { denyRules } from './access.mjs';
import { loadConfig } from './config.mjs';
import { t } from './i18n.mjs';
import { reportEvent } from './news.mjs';
import { notify } from './notify.mjs';
import { clip, DATA, ensureDir, languageName, now, readJson, ROOT, stamp, writeJson } from './util.mjs';

const MINUTE = 60_000;
// A problem seen in two checks in a row (10 minutes apart) is no passing moment.
const PERSIST_MS = 15 * MINUTE;
// The longest a run may go without a new action, an update may take to install, or wait to be installed.
const SILENT_MS = 60 * MINUTE;
const INSTALLING_MS = 75 * MINUTE;
const WAITING_MS = 2 * 60 * MINUTE;
// The same notice goes to the owner and the manager again only after this long.
const RENOTIFY_MS = 6 * 60 * MINUTE;
// An orphan process: one the crew's work left behind, alive for at least this long after its parent ended.
const ORPHAN_MS = 30 * MINUTE;
const LOW_MEMORY = 0.08;
const CHIEFMATE_RAM = 2 * 1024 ** 3;

/** "watchdog" in the settings: { "rescuer": true, "model": null (the default_model), "max_minutes": 15, "every_minutes": 60 }. */
export function watchSettings(config = loadConfig()) {
  const w = config.watchdog ?? {};
  return {
    rescuer: w.rescuer !== false,
    model: w.model || config.default_model || 'claude-opus-5-5',
    maxMinutes: Math.max(3, Number(w.max_minutes) || 15),
    // The rescuer is called at most once in this many minutes.
    everyMinutes: Math.max(10, Number(w.every_minutes) || 60),
  };
}

const watchDir = () => ensureDir(path.join(DATA, 'watch'));
const stateFile = () => path.join(DATA, 'watch', 'state.json');
export const readWatch = () => readJson(stateFile(), { seen: {}, notified: {}, rescues: [], resumed: {} });
const saveWatch = s => writeJson(path.join(watchDir(), 'state.json'), s);
const port = (config = loadConfig()) => Number(process.env.CHIEFMATE_PORT) || config.port || 4747;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const age = (iso, at) => (iso ? at - Date.parse(iso) : 0);

/** One line in data/watch/watch.log (kept under half a megabyte). */
function log(line) {
  const file = path.join(watchDir(), 'watch.log');
  try {
    if (existsSync(file) && statSync(file).size > 512 * 1024) renameSync(file, `${file}.old`);
    appendFileSync(file, `${now()} ${line}\n`);
  } catch {
    // the log never stops the watchdog
  }
}

async function api(route, body, { timeout = 15_000, config } = {}) {
  const r = await fetch(`http://localhost:${port(config)}${route}`, {
    ...(body ? { method: 'POST', headers: { 'content-type': 'application/json', 'x-chiefmate': '1' }, body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeout),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
  return data;
}

/** Whether Chiefmate answers, tried a few times: a restart after an update takes up to about 40 seconds. */
async function alive({ tries = 4, gap = 20_000, config } = {}) {
  for (let i = 0; i < tries; i++) {
    if (await api('/api/health', null, { config }).then(() => true, () => false)) return true;
    if (i < tries - 1) await sleep(gap);
  }
  return false;
}

function powershell(script, timeout = 60_000) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) =>
      error ? reject(error) : resolve(String(stdout)),
    );
  });
}

/** Every process, with its parent and when it started (Windows only; elsewhere, none). */
export async function processList() {
  if (process.platform !== 'win32') return [];
  const raw = JSON.parse((await powershell(
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; parent = $_.ParentProcessId; name = $_.Name; cmd = $_.CommandLine; ram = $_.WorkingSetSize; created = if ($_.CreationDate) { $_.CreationDate.ToString('o') } else { $null } } } | ConvertTo-Json -Compress",
  )) || '[]');
  return (Array.isArray(raw) ? raw : [raw]).map(p => ({ ...p, name: p.name ?? '', cmd: p.cmd ?? '', ram: Number(p.ram) || 0 }));
}

/** The kinds of process the crew's work starts, and only those: git, Claude Code headless and Codex exec. */
export function crewKind(p) {
  const name = String(p.name).toLowerCase();
  if (/^git(-remote-https?)?\.exe$/.test(name)) return 'git';
  if (name === 'claude.exe' && /\s-p(\s|$)|--output-format\s+stream-json/.test(p.cmd)) return 'claude';
  if (name === 'codex.exe' && /\bexec\b/.test(p.cmd)) return 'codex';
  return null;
}

/**
 * The orphan processes: of a crew kind (crewKind), alive for at least minAge, and whose parent is gone (or is a newer
 * process that took over its id: Windows reuses them). Nothing else is ever an orphan.
 */
export function orphansIn(list, at = Date.now(), minAge = ORPHAN_MS) {
  const byPid = new Map(list.map(p => [p.pid, p]));
  return list.filter(p => {
    if (!crewKind(p) || age(p.created, at) < minAge) return false;
    const parent = byPid.get(p.parent);
    return !parent || (parent.created && p.created && Date.parse(parent.created) > Date.parse(p.created));
  });
}

/**
 * The checks, with no AI. health: whether Chiefmate answered; state: its /api/state (null when it didn't);
 * memory: { free, total }; orphans: from orphansIn; seen: when each problem was first seen (by id), from the last
 * checks; lastCheck: when the last check ran. Returns [{ id, level: "stuck" (the rescuer may act) or "warn" (the owner
 * and the manager hear of it), text (in English, for the rescuer and the manager), say (for the owner) }].
 */
export function findProblems({ health, state, memory, orphans = [], seen = {}, lastCheck = null, at = Date.now() }) {
  const problems = [];
  const add = (id, level, text, say) => problems.push({ id, level, text, say });
  const lasting = id => age(seen[id], at) >= PERSIST_MS;
  if (!health) {
    add('server_down', 'stuck', "Chiefmate doesn't answer on its port (no answer to /api/health for about a minute): it is stopped or hung.", t("Chiefmate doesn't answer: it is stopped or hung."));
  } else if (state) {
    const running = state.running ?? [];
    const installing = state.update?.installing ?? null;
    // A run ready to start, with room for it, its project free and no update going on, that doesn't start.
    const ready = (state.queue ?? []).filter(r => r.status === 'queued' && (!r.notBefore || Date.parse(r.notBefore) <= at) && !running.some(x => x.project === r.project));
    if (ready.length && !installing && running.length < (state.parallel?.max ?? 3)) {
      const text = `The queue is stuck: ${ready.map(r => `"${r.title}" [${r.id}] (${r.project})`).join(', ')} ready to start, with room for it, and nothing starts.`;
      if (lasting('queue_stuck')) add('queue_stuck', 'stuck', text, t('The queue is stuck: {count} run(s) ready and nothing starts.', { count: ready.length }));
      else add('queue_stuck', 'pending', text, '');
    }
    for (const r of running) {
      const last = r.actions?.at(-1)?.at ?? r.stepStarted ?? r.started;
      if (r.needsYou || r.talking || age(last, at) < SILENT_MS) continue;
      add(`run_silent:${r.id}`, 'stuck', `The run "${r.title}" [${r.id}] (${r.project}) has done nothing for ${Math.round(age(last, at) / MINUTE)} minutes (step ${r.step ?? '-'}, ${r.agent ?? 'preparing'}).`, t('The run "{title}" has done nothing for {minutes} min.', { title: r.title, minutes: Math.round(age(last, at) / MINUTE) }));
    }
    if (installing && age(installing.since, at) >= INSTALLING_MS) {
      add('update_stuck', 'stuck', `An update of Chiefmate has been installing for ${Math.round(age(installing.since, at) / MINUTE)} minutes (stage ${installing.stage}).`, t('An update of Chiefmate has been installing for {minutes} min.', { minutes: Math.round(age(installing.since, at) / MINUTE) }));
    }
    // An approved update not installed: in "wait" mode with the crew at work, that is expected.
    const update = state.update ?? {};
    if (update.waiting > 0 && !installing && !(update.mode === 'wait' && running.length)) {
      const text = `An approved update of Chiefmate (${update.waiting} change(s)) has waited for over ${WAITING_MS / 3600_000} hours${update.blocked ? `, blocked (${update.blocked})` : ''}.`;
      if (age(seen.update_waiting, at) >= WAITING_MS) add('update_waiting', update.blocked ? 'warn' : 'stuck', text, t('An approved update has been waiting for hours.'));
      else add('update_waiting', 'pending', text, '');
    }
    for (const s of state.sessions?.open ?? []) {
      if (['starting', 'login'].includes(s.status) && age(s.started, at) >= PERSIST_MS) {
        add(`session_stuck:${s.id}`, 'warn', `The live session "${s.name}" [${s.id}] has been "${s.status}" for ${Math.round(age(s.started, at) / MINUTE)} minutes.`, t('The live session "{name}" has not started.', { name: s.name }));
      }
      if (s.lastTurn && s.lastTurn.ok === false && (!lastCheck || s.lastTurn.at > lastCheck)) {
        add(`session_error:${s.id}:${s.lastTurn.at}`, 'warn', `The last turn of the live session "${s.name}" [${s.id}] ended with an error.`, t('The live session "{name}" ended its last turn with an error.', { name: s.name }));
      }
    }
    const ram = state.computer?.chiefmate?.ram ?? 0;
    if (ram >= CHIEFMATE_RAM) add('chiefmate_ram', 'warn', `Chiefmate itself uses ${Math.round(ram / 1024 ** 2)} MB of memory.`, t('Chiefmate itself uses {mb} MB of memory.', { mb: Math.round(ram / 1024 ** 2) }));
  }
  if (memory?.total && memory.free / memory.total < LOW_MEMORY) {
    add('memory_low', 'warn', `This computer has only ${Math.round((memory.free / memory.total) * 100)}% of its memory free.`, t('Only {percent}% of the memory is free.', { percent: Math.round((memory.free / memory.total) * 100) }));
  }
  if (orphans.length) {
    add('orphans', 'stuck', `Orphan processes left by the crew's work: ${orphans.map(p => `${p.name} ${p.pid} (${Math.round(p.ram / 1024 ** 2)} MB, since ${p.created})`).join(', ')}.`, t('{count} orphan process(es) left by the crew.', { count: orphans.length }));
  }
  return problems;
}

/** What the watchdog sees now: health, state, memory and orphans, with the problems. Changes nothing. */
export async function look(config = loadConfig(), watch = readWatch(), { quick = false } = {}) {
  const health = await alive({ tries: quick ? 1 : 4, config });
  const state = health ? await api('/api/state', null, { config, timeout: 30_000 }).catch(() => null) : null;
  let orphans = [];
  try {
    orphans = orphansIn(await processList());
  } catch {
    // the process list is a help, not a must
  }
  const memory = { free: os.freemem(), total: os.totalmem() };
  const problems = findProblems({ health, state, memory, orphans, seen: watch.seen ?? {}, lastCheck: watch.last?.at ?? null });
  return { health, state, orphans, problems };
}

/** Tells the manager, through the running Chiefmate; when it doesn't answer, the news waits for its next start. */
async function tellManager(text, config) {
  try {
    await api('/api/watchdog', { text }, { config });
  } catch {
    reportEvent('watchdog', text, { config, later: true });
  }
}

/**
 * One check ("node src/cli.mjs watch"): looks, remembers when each problem was first seen, tells the owner and the
 * manager of what is new and calls the rescuer when Chiefmate is stuck. dryRun: only looks (nothing is saved, said
 * or done). Returns { problems, rescue, told }.
 */
export async function watchOnce({ dryRun = false, config = loadConfig() } = {}) {
  const watch = readWatch();
  const at = Date.now();
  const seen = { ...(watch.seen ?? {}) };
  const result = await look(config, watch, { quick: dryRun });
  if (dryRun) return { ...result, rescue: null, told: [] };
  // The first time each problem was seen; a problem gone is forgotten.
  for (const id of Object.keys(seen)) if (!result.problems.some(p => p.id === id)) delete seen[id];
  for (const p of result.problems) seen[p.id] ??= new Date(at).toISOString();
  const notified = Object.fromEntries(Object.entries(watch.notified ?? {}).filter(([id]) => seen[id]));
  const reportable = result.problems.filter(p => p.level !== 'pending');
  const stuck = reportable.filter(p => p.level === 'stuck');
  const settings = watchSettings(config);
  const lastRescue = watch.rescues?.at(-1);
  const busy = !!watch.rescuing && age(watch.rescuing.since, at) < (settings.maxMinutes + 5) * MINUTE;
  const rescueNow = stuck.length > 0 && settings.rescuer && !busy && (!lastRescue || age(lastRescue.at, at) >= settings.everyMinutes * MINUTE);
  const checked = new Date(at).toISOString();
  saveWatch({ ...watch, seen, notified, last: { at: checked, problems: result.problems.map(p => p.id) } });

  if (rescueNow) {
    saveWatch({ ...readWatch(), rescuing: { pid: process.pid, since: now() } });
    const rescue = await callRescuer(result, config, settings).catch(error => ({ ok: false, error: error.message, summary: '', needs: '', actions: [], log: null }));
    const after = readWatch();
    delete after.rescuing;
    after.rescues = [...(after.rescues ?? []), { at: now(), problems: stuck.map(p => p.id), ok: rescue.ok, summary: rescue.summary, needs: rescue.needs, log: rescue.log }].slice(-30);
    after.notified = { ...after.notified, ...Object.fromEntries(reportable.map(p => [p.id, checked])) };
    saveWatch(after);
    const answers = await alive({ tries: 2, gap: 15_000, config });
    const needs = rescue.needs || (answers ? '' : t('Chiefmate still does not answer.'));
    const said = rescue.ok ? rescue.summary : t('The rescuer could not act: {error}', { error: rescue.error ?? '?' });
    notify(t('Chiefmate watchdog'), [said, needs ? t('Needs you: {what}', { what: needs }) : ''].filter(Boolean).join(' '), 'chiefmate:operations', { urgent: !!needs || !rescue.ok });
    await tellManager(`The watchdog found Chiefmate stuck: ${stuck.map(p => p.text).join(' ')} The rescuer ${rescue.ok ? 'acted' : `could not act (${rescue.error})`}: ${rescue.summary || '-'}${rescue.actions.length ? ` Its actions: ${rescue.actions.join('; ')}.` : ''} Needs the owner: ${needs || 'no'}.${rescue.log ? ` Its full log: ${rescue.log}.` : ''}`, config);
    log(`rescue ${stuck.map(p => p.id).join(',')} ok=${rescue.ok} ${clip(rescue.summary || rescue.error, 200)}`);
    return { ...result, rescue, told: reportable.map(p => p.id) };
  }

  // No rescue now (it is off, ran within the hour or is going on): the owner and the manager hear of what is new.
  const told = reportable.filter(p => !notified[p.id] || age(notified[p.id], at) >= RENOTIFY_MS);
  if (told.length) {
    const after = readWatch();
    after.notified = { ...after.notified, ...Object.fromEntries(told.map(p => [p.id, checked])) };
    saveWatch(after);
    const why = !stuck.length ? '' : !settings.rescuer ? ' (the rescuer is off)' : busy ? ' (the rescuer is at work)' : ' (the rescuer already acted within the hour)';
    notify(t('Chiefmate watchdog'), told.map(p => p.say).join(' '), 'chiefmate:operations', { urgent: told.some(p => p.level === 'stuck') });
    await tellManager(`The watchdog found${why}: ${told.map(p => p.text).join(' ')}`, config);
  }
  log(result.problems.length ? `problems ${result.problems.map(p => `${p.id}(${p.level})`).join(',')}${told.length ? ' told' : ''}` : 'ok');
  return { ...result, rescue: null, told: told.map(p => p.id) };
}

/** The rescuer's instructions: what was found and the closed list of what it may do. */
export function rescuePrompt(found, config = loadConfig()) {
  const owner = config.owner || 'the owner';
  const language = languageName(config.language || 'en');
  return `You are Chiefmate's rescuer. Chiefmate (the command center for AI agents installed in this folder) seems stuck. The watchdog, a check that runs outside Chiefmate every 10 minutes, found:
${found.problems.filter(p => p.level !== 'pending').map(p => `- [${p.level}] ${p.text}`).join('\n')}

Diagnose it, then fix it only with these safe actions, and only when they fit:
- node src/cli.mjs rescue restart: stops Chiefmate (and the crew's processes under it) and starts it again; runs going on start their step over. Not while an update installs.
- node src/cli.mjs rescue stop-orphans [<pid> ...]: stops orphan processes (git, Claude Code or Codex left behind with no parent). Only those it lists.
- node src/cli.mjs rescue resume <run>: resumes a paused or failed run, at most once a day per run.
To look: Read, Grep and Glob (the server's log is data/server.log, the watchdog's is data/watch/watch.log), node src/cli.mjs status | history | report <id> | ram | watch --dry-run, git status and git log.

Rules:
- Never change a file and never try anything outside this list. What needs more (code to fix, settings, a decision, a sign-in) is for ${owner}: say exactly what to do.
- Don't act on a guess: if the evidence doesn't point to an action of the list, do nothing.
- Be quick: a few minutes at most.

End with these lines, in ${language}, as plain text:
SUMMARY: <one sentence: what was wrong and what you did>
NEEDS OWNER: <no, or what ${owner} must do>
then, below, a short report of what you saw and did.`;
}

/** Calls the rescuer (Claude Code, headless, with the closed list only). Returns { ok, summary, needs, actions, log, error }. */
export async function callRescuer(found, config = loadConfig(), settings = watchSettings(config)) {
  const { runClaude } = await import('./claude.mjs');
  const dir = watchDir();
  // Only the latest 20 rescues' logs are kept.
  const logs = readdirSync(dir).filter(f => /^rescue-.*\.jsonl$/.test(f)).sort();
  for (const f of logs.slice(0, Math.max(0, logs.length - 19))) rmSync(path.join(dir, f), { force: true });
  const file = path.join(dir, `rescue-${stamp()}.jsonl`);
  const cli = cmd => `Bash(node src/cli.mjs ${cmd})`;
  const actions = [];
  const job = runClaude({
    dir: ROOT,
    prompt: rescuePrompt(found, config),
    model: settings.model,
    maxMinutes: settings.maxMinutes,
    log: file,
    attribution: false,
    tools: ['Read', 'Grep', 'Glob', cli('rescue:*'), cli('status'), cli('history:*'), cli('report:*'), cli('ram'), cli('watch --dry-run:*'), 'Bash(git status:*)', 'Bash(git log:*)'],
    disallowed: [...denyRules(path.join(DATA, 'browser-profile')), 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Agent', 'Task'],
    env: { CHIEFMATE_RESCUER: '1' },
    onEvent: e => {
      if (e.type === 'action' && /rescue\s/.test(e.text)) actions.push(clip(e.text, 160));
    },
  });
  const r = await job.promise;
  const text = r.text ?? '';
  const line = name => (text.match(new RegExp(`^\\s*\\**${name}\\**:\\s*(.+)$`, 'mi'))?.[1] ?? '').trim();
  const needs = line('NEEDS OWNER');
  return {
    ok: r.ok, error: r.error ?? null, summary: clip(line('SUMMARY') || text, 300), actions, log: file,
    needs: /^(no|não|nao|none|nenhum|-)\.?$/i.test(needs) ? '' : clip(needs, 300),
  };
}

// The rescuer's closed list ("node src/cli.mjs rescue ..."). Each action checks what it touches on its own.

/** The process listening on Chiefmate's port, with its command line; null when none. */
async function listener(config) {
  if (process.platform !== 'win32') return null;
  const out = await powershell(`$c = Get-NetTCPConnection -LocalPort ${port(config)} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress }`);
  const p = out.trim() ? JSON.parse(out) : null;
  return p ? { pid: p.ProcessId, cmd: p.CommandLine ?? '' } : null;
}

/** Everything under a process, through the parent ids. */
function subtree(pid, list) {
  const out = new Set([pid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const p of list) {
      if (out.has(p.pid) || !out.has(p.parent)) continue;
      out.add(p.pid);
      grew = true;
    }
  }
  out.delete(pid);
  return out;
}

const stopPids = pids => (pids.length ? powershell(`Stop-Process -Id ${pids.map(Number).join(',')} -Force -ErrorAction SilentlyContinue`) : null);

/**
 * Restarts Chiefmate: stops the process on its port (only if it is Chiefmate's server) and the crew's processes under
 * it (crewKind; never a live session's or a development environment's window), then starts it as the sign-in does
 * (scripts/start-hidden.vbs). Refused while an update installs: that one restarts by itself.
 */
export async function rescueRestart({ dryRun = false, config = loadConfig() } = {}) {
  if (process.platform !== 'win32') throw new Error('The rescue actions are for Windows.');
  const state = await api('/api/state', null, { config, timeout: 20_000 }).catch(() => null);
  if (state?.update?.installing) throw new Error('An update is being installed: Chiefmate restarts by itself when it ends.');
  const server = await listener(config);
  if (server && !/cli\.mjs["']?\s+server\b/i.test(server.cmd)) throw new Error(`The port ${port(config)} belongs to another program (${clip(server.cmd, 120)}): nothing was stopped.`);
  let crew = [];
  if (server) {
    const list = await processList();
    const windows = list.filter(p => /cli\.mjs["']?\s+(session-run|dev-run)\b/i.test(p.cmd)).flatMap(p => [p.pid, ...subtree(p.pid, list)]);
    const under = subtree(server.pid, list);
    crew = list.filter(p => under.has(p.pid) && crewKind(p) && !windows.includes(p.pid));
  }
  const plan = { stop: server?.pid ?? null, crew: crew.map(p => `${p.name} ${p.pid}`), start: 'scripts/start-hidden.vbs' };
  if (dryRun) return { dryRun: true, ...plan };
  if (server) {
    await stopPids([server.pid]);
    await stopPids(crew.map(p => p.pid));
    for (let i = 0; i < 20 && (await listener(config)); i++) await sleep(1000);
  }
  spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wscript.exe'), [path.join(ROOT, 'scripts', 'start-hidden.vbs')], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true }).unref();
  const started = await alive({ tries: 12, gap: 5000, config });
  log(`rescue restart: stopped ${server?.pid ?? 'nothing'}${crew.length ? ` and ${crew.length} crew process(es)` : ''}; ${started ? 'started' : 'did not start'}`);
  return { ...plan, started };
}

/** Stops orphan processes (orphansIn): all of them, or only the given pids among them. */
export async function rescueStopOrphans(pids = [], { dryRun = false } = {}) {
  let orphans = orphansIn(await processList());
  if (pids.length) orphans = orphans.filter(p => pids.map(Number).includes(p.pid));
  if (!dryRun) {
    await stopPids(orphans.map(p => p.pid));
    if (orphans.length) log(`rescue stop-orphans: ${orphans.map(p => `${p.name} ${p.pid}`).join(', ')}`);
  }
  return orphans.map(({ pid, name, ram, cmd }) => ({ pid, name, ram, command: clip(cmd, 160) }));
}

/** Resumes a paused or failed run, through the running Chiefmate: at most once a day per run. */
export async function rescueResume(id, { dryRun = false, config = loadConfig() } = {}) {
  const state = await api('/api/state', null, { config, timeout: 20_000 });
  const run = [...(state.queue ?? []), ...(state.history ?? [])].find(r => r.id === id);
  if (!run) throw new Error(`Run ${id} not found among the latest.`);
  if (!['paused', 'failed'].includes(run.status)) throw new Error(`Run ${id} is ${run.status}: only a paused or failed run is resumed.`);
  const watch = readWatch();
  if (age(watch.resumed?.[id], Date.now()) < 24 * 60 * MINUTE) throw new Error(`Run ${id} was already resumed by the rescuer today.`);
  if (dryRun) return { dryRun: true, run: id, status: run.status };
  const { status } = await api('/api/resume', { id }, { config });
  saveWatch({ ...readWatch(), resumed: { ...watch.resumed, [id]: now() } });
  log(`rescue resume ${id}: ${status}`);
  return { run: id, status };
}
