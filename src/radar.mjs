// The project radar: ideas for new systems and sites with high potential, kept in data/radar.json. They belong to no
// project: they are Chiefmate's own. The crew (a weekly mission, the manager) researches and adds them, with sources;
// the owner decides: "I want this" (chosen: a proposal on the planning board for the manager to turn into a project),
// "later" (studying) or "discard". The manager marks it "project" once the new project exists.
import path from 'node:path';
import { planItems, proposeItem } from './planning.mjs';
import { clip, DATA, now, readJson, writeJson } from './util.mjs';

const RADAR_FILE = path.join(DATA, 'radar.json');

export const RADAR_STATUSES = ['new', 'studying', 'chosen', 'discarded', 'project'];
// The planning board's project for the chosen ideas, until the manager creates the real one and moves the item there.
export const RADAR_PROJECT = 'radar';
const SCORES = ['potential', 'effort', 'risk'];
const TEXTS = { summary: 300, problem: 1000, audience: 600 };
const FUNDAMENTALS = ['market', 'trend', 'revenue', 'advantage', 'risks'];

const plain = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

const STATUS_WORDS = {
  new: ['new', 'nova', 'novo'],
  studying: ['studying', 'study', 'later', 'em estudo', 'estudo', 'depois'],
  chosen: ['chosen', 'choose', 'escolhida', 'escolhido', 'quero este'],
  discarded: ['discarded', 'discard', 'descartada', 'descartado'],
  project: ['project', 'became a project', 'virou projeto', 'projeto'],
};

/** "em estudo", "new", "virou projeto": the status's key, or an error listing the valid ones. */
export function parseRadarStatus(text) {
  const s = plain(text);
  for (const [key, words] of Object.entries(STATUS_WORDS)) if (words.includes(s)) return key;
  throw new Error(`Unknown radar status "${text}". Use: ${RADAR_STATUSES.join(', ')}.`);
}

