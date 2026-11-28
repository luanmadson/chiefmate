// The app (http://localhost:4747) and the API it uses. It only answers this computer.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { attentionArchive, attentionItems, attentionSummary, markSeen } from './attention.mjs';
import { autopilotStatus, changeAutopilot } from './autopilot.mjs';
import { answerRequest, chargeProfileId, inCharge, openMatters, projectRequests } from './charge.mjs';
import { openWork, releaseWork, workNotesView } from './worknow.mjs';
import { checkClaude, checkLogin, claudeInfo, readFeed } from './claude.mjs';
import { EFFORTS, loadAgents, loadConfig, projectCrew, projectEfforts, projectLead, saveConfig } from './config.mjs';
import { effortHistory, effortSource, runEffortChanges, setEffort } from './effort.mjs';
import { agentTool, runTools, toolModel } from './tools.mjs';
import { previewChanges, projectContext, saveChanges } from './context.mjs';
import { addQuestion, askReboot, decide, decisionCards, openPushes, openQuestions, openRepoRequests } from './decisions.mjs';
import { listFolder, openOnComputer, rootsFor, runFiles, viewerRoots, viewFile } from './files.mjs';
import { t } from './i18n.mjs';
import { LEAD, memoryInfo } from './leads.mjs';
import { changeEscalation, escalationView } from './escalation.mjs';
import { addNote, engage, isLocked, lockdownView, recordSignal, release } from './lockdown.mjs';
import { watchView } from './sentinel.mjs';
import { closeBrowser, focusBrowser, openBrowsers } from './browsers.mjs';
import { computer, latestProcesses, processes, stoppable, stopProject } from './machine.mjs';
import { agentSender, chat, editPending, interruptManager, managerContext, newConversation, removePending, sendToManager } from './manager.mjs';
import { closeDefect, reportDefect } from './defects.mjs';
import { closeReplaced, mergeRun, previewClose, previewMerge } from './merge.mjs';
import { awayInfo, reportEvent, setAway } from './news.mjs';
import { askOwner, confirmByOwnerWords, finishRequest, openCalls, openRequests, parkRun, pollRequest } from './needs.mjs';
import { quarantineList, releaseQuarantine } from './quarantine.mjs';
import { cancelStop, logPower, powerInfo, powerPreview, rebootRefusal, setStandby, stopSystem } from './power.mjs';
import { alerts, changeResets, planResets, weekPace } from './plan.mjs';
import { isOwner, OWNER_HEADER, openAppWindow, redeemCode } from './owner.mjs';
import { changePlan, parseStatus, planItem, planItems, PRIORITIES, STATUSES } from './planning.mjs';
import { changeRadar, parseRadarStatus, RADAR_STATUSES, radarIdeas } from './radar.mjs';
import { deliverDevNotices, devState, openProjectApp, projectInfo, startDev, stopDev } from './projects.mjs';
import { builderPage, builderStatus, composeFromApp } from './prompts.mjs';
import { documentCommit, isSyncing, syncPrompts } from './promptsync.mjs';
import { cancel, cancelQueued, doNow, editQueued, endDoNow, focus, holdRun, maxParallel, moveInQueue, nudgeQueue, queueControl, queueInTurn, queueMarks, resume } from './queue.mjs';
import { changeSession, spendingStatus } from './spending.mjs';
import { activeRun, createRun, describeLater, doingNow, liveRuns, liveSpeech, needsBrief, outcomeLater, pauseLive, retryRun, setRunLevel, stepSays } from './runs.mjs';
import { speechView } from './speech.mjs';
import { closeGap, recordGap } from './gaps.mjs';
import { describeSchedule, nextRun } from './schedule.mjs';
import { changeSteer, steerView } from './steer.mjs';
import {
  answerPermission, endSession, finishSessionRequest, interruptSession, listSessions, openSession, planSession, profileFor, removeQueued, resumeSession, sayToSession, withManager,
  sessionRequests, sessionsState, sessionView,
} from './sessions.mjs';
import { talkTo } from './talk.mjs';
import { listRuns, readConversation, readNotifications, readPending, readRun, readUsage, runDir, runEnded, stepsOf } from './store.mjs';
import { checkNow, updateInfo, updateMode, updateNow } from './update.mjs';
import { browserPath, isReading, loginState, openLogin, readerSettings, readerStatus, readUsagePage, signedIn, signInNeeded } from './usagepage.mjs';
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
  pullRequest: run.pullRequest, needsYou: (run.requests ?? []).filter(r => r.status === 'open').length, onHold: !!run.onHold,
  // The run's speech bubble lines (src/speech.mjs), while it has not ended: a paused or waiting run shows its last ones.
  speech: runEnded(run) ? null : speechView(run),
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
    return reply(res, typeof error.code === 'number' ? error.code : 400, { error: error.message, ...(error.reason ? { reason: error.reason } : {}) });
  }
}

