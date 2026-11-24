// The app (http://localhost:4747) and the API it uses. It only answers this computer.
import { readdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { checkClaude, claudeInfo } from './claude.mjs';
import { loadAgents, loadConfig, projectCrew, saveConfig } from './config.mjs';
import { t } from './i18n.mjs';
import { computer, processes, stoppable, stopProject } from './machine.mjs';
import { chat, managerContext, newConversation, talkToManager } from './manager.mjs';
import { askOwner, finishRequest, openRequests, pollRequest } from './needs.mjs';
import { alerts, changeResets, planResets, weekPace } from './plan.mjs';
import { builderStatus } from './prompts.mjs';
import { isSyncing, syncPrompts } from './promptsync.mjs';
import { cancel, focus, nudgeQueue, queued, resume } from './queue.mjs';
import { createRun, live } from './runs.mjs';
import { describeSchedule, nextRun } from './schedule.mjs';
import { addMessage, listRuns, readConversation, readNotifications, readRun, readUsage, runDir, stepsOf } from './store.mjs';
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
function teams(config, agents, general, runs, current, queue, conversation) {
  return Object.entries(config.projects ?? {}).map(([id, p]) => {
    if (!p.crew) return { project: id, name: p.name ?? id, own: false, members: general.filter(a => a.id !== 'manager') };
    const team = Object.fromEntries(Object.entries(projectCrew(config, id, agents)).filter(([key]) => key !== 'manager'));
    const mine = r => r.project === id;
    const members = crew(team, config, runs.filter(mine), current && mine(current) ? current : null, queue.filter(mine), []).map(m => ({
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

/** Each crew member's presence: what they are doing now, their last work and their work this week. */
function crew(agents, config, runs, current, queue, conversation) {
  const since = Date.now() - 7 * 86400_000;
  const running = current ? stepsOf(current).find(s => s.status === 'running') : null;
  const pendingFor = id => r => stepsOf(r).some(s => s.status === 'pending' && s.agent === id);
  return Object.values(agents).map(agent => {
    let status = 'idle';
    let run = null;
    if (claudeInfo.found === false) status = 'offline';
    else if (running?.agent === agent.id) [status, run] = [running === current.review ? 'reviewing' : 'working', current.title];
    else if (agent.id === 'manager' && chat.responding) status = 'thinking';
    else if (current && pendingFor(agent.id)(current)) [status, run] = ['queued', current.title];
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
  const current = live.run ? runs.find(r => r.id === live.run) ?? null : null;
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
    crew: (general = crew(agents, config, runs, current, queue, conversation)),
    teams: teams(config, agents, general, runs, current, queue, conversation),
    needs: openRequests(runs),
    prompts: { ...builderStatus(config), syncing: isSyncing(), cdp: !!config.browser_cdp },
    focus: focus(config),
    current: current ? { ...summary(current), step: live.step, agent: live.agent, stepStarted: live.started, context: live.context, actions: live.actions.slice(-80) } : null,
    queue: queue.map(summary),
    history: runs.filter(r => !['queued', 'waiting'].includes(r.status) && r.id !== live.run).slice(0, 30).map(summary),
    usage: { limits: config.limits ?? {}, account: usage },
    computer: machine,
    plan: {
      resets: planResets(config),
      pace: weekPace(usage),
      reader: { ...readerSettings(config), signedIn: signedIn(), reading: isReading(), status: readerStatus() },
    },
    alerts: alerts(config, usage, machine),
    manager: {
      messages: conversation.slice(-80), responding: chat.responding, partial: chat.partial, actions: chat.actions.slice(-12), context: managerContext(),
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
          const run = createRun({ kind: 'mission', missionId: body.mission, origin: body.origin ?? 'app' });
          nudgeQueue();
          return reply(res, 200, summary(run));
        }
        case '/api/task': {
          const run = createRun({
            kind: 'task', projectId: body.project, agent: body.agent, instruction: body.instruction, review: !!body.review, origin: body.origin ?? 'app',
            modules: body.modules ?? [],
          });
          nudgeQueue();
          return reply(res, 200, summary(run));
        }
        case '/api/needs-you':
          return reply(res, 200, await askOwner(body));
        case '/api/needs-you/poll':
          return reply(res, 200, pollRequest(body.run, body.id));
        case '/api/needs-you/done':
          return reply(res, 200, finishRequest(body.run, body.id, body.by === 'check' ? 'check' : 'owner'));
        case '/api/prompts-sync':
          return reply(res, 200, await syncPrompts());
        case '/api/cancel':
          return reply(res, 200, { status: cancel(body.id) });
        case '/api/resume':
          return reply(res, 200, { status: resume(body.id, !!body.ignoreLimits) });
        case '/api/manager': {
          const message = String(body.message ?? '').trim();
          if (!message) return reply(res, 400, { error: t('Write a message.') });
          if (chat.renewing) return reply(res, 409, { error: t('The manager is renewing the conversation. Try again in a moment.') });
          if (chat.responding) return reply(res, 409, { error: t('The manager is still answering.') });
          talkToManager(message).catch(error => addMessage('manager', t("I couldn't answer: {error}", { error: error.message }), { error: error.message }));
          return reply(res, 202, { ok: true });
        }
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