/** Only http(s) addresses: anything else (javascript:, file:) would become a link in the app. */
function webUrl(text) {
  const url = String(text ?? '').trim();
  if (!url) return '';
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid address "${clip(url, 80)}": use a full http(s) link.`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`Invalid address "${clip(url, 80)}": only http(s) links.`);
  return parsed.href.slice(0, 500);
}

/**
 * A list of links: [{ name, url }], or texts "Name https://..." (the address last). A text with no address keeps
 * only the name (a competitor without a site).
 */
function links(list, { needUrl = false } = {}) {
  return (Array.isArray(list) ? list : [list]).filter(x => x != null && x !== '').slice(0, 12).map(x => {
    let name;
    let url;
    if (typeof x === 'object') [name, url] = [x.name ?? x.title, x.url];
    else {
      const m = /^(.*?)\s*(https?:\/\/\S+)\s*$/.exec(String(x).trim());
      [name, url] = m ? [m[1], m[2]] : [x, ''];
    }
    const link = { name: clip(String(name ?? '').replace(/[\s:|–—-]+$/, ''), 120), url: webUrl(url) };
    if (needUrl && !link.url) throw new Error(`"${clip(String(x?.name ?? x), 80)}" has no http(s) address: every source needs its link.`);
    if (!link.name) link.name = link.url ? new URL(link.url).hostname : '';
    return link;
  }).filter(l => l.name || l.url);
}

function score(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 5) throw new Error(`The ${name} score is a whole number from 1 to 5 (got "${value}").`);
  return n;
}

/** The trend: [{ label, value }] or "2024:40,2025:55" (a search index, a count by period), oldest first. */
function series(value) {
  const list = Array.isArray(value)
    ? value
    : String(value ?? '').split(/[,;]/).map(x => x.trim()).filter(Boolean).map(x => {
      const i = x.lastIndexOf(':');
      return { label: x.slice(0, i), value: x.slice(i + 1) };
    });
  return list.slice(0, 24).map(p => {
    const v = Number(p?.value);
    if (!p?.label || !Number.isFinite(v)) throw new Error('The trend series is "label:value" pairs, such as "2024:40,2025:55".');
    return { label: clip(String(p.label), 20), value: v };
  });
}

export function readRadar() {
  const radar = readJson(RADAR_FILE, null);
  return radar && Array.isArray(radar.ideas) ? radar : { next: 1, ideas: [] };
}
const saveRadar = radar => writeJson(RADAR_FILE, radar);

// The radar's order: the highest potential first, then the smallest effort, the smallest risk and the newest.
export const byPotential = (a, b) =>
  b.scores.potential - a.scores.potential || a.scores.effort - b.scores.effort || a.scores.risk - b.scores.risk || (b.created ?? '').localeCompare(a.created ?? '') || a.id - b.id;

/** Every idea, in the radar's order. */
export const radarIdeas = () => [...readRadar().ideas].sort(byPotential);

function findIn(radar, id) {
  const idea = radar.ideas.find(i => i.id === Number(String(id ?? '').replace(/^#/, '')));
  if (!idea) throw new Error(`Idea ${id} not found on the radar.`);
  return idea;
}
export const radarIdea = id => findIn(readRadar(), id);

/** Checks and applies the fields given (only those present). */
function applyFields(idea, fields) {
  const has = key => fields[key] !== undefined && fields[key] !== null;
  if (has('title')) idea.title = clip(fields.title, 80);
  for (const [key, max] of Object.entries(TEXTS)) if (has(key)) idea[key] = String(fields[key]).trim().slice(0, max);
  const given = { ...(fields.fundamentals ?? {}), ...Object.fromEntries(FUNDAMENTALS.filter(has).map(k => [k, fields[k]])) };
  for (const key of FUNDAMENTALS) if (given[key] != null) idea.fundamentals[key] = String(given[key]).trim().slice(0, 1500);
  if (has('competitors') || fields.fundamentals?.competitors) idea.fundamentals.competitors = links(fields.competitors ?? fields.fundamentals.competitors);
  const scores = fields.scores ?? {};
  for (const key of SCORES) if (has(key) || scores[key] != null) idea.scores[key] = score(fields[key] ?? scores[key], key);
  if (has('sources')) idea.sources = links(fields.sources, { needUrl: true });
  if (has('series')) idea.series = series(fields.series);
  if (has('status')) {
    const status = parseRadarStatus(fields.status);
    if (status === 'discarded' && idea.status !== 'discarded') idea.discarded_at = now();
    if (status !== 'discarded') Object.assign(idea, { discarded_at: null, discard_reason: '' });
    idea.status = status;
  }
  if (has('reason')) idea.discard_reason = clip(fields.reason, 200);
  if (has('project')) idea.project = clip(fields.project, 60) || null;
}

/**
 * A new idea: { title, summary, problem, audience, market, competitors, trend, revenue, advantage, risks, potential,
 * effort, risk, sources, series }. Refused without the scores or a source with its link, or when an idea with the same
 * title is already on the radar (discarded ones too: they are not proposed again).
 */
export function addIdea(fields = {}, by = 'owner') {
  const radar = readRadar();
  const name = plain(fields.title);
  if (!name) throw new Error('The title is missing.');
  const same = radar.ideas.find(i => plain(i.title) === name);
  if (same) throw new Error(`Already on the radar as #${same.id} (${same.status}): update that idea instead (radar set ${same.id} ...).`);
  const stamp = now();
  const idea = {
    id: radar.next, title: '', summary: '', problem: '', audience: '',
    fundamentals: { market: '', competitors: [], trend: '', revenue: '', advantage: '', risks: '' },
    scores: {}, sources: [], series: [], status: 'new', created: stamp, updated: stamp, by: clip(by, 60) || 'owner',
    plan: null, project: null, discarded_at: null, discard_reason: '',
  };
  applyFields(idea, { ...fields, status: fields.status ?? 'new' });
  if (!idea.summary) throw new Error('The one-sentence summary is missing (--summary).');
  const missing = SCORES.filter(k => !idea.scores[k]);
  if (missing.length) throw new Error(`Give the scores from 1 to 5: ${missing.map(k => `--${k}`).join(', ')}.`);
  if (!idea.sources.length) throw new Error('An idea needs at least one source with its link (--source "Name https://...").');
  radar.ideas.push(idea);
  radar.next = idea.id + 1;
  saveRadar(radar);
  return idea;
}

export function updateIdea(id, fields = {}) {
  const radar = readRadar();
  const idea = findIn(radar, id);
  if (fields.title !== undefined) {
    const name = plain(fields.title);
    if (!name) throw new Error('The title is missing.');
    const same = radar.ideas.find(i => i !== idea && plain(i.title) === name);
    if (same) throw new Error(`Another idea has this title: #${same.id}.`);
  }
  applyFields(idea, fields);
  if (idea.sources.length === 0) throw new Error('An idea needs at least one source with its link.');
  idea.updated = now();
  saveRadar(radar);
  return idea;
}

