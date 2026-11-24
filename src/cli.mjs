// Chiefmate's command line. The manager uses these commands to queue work; you can use them too.
import { loadConfig, saveConfig } from './config.mjs';
import { formatDateTime, formatDuration } from './i18n.mjs';
import { notify } from './notify.mjs';
import { listRuns, readRun, stepsOf } from './store.mjs';

const [command, ...rest] = process.argv.slice(2);
const option = name => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};
const has = name => rest.includes(name);
// CHIEFMATE_PORT runs a second, temporary Chiefmate next to yours (the smoke test does this).
const port = () => Number(process.env.CHIEFMATE_PORT) || loadConfig().port || 4747;
const work = run => formatDuration(stepsOf(run).reduce((sum, s) => sum + (s.durationMs ?? 0), 0));

async function api(route, body) {
  const r = await fetch(
    `http://localhost:${port()}${route}`,
    body ? { method: 'POST', headers: { 'content-type': 'application/json', 'x-chiefmate': '1' }, body: JSON.stringify(body) } : {},
  );
  const data = await r.json();
  if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
  return data;
}

const HELP = `Chiefmate: a command center for AI agents

  node src/cli.mjs server                       starts the app, the queue, the schedule and the updates (http://localhost:${port()})
  node src/cli.mjs status                       what is running, the queue, the account's usage and the crew
  node src/cli.mjs mission <id>                 queues a mission (the ids are in config/chiefmate.json)
  node src/cli.mjs task <project> <agent> "<what to do>" [--review] [--modules A,B]
                                                queues a one-off task; --review has the manager review it at the end;
                                                --modules adds optional blocks of the prompt builder
  node src/cli.mjs chat [n]                     the conversation with the manager: the last n messages (10), what it is
                                                doing now and the messages waiting in the queue
  node src/cli.mjs chat say "<message>"         writes to the manager; while it answers, the message waits in the queue
                                                and goes with the others, in order, when the answer ends
  node src/cli.mjs chat edit <id> "<message>"   changes a message still in the queue (chat remove <id> takes it out)
  node src/cli.mjs chat interrupt               ends the current answer (the conversation goes on); the queue goes next
  node src/cli.mjs cancel <id>                  cancels a run
  node src/cli.mjs resume <id> [--ignore-limits]
                                                resumes a paused, failed or canceled run
  node src/cli.mjs history [n]                  the latest runs
  node src/cli.mjs report <id>                  the report of each step of a run
  node src/cli.mjs context <id> [step]          what each step received: prompt, model, tools, folders, MCP servers
  node src/cli.mjs needs-you "<what to do>" [--url <address>] [--wait] [--check "<command>"] [--id <request>]
                                                for a step of a run: asks the owner to act and, with --wait, waits
                                                until they click Done (or the check command succeeds)
  node src/cli.mjs prompts-sync                 copies the prompt builder's document from Google Docs, through your browser
  node src/cli.mjs limits [--window-5h 0.85] [--plan-week 0.9]
                                                when runs pause, as a share of the account's 5-hour window and plan week
  node src/cli.mjs ram                          the projects running on this computer and the memory each one uses
  node src/cli.mjs stop-project <id> [--yes]    lists, then (with --yes) stops a project's processes on this computer
  node src/cli.mjs reset-grant [list]           the plan's free resets you recorded
  node src/cli.mjs reset-grant add <expires> ["<note>"]
                                                records a free reset (expires: YYYY-MM-DD)
  node src/cli.mjs reset-grant used <n>         marks free reset number n as used (remove <n> deletes it)
  node src/cli.mjs claude-login                 opens a browser window to sign in to claude.ai, for the optional usage reading
  node src/cli.mjs usage-reader on|off|now      turns the reading of claude.ai's usage page on or off, or reads it now
  node src/cli.mjs notify "<title>" "<text>"    tests a Windows notification`;

/** The API when Chiefmate is running, else the same work done here. */
async function apiOr(route, body, local) {
  try {
    return await api(route, body);
  } catch (error) {
    if (error.cause?.code !== 'ECONNREFUSED' && !/fetch failed/.test(error.message)) throw error;
    return local();
  }
}

