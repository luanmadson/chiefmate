// The manager's tool gaps: what it tried to do through Chiefmate's command line and found no command for (not what a
// safety rule refused). Each case is recorded in data/manager/gaps.json; when one comes back, it becomes a proposal on
// the planning board for Chiefmate's own project, to create the tool. The manager's situation lists the open ones.
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { clip, DATA, now, readJson, writeJson } from './util.mjs';

// How many times a gap comes up before it becomes a proposal.
export const PROPOSE_AT = 2;
const gapsFile = () => path.join(DATA, 'manager', 'gaps.json');

export function readGaps() {
  const list = readJson(gapsFile(), []);
  return Array.isArray(list) ? list : [];
}

const key = what => String(what ?? '').toLowerCase().replace(/["'`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);

/** Chiefmate's own project in the settings: the id "chiefmate", or the project whose repository is Chiefmate's. */
export function chiefmateProject(config = loadConfig()) {
  const projects = config.projects ?? {};
  if (projects.chiefmate) return 'chiefmate';
  return Object.keys(projects).find(id => /[/:]chiefmate(\.git)?\/?$/i.test(String(projects[id]?.repository ?? ''))) ?? null;
}

/**
 * Records a gap: { what (the missing tool, in a few words), example (the command tried), by }. The second time the
 * same gap comes up, a proposal goes to the planning board (src/planning.mjs) for Chiefmate's project, unless one is
 * already open. Returns the gap.
 */
export async function recordGap({ what, example = '', by = 'manager' } = {}, { config = loadConfig() } = {}) {
  const k = key(what);
  if (!k) throw new Error('Say what was missing.');
  const list = readGaps();
  let gap = list.find(g => g.key === k && g.status !== 'closed');
  if (!gap) {
    gap = { id: list.reduce((n, g) => Math.max(n, g.id), 0) + 1, key: k, what: clip(String(what).trim(), 200), count: 0, first: now(), status: 'open', examples: [], by };
    list.push(gap);
  }
  gap.count += 1;
  gap.last = now();
  if (example) gap.examples = [...new Set([...gap.examples, clip(String(example), 300)])].slice(-5);
  if (gap.count >= PROPOSE_AT && !gap.plan) {
    const project = chiefmateProject(config);
    if (project) {
      const { proposeItem } = await import('./planning.mjs');
      const title = clip(`Manager tool: ${gap.what}`, 60);
      const summary = `The manager needed this ${gap.count} times and Chiefmate has no command for it${gap.examples.length ? ` (tried: ${gap.examples.slice(-2).join('; ')})` : ''}. A command for it keeps the manager from stopping at "I can't".`;
      try {
        gap.plan = proposeItem({ project, title, summary, agent: 'generalist', priority: 'medium', by: 'tool gaps' }).id;
      } catch (error) {
        // Already on the board under the same title: that item is the proposal.
        const same = /#(\d+)/.exec(error.message);
        if (!same) throw error;
        gap.plan = Number(same[1]);
      }
      gap.status = 'proposed';
    } else {
      gap.note = 'No project for Chiefmate in the settings: nothing could be proposed.';
    }
  }
  writeJson(gapsFile(), list);
  return gap;
}

/** Closes a gap (the tool exists now, or it was not one). Returns it. */
export function closeGap(id, note = '') {
  const list = readGaps();
  const gap = list.find(g => g.id === Number(String(id ?? '').replace(/^#/, '')));
  if (!gap) throw new Error(`Gap ${id} not found.`);
  Object.assign(gap, { status: 'closed', closed: now(), ...(note ? { note: clip(note, 200) } : {}) });
  writeJson(gapsFile(), list);
  return gap;
}

/** For the manager's <situation>: the open gaps, or null when there are none. */
export function gapsLine() {
  const open = readGaps().filter(g => g.status !== 'closed');
  if (!open.length) return null;
  const one = g => `#${g.id} ${g.what} (${g.count}x${g.plan ? `, proposed as board item #${g.plan}` : ''})`;
  return `Tool gaps (what you needed and Chiefmate had no command for; "node src/cli.mjs gap close <n>" once solved): ${open.slice(-8).map(one).join('; ')}.`;
}
