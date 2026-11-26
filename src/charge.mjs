// The agent in charge of a project: the one the owner talks to directly, from the project's page ("Talk to the agent
// in charge"). It is the project's team lead when it has one, else the main member of the project's crew. The
// conversation is a live session in the app (src/sessions.mjs) with a profile of its own, "project-<id>-charge": it
// carries the project's memory and context, and only this project's. The agent in charge talks, answers and plans,
// but changes nothing: it reads only (no shell, no editing). When there is something to do, it ends its message with a
// ~~~manager-request block; Chiefmate records the request (data/manager/owner-requests.json), shows it on the
// project's page and tells the manager ("owner_request" news). The manager answers with "cli.mjs request <id>
// approve|hold|ask-owner|reject": approve queues the work for the project (an "ask" for a team lead, else a task with
// the manager's review), hold leaves it waiting with the reason, ask-owner turns it into a card in Decisions, reject
// refuses it. Each answer goes back to the conversation, and the agent reads its requests' state in every turn.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { denyRules, stepAccess } from './access.mjs';
import { loadAgents, loadConfig, projectCrew } from './config.mjs';
import { formatDateTime, t } from './i18n.mjs';
import { LEAD, readMemory, taskTakers } from './leads.mjs';
import { reportEvent } from './news.mjs';
import { readRun } from './store.mjs';
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
/** pending (with the manager), approved, waiting (on hold), owner (a card in Decisions), rejected. */
export const REQUEST_STATUSES = ['pending', 'approved', 'waiting', 'owner', 'rejected'];
const ACTIONS = { approve: 'approved', hold: 'waiting', 'ask-owner': 'owner', reject: 'rejected' };
const FINAL = ['approved', 'rejected'];

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
  reportEvent('owner_request', `${r.memberName ?? 'The agent in charge'}, in charge of ${config.projects[project].name ?? project}, sends you request #${r.id} from its conversation with ${owner}. ${owner} asked: "${clip(r.asked, 300)}". It intends to: ${clip(r.plan, 500)}. Size ${sizeWords[r.size]}, risk ${r.risk}${r.urgency ? `; ${owner} said it can be done now` : ''}. Answer it with node src/cli.mjs request ${r.id} approve|hold|ask-owner|reject --note "<why, one line>" --level 1|2|3.`, { config });
  return r;
}

/** A project's requests, newest first, each with its run's title and status when it was approved. */
export function projectRequests(projectId, limit = 12) {
  return readRequests().filter(r => r.project === projectId).reverse().slice(0, limit).map(r => {
    const run = r.run ? readRun(r.run) : null;
    return { ...r, history: undefined, runTitle: run?.title ?? null, runStatus: run?.status ?? null, merged: !!run?.merged };
  });
}

/** What the manager reads of an answer, or the owner's question card says. */
const describe = r => `request #${r.id} of ${r.project} ("${clip(r.plan, 120)}")`;

/**
 * The manager's answer (or the owner's, from the card of an "ask-owner"): approve | hold | ask-owner | reject, with a
 * note (required to hold or reject). approve queues the work, linked to the request (the caller nudges the queue); ask-owner adds a question card.
 * The level (1 to 3) is the approval level its decision card shows; kept on the request, so the owner's "Authorize" passes it on.
 * The answer goes back to the conversation with the agent in charge. Returns { request, run, question }.
 */
