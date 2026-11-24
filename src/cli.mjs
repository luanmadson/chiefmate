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
  node src/cli.mjs task <project> <agent> "<what to do>" [--review]
                                                queues a one-off task; --review has the manager review it at the end
  node src/cli.mjs cancel <id>                  cancels a run
  node src/cli.mjs resume <id> [--ignore-limits]
                                                resumes a paused, failed or canceled run
  node src/cli.mjs history [n]                  the latest runs
  node src/cli.mjs report <id>                  the report of each step of a run
  node src/cli.mjs limits [--window-5h 0.85] [--plan-week 0.9]
                                                when runs pause, as a share of the account's 5-hour window and plan week
  node src/cli.mjs notify "<title>" "<text>"    tests a Windows notification`;

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
      // The smoke test only needs the app and the API: no queue, no schedule, no updates.
      if (!process.env.CHIEFMATE_SMOKE) {
        const { startQueue } = await import('./queue.mjs');
        const { startSchedule } = await import('./schedule.mjs');
        const { startUpdates } = await import('./update.mjs');
        const { live } = await import('./runs.mjs');
        const { chat } = await import('./manager.mjs');
        startQueue();
        startSchedule();
        startUpdates({ isBusy: () => !!live.run || chat.responding, beforeRestart: () => new Promise(resolve => server.close(() => resolve())) });
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
      const run = await api('/api/task', { project, agent, instruction, review: has('--review'), origin: option('--origin') ?? 'manager' });
      console.log(`Queued: ${run.title} [${run.id}]`);
      return;
    }
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
