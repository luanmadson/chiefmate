// The app (http://localhost:4747) and the API it uses. It only answers this computer.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { attentionArchive, attentionItems, attentionSummary, markSeen } from './attention.mjs';
import { autopilotStatus, changeAutopilot } from './autopilot.mjs';
import { answerRequest, chargeProfileId, inCharge, projectRequests } from './charge.mjs';
import { checkClaude, claudeInfo, readFeed } from './claude.mjs';
import { EFFORTS, loadAgents, loadConfig, projectCrew, projectEfforts, projectLead, saveConfig } from './config.mjs';
import { effortHistory, effortSource, runEffortChanges, setEffort } from './effort.mjs';
import { agentTool, runTools, toolModel } from './tools.mjs';
import { previewChanges, projectContext, saveChanges } from './context.mjs';
import { addQuestion, decide, decisionCards, openPushes, openQuestions, openRepoRequests } from './decisions.mjs';
import { listFolder, rootsFor, runFiles, viewerRoots, viewFile } from './files.mjs';
import { t } from './i18n.mjs';
import { LEAD, memoryInfo } from './leads.mjs';
import { engage, isLocked, lockdownView, recordSignal, release } from './lockdown.mjs';
import { closeBrowser, focusBrowser, openBrowsers } from './browsers.mjs';
import { computer, latestProcesses, processes, stoppable, stopProject } from './machine.mjs';
import { chat, editPending, interruptManager, managerContext, newConversation, removePending, sendToManager } from './manager.mjs';
import { closeReplaced, mergeRun, previewClose, previewMerge } from './merge.mjs';
import { awayInfo, reportEvent, setAway } from './news.mjs';
import { askOwner, finishRequest, openRequests, pollRequest } from './needs.mjs';
import { cancelStop, powerInfo, powerPreview, setStandby, stopSystem } from './power.mjs';
import { alerts, changeResets, planResets, weekPace } from './plan.mjs';
import { changePlan, planItem, planItems, PRIORITIES, STATUSES } from './planning.mjs';
import { changeRadar, RADAR_STATUSES, radarIdeas } from './radar.mjs';
import { openProjectApp, projectInfo, startDev, stopDev } from './projects.mjs';
import { builderPage, builderStatus, composeFromApp } from './prompts.mjs';
import { documentCommit, isSyncing, syncPrompts } from './promptsync.mjs';
import { cancel, focus, maxParallel, nudgeQueue, queued, resume } from './queue.mjs';
import { activeRun, createRun, describeLater, doingNow, liveRuns, needsBrief, outcomeLater, setRunLevel } from './runs.mjs';
import { describeSchedule, nextRun } from './schedule.mjs';
import {
  answerPermission, endSession, finishSessionRequest, interruptSession, listSessions, openSession, planSession, profileFor, removeQueued, resumeSession, sayToSession,
  sessionRequests, sessionsState, sessionView,
} from './sessions.mjs';
import { talkTo } from './talk.mjs';
import { listRuns, readConversation, readNotifications, readPending, readRun, readUsage, runDir, stepsOf } from './store.mjs';
import { checkNow, updateInfo, updateMode, updateNow } from './update.mjs';
import { isReading, readerSettings, readerStatus, readUsagePage, signedIn } from './usagepage.mjs';
import { clip, now, ROOT, VERSION } from './util.mjs';
import { projectDir } from './workspace.mjs';

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

// On every answer: no guessing of content types, no framing by other sites, no address sent to other sites.
// ("same-origin", not "no-referrer": with "no-referrer" the browser sends "Origin: null" and the app's commands are refused.)
const SAFE_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'content-security-policy': "frame-ancestors 'none'",
  'x-frame-options': 'DENY',
};

/** The app's own settings ("ui"): dictation in the message fields, on unless "voice_input" is false. */
const uiSettings = config => ({ voice_input: config.ui?.voice_input !== false });