export async function answerRequest(id, action, { note = '', by = 'manager', recommend = null, title = null, summary = null, level = null } = {}, config = loadConfig()) {
  const status = ACTIONS[action];
  if (!status) throw new Error(t('Answer with approve, hold, ask-owner or reject.'));
  const list = readRequests();
  const r = list.find(x => x.id === Number(String(id).replace(/^#/, '')));
  if (!r) throw new Error(t('Request {id} not found.', { id }));
  if (FINAL.includes(r.status)) throw new Error(t('Request {id} was already answered: {status}.', { id: r.id, status: r.status }));
  // Taken to the owner: their card decides it, not another answer of the manager's.
  if (r.status === 'owner' && by !== 'owner') throw new Error(t('Request {id} waits for the owner in Decisions.', { id: r.id }));
  const why = clip(note, 600);
  const approval = level == null || level === '' ? r.level ?? null : parseLevel(level);
  if (!why && by === 'manager' && ['hold', 'reject', 'ask-owner'].includes(action)) throw new Error(t('Say why, with --note "<one line>".'));
  const owner = config.owner || 'the owner';
  let run = null;
  let question = null;
  if (action === 'approve') {
    const who = inCharge(config, r.project);
    if (!who) throw new Error(t('{project} has no one in its crew to be in charge.', { project: r.project }));
    const instruction = [
      r.plan,
      `What ${owner} asked the agent in charge of the project (request #${r.id}): ${r.asked}`,
      ...(why ? [`The manager's note: ${why}`] : []),
    ].join('\n\n');
    const { createRun } = await import('./runs.mjs');
    run = createRun(who.lead
      ? { kind: 'ask', projectId: r.project, instruction, origin: 'owner-request', request: r.id, title, summary, level: approval }
      : { kind: 'task', projectId: r.project, agent: who.member.id, instruction, review: true, origin: 'owner-request', request: r.id, title, summary, level: approval });
    r.run = run.id;
  } else if (action === 'ask-owner') {
    const { addQuestion } = await import('./decisions.mjs');
    const choice = { approve: t('Authorize'), hold: t('Wait'), reject: t('Refuse') }[word(recommend)] ?? null;
    question = addQuestion({
      question: clip(t('Authorize: {plan}?', { plan: clip(r.plan, 200) }), 300),
      context: [
        t('{owner} asked the agent in charge: {asked}', { owner, asked: clip(r.asked, 500) }),
        `${sizeText()[r.size]}, ${riskText()[r.risk].toLowerCase()}.`,
        ...(why ? [t("The manager's note: {note}", { note: why })] : []),
      ].join('\n'),
      options: [t('Authorize'), t('Wait'), t('Refuse')], recommend: choice, project: r.project, level: approval, request: r.id,
    }, config);
    r.question = question.id;
  }
  Object.assign(r, { status, note: why, answered_at: now(), by, level: approval });
  r.history = [...(r.history ?? []), { at: now(), action, by, note: why }];
  saveRequests(list);
  if (r.session) {
    const { noteSession } = await import('./sessions.mjs');
    noteSession(r.session, answerLine(r, owner), { kind: 'request', request: r.id, status });
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
  return `Requests from the agents in charge of the projects, sent from their conversations with ${config.owner || 'the owner'} (answer with node src/cli.mjs request <id> approve|hold|ask-owner|reject --note "..." --level 1|2|3; node src/cli.mjs request show <id> for the whole request): ${open.slice(0, 8).map(line).join('; ')}.`;
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
 * again every turn, so the project's memory and the requests' state are always current. cloneOf(project) finds the
 * other projects' own clones, kept out of reach like their working copies.
 */
export function chargeTurn(config, session, { cloneOf = () => null } = {}) {
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
    system: chargeSystem(config, projectId, who),
    model: who.member.model ?? session.model ?? config.default_model,
    tools: CHARGE_TOOLS,
    disallowed: [...CHARGE_REFUSED, ...access.denied, ...deny],
    addDirs: access.addDirs,
  };
}

/** The instructions of the agent in charge: its own (not the manager's work), its role here, the project, the memory, the requests. */
export function chargeSystem(config, projectId, who = inCharge(config, projectId)) {
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
- When there is something to do (a change, a fix, research, a text), don't do it: agree on it with ${owner}, then send a request to the manager (Chiefmate), who authorizes it, asks to wait, or takes it to ${owner} as a decision. Say in one line that you are sending it and what happens next. Send it by ending your message with this block (one request per message):
~~~manager-request
{"asked": "what ${owner} asked, in their words", "plan": "what you intend to do: who in the crew, where (files, pages) and how", "size": "S | M | L", "risk": "low | medium | high", "urgency": "now or empty"}
~~~
  Size: S for minutes and a few lines, M for about an hour and a few files, L for hours or many files. Risk: what could break, or reach people, if it goes wrong. "urgency": "now" only when ${owner} said it can be done right away.
- An authorized request becomes work for the crew, which ends in a pull request (or a local branch) that ${owner} approves. Nothing goes live without ${owner}.
- Your requests and their state are below, current at every message. Don't send the same one twice; when ${owner} asks how one is going, answer from there.
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
  const requests = readRequests().filter(r => r.project === projectId).slice(-10).reverse();
  const requestText = `## Your requests to the manager, newest first\n\n${requests.length ? requests.map(r => {
    const run = r.run ? readRun(r.run) : null;
    return `- #${r.id}, ${formatDateTime(r.at)}: ${r.status}${r.note ? ` (${r.by === 'owner' ? owner : 'the manager'}: ${r.note})` : ''}${run ? `; its run "${run.title}" is ${run.merged ? 'merged' : run.status}` : ''}. ${clip(r.plan, 200)}`;
  }).join('\n') : 'None yet.'}`;
  return [parts.map(p => p.text).join('').trim(), role, facts, memoryText, requestText].filter(Boolean).join('\n\n');
}
