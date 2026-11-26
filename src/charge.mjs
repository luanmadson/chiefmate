// The agent in charge of a project: the one the owner talks to directly, from the project's page ("Talk to the agent
// in charge"). It is the project's team lead when it has one, else the main member of the project's crew. The
// conversation is a live session in the app (src/sessions.mjs) with a profile of its own, "project-<id>-charge": it
// carries the project's memory and context, and only this project's. The agent in charge talks, answers and plans,
// but changes nothing: it reads only (no shell, no editing). When there is something to do, it ends its message with a
// ~~~manager-request block; Chiefmate records the request (data/manager/owner-requests.json), shows it on the
// project's page and tells the manager ("owner_request" news). Each answer goes back to the conversation, and the
// agent reads its requests' state in every turn.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { denyRules, stepAccess } from './access.mjs';
import { loadAgents, loadConfig, projectCrew } from './config.mjs';
import { formatDateTime, t } from './i18n.mjs';
import { LEAD, readMemory, taskTakers } from './leads.mjs';
import { reportEvent } from './news.mjs';
import { deliveryPlace, pendingDeliveries } from './attention.mjs';
import { planItems } from './planning.mjs';
import { listRuns, readRun } from './store.mjs';
import { clip, DATA, ensureDir, languageName, now, parseLevel, readJson, WORKSPACES, writeJson } from './util.mjs';

/** The profile id of a project's conversation with its agent in charge. */
export const chargeProfileId = projectId => `project-${projectId}-charge`;
/** The project of a charge profile id, or null. */
export const chargeProject = profileId => /^project-(.+)-charge$/.exec(String(profileId ?? ''))?.[1] ?? null;

/**
 * Who is in charge of a project: { member, lead } (the team lead when the project has one; else the first member of its
 * own crew, or the generalist of the general crew), or null when its crew has nobody to take work.
 */
export function inCharge(config, projectId, agents = loadAgents(config)) {
  if (!config.projects?.[projectId]) return null;
  const team = projectCrew(config, projectId, agents);
  if (team[LEAD]) return { member: team[LEAD], lead: true };
  const takers = taskTakers(team);
  const member = (config.projects[projectId].crew ? null : takers.generalist) ?? Object.values(takers)[0];
  return member ? { member, lead: false } : null;
}

/** The profile of a project's conversation with its agent in charge (never written to the settings). */
export function chargeProfile(config, projectId) {
  const who = inCharge(config, projectId);
  if (!who) throw new Error(t('{project} has no one in its crew to be in charge.', { project: projectId }));
  const name = config.projects[projectId].name ?? projectId;
  return {
    id: chargeProfileId(projectId), name: t('{project}: {agent}, in charge', { project: name, agent: t(who.member.name ?? who.member.id) }),
    tool: 'claude', project: projectId, library_folder: null, prompt_blocks: [], model: who.member.model ?? config.default_model ?? null,
    cwd: null, mcp: [], auto: true, charge: true, member: who.member.id,
  };
}

// ---------- The requests to the manager ----------

const REQUESTS_MAX = 300;
export const SIZES = ['S', 'M', 'L'];
export const RISKS = ['low', 'medium', 'high'];
const ACTIONS = { approve: 'approved', hold: 'waiting', 'ask-owner': 'owner', forward: 'forwarded', 'in-progress': 'in-progress', reject: 'rejected' };
export const REQUEST_STATUSES = ['pending', ...Object.values(ACTIONS)];
const FINAL = ['approved', 'forwarded', 'in-progress', 'rejected'];
const ANSWERS = Object.keys(ACTIONS).join('|');

const requestsFile = () => path.join(ensureDir(path.join(DATA, 'manager')), 'owner-requests.json');
export const readRequests = () => readJson(requestsFile(), []);
const saveRequests = list => writeJson(requestsFile(), list.slice(-REQUESTS_MAX));
const word = x => String(x ?? '').trim().toLowerCase();

