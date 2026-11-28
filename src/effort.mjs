// Each agent's effort (how hard Claude works on a step: low, medium, high, xhigh, max), seen and changed from the app
// and the command line. Where it comes from, last wins: the agent's header (agents/<id>.md), the installation's
// crew.<id>.effort, a project crew member's, team lead's or agent of the settings' own (agents.<id>.effort), then
// projects.<id>.effort.<member> (that project only).
// The manager's conversation has its own, chat_effort. Every change is recorded in data/effort-history.jsonl.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { EFFORTS, explicitAgent, loadAgents, loadConfig, projectCrew, projectEfforts, saveConfig } from './config.mjs';
import { DATA, ensureDir, now } from './util.mjs';

export { EFFORTS };
const HISTORY_FILE = path.join(DATA, 'effort-history.jsonl');

/** A level as written by a person: a known level, "default" (back to what comes before), or null. */
export function parseEffort(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (EFFORTS.includes(v)) return v;
  if (['default', 'padrão', 'padrao', 'none', 'auto'].includes(v)) return 'default';
  return null;
}

/**
 * Where a member's effort comes from: project, member (a project crew member, a team lead or an agent of the settings,
 * agents.<id>.effort), installation, agent or none.
 */
export function effortSource(config, projectId, member) {
  if (!member) return 'none';
  if (member.effortFrom === 'project') return 'project';
  if (!member.effort) return 'none';
  if (member.explicit && config.agents?.[member.id]?.effort === member.effort) return 'member';
  const project = config.projects?.[projectId];
  if (member.lead && project?.lead?.effort) return 'member';
  if (member.project && !Array.isArray(project?.crew) && project?.crew?.[member.id]?.effort) return 'member';
  if (config.crew?.[member.base ?? member.id]?.effort === member.effort) return 'installation';
  return 'agent';
}

/** A member's effort now, read again from the settings: a change made during a run counts from its next step. */
export function currentEffort(projectId, memberId, fallback = null) {
  try {
    const member = projectCrew(loadConfig(), projectId)[memberId];
    return member ? member.effort ?? null : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Changes a member's effort. project: that project only (projects.<id>.effort), else the installation (crew.<id>.effort,
 * or agents.<id>.effort for an agent of the settings; chat: the manager's conversation, crew.manager.chat_effort).
 * level "default" removes the setting, so the level that comes before applies again. by: owner, manager. Nothing is
 * saved nor recorded when the level in use stays the same. save and file: for the tests.
 * Returns { at, by, project, member, chat, from, to, asked, changed }.
 */
export function setEffort({ member, level, project = null, chat = false, by = 'owner', config = loadConfig(), save = saveConfig, file = HISTORY_FILE }) {
  const asked = parseEffort(level);
  if (!asked) throw new Error(`Unknown effort "${level}": use ${EFFORTS.join(', ')} or default.`);
  if (chat && member !== 'manager') throw new Error('Only the manager has a conversation effort.');
  if (chat && project) throw new Error("The manager's conversation is the same for every project: leave out --project.");
  if (project && !config.projects?.[project]) throw new Error(`Unknown project: ${project}`);
  const agents = loadAgents(config);
  // An agent of the settings keeps its own level (agents.<id>.effort), even while inactive.
  const own = !project && !chat && !!explicitAgent(config, member, agents);
  const team = project ? projectCrew(config, project, agents, { inactive: true }) : own ? { [member]: explicitAgent(config, member, agents) } : agents;
  if (!team[member]) throw new Error(project ? `${member} is not in the crew of ${project}.` : `Unknown agent: ${member}`);
  const levelIn = (c, a = loadAgents(c)) => (chat ? a.manager.chat_effort ?? a.manager.effort
    : own ? explicitAgent(c, member, a)?.effort : (project ? projectCrew(c, project, a, { inactive: true }) : a)[member]?.effort) ?? null;
  const from = levelIn(config, agents);
  const next = structuredClone(config);
  const field = chat ? 'chat_effort' : 'effort';
  if (project) {
    const map = { ...projectEfforts(next, project) };
    if (asked === 'default') delete map[member];
    else map[member] = asked;
    if (Object.keys(map).length) next.projects[project].effort = map;
    else delete next.projects[project].effort;
  } else if (own) {
    if (asked === 'default') delete next.agents[member].effort;
    else next.agents[member].effort = asked;
  } else {
    next.crew ??= {};
    const spec = { ...(next.crew[member] ?? {}) };
    if (asked === 'default') delete spec[field];
    else spec[field] = asked;
    if (Object.keys(spec).length) next.crew[member] = spec;
    else delete next.crew[member];
  }
  const to = levelIn(next);
  const entry = { at: now(), by, project, member, chat: !!chat, from, to, asked };
  if (from !== to) {
    save(next);
    ensureDir(path.dirname(file));
    appendFileSync(file, `${JSON.stringify(entry)}\n`);
  }
  return { ...entry, changed: from !== to };
}

/** The recorded changes, oldest first. project: those that reach it (its own and the installation's). from/until: ISO dates. */
export function effortHistory({ project, from, until, file = HISTORY_FILE } = {}) {
  if (!existsSync(file)) return [];
  const list = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    try {
      if (line.trim()) list.push(JSON.parse(line));
    } catch {
      // a broken line is skipped
    }
  }
  return list.filter(e => (project === undefined || !e.project || e.project === project) && (!from || e.at >= from) && (!until || e.at <= until));
}

/** The changes made while a run went on (from its start to its end, or now), that reach its project. */
export const runEffortChanges = (run, file = HISTORY_FILE) =>
  run?.started ? effortHistory({ project: run.project, from: run.started, until: run.ended ?? undefined, file }) : [];

/** One change in words, for the reports and the command line. */
export function effortChangeLine(e) {
  const who = e.chat ? `${e.member} (conversation)` : e.member;
  return `${new Date(e.at).toLocaleString('sv-SE').slice(0, 16)} ${e.by}: ${who}${e.project ? ` in ${e.project}` : ''}, ${e.from ?? 'default'} → ${e.to ?? 'default'}`;
}
