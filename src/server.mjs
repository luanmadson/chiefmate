// The app (http://localhost:4747) and the API it uses. It only answers this computer.
import { readdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { checkClaude, claudeInfo } from './claude.mjs';
import { loadAgents, loadConfig, projectCrew, saveConfig } from './config.mjs';
import { t } from './i18n.mjs';
import { computer, processes, stoppable, stopProject } from './machine.mjs';
import { chat, editPending, interruptManager, managerContext, newConversation, removePending, sendToManager } from './manager.mjs';
import { askOwner, finishRequest, openRequests, pollRequest } from './needs.mjs';
import { alerts, changeResets, planResets, weekPace } from './plan.mjs';
import { changePlan, planItem, planItems, PRIORITIES, STATUSES } from './planning.mjs';
import { builderStatus } from './prompts.mjs';
import { isSyncing, syncPrompts } from './promptsync.mjs';
import { cancel, focus, maxParallel, nudgeQueue, queued, resume } from './queue.mjs';
import { activeRun, createRun, liveRuns } from './runs.mjs';
import { describeSchedule, nextRun } from './schedule.mjs';
import { endSession, finishSessionRequest, openSession, sessionRequests, sessionsState } from './sessions.mjs';
import { listRuns, readConversation, readNotifications, readPending, readRun, readUsage, runDir, stepsOf } from './store.mjs';
import { updateInfo } from './update.mjs';
import { isReading, readerSettings, readerStatus, readUsagePage, signedIn } from './usagepage.mjs';
import { now, ROOT, VERSION } from './util.mjs';

const UI = path.join(ROOT, 'ui');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function reply(res, code, data) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

function serveFile(res, pathname) {
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(UI, relative);
  if (!file.startsWith(UI + path.sep)) return reply(res, 404, { error: 'not found' });
  try {
    const content = readFileSync(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(content);
  } catch {
    reply(res, 404, { error: 'not found' });
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', d => {
      chunks.push(d);
      size += d.length;
      if (size > 200_000) reject(new Error('request too large'));
    });
    req.on('end', () => {
      // Join the chunks before decoding, so a character split across two chunks survives.
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
  });
}

const summary = run => ({
  id: run.id, title: run.title, kind: run.kind, mission: run.mission, project: run.project, origin: run.origin, status: run.status,
  created: run.created, started: run.started, ended: run.ended, notBefore: run.notBefore, note: run.note, result: run.result,
  pullRequest: run.pullRequest, needsYou: (run.requests ?? []).filter(r => r.status === 'open').length,
  steps: stepsOf(run).map(s => ({ agent: s.agent, status: s.status, review: s === run.review })),
});

/**
 * The crews by project: a project with "crew" in its settings has its own members (with their presence counted on
 * that project's runs only); the others use the general crew. The manager is global and is not repeated here.
 */
function teams(config, agents, general, runs, going, queue, conversation) {
  return Object.entries(config.projects ?? {}).map(([id, p]) => {
    if (!p.crew) return { project: id, name: p.name ?? id, own: false, members: general.filter(a => a.id !== 'manager') };
    const team = Object.fromEntries(Object.entries(projectCrew(config, id, agents)).filter(([key]) => key !== 'manager'));
    const mine = r => r.project === id;
    const members = crew(team, config, runs.filter(mine), going.filter(mine), queue.filter(mine), []).map(m => ({
      ...m, base: team[m.id].base, extra: !!p.crew?.[m.id]?.extra_instructions, mcp: team[m.id].mcp ?? [],
    }));
    return { project: id, name: p.name ?? id, own: true, members };
  });
}

/** The file of a step's context report: data/runs/<id>/<NN>-<agent>.context.md. */
function contextFile(id, n) {
  if (!/^[\w.-]+$/.test(id) || id.includes('..') || !readRun(id)) return null;
  const prefix = `${String(Number(n)).padStart(2, '0')}-`;
  const dir = runDir(id);
  const name = readdirSync(dir).find(f => f.startsWith(prefix) && f.endsWith('.context.md'));
  return name ? path.join(dir, name) : null;
}

/**
 * Each crew member's presence: what they are doing now, their last work and their work this week.
 * going: the runs going on now (runs of different projects go on at once, so one agent may be at work on two).
 */
function crew(agents, config, runs, going, queue, conversation) {
  const since = Date.now() - 7 * 86400_000;
  const pendingFor = id => r => stepsOf(r).some(s => s.status === 'pending' && s.agent === id);
  const titles = list => list.map(r => r.title).join(' · ');
  return Object.values(agents).map(agent => {
    let status = 'idle';
    let run = null;
    const working = going.filter(r => stepsOf(r).some(s => s.status === 'running' && s.agent === agent.id));
    const waitingIn = going.filter(pendingFor(agent.id));
    if (claudeInfo.found === false) status = 'offline';
    else if (working.length) {
      const reviewing = working.every(r => r.review?.status === 'running' && r.review.agent === agent.id);
      [status, run] = [reviewing ? 'reviewing' : 'working', titles(working)];
    } else if (agent.id === 'manager' && chat.responding) status = 'thinking';
    else if (waitingIn.length) [status, run] = ['queued', titles(waitingIn)];
    else {
      const next = queue.find(pendingFor(agent.id));
      if (next) [status, run] = [next.status === 'waiting' ? 'waiting' : 'queued', next.title];
    }
    let last = null;
    const week = { steps: 0, minutes: 0, answers: 0 };
    for (const r of runs) {
      for (const s of stepsOf(r)) {
        if (s.agent !== agent.id || !s.ended) continue;
        if (!last || s.ended > last.at) last = { at: s.ended, status: s.status, title: r.title, run: r.id };
        if (new Date(s.ended).getTime() >= since) Object.assign(week, { steps: week.steps + 1, minutes: week.minutes + Math.round((s.durationMs ?? 0) / 60000) });
      }
    }
    if (agent.id === 'manager') {
      for (const m of conversation.filter(x => x.who === 'manager')) {
        if (!last || m.at > last.at) last = { at: m.at, status: m.error ? 'failed' : 'done', chat: true };
        if (new Date(m.at).getTime() >= since) week.answers++;
      }
    }
    return {
      id: agent.id, name: agent.name, title: agent.title, role: agent.role, model: agent.model ?? config.default_model,
      effort: agent.effort ?? null, maxMinutes: agent.max_minutes ?? null,
      color: agent.color ?? null, face: agent.face ?? null, status, run, last, week,
    };
  });
}

function buildState() {
  const config = loadConfig();
  const agents = loadAgents(config);
  let general;
  const runs = listRuns();
  // The runs going on, as they are in memory, oldest first.
  const going = liveRuns().map(l => ({ l, run: activeRun(l.run) ?? runs.find(r => r.id === l.run) })).filter(x => x.run);
  const goingIds = new Set(going.map(x => x.run.id));
  const running = going.map(({ l, run }) => ({
    ...summary(run), step: l.step, agent: l.agent, stepStarted: l.started, context: l.context, actions: l.actions.slice(-80),
  }));
  const queue = queued();
  const conversation = readConversation();
  const usage = readUsage();
  const machine = computer(config, queue);
  const lastOf = id => runs.find(r => r.mission === id && !['queued', 'waiting'].includes(r.status));
  return {
    now: now(),
    version: VERSION,
    owner: config.owner,
    language: config.language || 'en',
    ai: { claude: { ...claudeInfo }, account: { status: usage.status ?? null, updated: usage.updated ?? null } },
    update: { ...updateInfo },
    projects: Object.entries(config.projects ?? {}).map(([id, p]) => ({ id, name: p.name, site: p.site })),
    missions: Object.entries(config.missions ?? {}).map(([id, m]) => ({
      id, name: m.name, description: m.description, project: m.project,
      crew: [...(m.steps ?? []).map(s => s.agent), ...(m.review ? [m.review.agent] : [])],
      schedule: describeSchedule(m.schedule), next: nextRun(m.schedule)?.toISOString() ?? null,
      last: lastOf(id) ? summary(lastOf(id)) : null,
    })),
    crew: (general = crew(agents, config, runs, going.map(x => x.run), queue, conversation)),
    teams: teams(config, agents, general, runs, going.map(x => x.run), queue, conversation),
    needs: [...openRequests(runs), ...sessionRequests()].sort((a, b) => b.at.localeCompare(a.at)),
    prompts: { ...builderStatus(config), syncing: isSyncing(), cdp: !!config.browser_cdp },
    focus: focus(config),
    // Every run going on (one per project, up to "max_parallel"); "current" is the oldest, for older readers of the API.
    running,
    current: running[0] ?? null,
    parallel: { max: maxParallel(config) },
    queue: queue.map(summary),
    history: runs.filter(r => !['queued', 'waiting'].includes(r.status) && !goingIds.has(r.id)).slice(0, 30).map(summary),
    usage: { limits: config.limits ?? {}, account: usage },
    computer: machine,
    sessions: sessionsState(config, machine),
    plan: {
      resets: planResets(config),
      pace: weekPace(usage),
      reader: { ...readerSettings(config), signedIn: signedIn(), reading: isReading(), status: readerStatus() },
    },
    alerts: alerts(config, usage, machine),
    // The owner's planning board (data/plan.json): every item, archived ones included, in the board's order.
    planning: { items: planItems(), priorities: PRIORITIES, statuses: STATUSES },
    manager: {
      messages: conversation.slice(-80), responding: chat.responding, interrupting: chat.interrupting, since: chat.since, partial: chat.partial,
      actions: chat.actions.slice(-12), lastAction: chat.actions.at(-1) ?? null, pending: readPending(), context: managerContext(),
    },
    notifications: readNotifications().slice(-8).reverse(),
  };
}

function validLimits(body) {
  const limits = {};
  for (const key of ['pause_at_5h_window', 'pause_at_plan_week']) if (body[key] !== undefined) limits[key] = Math.min(1, Math.max(0.05, Number(body[key]) || 0.9));
  return limits;
}

export function startServer() {
  const port = Number(process.env.CHIEFMATE_PORT) || loadConfig().port || 4747;
  const allowed = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
  checkClaude();
  setInterval(checkClaude, 10 * 60_000);
  const server = http.createServer(async (req, res) => {
    try {
      // Guards against another website open in the browser trying to send commands here.
      if (!allowed.has(req.headers.host)) return reply(res, 403, { error: 'address not allowed' });
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === 'GET') {
        if (url.pathname === '/api/health') return reply(res, 200, { ok: true, version: VERSION });
        if (url.pathname === '/api/state') return reply(res, 200, buildState());
        if (url.pathname === '/api/computer') {
          await processes(5000);
          return reply(res, 200, computer());
        }
        const context = url.pathname.match(/^\/api\/run\/([^/]+)\/context\/(\d+)$/);
        if (context) {
          const file = contextFile(decodeURIComponent(context[1]), context[2]);
          return file ? reply(res, 200, { text: readFileSync(file, 'utf8') }) : reply(res, 404, { error: t('No context recorded for this step.') });
        }
        if (url.pathname.startsWith('/api/run/')) {
          const run = readRun(decodeURIComponent(url.pathname.slice('/api/run/'.length)));
          return run ? reply(res, 200, run) : reply(res, 404, { error: t('Run not found.') });
        }
        if (!url.pathname.startsWith('/api/')) return serveFile(res, url.pathname);
        return reply(res, 404, { error: 'not found' });
      }
      if (req.method !== 'POST') return reply(res, 405, { error: 'method not allowed' });
      const origin = req.headers.origin;
      if (req.headers['x-chiefmate'] !== '1' || (origin && !allowed.has(origin.replace(/^https?:\/\//, '')))) {
        return reply(res, 403, { error: 'request refused' });
      }
      const body = await readBody(req);
      switch (url.pathname) {
        case '/api/mission': {
          if (body.plan) planItem(body.plan); // the board's item to link must exist
          const run = createRun({ kind: 'mission', missionId: body.mission, origin: body.origin ?? 'app', plan: body.plan ?? null });
          nudgeQueue();
          return reply(res, 200, summary(run));
        }
        case '/api/task': {
          if (body.plan) planItem(body.plan);
          const run = createRun({
            kind: 'task', projectId: body.project, agent: body.agent, instruction: body.instruction, review: !!body.review, origin: body.origin ?? 'app',
            modules: body.modules ?? [], plan: body.plan ?? null,
          });
          nudgeQueue();
          return reply(res, 200, summary(run));
        }
        case '/api/needs-you':
          return reply(res, 200, await askOwner(body));
        case '/api/needs-you/poll':
          return reply(res, 200, pollRequest(body.run, body.id));
        case '/api/needs-you/done':
          if (body.session) return reply(res, 200, finishSessionRequest(String(body.session), String(body.id ?? '')));
          return reply(res, 200, finishRequest(body.run, body.id, body.by === 'check' ? 'check' : 'owner'));
        case '/api/session':
          return reply(res, 200, await openSession(String(body.profile ?? ''), { origin: body.origin ?? 'app' }));
        case '/api/session/end':
          return reply(res, 200, await endSession(String(body.id ?? '')));
        case '/api/prompts-sync':
          return reply(res, 200, await syncPrompts());
        case '/api/cancel':
          return reply(res, 200, { status: cancel(body.id) });
        case '/api/resume':
          return reply(res, 200, { status: resume(body.id, !!body.ignoreLimits) });
        case '/api/manager':
          // Accepted at any time: while the manager answers, the message waits in the queue.
          return reply(res, 202, { ok: true, ...sendToManager(body.message) });
        case '/api/manager/edit':
        case '/api/manager/remove': {
          const id = String(body.id ?? '');
          const pending = url.pathname.endsWith('/edit') ? editPending(id, body.message) : removePending(id);
          return pending ? reply(res, 200, { pending }) : reply(res, 404, { error: t('This message is no longer in the queue: it was delivered or removed.') });
        }
        case '/api/manager/interrupt':
          return reply(res, 200, { interrupted: interruptManager() });
        case '/api/new-conversation':
          newConversation();
          return reply(res, 200, { ok: true });
        case '/api/limits': {
          const config = loadConfig();
          const { weekly_usd, per_run_usd, ...kept } = config.limits ?? {}; // dollar limits from older versions
          config.limits = { ...kept, ...validLimits(body) };
          saveConfig(config);
          return reply(res, 200, config.limits);
        }
        case '/api/stop-project': {
          // With "preview", only lists what would stop. Otherwise stops the processes you confirmed, never Chiefmate or the crew.
          if (body.preview) return reply(res, 200, { processes: await stoppable(String(body.project ?? '')) });
          if (!Array.isArray(body.pids) || !body.pids.length) return reply(res, 400, { error: t('Confirm which processes to stop.') });
          return reply(res, 200, { stopped: await stopProject(String(body.project ?? ''), body.pids) });
        }
        case '/api/planning':
          return reply(res, 200, { item: changePlan(body) });
        case '/api/reset-grants':
          return reply(res, 200, { resets: changeResets(body) });
        case '/api/usage-reader': {
          if (body.enabled !== undefined) {
            const config = loadConfig();
            config.usage_reader = { ...config.usage_reader, enabled: !!body.enabled };
            saveConfig(config);
          }
          if (body.read) {
            if (!signedIn()) return reply(res, 400, { error: t('Not signed in yet. Run: node src/cli.mjs claude-login') });
            readUsagePage().catch(() => {});
          }
          return reply(res, 200, { ...readerSettings(), reading: isReading() });
        }
        default:
          return reply(res, 404, { error: 'not found' });
      }
    } catch (error) {
      reply(res, 400, { error: error.message });
    }
  });
  server.listen(port, '127.0.0.1');
  return { server, port };
}