// Answers in JSON, compressed with gzip when the browser takes it and the answer is worth it (the state is ~140 KB).
function reply(res, code, data, headers = {}) {
  let body = Buffer.from(JSON.stringify(data));
  const head = { ...SAFE_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', vary: 'accept-encoding', ...headers };
  if (body.length > 1024 && /\bgzip\b/.test(res.req?.headers['accept-encoding'] ?? '')) {
    body = gzipSync(body);
    head['content-encoding'] = 'gzip';
  }
  res.writeHead(code, head);
  res.end(body);
}

// The state with a tag of its content, leaving out "now": the app sends the tag back, and an unchanged state
// answers 304 with no body. Free memory and Chiefmate's own RAM move on every reading, so the tag counts them in
// steps (128 MB and 8 MB), about what the app shows.
function replyState(req, res) {
  const state = buildState();
  const { now: _, computer: c, ...rest } = state;
  const steady = { ...rest, computer: { ...c, memory: { ...c.memory, free: Math.round(c.memory.free / 2 ** 27) }, chiefmate: { ram: Math.round(c.chiefmate.ram / 2 ** 23) } } };
  const etag = `"${createHash('sha1').update(JSON.stringify(steady)).digest('base64url')}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ...SAFE_HEADERS, etag, 'cache-control': 'no-store', vary: 'accept-encoding' });
    return res.end();
  }
  reply(res, 200, state, { etag });
}

function serveFile(res, pathname) {
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(UI, relative);
  if (!file.startsWith(UI + path.sep)) return reply(res, 404, { error: 'not found' });
  try {
    const content = readFileSync(file);
    res.writeHead(200, { ...SAFE_HEADERS, 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
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
  id: run.id, title: run.title, summary: run.summary ?? null, outcome: run.outcome ?? null, kind: run.kind, mission: run.mission, project: run.project, origin: run.origin, status: run.status,
  created: run.created, started: run.started, ended: run.ended, notBefore: run.notBefore, due: run.due ?? null, note: run.note, result: run.result,
  pullRequest: run.pullRequest, needsYou: (run.requests ?? []).filter(r => r.status === 'open').length,
  steps: stepsOf(run).map(s => ({ agent: s.agent, status: s.status, review: s === run.review, role: s.role ?? null, task: s.task ?? null, tool: s.tool ?? null })),
  // Codex or Grok, when the run's crew steps ran (or were chosen to run) on them: the cards, the queue and the log show it.
  tools: runTools(run),
  // A request to a project's team lead, and what the lead decided: its plan and its opinion (src/leads.mjs).
  request: run.kind === 'ask' ? run.instruction : null,
  lead: run.lead ? { plan: run.lead.plan ?? null, opinion: run.lead.opinion ? clip(run.lead.opinion, 700) : null } : null,
});

/**
 * The crews by project: a project with "crew" in its settings has its own members (with their presence counted on
 * that project's runs only); the others use the general crew. The manager is global and is not repeated here.
 */
function teams(config, agents, general, runs, going, queue, conversation) {
  return Object.entries(config.projects ?? {}).map(([id, p]) => {
    const mine = r => r.project === id;
    // The project's team lead, shown above its crew: its presence counts on this project's runs only.
    const leader = projectLead(config, id, agents);
    const lead = leader
      ? { ...crew({ [LEAD]: leader }, config, runs.filter(mine), going.filter(mine), queue.filter(mine), [])[0], base: leader.base, extra: !!p.lead?.extra_instructions, memory: memoryInfo(id) }
      : null;
    // The project's own effort (projects.<id>.effort) over the general crew's.
    const own = projectEfforts(config, id);
    const effortOf = a => (EFFORTS.includes(own[a.id]) ? { ...a, effort: own[a.id], effortFrom: 'project' } : a);
    if (lead) lead.effortFrom = effortSource(config, id, leader);
    if (!p.crew) return { project: id, name: p.name ?? id, own: false, lead, members: general.filter(a => a.id !== 'manager').map(effortOf) };
    const team = Object.fromEntries(Object.entries(projectCrew(config, id, agents)).filter(([key]) => key !== 'manager' && key !== LEAD));
    const members = crew(team, config, runs.filter(mine), going.filter(mine), queue.filter(mine), []).map(m => ({
      ...m, base: team[m.id].base, extra: !!p.crew?.[m.id]?.extra_instructions, mcp: team[m.id].mcp ?? [], effortFrom: effortSource(config, id, team[m.id]),
    }));
    return { project: id, name: p.name ?? id, own: true, lead, members };
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
 * What an agent at work is doing, live, for its panel in the app: the actions and the text of a step, read from the
 * step's log (data/runs/<id>/<NN>-<agent>.jsonl) from the byte offset "from" on, with the run's direct conversation
 * and its open requests. step: the step to read (by default, the one at work or the last one that started).
 */
function runFeed(id, params) {
  if (!/^[\w.-]+$/.test(id) || id.includes('..')) return null;
  const run = activeRun(id) ?? readRun(id);
  if (!run) return null;
  const l = liveRuns().find(x => x.run === id) ?? null;
  const steps = stepsOf(run);
  const started = steps.reduce((n, s, i) => (s.status !== 'pending' ? i + 1 : n), 1);
  const current = l?.step ?? started;
  const n = Math.max(1, Math.min(steps.length, Number(params.get('step')) || current));
  const step = steps[n - 1];
  const file = step ? path.join(runDir(id), `${String(n).padStart(2, '0')}-${step.agent}.jsonl`) : null;
  const from = params.has('from') ? Number(params.get('from')) : null;
  const { items, next } = file ? readFeed(file, projectDir(run.project), from) : { items: [], next: 0 };
  return {
    run: id, title: run.title, summary: run.summary ?? null, doing: l ? doingNow(l) : null, project: run.project, status: run.status, live: !!l, talking: !!l?.talking && l.step === n,
    step: n, current, total: steps.length, agent: step?.agent ?? null, stepStatus: step?.status ?? null, stepStarted: step?.started ?? null,
    review: step === run.review, items, next, talk: (run.talk ?? []).slice(-80), requests: (run.requests ?? []).filter(r => r.status === 'open'),
  };
}

/** A run's record by its id from the address, or null for an id that is not one. */
const runById = id => (/^[\w.-]+$/.test(id) && !id.includes('..') ? activeRun(id) ?? readRun(id) : null);

/**
 * The file viewer, read only (src/files.mjs): GET /api/files/run/<id> (what a run created or changed), roots (a
 * project's folders), list (a folder), info, raw, text and table (a file, by "path", or by "run" and "file"). Refused
 * when another site asks, even one on another port of this computer (Sec-Fetch-Site).
 */
async function filesRoute(req, res, url) {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return reply(res, 403, { error: 'request refused' });
  const config = loadConfig();
  const params = Object.fromEntries(url.searchParams);
  const route = url.pathname.slice('/api/files/'.length);
  try {
    const runPath = route.match(/^run\/([^/]+)$/);
    if (runPath) {
      const run = runById(decodeURIComponent(runPath[1]));
      if (!run) return reply(res, 404, { error: t('Run not found.') });
      const { dir: _, ...files } = await runFiles(run, config);
      return reply(res, 200, files);
    }
    if (route === 'roots') return reply(res, 200, { roots: rootsFor(config, params.project ?? '') });
    if (route === 'list') return reply(res, 200, listFolder(params.path, viewerRoots(config)));
    if (['info', 'text', 'table'].includes(route)) return reply(res, 200, await viewFile(route, params, { config, readRun: runById }));
    if (route === 'raw') {
      const { body, headers } = await viewFile('raw', params, { config, readRun: runById, dest: req.headers['sec-fetch-dest'] ?? '' });
      res.writeHead(200, { ...headers, 'content-length': body.length });
      return res.end(body);
    }
    return reply(res, 404, { error: 'not found' });
  } catch (error) {
    return reply(res, typeof error.code === 'number' ? error.code : 400, { error: error.message });
  }
}

/**
 * A project's page: its facts, your clone and its branch, its development environment, and its recent runs (the ones
 * neither waiting nor going on, newest first). The rest of the page (crew, runs going on, planning, memory, sessions)
 * comes from the state.
 */
async function projectPage(id) {
  const config = loadConfig();
  const info = await projectInfo(id, config, computer(config));
  const going = new Set(liveRuns().map(l => l.run));
  const history = listRuns().filter(r => r.project === id && !['queued', 'waiting'].includes(r.status) && !going.has(r.id)).slice(0, 15).map(summary);
  return { ...info, history };
}

/** The title and summary given with a new run ("title", "summary"): nothing is generated for what is given. */
const brief = body => ({
  title: typeof body.title === 'string' && body.title.trim() ? body.title : null,
  summary: typeof body.summary === 'string' && body.summary.trim() ? body.summary : null,
  // The manager's approval level (1 to 3) for the owner's decision card.
  level: body.level ?? null,
  // The tool of the run's crew steps (--tool): claude, codex or grok; none: each member's own.
  tool: typeof body.tool === 'string' && body.tool.trim() ? body.tool : null,
});

/** A run's task, short, for "waiting for <who>: <task>". */
const shortTask = r => clip(r.title, 70);

/**
 * Each crew member's presence: what they are doing now, their last work and their work this week.
 * going: the runs going on now (runs of different projects go on at once, so one agent may be at work on two).
 */
function crew(agents, config, runs, going, queue, conversation) {
  const since = Date.now() - 7 * 86400_000;
  const pendingFor = id => r => stepsOf(r).some(s => s.status === 'pending' && s.agent === id);
  const titles = list => list.map(r => r.title).join(' · ');
  // What a step waiting its turn waits for: the agent at work on its run, or the run ahead of it in the queue
  // (the one of the same project, else the oldest going on when there is no room for one more).
  const inRun = r => ({ agent: stepsOf(r).find(s => s.status === 'running')?.agent ?? null, project: r.project, task: shortTask(r) });
  const ahead = r => {
    const before = going.find(g => g.project === r.project) ?? (going.length >= maxParallel(config) ? going[0] : null);
    return before ? { agent: null, project: before.project, task: shortTask(before) } : null;
  };
  return Object.values(agents).map(agent => {
    let status = 'idle';
    let run = null;
    let waitingFor = null;
    const working = going.filter(r => stepsOf(r).some(s => s.status === 'running' && s.agent === agent.id));
    const waitingIn = going.filter(pendingFor(agent.id));
    if (claudeInfo.found === false) status = 'offline';
    else if (working.length) {
      // A team lead plans a request or reviews the crew's work first (its steps have a "role").
      const role = r => stepsOf(r).find(s => s.status === 'running' && s.agent === agent.id)?.role;
      const reviewing = working.every(r => (r.review?.status === 'running' && r.review.agent === agent.id) || role(r) === 'review');
      const planning = working.every(r => role(r) === 'plan');
      [status, run] = [planning ? 'planning' : reviewing ? 'reviewing' : 'working', titles(working)];
    } else if (agent.id === 'manager' && chat.responding) status = 'thinking';
    else if (waitingIn.length) [status, run, waitingFor] = ['queued', titles(waitingIn), inRun(waitingIn[0])];
    else {
      const next = queue.find(pendingFor(agent.id));
      if (next) [status, run, waitingFor] = [next.status === 'waiting' ? 'waiting' : 'queued', next.title, next.status === 'waiting' ? null : ahead(next)];
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
    // The tool its steps run on (src/tools.mjs): the one asked, unless it is not available (then Claude Code).
    const choice = agentTool(config, agent);
    return {
      id: agent.id, name: agent.name, title: agent.title, role: agent.role,
      model: choice.tool === 'claude' ? agent.model ?? config.default_model : toolModel(choice.tool, agent.model),
      tool: choice.tool, toolAsked: choice.asked, toolUntil: choice.until, toolReason: choice.reason,
      effort: agent.effort ?? null, effortFrom: effortSource(config, agent.project ?? null, agent), maxMinutes: agent.max_minutes ?? null,
      ...(agent.id === 'manager' ? { chatEffort: agent.chat_effort ?? agent.effort ?? null } : {}),
      color: agent.color ?? null, face: agent.face ?? null, status, run, last, week, waitingFor,
      // The runs this member is at work on now: a click on it opens its panel.
      runs: working.map(r => r.id),
    };
  });
}

// When this Chiefmate started. The app loads itself again when it changes, after an update or a restart.
const STARTED = now();

/** Per project: { agent, name, lead, profile, session (its conversation: the open one, else the latest), requests }. */
function chargeState(config, agents) {
  const sessions = listSessions().filter(s => s.charge && s.mode === 'app');
  return Object.fromEntries(Object.keys(config.projects ?? {}).map(id => {
    const who = inCharge(config, id, agents);
    const own = sessions.filter(s => s.project === id);
    const session = own.find(s => s.status !== 'ended') ?? own[0] ?? null;
    return [id, who ? {
      agent: who.member.id, name: who.member.name ?? who.member.id, base: who.member.base ?? who.member.id, lead: who.lead, profile: chargeProfileId(id),
      session: session?.id ?? null, requests: projectRequests(id, 8),
    } : null];
  }));
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
    ...summary(run), step: l.step, agent: l.agent, stepStarted: l.started, context: l.context, actions: l.actions.slice(-80), talking: !!l.talking,
    doing: doingNow(l),
  }));
  const queue = queued();
  const conversation = readConversation();
  // The runs the app lists without a title and summary of their own (older ones) get them, one at a time.
  for (const r of [...queue, ...runs.slice(0, 30)]) if (needsBrief(r)) describeLater(r.id, r);
  const usage = readUsage();
  const machine = computer(config, queue);
  const needs = [...openRequests(runs), ...sessionRequests()].sort((a, b) => b.at.localeCompare(a.at));
  const items = planItems();
  const questions = openQuestions();
  const pushes = openPushes();
  const repos = openRepoRequests();
  const security = lockdownView();
  const attention = attentionItems({ config, runs, needs, usage, machine, items, update: updateInfo, questions, pushes, repos, lockdown: security });
  const lastOf = id => runs.find(r => r.mission === id && !['queued', 'waiting'].includes(r.status));
  return {
    now: now(),
    version: VERSION,
    started: STARTED,
    owner: config.owner,
    language: config.language || 'en',
    ui: uiSettings(config),
    ai: { claude: { ...claudeInfo }, account: { status: usage.status ?? null, updated: usage.updated ?? null } },
    update: { ...updateInfo, mode: updateMode(config) },
    projects: Object.entries(config.projects ?? {}).map(([id, p]) => ({ id, name: p.name, site: p.site })),
    // Each project's agent in charge (src/charge.mjs): who it is, its conversation and its requests to the manager.
    charge: chargeState(config, agents),
    missions: Object.entries(config.missions ?? {}).map(([id, m]) => ({
      id, name: m.name, description: m.description, project: m.project,
      crew: [...(m.steps ?? []).map(s => s.agent), ...(m.review ? [m.review.agent] : [])],
      schedule: describeSchedule(m.schedule), next: nextRun(m.schedule)?.toISOString() ?? null,
      last: lastOf(id) ? summary(lastOf(id)) : null,
      // A run of it missed while Chiefmate was off or on standby, queued or going on now: the app marks it late.
      late: (r => (r ? { run: r.id, due: r.due, status: r.status } : null))(runs.find(r => r.mission === id && r.due && ['queued', 'waiting', 'running'].includes(r.status))),
    })),
    crew: (general = crew(agents, config, runs, going.map(x => x.run), queue, conversation)),
    effortHistory: effortHistory().slice(-12).reverse(),
    teams: teams(config, agents, general, runs, going.map(x => x.run), queue, conversation),
    needs,
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
    // The crew's browsers open (src/browsers.mjs): project, task, since when and whether the task still goes on.
    browsers: openBrowsers(config, latestProcesses()),
    sessions: sessionsState(config, machine),
    plan: {
      resets: planResets(config),
      pace: weekPace(usage),
      reader: { ...readerSettings(config), signedIn: signedIn(), reading: isReading(), status: readerStatus() },
    },
    // The autopilot (src/autopilot.mjs): its settings, whether it may act now and what it did today.
    autopilot: autopilotStatus(config, usage, new Date(), runs),
    alerts: alerts(config, usage, machine),
    // What needs the owner, in three levels (src/attention.mjs): the band at the top, the sections, the title and the icon.
    attention: { items: attention, ...attentionSummary(attention), archived: attentionArchive().length },
    // The owner's decisions as cards (src/decisions.mjs): pull requests and branches to merge, proposals, the manager's questions.
    decisions: decisionCards({ config, attention, items, questions, pushes, repos }),
    // The owner's planning board (data/plan.json): every item, archived ones included, in the board's order.
    planning: { items, priorities: PRIORITIES, statuses: STATUSES },
    // The project radar (data/radar.json): ideas for new projects, highest potential first.
    radar: { ideas: radarIdeas(), statuses: RADAR_STATUSES },
    manager: {
      messages: conversation.slice(-80), responding: chat.responding, interrupting: chat.interrupting, since: chat.since, partial: chat.partial,
      actions: chat.actions.slice(-12), lastAction: chat.actions.at(-1) ?? null, pending: readPending(), context: managerContext(),
    },
    // The emergency lockdown (src/lockdown.mjs): whether it is on, why, its evidence and the security warnings of the day.
    lockdown: security,
    // The away mode (src/news.mjs): { since, held } while the owner is away, else null.
    away: awayInfo(),
    // The power mode (src/power.mjs): on, standby or stopping, shown at the top of the app.
    power: powerInfo(),
    notifications: readNotifications().slice(-8).reverse(),
  };
}

function validLimits(body) {
  const limits = {};
  for (const key of ['pause_at_5h_window', 'pause_at_plan_week']) if (body[key] !== undefined) limits[key] = Math.min(1, Math.max(0.05, Number(body[key]) || 0.9));
  return limits;
}

/**
 * The optional remote access through Tailscale Serve ("remote_access": { "enabled", "host", "logins", "port" }), or
 * null when it is off. "host" is this computer's name in the tailnet (<pc>.<tailnet>.ts.net) and "logins" the
 * Tailscale logins allowed in. Incomplete settings turn it off, with a message.
 */
export function remoteSettings(settings, mainPort) {
  if (!settings?.enabled) return null;
  const host = String(settings.host ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/:].*$/, '');
  const logins = [settings.logins ?? []].flat().map(x => String(x ?? '').trim().toLowerCase()).filter(Boolean);
  const port = Number(settings.port) || 4748;
  const problem = !/^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/.test(host) ? 'remote_access.host must be the computer\'s name in the tailnet, such as pc.tailnet.ts.net'
    : !logins.length ? 'remote_access.logins must list the Tailscale logins allowed in'
      : port === mainPort ? 'remote_access.port must differ from the app\'s own port' : '';
  if (problem) {
    console.error(`Remote access is off: ${problem}.`);
    return null;
  }
  return { host, logins, port };
}

/**
 * Why a request to the remote listener is refused, or '' when it may go on. Tailscale Serve sets
 * Tailscale-User-Login and removes one sent by the device; Funnel (the public internet) and tagged devices send none.
 * Host and Origin must be the tailnet name, so no other website can drive the app through the browser.
 */
export function remoteRefusal(req, remote) {
  const hostname = String(req.headers.host ?? '').toLowerCase().replace(/:443$/, '');
  if (hostname !== remote.host) return 'address not allowed';
  const origin = req.headers.origin;
  if (origin !== undefined && origin.toLowerCase() !== `https://${remote.host}`) return 'request refused';
  if (req.method !== 'GET' && origin === undefined) return 'request refused';
  const login = String(req.headers['tailscale-user-login'] ?? '').trim().toLowerCase();
  if (!login || !remote.logins.includes(login)) return 'not allowed in';
  return '';
}

// Commands that open a window or a program on the computer where Chiefmate runs: from another device, nobody would see
// them, so they are refused there (their "dryRun" still answers).
const OPENS_ON_PC = {
  '/api/project/open': () => true,
  '/api/project/dev': body => body.action === 'start',
  '/api/session': body => !!body.window,
  '/api/prompt-builder/session': body => !!body.window,
  '/api/browser': body => body.action === 'focus',
};

export function startServer() {
  const config = loadConfig();
  const port = Number(process.env.CHIEFMATE_PORT) || config.port || 4747;
  const allowed = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
  checkClaude();
  setInterval(checkClaude, 10 * 60_000);
  const handle = async (req, res, remote = null) => {
    try {
      // Guards against another website open in the browser trying to send commands here.
      // Each refusal is a signal for the emergency lockdown's detection (src/lockdown.mjs).
      if (remote) {
        const refused = remoteRefusal(req, remote);
        if (refused) {
          recordSignal(refused === 'not allowed in' ? 'login_failed' : 'unknown_origin', `${req.method} ${clip(String(req.url), 120)} (${refused})`, { who: 'remote' });
          return reply(res, 403, { error: refused });
        }
        // In an emergency lockdown, the remote access is off: only engaging it again is taken.
        if (isLocked() && !(req.method === 'POST' && req.url === '/api/lockdown')) return reply(res, 423, { error: t('Chiefmate is in emergency lockdown: the remote access is off until the owner releases it on the computer.') });
      } else if (!allowed.has(req.headers.host)) {
        recordSignal('unknown_origin', `${req.method} ${clip(String(req.url), 120)} (host ${clip(String(req.headers.host ?? ''), 80)})`, { who: 'app' });
        return reply(res, 403, { error: 'address not allowed' });
      }
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === 'GET') {
        if (url.pathname === '/api/health') return reply(res, 200, { ok: true, version: VERSION });
        if (url.pathname === '/api/state') return replyState(req, res);
        // The notices that no longer need the owner, most recent first (the app's "Archived").
        if (url.pathname === '/api/attention/archived') return reply(res, 200, { items: attentionArchive() });
        if (url.pathname === '/api/computer') {
          await processes(5000);
          return reply(res, 200, computer());
        }
        const context = url.pathname.match(/^\/api\/run\/([^/]+)\/context\/(\d+)$/);
        if (context) {
          const file = contextFile(decodeURIComponent(context[1]), context[2]);
          return file ? reply(res, 200, { text: readFileSync(file, 'utf8') }) : reply(res, 404, { error: t('No context recorded for this step.') });
        }
        const feed = url.pathname.match(/^\/api\/run\/([^/]+)\/feed$/);
        if (feed) {
          const data = runFeed(decodeURIComponent(feed[1]), url.searchParams);
          return data ? reply(res, 200, data) : reply(res, 404, { error: t('Run not found.') });
        }
        if (url.pathname.startsWith('/api/files/')) return await filesRoute(req, res, url);
        // The app's prompt builder: the document and the project's last choice ("?project=<id>").
        if (url.pathname === '/api/prompt-builder') {
          const config = loadConfig();
          const page = builderPage(config, url.searchParams.get('project') ?? '');
          // With a library, the document's last commit there (read once per commit of the library's copy).
          if (page.status.source === 'library') page.status.commit = await documentCommit(config);
          return reply(res, 200, { ...page, syncing: isSyncing(), cdp: !!config.browser_cdp });
        }
        // The project's Context tab: everything its crew gets, in order and by source (src/context.mjs).
        const projectContextPath = url.pathname.match(/^\/api\/project\/([^/]+)\/context$/);
        if (projectContextPath) return reply(res, 200, projectContext(loadConfig(), decodeURIComponent(projectContextPath[1]), { member: url.searchParams.get('member') || null }));
        const page = url.pathname.match(/^\/api\/project\/([^/]+)$/);
        if (page) return reply(res, 200, await projectPage(decodeURIComponent(page[1])));
        // A live session's conversation in the app: the session, its queue, its open requests and its history from "?from=".
        const sessionPath = url.pathname.match(/^\/api\/session\/([\w.-]+)$/);
        if (sessionPath) return reply(res, 200, sessionView(sessionPath[1], url.searchParams.has('from') ? Number(url.searchParams.get('from')) : null));
        if (url.pathname.startsWith('/api/run/')) {
          const run = readRun(decodeURIComponent(url.pathname.slice('/api/run/'.length)));
          if (!run) return reply(res, 404, { error: t('Run not found.') });
          // Opened in the app: what an older run is missing (title, summary, final summary) is generated now.
          describeLater(run.id, run);
          outcomeLater(run.id);
          // The effort changes made while it went on (src/effort.mjs), for its report.
          return reply(res, 200, { ...run, efforts: runEffortChanges(run) });
        }
        if (!url.pathname.startsWith('/api/')) return serveFile(res, url.pathname);
        return reply(res, 404, { error: 'not found' });
      }
      if (req.method !== 'POST') return reply(res, 405, { error: 'method not allowed' });
      const origin = req.headers.origin;
      if (req.headers['x-chiefmate'] !== '1' || (!remote && origin && !allowed.has(origin.replace(/^https?:\/\//, '')))) {
        recordSignal('unknown_origin', `POST ${clip(String(req.url), 120)} (origin ${clip(String(origin ?? 'none'), 80)})`, { who: remote ? 'remote' : 'app' });
        return reply(res, 403, { error: 'request refused' });
      }
      const body = await readBody(req);
      if (remote && !body.dryRun && OPENS_ON_PC[url.pathname]?.(body)) {
        return reply(res, 403, { error: t('This opens on the computer where Chiefmate runs: do it there.') });
      }
      switch (url.pathname) {
        case '/api/mission': {
          if (body.plan) planItem(body.plan); // the board's item to link must exist
          const run = createRun({ kind: 'mission', missionId: body.mission, origin: body.origin ?? 'app', plan: body.plan ?? null, ...brief(body) });
          nudgeQueue();
          return reply(res, 200, summary(run));
        }
        case '/api/task': {
          if (body.plan) planItem(body.plan);
          const run = createRun({
            kind: 'task', projectId: body.project, agent: body.agent, instruction: body.instruction, review: !!body.review, origin: body.origin ?? 'app',
            modules: body.modules ?? [], plan: body.plan ?? null, ...brief(body),
            // From the app's prompt builder: the steps get this prompt instead of the one put together from the document.
            prompt: typeof body.prompt === 'string' ? body.prompt : null,
          });
          nudgeQueue();
          return reply(res, 200, summary(run));
        }
        case '/api/ask': {
          // A request for a project's team lead, who plans it into tasks for the project's crew.
          if (body.plan) planItem(body.plan);
          const run = createRun({ kind: 'ask', projectId: body.project, instruction: body.request, origin: body.origin ?? 'app', plan: body.plan ?? null, ...brief(body) });
          nudgeQueue();
          return reply(res, 200, summary(run));
        }
        case '/api/needs-you':
          return reply(res, 200, await askOwner(body));
        case '/api/needs-you/poll':
          return reply(res, 200, pollRequest(body.run, body.id));
        case '/api/needs-you/done':
          if (body.session) return reply(res, 200, finishSessionRequest(String(body.session), String(body.id ?? '')));
          return reply(res, 200, finishRequest(body.run, body.id, body.by === 'check' ? 'check' : 'owner', body.answer ?? null, body.note ?? null));
        case '/api/decide': {
          // The owner's click on a decision card: approve (a merge goes through src/merge.mjs), later, discard or answer.
          const decided = await decide({ card: body.card, action: body.action, option: body.option, note: body.note, reason: body.reason }, buildState().decisions);
          // A request of an agent in charge, authorized on its card, has its run queued: the queue looks at once.
          if (decided.run) nudgeQueue();
          return reply(res, 200, decided);
        }
        case '/api/request': {
          // The manager's answer to a request of a project's agent in charge (cli.mjs request <id> approve|hold|ask-owner|reject).
          const answered = await answerRequest(body.id, String(body.action ?? ''), { note: body.note, recommend: body.recommend, ...brief(body) });
          if (answered.run) nudgeQueue();
          return reply(res, 200, answered);
        }
        case '/api/ask-owner':
          // The manager's question for the owner, shown as a card with one button per option and a field to write.
          return reply(res, 200, { question: addQuestion(body) });
        case '/api/attention/seen':
          // Marks notices as seen: they fade (an info notice goes to the archive).
          return reply(res, 200, { seen: markSeen(Array.isArray(body.ids) ? body.ids : [body.id]) });
        case '/api/run/talk':
          return reply(res, 200, talkTo(body.run, body.text));
        case '/api/session': {
          // With "dryRun": the folder and the first message it would open with, and nothing opens.
          if (body.dryRun) {
            const { profile, folder, prompt } = planSession(loadConfig(), String(body.profile ?? ''));
            return reply(res, 200, { dryRun: true, profile: profile.id, tool: profile.tool, cwd: folder.dir, blocks: prompt.blocks, missing: prompt.missing, prompt: prompt.blocksGiven ? prompt.text : null });
          }
          // "window": in a window of its own (Windows Terminal), instead of the conversation in the app.
          return reply(res, 200, await openSession(String(body.profile ?? ''), { origin: body.origin ?? 'app', window: !!body.window }));
        }
        case '/api/session/say':
          return reply(res, 200, sayToSession(String(body.id ?? ''), body.text, { by: body.by === 'manager' ? 'manager' : 'owner' }));
        case '/api/session/interrupt':
          return reply(res, 200, { interrupted: interruptSession(String(body.id ?? '')) });
        case '/api/session/resume':
          return reply(res, 200, resumeSession(String(body.id ?? '')));
        case '/api/session/queue/remove':
          return reply(res, 200, { queue: removeQueued(String(body.id ?? ''), String(body.item ?? '')) });
        case '/api/session/permission':
          return reply(res, 200, answerPermission(String(body.id ?? ''), String(body.request ?? ''), body.allow === true));
        case '/api/project/open':
          // "app": "folder" (the file manager) or "vscode", in your own clone of the project.
          return reply(res, 200, openProjectApp(String(body.project ?? ''), String(body.app ?? ''), { dryRun: !!body.dryRun }));
        case '/api/project/dev': {
          // The project's development environment ("dev_start"): "action": "start" or "stop".
          const options = { dryRun: !!body.dryRun };
          if (body.action === 'start') return reply(res, 200, await startDev(String(body.project ?? ''), options));
          if (body.action === 'stop') return reply(res, 200, await stopDev(String(body.project ?? ''), options));
          return reply(res, 400, { error: t('Say "start" or "stop".') });
        }
        case '/api/project/context/preview':
          // What the changes to the project's context would do ("changes": modules, exclude, notes, agentNotes, extra); nothing is saved.
          return reply(res, 200, previewChanges(String(body.project ?? ''), body.changes ?? {}));
        case '/api/project/context/save':
          // Saves them in the settings and records them in data/projects/<id>/context-history.jsonl.
          return reply(res, 200, saveChanges(String(body.project ?? ''), body.changes ?? {}, { by: body.origin === 'cli' ? 'cli' : 'app' }));
        case '/api/session/end':
          return reply(res, 200, await endSession(String(body.id ?? '')));
        case '/api/prompt-builder/compose':
          // A choice of blocks ("chosen", and "off": automatic blocks turned off) put together; remembered for "project".
          return reply(res, 200, composeFromApp(loadConfig(), { project: String(body.project ?? ''), chosen: body.chosen, off: body.off, remember: body.remember !== false }));
        case '/api/prompt-builder/session': {
          // A live session in the project's folder with the prompt written in the prompt builder as its first message.
          // With "dryRun": what it would open, and nothing opens.
          const config = loadConfig();
          const tool = String(body.tool ?? '');
          const profile = profileFor(config, String(body.project ?? ''), tool);
          if (!String(body.prompt ?? '').trim()) return reply(res, 400, { error: t('The prompt is empty.') });
          if (body.dryRun) {
            const { folder, prompt } = planSession(config, profile, { prompt: String(body.prompt) });
            return reply(res, 200, { dryRun: true, profile, tool, cwd: folder.dir, prompt: prompt.text });
          }
          return reply(res, 200, await openSession(profile, { origin: 'app', prompt: String(body.prompt), window: !!body.window }));
        }
        case '/api/prompts-sync':
          return reply(res, 200, await syncPrompts());
        case '/api/cancel':
          return reply(res, 200, { status: cancel(body.id) });
        case '/api/effort': {
          // An agent's effort, for the installation or one project (src/effort.mjs); it counts from the next step.
          const change = setEffort({ member: body.member, level: body.level, project: body.project || null, chat: !!body.chat, by: 'owner' });
          return reply(res, 200, change);
        }
        case '/api/level': {
          // The manager's approval level for a run (cli.mjs level), shown on the owner's decision card.
          const run = setRunLevel(body.run, body.level);
          return reply(res, 200, { run: run.id, title: run.title, level: run.level });
        }
        case '/api/resume':
          return reply(res, 200, { status: resume(body.id, !!body.ignoreLimits) });
        case '/api/merge':
          // Merges a finished run's work with the owner's authorization (src/merge.mjs): "preview" only shows it.
          if (body.preview) return reply(res, 200, await previewMerge(body.run));
          return reply(res, 200, await mergeRun(body.run, { by: body.by === 'manager' ? 'manager' : 'owner' }));
        case '/api/close-pr':
          // Closes a run's pull request replaced by a newer run's (src/merge.mjs): "preview" only shows it.
          if (body.preview) return reply(res, 200, previewClose(body.run, body.replacedBy));
          return reply(res, 200, await closeReplaced(body.run, body.replacedBy, { by: body.by === 'manager' ? 'manager' : 'owner' }));
        case '/api/manager':
          // Accepted at any time: while the manager answers, the message waits in the queue.
          return reply(res, 202, { ok: true, ...sendToManager(body.message) });
        case '/api/manager/edit':
        case '/api/manager/remove': {
          const id = String(body.id ?? '');
          const pending = url.pathname.endsWith('/edit') ? editPending(id, body.message) : removePending(id);
          return pending ? reply(res, 200, { pending }) : reply(res, 404, { error: t('This message is no longer in the queue: it was delivered or removed.') });
        }
        case '/api/watchdog':
          // The watchdog (src/watch.mjs), a process apart from Chiefmate, tells the manager what it found and did.
          return reply(res, 200, { event: reportEvent('watchdog', clip(String(body.text ?? ''), 3000)) });
        case '/api/update-now':
          // Installs the approved update now, pausing the work going on (src/update.mjs); "interruptManager" interrupts
          // the manager's answer instead of waiting for it.
          return reply(res, 200, await updateNow({ interruptManager: !!body.interruptManager }));
        case '/api/update-check':
          return reply(res, 200, await checkNow());
        case '/api/lockdown': {
          // The emergency lockdown (src/lockdown.mjs): "engage" from the app, the remote access or the command line;
          // "release" only on this computer, confirmed by the owner.
          if (body.action === 'engage') {
            const by = ['manager', 'step'].includes(body.by) ? body.by : 'owner';
            const from = remote ? 'remote' : body.origin === 'cli' ? 'cli' : 'app';
            return reply(res, 200, { lockdown: lockdownView(await engage({ reason: String(body.reason ?? ''), by, from })) });
          }
          if (body.action === 'release') {
            if (remote) return reply(res, 403, { error: t('The lockdown is released only on the computer where Chiefmate runs, not through the remote access.') });
            if (body.confirm !== true) return reply(res, 400, { error: t('Confirm that you reviewed what triggered the lockdown.') });
            return reply(res, 200, { lockdown: lockdownView(release({ by: 'owner', from: body.origin === 'cli' ? 'cli' : 'app' })) });
          }
          return reply(res, 400, { error: 'unknown action' });
        }
        case '/api/away':
          // The owner stepped out or is back: the manager is told at once (src/news.mjs).
          return reply(res, 200, { away: setAway(!!body.on) });
        case '/api/power': {
          // The power modes (src/power.mjs). From another device, only standby: a Chiefmate stopped there could not be
          // started again from it.
          const action = String(body.action ?? '');
          if (remote && ['stop', 'shutdown'].includes(action)) return reply(res, 403, { error: t('Shutting down is done on the computer itself: from another device, Chiefmate could not be started again.') });
          if (action === 'preview') {
            const runs = liveRuns().map(l => ({ run: l.run, title: l.title, project: l.project }));
            const sessions = sessionsState().open.map(x => ({ id: x.id, name: x.name, cwd: x.cwd, mode: x.mode, tool: x.tool }));
            return reply(res, 200, await powerPreview({ runs, sessions }));
          }
          if (action === 'standby') return reply(res, 200, setStandby(true));
          if (action === 'on') return reply(res, 200, setStandby(false));
          if (action === 'cancel') return reply(res, 200, cancelStop());
          if (['stop', 'shutdown'].includes(action)) return reply(res, 200, stopSystem(action));
          return reply(res, 400, { error: t('Unknown power mode.') });
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
        case '/api/voice-input': {
          // Dictation's switch, from its first-use notice in the app.
          const config = loadConfig();
          config.ui = { ...config.ui, voice_input: !!body.enabled };
          saveConfig(config);
          return reply(res, 200, { ui: uiSettings(config) });
        }
        case '/api/autopilot':
          // The autopilot's switch, mode and limits, from the Usage section (src/autopilot.mjs), kept with who changed them.
          changeAutopilot(body, { by: remote ? `remote:${String(req.headers['tailscale-user-login'] ?? '').trim().toLowerCase()}` : 'app' });
          return reply(res, 200, autopilotStatus());
        case '/api/stop-project': {
          // With "preview", only lists what would stop. Otherwise stops the processes you confirmed, never Chiefmate or the crew.
          if (body.preview) return reply(res, 200, { processes: await stoppable(String(body.project ?? '')) });
          if (!Array.isArray(body.pids) || !body.pids.length) return reply(res, 400, { error: t('Confirm which processes to stop.') });
          return reply(res, 200, { stopped: await stopProject(String(body.project ?? ''), body.pids) });
        }
        case '/api/browser': {
          // One of the crew's browsers: closed, or brought to the front on this computer.
          const pid = Number(body.pid);
          if (body.action === 'focus') return reply(res, 200, { browser: await focusBrowser(pid) });
          if (body.action === 'close') return reply(res, 200, { browser: await closeBrowser(pid) });
          return reply(res, 400, { error: 'unknown action' });
        }
        case '/api/planning':
          return reply(res, 200, { item: await changePlan(body) });
        case '/api/radar':
          return reply(res, 200, { idea: changeRadar(body) });
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
  };
  const server = http.createServer((req, res) => handle(req, res));
  server.listen(port, '127.0.0.1');
  // The remote access: a second listener, also on this computer only, for Tailscale Serve alone. The smoke test's
  // temporary Chiefmate never opens the installation's: it takes its own from CHIEFMATE_REMOTE_ACCESS.
  const remote = remoteSettings(process.env.CHIEFMATE_SMOKE ? JSON.parse(process.env.CHIEFMATE_REMOTE_ACCESS || 'null') : config.remote_access, port);
  let remoteServer = null;
  if (remote) {
    remoteServer = http.createServer((req, res) => handle(req, res, remote));
    remoteServer.on('error', error => console.error(`Remote access is off: ${error.message}`));
    remoteServer.listen(remote.port, '127.0.0.1', () => console.log(`Remote access through Tailscale Serve at https://${remote.host} (127.0.0.1:${remote.port})`));
  }
  // Both listeners (such as before a restart for an update), so the next Chiefmate can open them.
  const close = () => {
    remoteServer?.close();
    remoteServer?.closeAllConnections();
    return new Promise(resolve => server.close(() => resolve()));
  };
  return { server, port, remote, close };
}