/** A size in S, M or L (P/G, as in Portuguese, and the words too). */
function sizeOf(value) {
  const w = word(value);
  if (['s', 'p', 'small', 'pequeno', 'pequena'].includes(w)) return 'S';
  if (['l', 'g', 'large', 'big', 'grande'].includes(w)) return 'L';
  return 'M';
}

function riskOf(value) {
  const w = word(value);
  if (['low', 'baixo', 'baixa'].includes(w)) return 'low';
  if (['high', 'alto', 'alta'].includes(w)) return 'high';
  return 'medium';
}

/** The last ~~~manager-request block of a message, taken out: { text (without it), request (or null), error }. */
export function takeRequest(message) {
  const text = String(message ?? '');
  const re = /^(~{3,}|`{3,})[ \t]*manager-request[^\n]*\n([\s\S]*?)\n\1[ \t]*$/gm;
  const found = [...text.matchAll(re)];
  if (!found.length) return { text, request: null, error: null };
  const rest = text.replace(re, '').replace(/\n{3,}/g, '\n\n').trim();
  let data;
  try {
    data = JSON.parse(found.at(-1)[2]);
  } catch (error) {
    return { text: rest, request: null, error: `the request is not valid JSON (${error.message})` };
  }
  const asked = clip(data?.asked, 1000);
  const plan = clip(data?.plan, 2000);
  if (!asked || !plan) return { text: rest, request: null, error: 'the request needs "asked" and "plan"' };
  return { text: rest, request: { asked, plan, size: sizeOf(data.size), risk: riskOf(data.risk), urgency: word(data.urgency) === 'now' ? 'now' : null }, error: null };
}

const sizeWords = { S: 'small', M: 'medium', L: 'large' };
/** The size and the risk in the owner's language. */
export const sizeText = () => ({ S: t('Size S'), M: t('Size M'), L: t('Size L') });
export const riskText = () => ({ low: t('Low risk'), medium: t('Medium risk'), high: t('High risk') });

/**
 * Records a request of the agent in charge and tells the manager. The same plan still pending for the project is not
 * recorded twice. Returns the request.
 */
export function addRequest({ project, session = null, asked, plan, size, risk, urgency = null } = {}, config = loadConfig()) {
  if (!config.projects?.[project]) throw new Error(t('Unknown project: {id}', { id: project }));
  const who = inCharge(config, project);
  const list = readRequests();
  const same = list.find(r => r.project === project && r.status === 'pending' && word(r.plan) === word(plan));
  if (same) return same;
  const r = {
    id: Math.max(0, ...list.map(x => x.id)) + 1, project, session, member: who?.member.id ?? null, memberName: who?.member.name ?? null,
    asked: clip(asked, 1000), plan: clip(plan, 2000), size: sizeOf(size), risk: riskOf(risk), urgency: urgency === 'now' ? 'now' : null,
    status: 'pending', at: now(), note: '', answered_at: null, by: null, run: null, question: null, history: [],
  };
  saveRequests([...list, r]);
  const owner = config.owner || 'the owner';
  reportEvent('owner_request', `${r.memberName ?? 'The agent in charge'}, in charge of ${config.projects[project].name ?? project}, sends you request #${r.id} from its conversation with ${owner}. ${owner} asked: "${clip(r.asked, 300)}". It intends to: ${clip(r.plan, 500)}. Size ${sizeWords[r.size]}, risk ${r.risk}${r.urgency ? `; ${owner} said it can be done now` : ''}. Answer it with node src/cli.mjs request ${r.id} ${ANSWERS} --note "<why, one line>" --level 1|2|3.`, { config });
  return r;
}

/** A project's requests, newest first, with the current state of linked work. */
export function projectRequests(projectId, limit = 12) {
  return readRequests().filter(r => r.project === projectId).reverse().slice(0, limit).map(r => {
    const run = r.run ? readRun(r.run) : null;
    const managerNote = r.by === 'manager' ? r.note : r.history?.findLast(h => h.by === 'manager')?.note;
    return { ...r, history: undefined, managerNote, runTitle: run?.title ?? null, runStatus: run?.status ?? null, merged: !!run?.merged };
  });
}

/** What the manager reads of an answer, or the owner's question card says. */
const describe = r => `request #${r.id} of ${r.project} ("${clip(r.plan, 120)}")`;

/**
 * The manager's answer, or the owner's from an "ask-owner" card. Only approve queues work, and the caller nudges
 * the queue. Forward and in-progress record the destination without queueing work.
 * The level (1 to 3) is the approval level its decision card shows; kept on the request, so the owner's "Authorize" passes it on.
 * The answer goes back to the conversation with the agent in charge. Returns { request, run, question }.
 */
export async function answerRequest(id, action, { note = '', by = 'manager', recommend = null, title = null, summary = null, level = null, project = null, run: runId = null } = {}, config = loadConfig()) {
  if (!Object.hasOwn(ACTIONS, action)) throw new Error(t('Answer with approve, hold, ask-owner, forward, in-progress or reject.'));
  const status = ACTIONS[action];
  // Resolve imports before reading the requests so concurrent answers cannot use the same snapshot.
  const [{ noteSession }, runs, decisions] = await Promise.all([
    import('./sessions.mjs'),
    action === 'approve' ? import('./runs.mjs') : null,
    action === 'ask-owner' ? import('./decisions.mjs') : null,
  ]);
  const list = readRequests();
  const r = list.find(x => x.id === Number(String(id).replace(/^#/, '')));
  if (!r) throw new Error(t('Request {id} not found.', { id }));
  if (FINAL.includes(r.status)) throw new Error(t('Request {id} was already answered: {status}.', { id: r.id, status: r.status }));
  // Taken to the owner: their card decides it, not another answer of the manager's.
  if (r.status === 'owner' && by !== 'owner') throw new Error(t('Request {id} waits for the owner in Decisions.', { id: r.id }));
  const why = clip(note, 600);
  const approval = level == null || level === '' ? r.level ?? null : parseLevel(level);
  if (!why && by === 'manager' && action !== 'approve') throw new Error(t('Say why, with --note "<one line>".'));
  if (action === 'forward' && !!project === !!runId) throw new Error(t('Forward to one destination with --project <id> or --run <id>.'));
  if (action === 'in-progress' && !runId) throw new Error(t('Link the existing run with --run <id>.'));
  if (project && !['approve', 'forward'].includes(action)) throw new Error(t('Use --project with approve or forward.'));
  if (runId && !['forward', 'in-progress'].includes(action)) throw new Error(t('Use --run with forward or in-progress.'));
  if (project && !Object.hasOwn(config.projects ?? {}, project)) throw new Error(t('Unknown project: {id}', { id: project }));
  const linkedRun = typeof runId === 'string' && /^[\w-]+$/.test(runId) ? readRun(runId) : null;
  if (runId && !linkedRun) throw new Error(t('Run {id} not found.', { id: runId }));
  if (action === 'in-progress' && !['queued', 'running', 'waiting', 'paused'].includes(linkedRun.status)) {
    throw new Error(t('Run {id} is no longer in progress.', { id: runId }));
  }
  const owner = config.owner || 'the owner';
  let run = null;
  let question = null;
  if (action === 'approve') {
    const projectId = project || r.project;
    const who = inCharge(config, projectId);
    if (!who) throw new Error(t('{project} has no one in its crew to be in charge.', { project: projectId }));
    const instruction = [
      r.plan,
      `What ${owner} asked the agent in charge of the project (request #${r.id}): ${r.asked}`,
      ...(why ? [`The manager's note: ${why}`] : []),
    ].join('\n\n');
    const work = { projectId, instruction, origin: 'owner-request', request: r.id, title, summary, level: approval };
    run = runs.createRun(who.lead ? { ...work, kind: 'ask' } : { ...work, kind: 'task', agent: who.member.id, review: true }, config);
    r.run = run.id;
  } else if (action === 'ask-owner') {
    const choice = { approve: t('Authorize'), hold: t('Wait'), reject: t('Refuse') }[word(recommend)] ?? null;
    question = decisions.addQuestion({
      question: clip(t('Authorize: {plan}?', { plan: clip(r.plan, 200) }), 300),
      context: [
        t('{owner} asked the agent in charge: {asked}', { owner, asked: clip(r.asked, 500) }),
        `${sizeText()[r.size]}, ${riskText()[r.risk].toLowerCase()}.`,
        ...(why ? [t("The manager's note: {note}", { note: why })] : []),
      ].join('\n'),
      options: [t('Authorize'), t('Wait'), t('Refuse')], recommend: choice, project: r.project, level: approval, request: r.id,
    }, config);
    r.question = question.id;
  } else if (linkedRun) {
    r.run = linkedRun.id;
  } else if (action === 'forward') {
    r.targetProject = project;
  }
  Object.assign(r, { status, note: why, answered_at: now(), by, level: approval });
  r.history = [...(r.history ?? []), { at: now(), action, by, note: why }];
  saveRequests(list);
  if (r.session) {
    const target = run ?? linkedRun;
    noteSession(r.session, answerLine(r, owner), {
      kind: 'request', request: r.id, status, by,
      ...(target ? { run: target.id, runTitle: target.title } : {}),
      ...(r.targetProject ? { targetProject: r.targetProject } : {}),
    });
  }
  return { request: r, run, question };
}

/** The answer, in one line, for the conversation with the agent in charge. */
function answerLine(r, owner) {
  const who = r.by === 'owner' ? owner : t('The manager');
  const note = r.note ? ` ${t('Note: {note}', { note: r.note })}` : '';
  return {
    approved: t('{who} authorized request #{id}: the work is in the queue for the crew.', { who, id: r.id }),
    waiting: t('{who} put request #{id} on hold.', { who, id: r.id }),
    owner: t('The manager took request #{id} to you: answer it in Decisions.', { id: r.id }),
    forwarded: t('{who} forwarded request #{id}.', { who, id: r.id }),
    'in-progress': t('{who} linked request #{id} to work already in progress.', { who, id: r.id }),
    rejected: t('{who} refused request #{id}.', { who, id: r.id }),
  }[r.status] + note;
}

/** The owner answered the card of an "ask-owner" (or closed it without answering): the request follows. */
export async function ownerAnswered(q) {
  if (!q?.request) return null;
  const index = q.answer == null ? -1 : q.options.indexOf(q.answer);
  const action = ['approve', 'hold', 'reject'][index] ?? 'hold';
  // What the owner wrote goes with it; written without an option, the request waits on hold with those words.
  const note = q.note || (q.answer == null ? t('closed the question without answering') : '');
  return answerRequest(q.request, action, { by: 'owner', note });
}

/** The manager's line: the requests waiting for its answer, and the ones on hold. */
export function requestsLine(config = loadConfig()) {
  const open = readRequests().filter(r => ['pending', 'waiting'].includes(r.status));
  if (!open.length) return '';
  const line = r => `#${r.id} (${r.project}, ${r.status === 'pending' ? 'waiting for you' : `on hold: ${clip(r.note, 80)}`}, ${sizeWords[r.size]}, risk ${r.risk}${r.urgency ? ', the owner said "now"' : ''}): ${clip(r.plan, 140)}`;
  return `Requests from the agents in charge of the projects, sent from their conversations with ${config.owner || 'the owner'} (answer with node src/cli.mjs request <id> ${ANSWERS} --note "..." --level 1|2|3; node src/cli.mjs request show <id> for the whole request): ${open.slice(0, 8).map(line).join('; ')}.`;
}

// ---------- The project's open matters ----------
// What the agent in charge (and the project's page) knows of the work still open, beyond the clone's main branch:
// the board's open items, the latest runs' final summaries, the deliveries waiting for the owner and the live
// sessions. Only this project's, each list with a ceiling, so a long history never floods the conversation.

const RECENT_FOR = 7 * 24 * 3600_000;
const MAX = { plan: 12, recent: 10, deliveries: 10, sessions: 8 };
const MATTERS_MAX = 9000; // characters of the whole section in the instructions
const OPEN_SESSION = ['login', 'starting', 'open'];
// An open item's next step, by its status.
export const NEXT_STEP = {
  proposed: "waits for the manager's triage", triaged: "waits for the owner's decision", approved: 'approved: waits its turn for the crew',
  future: 'kept for later', todo: 'to do, not started', queued: 'its run is in the queue', in_progress: 'its run is going on',
  waiting_owner: 'waits for the owner: approve its delivery or act',
};

/**
 * A project's open matters, only of "projectId": { plan (the board's order), recent (newest first), deliveries
 * (oldest first), sessions }. The sessions are given by the caller (src/sessions.mjs imports this module).
 */
export function openMatters(config, projectId, { runs = listRuns(), items = planItems(), sessions = [] } = {}) {
  const name = config.projects?.[projectId]?.name;
  const ours = p => p === projectId || (!!name && p === name);
  const closed = ['done', 'discarded'];
  const outcome = r => (r.outcome ? [r.outcome.done?.join('; '), r.outcome.change, r.outcome.needs ? `needs the owner: ${r.outcome.needs}` : ''].filter(Boolean).join(' ') : '');
  const plan = items.filter(i => ours(i.project) && !i.archived && !closed.includes(i.status)).slice(0, MAX.plan)
    .map(i => ({ id: i.id, title: i.title, status: i.status, priority: i.priority, note: clip(i.recommend_note || i.description, 200), run: i.run ?? null }));
  const deliveries = pendingDeliveries(runs.filter(r => ours(r.project))).slice(0, MAX.deliveries).map(({ run: r, waited, stale }) => ({
    run: r.id, title: r.title, summary: clip(r.summary || r.outcome?.change || r.result, 300), pullRequest: r.pullRequest ?? null, branch: r.branch ?? null,
    place: deliveryPlace(r), ended: r.ended, waited, stale,
  }));
  const recent = runs.filter(r => ours(r.project) && ['done', 'failed', 'canceled'].includes(r.status) && r.ended && Date.now() - Date.parse(r.ended) <= RECENT_FOR)
    .sort((a, b) => b.ended.localeCompare(a.ended)).slice(0, MAX.recent)
    .map(r => ({ run: r.id, title: r.title, status: r.status, merged: !!r.merged, discarded: !!r.discarded, ended: r.ended, outcome: clip(outcome(r) || r.result, 400) }));
  const live = sessions.filter(s => ours(s.project) && !s.charge && OPEN_SESSION.includes(s.status)).slice(0, MAX.sessions)
    .map(s => ({ id: s.id, name: s.name, tool: s.tool, mode: s.mode === 'app' ? 'app' : 'window', started: s.started ?? s.created }));
  return { plan, recent, deliveries, sessions: live };
}

/**
 * The open matters, in text for the instructions of the agent in charge and the first message of "Work now"
 * (src/worknow.mjs), capped at MATTERS_MAX characters. when: what the heading says of their date.
 */
export function mattersText(m, owner = 'the owner', { when = 'current at every message' } = {}) {
  const none = 'None.';
  const hours = ms => `${Math.floor(ms / 3600_000)} h`;
  const sections = [
    ['### Planning board: open items', m.plan.map(i => `- #${i.id} ${i.title} (${i.status.replace('_', ' ')}, ${i.priority} priority): next, ${NEXT_STEP[i.status] ?? i.status}.${i.note ? ` ${i.note}` : ''}`)],
    [`### Deliveries waiting for ${owner} (not merged, not discarded)`, m.deliveries.map(d => `- ${d.title} [run ${d.run}]: ${d.place}, waiting for ${hours(d.waited)}${d.stale ? ', stalled' : ''}.${d.summary ? ` ${d.summary}` : ''}`)],
    ['### Runs of the last 7 days, newest first, with their final summary', m.recent.map(r => `- ${formatDateTime(r.ended)}, ${r.title} [run ${r.run}]: ${r.merged ? 'merged' : r.discarded ? 'discarded' : r.status}.${r.outcome ? ` ${r.outcome}` : ''}`)],
    [`### Live sessions open on this project (${owner} working with an agent)`, m.sessions.map(s => `- ${s.name} (${s.tool === 'codex' ? 'Codex' : 'Claude Code'}, ${s.mode === 'app' ? 'in the app' : 'in a window'}), open since ${formatDateTime(s.started)}.`)],
  ];
  const text = `## The project's open matters, ${when}

Work already done or under way may not be on the main branch of the current folder yet: a delivery waiting for ${owner} lives on its own branch or pull request. When ${owner} asks to carry on with a subject, look for it here first, and say where it stands.

${sections.map(([title, lines]) => `${title}\n${lines.length ? lines.join('\n') : none}`).join('\n\n')}`;
  return text.length > MATTERS_MAX ? `${text.slice(0, MATTERS_MAX - 1)}…` : text;
}

// ---------- The conversation's turns ----------

// The agent in charge reads; it never changes anything, runs commands or starts other agents.
export const CHARGE_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'TodoWrite'];
const CHARGE_REFUSED = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Bash', 'Agent', 'Task'];

/** The folder of the conversation: your clone of the project, else the crew's working copy (only read here). */
export function chargeFolder(projectId, clone) {
  if (clone) return clone;
  const copy = path.join(WORKSPACES, projectId);
  if (existsSync(copy)) return copy;
  throw new Error(t('{project} has no copy on this computer yet: set "local_clone", or let the crew run it once.', { project: projectId }));
}

/**
 * What one turn of the conversation gets: { system, model, tools, disallowed, addDirs }. The system prompt is built
 * again every turn, so the project's memory, its open matters and the requests' state are always current. cloneOf(project)
 * finds the other projects' own clones, kept out of reach like their working copies; "sessions" are the live sessions' records.
 */
export function chargeTurn(config, session, { cloneOf = () => null, sessions = [] } = {}) {
  const projectId = session.project;
  const project = config.projects?.[projectId];
  if (!project) throw new Error(t('Unknown project: {id}', { id: projectId }));
  const who = inCharge(config, projectId);
  if (!who) throw new Error(t('{project} has no one in its crew to be in charge.', { project: projectId }));
  const libraries = [...new Set([...(project.library ?? []), ...(project.docs ? [project.docs.split('/')[0]] : [])])]
    .map(id => ({ id, dir: path.join(WORKSPACES, '.library', id) })).filter(l => existsSync(l.dir));
  const access = stepAccess({ config, projectId, project, libraries });
  const others = Object.entries(config.projects ?? {}).filter(([id]) => id !== projectId).map(([, p]) => cloneOf(p)).filter(Boolean);
  const own = path.resolve(session.cwd ?? '');
  const deny = others.filter(dir => path.resolve(dir) !== own).flatMap(dir => denyRules(dir));
  return {
    system: chargeSystem(config, projectId, who, { sessions }),
    requests: chargeRequests(projectId, config.owner || 'the owner'),
    model: who.member.model ?? session.model ?? config.default_model,
    tools: CHARGE_TOOLS,
    disallowed: [...CHARGE_REFUSED, ...access.denied, ...deny],
    addDirs: access.addDirs,
  };
}

/** The instructions of the agent in charge: its role, project, memory and open matters. */
export function chargeSystem(config, projectId, who = inCharge(config, projectId), { sessions = [] } = {}) {
  const owner = config.owner || 'the owner';
  const project = config.projects[projectId];
  const name = project.name ?? projectId;
  const member = who.member;
  // A lead based on the manager doesn't bring the manager's own work (the conversation, the queue, the reviews).
  const parts = (member.instructionParts ?? []).filter(p => p.key !== 'lead-role' && !(member.lead && member.base === 'manager' && ['agent', 'installation'].includes(p.key)));
  const role = `## Your role here: the agent in charge of ${name}, talking with ${owner}

${owner} talks to you directly from the project's page in the Chiefmate app. You are ${member.name ?? member.id}, ${who.lead ? 'the team lead' : 'the main member of the crew'} of the project ${name}, and the one in charge of it in this conversation. The instructions above describe your usual work in the crew; here you talk, answer questions and plan with ${owner}, in ${languageName(config.language || 'en')}, and you carry out nothing yourself. Ignore what they say about editing, committing, queueing work or Chiefmate's command line.
- You only read: this project's files (the current folder), its documentation and the web. You have no shell and cannot edit, commit, push or publish anything; never ask for it, and don't try another way.
- You see only this project. Other projects' files are out of reach: don't look for them.
- When there is something to do (a change, a fix, research, a text), don't do it: agree on it with ${owner}, then send a request to the manager (Chiefmate). Say in one line that you are sending it and what happens next. Send it by ending your message with this block (one request per message):
~~~manager-request
{"asked": "what ${owner} asked, in their words", "plan": "what you intend to do: who in the crew, where (files, pages) and how", "size": "S | M | L", "risk": "low | medium | high", "urgency": "now or empty"}
~~~
  Size: S for minutes and a few lines, M for about an hour and a few files, L for hours or many files. Risk: what could break, or reach people, if it goes wrong. "urgency": "now" only when ${owner} said it can be done right away.
- An authorized request becomes work for the crew, which ends in a pull request (or a local branch) that ${owner} approves. Nothing goes live without ${owner}.
- Chiefmate gives you the latest state of your requests in each turn. Don't send the same one twice; when ${owner} asks how one is going, answer from the latest list.
- Be short and plain: the essentials first, no jargon.`;
  const facts = [
    `## The project: ${name}`,
    [project.about, project.site ? `Site: ${project.site}` : '', project.repository ? `Repository: ${project.repository}` : ''].filter(Boolean).join('\n'),
    ...(project.notes ? ['### Notes for the crew', clip(project.notes, 6000)] : []),
  ].filter(Boolean).join('\n\n');
  const memory = readMemory(projectId);
  const memoryText = memory
    ? `## The project's memory (kept by the team lead; read here, never changed)\n\n${memory}`
    : "## The project's memory\n\nNone yet.";
  const matters = mattersText(openMatters(config, projectId, { sessions }), owner);
  return [parts.map(p => p.text).join('').trim(), role, facts, memoryText, matters].filter(Boolean).join('\n\n');
}

/** The request state goes in the turn's input so it also reaches a resumed conversation. */
function chargeRequests(projectId, owner) {
  const lines = projectRequests(projectId, 10).map(r => {
    const target = r.run ? `; run "${r.runTitle ?? r.run}" [open run](#log/${encodeURIComponent(r.run)})${r.runStatus ? ` (${r.merged ? 'merged' : r.runStatus})` : ''}`
      : r.targetProject ? `; project ${r.targetProject} [open project](#project/${encodeURIComponent(r.targetProject)})` : '';
    const managerNote = r.managerNote ? `; the manager: ${r.managerNote}` : '';
    const ownerNote = r.by === 'owner' && r.note ? `; ${owner}: ${r.note}` : '';
    return `- #${r.id}, ${formatDateTime(r.at)}: ${r.status}${managerNote}${ownerNote}${target}. ${clip(r.plan, 200)}`;
  });
  return `## Your requests to the manager, newest first\n\n${lines.join('\n') || 'None yet.'}`;
}