/**
 * A project's page: its facts, your clone and its branch, its development environment, its recent runs (the ones
 * neither waiting nor going on, newest first) and its open matters (src/charge.mjs). The rest of the page (crew, runs
 * going on, planning, memory, sessions) comes from the state.
 */
async function projectPage(id) {
  const config = loadConfig();
  const info = await projectInfo(id, config, computer(config));
  const going = new Set(liveRuns().map(l => l.run));
  const runs = listRuns(); // read once: the page asks again every few seconds
  const history = runs.filter(r => r.project === id && !['queued', 'waiting'].includes(r.status) && !going.has(r.id)).slice(0, 15).map(summary);
  return { ...info, history, open: openMatters(config, id, { runs, sessions: listSessions() }) };
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

/**
 * Per project: { agent, name, lead, profile, session (its conversation: the open one, else the latest), requests,
 * work: { session (the "Work now" session open, else null), notes (the latest summaries) } }.
 */
function chargeState(config, agents) {
  const all = listSessions();
  const sessions = all.filter(s => s.charge && s.mode === 'app');
  return Object.fromEntries(Object.keys(config.projects ?? {}).map(id => {
    const who = inCharge(config, id, agents);
    const own = sessions.filter(s => s.project === id);
    const session = own.find(s => s.status !== 'ended') ?? own[0] ?? null;
    return [id, who ? {
      agent: who.member.id, name: who.member.name ?? who.member.id, base: who.member.base ?? who.member.id, lead: who.lead, profile: chargeProfileId(id),
      session: session?.id ?? null, requests: projectRequests(id, 8),
      work: { session: all.find(s => s.work && s.project === id && s.mode === 'app' && s.status !== 'ended')?.id ?? null, notes: workNotesView(id) },
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
    // The agent's speech bubble and the run's latest lines (src/speech.mjs).
    speech: speechView(run, liveSpeech(l)),
  }));
  // in the order the turns go: a fair turn among projects (src/queue.mjs)
  const queue = queueInTurn(runs);
  const control = queueControl(runs);
  const doNowInForce = control.doNow;
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
  const spending = spendingStatus(config, { usage, runs, items });
  const attention = attentionItems({ config, runs, needs, usage, machine, items, update: updateInfo, questions, pushes, repos, lockdown: security, quarantine: quarantineList(), spare: spending.offer });
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
    projects: Object.entries(config.projects ?? {}).map(([id, p]) => ({ id, name: p.name, site: p.site, devUrl: devState(id, p, machine)?.url ?? null })),
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
    // The owner's focus (src/steer.mjs): the mode, its line, the latest changes and each project's control and hold.
    steer: steerView(config),
    // Every run going on (one per project, up to "max_parallel"); "current" is the oldest, for older readers of the API.
    running,
    current: running[0] ?? null,
    parallel: { max: maxParallel(config) },
    // In the order it runs, each run with what holds it and why, who placed it and whether it resumes first; and the
    // owner's "Do now" in force with the latest changes to the queue (src/queue.mjs).
    queue: queue.map(r => ({ ...summary(r), ...queueMarks(r, doNowInForce) })),
    queueControl: control,
    history: runs.filter(r => !['queued', 'waiting'].includes(r.status) && !goingIds.has(r.id)).slice(0, 30).map(summary),
    usage: { limits: config.limits ?? {}, account: usage },
    computer: machine,
    // The crew's browsers open (src/browsers.mjs): project, task, since when and whether the task still goes on.
    browsers: openBrowsers(config, latestProcesses()),
    sessions: sessionsState(config, machine),
    plan: {
      resets: planResets(config),
      pace: weekPace(usage),
      reader: { ...readerSettings(config), signedIn: signedIn(), reading: isReading(), status: readerStatus(), signIn: signInNeeded(), login: loginState() },
    },
    // The autopilot (src/autopilot.mjs): its settings, whether it may act now and what it did today.
    autopilot: autopilotStatus(config, usage, new Date(), runs),
    // The session's spending (src/spending.mjs): its mode now, a boost, the estimate of what will be left and the offer.
    spending,
    alerts: alerts(config, usage, machine),
    // What needs the owner, in three levels (src/attention.mjs): the band at the top, the sections, the title and the icon.
    attention: { items: attention, ...attentionSummary(attention), archived: attentionArchive().length },
    // The owner's decisions as cards (src/decisions.mjs): pull requests and branches to merge, proposals, the manager's questions.
    decisions: decisionCards({ config, attention, items, questions, pushes, repos, runs }),
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
    // The emergency watch (src/sentinel.mjs), its own team in the org chart.
    watch: watchView(config),
    // Calling the owner outside the app (src/escalation.mjs): Telegram, the PIN and the e-mail, never their secrets.
    escalation: escalationView(),
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
  // the session's pause may be off: only the safety margin (src/spending.mjs)
  if (body.pause_at_5h_window === null || String(body.pause_at_5h_window).trim().toLowerCase() === 'off') limits.pause_at_5h_window = null;
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
 * Host and Origin must be the tailnet name, so no other website can drive the app through the browser. The device
 * must be another one of the tailnet (tailnetSource); that the headers are Serve's is checked apart (fromServe).
 */
export function remoteRefusal(req, remote) {
  const hostname = String(req.headers.host ?? '').toLowerCase().replace(/:443$/, '');
  if (hostname !== remote.host) return 'address not allowed';
  const origin = req.headers.origin;
  if (origin !== undefined && origin.toLowerCase() !== `https://${remote.host}`) return 'request refused';
  if (req.method !== 'GET' && origin === undefined) return 'request refused';
  const login = String(req.headers['tailscale-user-login'] ?? '').trim().toLowerCase();
  if (!login || !remote.logins.includes(login)) return 'not allowed in';
  return tailnetSource(req.headers['x-forwarded-for'], ownAddresses());
}

// A Tailscale address: 100.64.0.0/10 or fd7a:115c:a1e0::/48.
const TAILNET_ADDRESS = /^(100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}|fd7a:115c:a1e0:[0-9a-f:]*)$/i;

/** This computer's own addresses, its node in the tailnet among them. */
export function ownAddresses() {
  return Object.values(os.networkInterfaces()).flat().map(a => String(a?.address ?? '').toLowerCase());
}

/**
 * Why the device behind a request is refused, or '' when it may go on. Tailscale Serve puts the device's tailnet
 * address in X-Forwarded-For, replacing one the device sent. A request from this computer's own node (its programs
 * calling the tailnet name) carries the owner's login too, so it is refused: only another device comes in this way.
 */
export function tailnetSource(forwarded, own) {
  const address = String(forwarded ?? '').trim().toLowerCase();
  if (!TAILNET_ADDRESS.test(address)) return 'not through the tailnet';
  return own.includes(address) ? 'from this computer' : '';
}

/**
 * The process that opened a TCP connection from 127.0.0.1:<from> to 127.0.0.1:<to>, read from `netstat -ano -p TCP`:
 * its PID, or 0. The connection's state is skipped, as Windows may translate it.
 */
export function connectionOwner(netstat, from, to) {
  for (const line of String(netstat).split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] === 'TCP' && cols[1] === `127.0.0.1:${from}` && cols[2] === `127.0.0.1:${to}`) return Number(cols.at(-1)) || 0;
  }
  return 0;
}

/** Whether a row of `tasklist /FO CSV /NH` is Tailscale's own service process: tailscaled.exe in session 0. */
export function isTailscaleService(row) {
  const [image, , , session] = (String(row).trim().match(/"[^"]*"/g) ?? []).map(x => x.slice(1, -1));
  return image?.toLowerCase() === 'tailscaled.exe' && session === '0';
}

const output = (command, args) => new Promise(resolve =>
  execFile(command, args, { windowsHide: true, timeout: 10_000 }, (error, stdout) => resolve(error ? '' : String(stdout))));

/**
 * Whether the connection to the remote listener was opened by Tailscale Serve itself, and not by another program of
 * this computer sending Serve's headers. Serve runs inside Tailscale's Windows service (session 0, where a user's
 * programs can't run); a stand-in's PID replaces it in the smoke test. Elsewhere than Windows, nothing is taken.
 * A raw TCP forward that Serve's own settings point here (tailscale serve --tcp) is opened by the service too, with
 * whatever headers its sender writes: changing Tailscale's settings is beyond this check.
 */
export async function fromServe(socket, remote) {
  if (process.platform !== 'win32' || socket.remoteAddress !== '127.0.0.1') return false;
  const pid = connectionOwner(await output('netstat', ['-ano', '-p', 'TCP']), socket.remotePort, socket.localPort);
  if (!pid) return false;
  if (remote.servePid) return pid === remote.servePid;
  return isTailscaleService(await output('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']));
}

/**
 * A command from another device (the remote access), where nobody would see a window open on the computer where
 * Chiefmate runs: { body } as it goes on, or { refused: true }. A session (the prompt builder's too) opens in the app
 * instead of a window, and the development environment runs in the background with no window. Opening the folder or
 * VS Code, a file of your user folder and bringing a browser to the front work only on the computer, so they are
 * refused, and the app doesn't offer them there (ui/afar.js; a file's path is shown to copy). Their "dryRun" still
 * answers.
 */
export function fromAfar(route, body) {
  switch (route) {
    case '/api/session':
    case '/api/prompt-builder/session':
      return { body: { ...body, window: false } };
    case '/api/project/dev':
      return { body: body.action === 'start' ? { ...body, background: true } : body };
    case '/api/project/open':
    case '/api/files/open':
      return { body, refused: true };
    case '/api/browser':
      return { body, refused: body.action === 'focus' };
    default:
      return { body };
  }
}

// What a command without the owner's key may do on this computer: what the command line lets an agent (a step, a live
// session, the manager, the watchdog and its rescuer) do, and never as the owner. Anything else is the owner's: the
// app and the owner's terminal send the key (src/owner.mjs). A route missing here needs the key.
const PLAN_DECISIONS = ['triage', 'approve', 'later', 'discard', 'restore', 'reorder'];
const DECIDED = ['proposed', 'triaged', 'approved', 'discarded'];
// The radar: the crew adds and updates ideas; deciding on one is the owner's (the manager's on the owner's word).
const RADAR_DECISIONS = ['choose', 'later', 'discard', 'restore'];
const RADAR_DECIDED = ['chosen', 'discarded', 'project'];
const statusOf = (text, parse = parseStatus) => {
  try {
    return parse(text);
  } catch {
    return null;
  }
};
const KEYLESS = {
  '/api/needs-you': true,
  '/api/needs-you/poll': true,
  '/api/needs-you/done': b => b.by === 'check' && !b.session && b.answer == null && b.note == null,
  // The open calls and the quarantine holds may be read; a call marked done, a run parked or a hold lifted, only by the
  // manager (src/needs.mjs, src/quarantine.mjs).
  '/api/calls': b => (b.action ?? 'list') === 'list' || b.by === 'manager',
  '/api/quarantine': b => b.action !== 'release' || b.by === 'manager',
  '/api/defect': true,
  '/api/defect/close': b => b.by === 'manager',
  '/api/manager': b => !!b.from && typeof b.from === 'object', // an agent's message, marked as the agent's
  '/api/request': true,
  '/api/ask-owner': true,
  '/api/task': true,
  '/api/ask': true,
  '/api/mission': true,
  '/api/level': true,
  '/api/cancel': true,
  '/api/resume': true,
  '/api/planning': b => b.by === 'manager' || !(PLAN_DECISIONS.includes(b.action) || (b.status && DECIDED.includes(statusOf(b.status)))),
  '/api/radar': b => b.by === 'manager'
    || (b.by === 'crew' && !RADAR_DECISIONS.includes(b.action) && !(b.status && RADAR_DECIDED.includes(statusOf(b.status, parseRadarStatus)))),
  '/api/session': true,
  '/api/session/end': true,
  '/api/session/say': b => b.by === 'manager',
  // A step's line for its speech bubble, always kept as the agent's (stepSays), never as the owner's.
  '/api/say': b => typeof b.run === 'string' && !!b.run,
  '/api/steer': b => b.by === 'manager',
  // The manager's tools (cli.mjs queue, edit, retry, guide and gap): its changes to the queue and to a queued run, a
  // step redone, its guidance to an agent at work (kept as the manager's) and its tool gaps.
  '/api/queue': b => b.by === 'manager',
  '/api/run/edit': b => b.by === 'manager',
  '/api/retry': b => b.by === 'manager',
  '/api/run/talk': b => b.by === 'manager',
  '/api/gap': b => b.by === 'manager',
  // What a restart of the computer would stop, and the manager's restart (src/power.mjs); never the owner's own.
  '/api/power': b => b.action === 'preview' || (b.action === 'reboot' && b.by === 'manager'),
  '/api/merge': b => !!b.preview || b.by === 'manager',
  '/api/close-pr': b => !!b.preview || b.by === 'manager',
  '/api/lockdown': b => b.action === 'engage' && ['manager', 'step'].includes(b.by),
  '/api/limits': true,
  '/api/stop-project': true,
  '/api/project/dev': true,
  '/api/prompts-sync': true,
  '/api/update-check': true,
  '/api/update-now': b => !b.interruptManager,
  '/api/usage-reader': b => b.read === true && b.enabled === undefined && !b.login,
  '/api/watchdog': true,
  // Opening the app's window, and the trade of its pairing code for the key.
  '/api/owner/window': true,
  '/api/owner/pair': true,
};

/** Whether a command (route and body) needs the owner's key on this computer. */
export function ownerOnly(route, body = {}) {
  const rule = KEYLESS[route];
  return !(rule === true || (typeof rule === 'function' && rule(body ?? {})));
}

export function startServer() {
  const config = loadConfig();
  const port = Number(process.env.CHIEFMATE_PORT) || config.port || 4747;
  const allowed = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
  checkClaude();
  setInterval(checkClaude, 10 * 60_000);
  // Claude Code's sign-in: at the start, then once a day (hourly within the warning; checkLogin skips the rest).
  checkLogin({ force: true });
  setInterval(checkLogin, 60 * 60_000).unref();
  const devNotices = setInterval(() => {
    try {
      deliverDevNotices();
    } catch (error) {
      console.error(`Development environment notices: ${error.message}`);
    }
  }, 2000).unref();
  // Whether each connection to the remote listener came from Tailscale Serve (fromServe), checked once.
  const servePeers = new WeakMap();
  const servePeer = (socket, remote) => {
    if (!servePeers.has(socket)) servePeers.set(socket, fromServe(socket, remote).catch(() => false));
    return servePeers.get(socket);
  };
  const handle = async (req, res, remote = null) => {
    try {
      // Guards against another website open in the browser trying to send commands here.
      // Each refusal is a signal for the emergency lockdown's detection (src/lockdown.mjs).
      if (remote) {
        // The headers first, then who opened the connection: once per connection, as Serve keeps them open.
        const refused = remoteRefusal(req, remote) || (!(await servePeer(req.socket, remote)) && 'not through Tailscale Serve');
        if (refused) {
          recordSignal(refused === 'not allowed in' ? 'login_failed' : 'unknown_origin', `${req.method} ${clip(String(req.url), 120)} (${refused})`, { who: 'remote' });
          // A connection refused stays refused (servePeer), so it is closed: a lookup that failed once must not keep
          // refusing the connection Serve reuses for the app's reads, each refusal a signal toward the lockdown.
          return reply(res, 403, { error: refused }, refused === 'not through Tailscale Serve' ? { connection: 'close' } : {});
        }
        // In an emergency lockdown, the remote access is off: only the lockdown's own screen is taken (the app's files,
        // which hold no data, so the phone can open it; reading the lockdown, engaging it again, the owner's note). The
        // refusal carries the reason, so the device shows the lockdown instead of a lost connection.
        // The path is read as the routes below read it, so "/./api/state" and the like are the API, not a file.
        const appFile = req.method === 'GET' && !new URL(req.url, `https://${remote.host}`).pathname.startsWith('/api/');
        const screen = appFile || (req.url === '/api/lockdown' && ['GET', 'POST'].includes(req.method));
        if (isLocked() && !screen) {
          const { since, reason } = lockdownView();
          return reply(res, 423, {
            error: t('Chiefmate is in emergency lockdown: the remote access is off until the owner releases it on the computer.'),
            lockdown: { active: true, since, reason }, language: loadConfig().language || 'en',
          });
        }
      } else if (!allowed.has(req.headers.host)) {
        recordSignal('unknown_origin', `${req.method} ${clip(String(req.url), 120)} (host ${clip(String(req.headers.host ?? ''), 80)})`, { who: 'app' });
        return reply(res, 403, { error: 'address not allowed' });
      }
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === 'GET') {
        if (url.pathname === '/api/health') return reply(res, 200, { ok: true, version: VERSION });
        if (url.pathname === '/api/state') return replyState(req, res);
        // The emergency lockdown alone, for the phone's screen while the rest of the remote access is off.
        if (url.pathname === '/api/lockdown') return reply(res, 200, { lockdown: lockdownView(), language: loadConfig().language || 'en' });
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
      let body = await readBody(req);
      // On this computer, what is the owner's needs the owner's key; the remote access keeps its own checks.
      if (!remote && ownerOnly(url.pathname, body) && !isOwner(req.headers)) {
        recordSignal('unknown_origin', `POST ${clip(String(req.url), 120)} (no owner key)`, { who: 'app' });
        return reply(res, 403, { error: t("Refused: this is the owner's, and the request doesn't carry the owner's key."), owner: true });
      }
      if (remote) {
        const afar = fromAfar(url.pathname, body);
        if (afar.refused && !body.dryRun) return reply(res, 403, { error: t('This opens on the computer where Chiefmate runs: do it there.') });
        body = afar.body;
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
        case '/api/calls': {
          // The manager's handling of the open calls (cli.mjs calls): list them, mark one done on the owner's words in
          // its conversation (only while it answers, src/needs.mjs), or park a run that waits for the owner.
          const action = String(body.action ?? 'list');
          if (action === 'list') return reply(res, 200, { calls: openCalls() });
          if (action === 'done') {
            if (body.by !== 'manager') return reply(res, 403, { error: t("Only the manager, while it answers the owner, marks a call done on the owner's word.") });
            return reply(res, 200, confirmByOwnerWords(body.run, String(body.id ?? ''), body.ownerSaid, { conversation: readConversation(), answering: chat.responding }));
          }
          if (action === 'park') {
            const parked = parkRun(body.run, { by: body.by === 'owner' ? 'owner' : 'manager', request: body.id ? String(body.id) : null });
            nudgeQueue();
            return reply(res, 200, parked);
          }
          return reply(res, 400, { error: t('Unknown action: {action}', { action }) });
        }
        case '/api/quarantine':
          // The projects waiting for a file the antivirus probably took (src/quarantine.mjs); "release" lifts a hold.
          if (body.action === 'release') {
            const released = releaseQuarantine(String(body.project ?? ''), body.by === 'manager' ? 'manager' : 'owner');
            nudgeQueue();
            return reply(res, 200, released);
          }
          return reply(res, 200, { holds: quarantineList() });
        case '/api/decide': {
          // The owner's click on a decision card: approve (a merge goes through src/merge.mjs), later, discard or answer.
          const decided = await decide({ card: body.card, action: body.action, option: body.option, note: body.note, reason: body.reason }, buildState().decisions);
          // A request of an agent in charge, authorized on its card, has its run queued: the queue looks at once.
          if (decided.run) nudgeQueue();
          return reply(res, 200, decided);
        }
        case '/api/request': {
          // The manager's answer to a request of a project's agent in charge (cli.mjs request <id> <answer>).
          const answered = await answerRequest(body.id, String(body.action ?? ''), { note: body.note, recommend: body.recommend, project: body.project, run: body.run, ...brief(body) });
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
          // "by": "manager" for the manager's guidance (cli.mjs guide); the owner's from the agent's panel otherwise.
          return reply(res, 200, talkTo(body.run, body.text, { by: body.by === 'manager' ? 'manager' : 'owner' }));
        case '/api/say':
          // A line of the agent at work for its speech bubble (cli.mjs say, from its step; src/speech.mjs).
          return reply(res, 200, stepSays(body.run, body.step, body.text));
        case '/api/run/edit':
          // A run still in the queue: more instructions, its title, summary, agent, tool or level (src/runs.mjs, editRun).
          return reply(res, 200, summary(editQueued(body.id, body.changes ?? {}, { by: body.by === 'owner' ? 'owner' : 'manager' })));
        case '/api/retry': {
          // Redoes a step of a run that stopped, with another agent or tool if given (src/runs.mjs, retryRun).
          const run = retryRun(body.id, { step: body.step, agent: body.agent, tool: body.tool }, { by: body.by === 'owner' ? 'owner' : 'manager' });
          nudgeQueue();
          return reply(res, 200, summary(run));
        }
        case '/api/gap':
          // The manager's tool gaps (src/gaps.mjs): "record" one more case, or "close" one.
          if (body.action === 'close') return reply(res, 200, { gap: closeGap(body.id, body.note) });
          return reply(res, 200, { gap: await recordGap({ what: body.what, example: body.example, by: body.by ?? 'manager' }) });
        case '/api/session': {
          // With "dryRun": the folder and the first message it would open with, and nothing opens.
          if (body.dryRun) {
            const config = loadConfig();
            const { profile, folder, prompt } = planSession(config, String(body.profile ?? ''));
            const text = profile.charge ? prompt.text : withManager(prompt.text, config, '<session id>');
            return reply(res, 200, { dryRun: true, profile: profile.id, tool: profile.tool, cwd: folder.dir, blocks: prompt.blocks, missing: prompt.missing, prompt: prompt.blocksGiven ? text : null });
          }
          // "window": in a window of its own (Windows Terminal), instead of the conversation in the app.
          return reply(res, 200, await openSession(String(body.profile ?? ''), { origin: body.origin ?? 'app', window: !!body.window }));
        }
        case '/api/work-now': {
          // "Work now", the owner's click on a project's page (src/worknow.mjs): the session, at once; { conflict } only
          // with "work_now_mode": "ask" while a run of the crew goes on ("choice": "pause" or "copy" then). "dryRun" opens nothing.
          const tool = body.tool === 'codex' ? 'codex' : 'claude';
          const choice = ['pause', 'copy'].includes(body.choice) ? body.choice : null;
          return reply(res, 200, await openWork(String(body.project ?? ''), { tool, choice, dryRun: !!body.dryRun }));
        }
        case '/api/work-now/release':
          // "Let it go on": the crew's runs paused by a "Work now" session go on now, in their own working copy.
          return reply(res, 200, { released: await releaseWork(String(body.id ?? '')) });
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
        case '/api/files/open':
          // A file of your user folder, opened on this computer (src/files.mjs); "dryRun" only finds it, as the phone does.
          try {
            return reply(res, 200, openOnComputer(body.path, { dryRun: !!body.dryRun }));
          } catch (error) {
            if (typeof error.code !== 'number') throw error;
            return reply(res, error.code, { error: error.message, ...(error.reason ? { reason: error.reason } : {}), ...(error.tried ? { tried: error.tried } : {}) });
          }
        case '/api/project/open':
          // "app": "folder" (the file manager) or "vscode", in your own clone of the project.
          return reply(res, 200, openProjectApp(String(body.project ?? ''), String(body.app ?? ''), { dryRun: !!body.dryRun }));
        case '/api/project/dev': {
          // The project's development environment ("dev_start"): "action": "start" or "stop"; "background" runs it
          // with no window (from another device), its output kept in a log.
          const options = { dryRun: !!body.dryRun, background: !!body.background };
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
            return reply(res, 200, { dryRun: true, profile, tool, cwd: folder.dir, prompt: withManager(prompt.text, config, '<session id>') });
          }
          return reply(res, 200, await openSession(profile, { origin: 'app', prompt: String(body.prompt), window: !!body.window }));
        }
        case '/api/prompts-sync':
          return reply(res, 200, await syncPrompts());
        case '/api/cancel':
          return reply(res, 200, { status: cancel(body.id) });
        case '/api/queue': {
          // Changes to the queue (src/queue.mjs): move a run, hold it (with the reason) or release it, "Do now" and its
          // end, cancel. The owner's, from the app with the owner's key; the manager's (cli.mjs queue, "by": "manager",
          // without the key: ownerOnly) never undo the owner's changes.
          const by = body.by === 'manager' ? 'manager' : 'owner';
          const id = String(body.id ?? '');
          switch (body.action) {
            case 'move': {
              const where = { before: body.before ?? null, after: body.after ?? null, top: !!body.top, up: !!body.up, down: !!body.down };
              return reply(res, 200, { queue: moveInQueue(id, where, by).map(summary) });
            }
            case 'hold':
            case 'release':
              return reply(res, 200, summary(holdRun(id, body.action === 'hold', by, body.reason ?? null)));
            case 'do-now':
              return reply(res, 200, doNow(id, String(body.scope ?? ''), by));
            case 'do-now-end':
              return reply(res, 200, endDoNow(by));
            case 'cancel':
              return reply(res, 200, { status: cancelQueued(id, by) });
            default:
              return reply(res, 400, { error: t('Say "move", "hold", "release", "do-now", "do-now-end" or "cancel".') });
          }
        }
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
          return reply(res, 200, await mergeRun(body.run, { by: body.by === 'manager' ? 'manager' : 'owner', savePending: body.savePending === true }));
        case '/api/close-pr':
          // Closes a run's pull request replaced by a newer run's (src/merge.mjs): "preview" only shows it.
          if (body.preview) return reply(res, 200, previewClose(body.run, body.replacedBy));
          return reply(res, 200, await closeReplaced(body.run, body.replacedBy, { by: body.by === 'manager' ? 'manager' : 'owner' }));
        case '/api/manager':
          // Accepted at any time: while the manager answers, the message waits in the queue. "from": an agent's
          // (a live session or a step, from the command line), marked as the agent's, never as the owner's.
          return reply(res, 202, { ok: true, ...sendToManager(body.message, { sender: body.from ? agentSender(body.from) : null }) });
        case '/api/defect':
          // A defect of Chiefmate an agent reports on its own (src/defects.mjs): recorded, and news for the manager.
          return reply(res, 200, reportDefect(body.text, agentSender(body.from ?? {})));
        case '/api/defect/close':
          return reply(res, 200, { defect: closeDefect(body.id, body.note, body.by === 'manager' ? 'manager' : 'owner') });
        case '/api/manager/edit':
        case '/api/manager/remove': {
          const id = String(body.id ?? '');
          const pending = url.pathname.endsWith('/edit') ? editPending(id, body.message) : removePending(id);
          return pending ? reply(res, 200, { pending }) : reply(res, 404, { error: t('This message is no longer in the queue: it was delivered or removed.') });
        }
        case '/api/owner/window':
          // The app's window, opened here with a pairing code (scripts/open.vbs, or the app without the key).
          if (remote) return reply(res, 403, { error: t('This opens on the computer where Chiefmate runs: do it there.') });
          return reply(res, 200, openAppWindow({ port, section: String(body.section ?? ''), browser: browserPath(loadConfig()) }));
        case '/api/owner/pair': {
          // The app trades its window's pairing code for the key, once.
          const key = remote ? null : redeemCode(body.code);
          if (!key) {
            recordSignal('unknown_origin', 'POST /api/owner/pair (a pairing code unknown, spent or expired)', { who: remote ? 'remote' : 'app' });
            return reply(res, 403, { error: t('This pairing code is not valid: open Chiefmate again from its shortcut.') });
          }
          return reply(res, 200, { key, header: OWNER_HEADER });
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
            return reply(res, 200, { lockdown: lockdownView(release({ by: 'owner', from: body.origin === 'cli' ? 'cli' : 'app', note: String(body.note ?? '') })) });
          }
          if (body.action === 'note') {
            // The owner's note on the alarm going on, from this computer or the phone: in its record and to the manager.
            return reply(res, 200, { lockdown: lockdownView(addNote(String(body.note ?? ''), { from: remote ? 'remote' : 'app' })) });
          }
          return reply(res, 400, { error: 'unknown action' });
        }
        case '/api/escalation':
          // Calling the owner outside the app (src/escalation.mjs): set up and tested on this computer only.
          if (remote) return reply(res, 403, { error: t('Telegram, the PIN and the e-mail are set up on the computer where Chiefmate runs.') });
          return reply(res, 200, await changeEscalation(body));
        case '/api/away':
          // The owner stepped out or is back: the manager is told at once (src/news.mjs).
          return reply(res, 200, { away: setAway(!!body.on) });
        case '/api/power': {
          // The power modes (src/power.mjs). From another device, only standby: a Chiefmate stopped there could not be
          // started again from it.
          const action = String(body.action ?? '');
          if (remote && ['stop', 'shutdown', 'reboot'].includes(action)) return reply(res, 403, { error: t('Shutting down is done on the computer itself: from another device, Chiefmate could not be started again.') });
          const runs = liveRuns().map(l => ({ run: l.run, title: l.title, project: l.project }));
          const sessions = () => sessionsState().open.map(x => ({ id: x.id, name: x.name, cwd: x.cwd, mode: x.mode, tool: x.tool, phase: x.phase ?? null }));
          if (action === 'preview') return reply(res, 200, { ...(await powerPreview({ runs, sessions: sessions() })), away: !!awayInfo() });
          if (action === 'reboot') {
            // A restart of the computer, the manager's or the owner's, always with a reason. Refused while a live
            // session's turn goes on; the manager's, during an emergency lockdown, and outside away mode it waits for
            // the owner's confirmation on a question card (askReboot in src/decisions.mjs).
            const by = body.by === 'manager' ? 'manager' : 'owner';
            const reason = clip(String(body.reason ?? '').trim(), 300);
            const refusal = by === 'manager' && isLocked() ? t('The emergency lockdown is on: only the owner may restart the computer now.') : rebootRefusal({ reason });
            if (refusal) {
              logPower({ action: 'reboot', outcome: 'refused', by, reason, why: refusal });
              return reply(res, 409, { error: refusal });
            }
            if (by === 'manager' && !awayInfo()) {
              const q = askReboot({ by, reason, runs, sessions: sessions() });
              logPower({ action: 'reboot', outcome: 'asked', by, reason, question: q.id });
              return reply(res, 200, { ...powerInfo(), asked: q.id });
            }
            return reply(res, 200, stopSystem('reboot', { by, reason }));
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
        case '/api/steer': {
          // The owner's focus (src/steer.mjs), from the app's Focus panel or the command line ("focus", by the manager).
          const by = remote ? `remote:${String(req.headers['tailscale-user-login'] ?? '').trim().toLowerCase()}` : ['manager', 'cli'].includes(body.by) ? body.by : 'owner';
          const live = liveRuns().map(l => ({ run: l.run, project: l.project }));
          // with "preview", only the runs going on the change would hold, for the owner's choice: finish or pause
          if (body.preview) return reply(res, 200, changeSteer(body, { by, live, dryRun: true }));
          const { paused } = changeSteer(body, { by, live, pause: id => pauseLive(id, 'focus') });
          return reply(res, 200, { steer: steerView(), paused });
        }
        case '/api/spending':
          // The session's mode, runs at once and pause, "Spend all until" the renewal and "Not now" (src/spending.mjs).
          changeSession(body, { by: remote ? `remote:${String(req.headers['tailscale-user-login'] ?? '').trim().toLowerCase()}` : 'app' });
          return reply(res, 200, spendingStatus());
        case '/api/autopilot':
          // Save the autopilot's settings and record who changed them (src/autopilot.mjs).
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
          // The sign-in window, from the app's card (it closes by itself after a few minutes).
          if (body.login) openLogin();
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
  const smokeRemote = process.env.CHIEFMATE_SMOKE ? JSON.parse(process.env.CHIEFMATE_REMOTE_ACCESS || 'null') : null;
  const remote = remoteSettings(process.env.CHIEFMATE_SMOKE ? smokeRemote : config.remote_access, port);
  // The smoke test's process stands in for Tailscale Serve there.
  if (remote && smokeRemote) remote.servePid = Number(smokeRemote.serve_pid) || 0;
  let remoteServer = null;
  if (remote) {
    remoteServer = http.createServer((req, res) => handle(req, res, remote));
    // Serve's connections stay open between the app's reads, so each is checked once (fromServe).
    remoteServer.keepAliveTimeout = 65_000;
    remoteServer.on('error', error => console.error(`Remote access is off: ${error.message}`));
    remoteServer.listen(remote.port, '127.0.0.1', () => console.log(`Remote access through Tailscale Serve at https://${remote.host} (127.0.0.1:${remote.port})`));
  }
  // Both listeners (such as before a restart for an update), so the next Chiefmate can open them.
  const close = () => {
    clearInterval(devNotices);
    remoteServer?.close();
    remoteServer?.closeAllConnections();
    return new Promise(resolve => server.close(() => resolve()));
  };
  return { server, port, remote, close };
}