/**
 * "needs-you", run by a step (Chiefmate gives it CHIEFMATE_RUN and CHIEFMATE_STEP). Without --wait it only records
 * the request. With --wait it waits in rounds of at most 9 minutes (the Bash tool stops a command at 10): exit code 0
 * when it is done, 3 when the round ended and it is still waiting (run the command printed), 2 past the longest wait.
 */
async function needsYou() {
  const run = process.env.CHIEFMATE_RUN;
  if (!run) throw new Error('needs-you is for a step of a Chiefmate run (CHIEFMATE_RUN is not set).');
  const check = option('--check');
  let id = option('--id');
  if (!id) {
    const what = rest.find((x, i) => !x.startsWith('--') && !['--url', '--check', '--id'].includes(rest[i - 1]));
    const request = await api('/api/needs-you', { run, step: process.env.CHIEFMATE_STEP, what, url: option('--url'), wait: has('--wait'), check });
    id = request.id;
    const opened = { browser_cdp: "in a new tab of the owner's browser", playwright: 'in a browser window for the owner', browser: 'in a browser window for the owner' }[request.opened];
    console.log(`Request ${id} sent to the owner${opened ? `; the address opened ${opened}` : ''}.${request.openError ? ` The address did not open: ${request.openError}` : ''}`);
    if (!has('--wait')) return;
  }
  const { spawnSync } = await import('node:child_process');
  const roundEnds = Date.now() + 9 * 60_000;
  let lastCheck = 0;
  for (;;) {
    const s = await api('/api/needs-you/poll', { run, id });
    if (s.status === 'done') {
      console.log(s.by === 'check' ? 'Done: the check succeeded.' : 'Done: the owner signaled it is done. Go on.');
      return;
    }
    if (s.timedOut) {
      console.log(`No answer within ${s.maxWaitMinutes} min. The request stays open in the app: finish what you can and say in your report what is left for the owner.`);
      process.exitCode = 2;
      return;
    }
    if (check && Date.now() - lastCheck >= 15_000) {
      lastCheck = Date.now();
      if (spawnSync(check, { shell: true, stdio: 'ignore', windowsHide: true, timeout: 60_000 }).status === 0) {
        await api('/api/needs-you/done', { run, id, by: 'check' });
        console.log('Done: the check succeeded.');
        return;
      }
    }
    if (Date.now() >= roundEnds) {
      const self = process.argv[1].replaceAll('\\', '/');
      console.log(`Still waiting for the owner (${s.waitedMinutes} of at most ${s.maxWaitMinutes} min). To keep waiting, run: node ${/\s/.test(self) ? `"${self}"` : self} needs-you --wait --id ${id}${check ? ` --check ${JSON.stringify(check)}` : ''}`);
      process.exitCode = 3;
      return;
    }
    await new Promise(r => setTimeout(r, 5000));
  }
}

/** "chat": the conversation with the manager, through the running Chiefmate. */
async function chatCommand() {
  const [action, ...args] = rest;
  const time = iso => (iso ? formatDateTime(iso) : '');
  if (['say', 'edit', 'remove', 'interrupt'].includes(action) && process.env.CHIEFMATE_MANAGER) {
    throw new Error("The manager can't write to its own conversation.");
  }
  switch (action) {
    case 'say': {
      const m = await api('/api/manager', { message: args.join(' ') });
      console.log(m.queued ? `Queued (${m.position} waiting, id ${m.id}): it goes when the manager finishes its answer.` : 'Sent. The manager is answering: node src/cli.mjs chat');
      return;
    }
    case 'edit':
      await api('/api/manager/edit', { id: args[0], message: args.slice(1).join(' ') });
      console.log(`Message ${args[0]} changed.`);
      return;
    case 'remove':
      await api('/api/manager/remove', { id: args[0] });
      console.log(`Message ${args[0]} taken out of the queue.`);
      return;
    case 'interrupt':
      console.log((await api('/api/manager/interrupt', {})).interrupted ? 'Interrupted. The messages in the queue go next.' : 'The manager was not answering.');
      return;
    default: {
      if (action && !/^\d+$/.test(action)) throw new Error('Use: chat [n] | say "<message>" | edit <id> "<message>" | remove <id> | interrupt');
      const g = (await api('/api/state')).manager;
      const who = { you: 'You', manager: 'Manager', system: 'Chiefmate' };
      for (const m of g.messages.slice(-(Number(action) || 10))) {
        const extra = [m.queued ? `delivered ${time(m.delivered)}` : '', m.interrupted ? 'interrupted' : ''].filter(Boolean).join(', ');
        console.log(`[${time(m.at)}] ${who[m.who] ?? m.who}${extra ? ` (${extra})` : ''}:\n${m.text}\n`);
      }
      if (g.responding) {
        console.log(`Now: ${g.context?.renewing ? 'renewing the conversation' : 'answering'} since ${time(g.since)}.${g.lastAction ? ` Last action, ${time(g.lastAction.at)}: ${g.lastAction.text}` : ''}`);
      } else console.log('Now: waiting for you.');
      for (const m of g.pending) console.log(`In the queue [${m.id}], sent ${time(m.at)}${m.edited ? ', edited' : ''}: ${m.text}`);
    }
  }
}

