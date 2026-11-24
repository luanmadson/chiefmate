// Chiefmate's command line. The manager uses these commands to queue work; you can use them too.
import { loadConfig, saveConfig } from './config.mjs';
import { formatDateTime, formatMoney } from './i18n.mjs';
import { notify } from './notify.mjs';
import { listRuns, readRun, runCost, stepsOf } from './store.mjs';

const [command, ...rest] = process.argv.slice(2);
const option = name => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};
const has = name => rest.includes(name);
const port = () => loadConfig().port ?? 4747;

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

  node src/cli.mjs server                       starts the app, the queue and the schedule (http://localhost:${port()})
  node src/cli.mjs status                       what is running, the queue and usage
  node src/cli.mjs mission <id>                 queues a mission (the ids are in config/chiefmate.json)
  node src/cli.mjs task <project> <agent> "<what to do>" [--review]
                                                queues a one-off task; --review has the manager review it at the end
  node src/cli.mjs cancel <id>                  cancels a run
  node src/cli.mjs resume <id> [--ignore-limits]
                                                resumes a paused, failed or canceled run
  node src/cli.mjs history [n]                  the latest runs
  node src/cli.mjs report <id>                  the report of each step of a run
  node src/cli.mjs limits [--weekly N] [--per-run N] [--window-5h 0.85] [--plan-week 0.9]
  node src/cli.mjs notify "<title>" "<text>"    tests a Windows notification`;

async function main() {
  switch (command) {
    case 'server': {
      try {
        await api('/api/health');
        console.log(`Chiefmate is already running at http://localhost:${port()}`);
        return;
      } catch {
        // not running yet: start it
      }
      const { startServer } = await import('./server.mjs');
      const { startQueue } = await import('./queue.mjs');
      const { startSchedule } = await import('./schedule.mjs');
      const { port: p } = startServer();
      startQueue();
      startSchedule();
      console.log(`Chiefmate running at http://localhost:${p} (${new Date().toISOString()})`);
      return;
    }
    case 'status': {
      const s = await api('/api/state');
      const account = s.usage.account;
      const percent = v => `${Math.round((v ?? 0) * 100)}%`;
      console.log(s.current ? `Running: ${s.current.title} [${s.current.id}], step ${s.current.step}: ${s.current.agent}` : 'Running: nothing');
      console.log(`Queue: ${s.queue.map(r => `${r.title} [${r.id}]`).join('; ') || 'empty'}`);
      console.log(`Usage over 7 days: ${formatMoney(s.usage.week)} of ${formatMoney(s.usage.limits.weekly_usd)}`);
      console.log(`Account: 5-hour window ${percent(account.five_hour?.used)}, plan week ${percent(account.seven_day?.used)}`);
      console.log(`Claude Code: ${s.ai.claude.found ? s.ai.claude.version : 'not found'}`);
      for (const m of s.missions) console.log(`Mission ${m.id}: ${m.schedule}${m.next ? `, next ${formatDateTime(m.next)}` : ''}`);
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
        console.log(`${formatDateTime(r.created)}  ${r.status.padEnd(9)} ${formatMoney(runCost(r)).padStart(11)}  ${r.title} [${r.id}]${r.pullRequest ? `  ${r.pullRequest}` : ''}`);
      }
      return;
    case 'report': {
      const run = readRun(rest[0]);
      if (!run) throw new Error('Run not found.');
      console.log(`# ${run.title} (${run.status})\n${run.result ?? ''}${run.pullRequest ? `\nPull request: ${run.pullRequest}` : ''}\n`);
      for (const step of stepsOf(run)) console.log(`## ${step.agent} (${step.status}, ${formatMoney(step.cost)})\n${step.report || step.error || '(no report)'}\n`);
      return;
    }
    case 'limits': {
      const map = { '--weekly': 'weekly_usd', '--per-run': 'per_run_usd', '--window-5h': 'pause_at_5h_window', '--plan-week': 'pause_at_plan_week' };
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