/** The planning item of a chosen idea: what the manager does to turn it into a project. */
function planText(idea) {
  const f = idea.fundamentals;
  return [
    `The owner chose radar idea #${idea.id} (node src/cli.mjs radar show ${idea.id}): ${idea.summary}`,
    idea.problem ? `Problem and audience: ${idea.problem}${idea.audience ? ` (${idea.audience})` : ''}` : '',
    `Scores: potential ${idea.scores.potential}/5, effort ${idea.scores.effort}/5, risk ${idea.scores.risk}/5.${f.revenue ? ` Revenue: ${f.revenue}` : ''}`,
    `Turn it into a project: plan its first version with the owner, create its repository and add it to the settings; then move this item to it (plan set <n> --project <id>) and mark the idea (radar set ${idea.id} --status project --project <id>).`,
  ].filter(Boolean).join('\n');
}

/**
 * The owner's decision: "choose" (I want this: a proposal on the planning board, under the project "radar", for the
 * manager to turn into a project), "later" (studying), "discard" (with an optional reason) or "restore" (back to new).
 */
export function decideIdea(id, decision, { reason, by = 'owner' } = {}) {
  const radar = readRadar();
  const idea = findIn(radar, id);
  const stamp = now();
  if (decision === 'choose') {
    if (['chosen', 'project'].includes(idea.status)) throw new Error(`Idea #${idea.id} is already ${idea.status === 'chosen' ? 'chosen' : 'a project'}.`);
    // Its earlier item, when it is still on the board and not discarded; else a new one.
    const earlier = idea.plan && planItems().find(i => i.id === idea.plan && i.status !== 'discarded' && !i.archived);
    if (!earlier) {
      const item = proposeItem({ project: RADAR_PROJECT, title: clip(`New project from the radar: ${idea.title}`, 200), summary: planText(idea), agent: 'manager', priority: 'high', by });
      idea.plan = item.id;
    }
    Object.assign(idea, { status: 'chosen', chosen_at: stamp, discarded_at: null, discard_reason: '' });
  } else if (decision === 'later') {
    if (!['new', 'discarded'].includes(idea.status)) throw new Error(`Idea #${idea.id} is ${idea.status}: only new or discarded ideas wait for later.`);
    Object.assign(idea, { status: 'studying', later_at: stamp, discarded_at: null, discard_reason: '' });
  } else if (decision === 'discard') {
    if (idea.status === 'discarded') throw new Error(`Idea #${idea.id} is already discarded.`);
    if (idea.status === 'project') throw new Error(`Idea #${idea.id} is already a project.`);
    Object.assign(idea, { status: 'discarded', discarded_at: stamp, discard_reason: clip(reason, 200) || '' });
  } else if (decision === 'restore') {
    if (idea.status !== 'discarded') throw new Error(`Idea #${idea.id} is not discarded.`);
    Object.assign(idea, { status: 'new', discarded_at: null, discard_reason: '' });
  } else throw new Error(`Unknown decision "${decision}". Use: choose, later, discard, restore.`);
  idea.updated = stamp;
  saveRadar(radar);
  return idea;
}

/** The app's commands: { action: add | set | choose | later | discard | restore, id, ...fields }. */
export function changeRadar(body = {}) {
  const { action, id, reason, by, ...fields } = body;
  switch (action) {
    case 'add':
      return addIdea(fields, by);
    case 'set':
      return updateIdea(id, { ...fields, ...(reason !== undefined ? { reason } : {}) });
    case 'choose':
    case 'later':
    case 'discard':
    case 'restore':
      return decideIdea(id, action, { reason, by });
    default:
      throw new Error('Unknown radar action.');
  }
}

/** The manager's line: how many new ideas wait for the owner, the chosen ones to turn into projects. */
export function radarLine(owner = 'the owner') {
  const ideas = radarIdeas();
  if (!ideas.length) return 'Project radar (node src/cli.mjs radar): no ideas yet (a weekly mission researches them; radar add ... to add one).';
  const of = status => ideas.filter(i => i.status === status);
  const short = i => `#${i.id} ${clip(i.title, 60)} (potential ${i.scores.potential}, effort ${i.scores.effort}, risk ${i.scores.risk})`;
  const parts = [`Project radar (node src/cli.mjs radar): ${of('new').length} new idea(s) waiting for ${owner}${of('new').length ? `: ${of('new').slice(0, 5).map(short).join('; ')}` : ''}`];
  if (of('studying').length) parts.push(`${of('studying').length} in study`);
  if (of('chosen').length) parts.push(`chosen by ${owner}, to turn into projects: ${of('chosen').map(i => `${short(i)}${i.plan ? `, planning item #${i.plan}` : ''}`).join('; ')}`);
  return `${parts.join('. ')}.`;
}