async function main() {
  switch (command) {
    case 'server': {
      // After a self-update, the new Chiefmate waits for the old one to leave.
      if (process.env.CHIEFMATE_RESTART_DELAY) await new Promise(r => setTimeout(r, Number(process.env.CHIEFMATE_RESTART_DELAY)));
      try {
        await api('/api/health');
        console.log(`Chiefmate is already running at http://localhost:${port()}`);
        return;
      } catch {
        // not running yet: start it
      }
      const { startServer } = await import('./server.mjs');
      const { server, port: p } = startServer();
      if (!process.env.CHIEFMATE_SMOKE) (await import('./config.mjs')).backupConfig();
      // The smoke test only needs the app and the API: no queue, no schedule, no updates.
      if (!process.env.CHIEFMATE_SMOKE) {
        const { startQueue } = await import('./queue.mjs');
        const { startSchedule } = await import('./schedule.mjs');
        const { startUpdates } = await import('./update.mjs');
        const { live } = await import('./runs.mjs');
        const { deliverPending, managerBusy } = await import('./manager.mjs');
        const { startWatch } = await import('./plan.mjs');
        startQueue();
        startSchedule();
        startWatch();
        startUpdates({ isBusy: () => !!live.run || managerBusy(), beforeRestart: () => new Promise(resolve => server.close(() => resolve())) });
        deliverPending(); // messages left in the queue when Chiefmate stopped
      }
      console.log(`Chiefmate running at http://localhost:${p} (${new Date().toISOString()})`);
      return;
    }
    case 'status': {
      const s = await api('/api/state');
      const account = s.usage.account;
      const percent = v => `${Math.round((v ?? 0) * 100)}%`;
      console.log(s.current ? `Running: ${s.current.title} [${s.current.id}], step ${s.current.step}: ${s.current.agent}` : 'Running: nothing');
      console.log(`Queue: ${s.queue.map(r => `${r.title} [${r.id}]`).join('; ') || 'empty'}`);
      console.log(`Account: 5-hour window ${percent(account.five_hour?.used)}, plan week ${percent(account.seven_day?.used)}`);
      console.log(`Claude Code: ${s.ai.claude.found ? s.ai.claude.version : 'not found'}`);
      console.log(`Chiefmate ${s.version}${s.update.waiting ? `, update waiting (${s.update.waiting} change(s))` : ''}`);
      for (const m of s.missions) console.log(`Mission ${m.id} (${m.project}): ${m.schedule}${m.next ? `, next ${formatDateTime(m.next)}` : ''}`);
      for (const a of s.crew) console.log(`Crew ${a.id}: ${a.status}${a.run ? ` (${a.run})` : ''}, ${a.model}`);
      return;
    }
    case 'mission': {
      const run = await api('/api/mission', { mission: rest[0], origin: option('--origin') ?? 'manager' });
      console.log(`Queued: ${run.title} [${run.id}]`);
      return;
    }
    case 'task': {
      const [project, agent, instruction] = rest;
      const modules = (option('--modules') ?? '').split(',').map(m => m.trim()).filter(Boolean);
      const run = await api('/api/task', { project, agent, instruction, review: has('--review'), modules, origin: option('--origin') ?? 'manager' });
      console.log(`Queued: ${run.title} [${run.id}]`);
      return;
    }
    case 'chat':
      await chatCommand();
      return;
    case 'cancel':
      console.log((await api('/api/cancel', { id: rest[0] })).status);
      return;
    case 'resume':
      console.log((await api('/api/resume', { id: rest[0], ignoreLimits: has('--ignore-limits') })).status);
      return;
    case 'history':
      for (const r of listRuns().slice(0, Number(rest[0]) || 10)) {
        console.log(`${formatDateTime(r.created)}  ${r.status.padEnd(9)} ${work(r).padStart(10)}  ${r.title} [${r.id}]${r.pullRequest ? `  ${r.pullRequest}` : ''}`);
      }
      return;
    case 'report': {
      const run = readRun(rest[0]);
      if (!run) throw new Error('Run not found.');
      console.log(`# ${run.title} (${run.status})\n${run.result ?? ''}${run.pullRequest ? `\nPull request: ${run.pullRequest}` : ''}\n`);
      for (const step of stepsOf(run)) {
        console.log(`## ${step.agent} (${step.status}, ${formatDuration(step.durationMs)}, ${step.model ?? ''})\n${step.report || step.error || '(no report)'}\n`);
      }
      return;
    }
    case 'context': {
      const { readdirSync, readFileSync } = await import('node:fs');
      const { runDir } = await import('./store.mjs');
      if (!rest[0] || !readRun(rest[0])) throw new Error('Run not found. Use: context <id> [step]');
      const dir = runDir(rest[0]);
      const prefix = rest[1] ? `${String(Number(rest[1])).padStart(2, '0')}-` : '';
      const files = readdirSync(dir).filter(f => f.endsWith('.context.md') && f.startsWith(prefix)).sort();
      if (!files.length) throw new Error('No context recorded for this run or step (runs from before this version have none).');
      for (const f of files) console.log(`${readFileSync(`${dir}/${f}`, 'utf8')}\n`);
      return;
    }
    case 'needs-you':
      await needsYou();
      return;
    case 'prompts-sync': {
      const { syncPrompts } = await import('./promptsync.mjs');
      const status = await apiOr('/api/prompts-sync', {}, () => syncPrompts());
      if (!status.ok) throw new Error(status.error);
      console.log(`Prompt builder copied at ${formatDateTime(status.synced_at)} (${status.bytes} bytes).`);
      return;
    }
    case 'limits': {
      const map = { '--window-5h': 'pause_at_5h_window', '--plan-week': 'pause_at_plan_week' };
      const changes = Object.fromEntries(Object.entries(map).filter(([o]) => option(o) !== undefined).map(([o, key]) => [key, Number(option(o))]));
      if (Object.keys(changes).length) {
        try {
          await api('/api/limits', changes);
        } catch {
          const config = loadConfig();
          config.limits = { ...config.limits, ...changes };
          saveConfig(config);
        }
      }
      console.log(JSON.stringify(loadConfig().limits, null, 2));
      return;
    }
    case 'ram': {
      const machine = await import('./machine.mjs');
      const c = await apiOr('/api/computer', null, async () => (await machine.processes(0), machine.computer()));
      const { formatBytes } = machine;
      const state = { agent: 'crew at work', running: 'running on this computer', queued: 'in the queue', stopped: 'stopped' };
      console.log(`Free memory: ${Math.round((c.memory.free / c.memory.total) * 100)}% (${formatBytes(c.memory.free)} of ${formatBytes(c.memory.total)})`);
      console.log(`Chiefmate itself: ${formatBytes(c.chiefmate.ram)}`);
      if (!c.supported) console.log("The projects' processes are read on Windows only.");
      if (c.error) console.log(`Couldn't read the processes: ${c.error}`);
      for (const p of c.projects) {
        console.log(`${p.id.padEnd(16)} ${state[p.state].padEnd(25)} ${formatBytes(p.ram).padStart(8)}  ${p.processes.length} process(es)`);
        for (const x of p.processes) console.log(`    ${String(x.pid).padStart(6)} ${formatBytes(x.ram).padStart(8)}  ${x.name}${x.crew ? ' (crew)' : ''}${x.guarded ? ' (kept)' : ''}  ${x.command}`);
      }
      return;
    }
    case 'stop-project': {
      const id = rest[0];
      if (!id) throw new Error('Which project? node src/cli.mjs stop-project <id> [--yes]');
      const machine = await import('./machine.mjs');
      const { processes } = await apiOr('/api/stop-project', { project: id, preview: true }, async () => ({ processes: await machine.stoppable(id) }));
      if (!processes.length) {
        console.log(`Nothing of ${id} to stop on this computer.`);
        return;
      }
      console.log(`${has('--yes') ? 'Stopping' : 'These would stop'}:`);
      for (const x of processes) console.log(`  ${String(x.pid).padStart(6)} ${machine.formatBytes(x.ram).padStart(8)}  ${x.name}  ${x.command}`);
      if (!has('--yes')) {
        console.log('Nothing was stopped. Add --yes to stop them.');
        return;
      }
      const pids = processes.map(x => x.pid);
      const { stopped } = await apiOr('/api/stop-project', { project: id, pids }, async () => ({ stopped: await machine.stopProject(id, pids) }));
      console.log(`Stopped ${stopped.length} process(es).`);
      return;
    }
    case 'reset-grant': {
      const { changeResets, planResets } = await import('./plan.mjs');
      const [action = 'list', ...args] = rest;
      let list;
      if (action === 'list') list = planResets();
      else if (action === 'add') list = changeResets({ action, expires: args[0], note: args.slice(1).join(' ') });
      else if (action === 'used' || action === 'remove') list = changeResets({ action, index: args[0] });
      else throw new Error('Use: reset-grant [list] | add <expires> ["<note>"] | used <n> | remove <n>');
      for (const g of list) {
        const status = g.used ? 'used' : g.available ? 'available' : 'expired';
        console.log(`${String(g.index).padStart(2)}. ${status.padEnd(9)} ${g.expires ? `expires ${formatDateTime(g.expires)}` : 'expiry unknown'}${g.note ? `  ${g.note}` : ''}${g.source === 'claude.ai' ? '  (read on claude.ai)' : ''}`);
      }
      if (!list.length) console.log('No free resets recorded.');
      return;
    }
    case 'claude-login': {
      const { openLogin, PROFILE_DIR } = await import('./usagepage.mjs');
      openLogin();
      console.log(`A browser window opened with Chiefmate's own profile (${PROFILE_DIR}).
Sign in to claude.ai there, then close the window.
The reading is off until you turn it on: node src/cli.mjs usage-reader on`);
      return;
    }
    case 'usage-reader': {
      const reader = await import('./usagepage.mjs');
      const action = rest[0];
      if (action === 'on' || action === 'off') {
        const config = loadConfig();
        config.usage_reader = { ...config.usage_reader, enabled: action === 'on' };
        saveConfig(config);
      } else if (action === 'now') {
        const start = Date.now() - 1000;
        await apiOr('/api/usage-reader', { read: true }, () => reader.readUsagePage());
        // Through the server, the reading goes on there: its result is written when it ends (wait up to two minutes).
        for (let i = 0; i < 120 && !(Date.parse(reader.readerStatus().attempted ?? '') >= start); i++) await new Promise(r => setTimeout(r, 1000));
      }
      const { enabled, everyHours } = reader.readerSettings();
      console.log(`Reading of claude.ai: ${enabled ? `on, every ${everyHours} h` : 'off'}${reader.signedIn() ? '' : ' (not signed in: node src/cli.mjs claude-login)'}`);
      console.log(JSON.stringify(reader.readerStatus(), null, 2));
      return;
    }
    case 'notify':
      notify(rest[0] ?? 'Chiefmate', rest[1] ?? 'Test notification.');
      return;
    default:
      console.log(HELP);
  }
}

main().catch(error => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
