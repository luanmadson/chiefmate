// The defects of Chiefmate the agents report on their own ("node src/cli.mjs defect report", or "chat say --defect"):
// an error or failure of Chiefmate or of the communication between agents (a notice that never came, a command that
// failed, outdated information, a missing instruction). Each goes to data/defects.json with who reported it and when;
// the same defect reported again is joined to the open one (a count and the reporters), not recorded twice. A new defect
// is "defect" news for the manager (gathered with the other news, never a message of the owner's); the manager sees the
// open ones in its situation and closes each once its fix is in ("defect close").
import path from 'node:path';
import { formatDateTime } from './i18n.mjs';
import { reportEvent } from './news.mjs';
import { clip, DATA, now, readJson, writeJson } from './util.mjs';

const FILE = () => path.join(DATA, 'defects.json');
const MAX_TEXT = 2000;
const MAX_REPORTERS = 10;
const MAX_KEPT = 300;
// Two reports share at least this much of their words: the same defect.
const SAME = 0.75;

export const readDefects = () => readJson(FILE(), []);
const saveDefects = list => writeJson(FILE(), list.slice(-MAX_KEPT));

// The words that tell a defect apart: without the tag ("[Defect]", "[Defeito]"), accents, case and punctuation.
const words = text => new Set(String(text ?? '')
  .replace(/^\s*\[(defect|defeito)\]\s*/i, '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2));

/** How much two texts share of their words (0 to 1). */
export function likeness(a, b) {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return 0;
  let common = 0;
  for (const w of x) if (y.has(w)) common++;
  return common / (x.size + y.size - common);
}

/** Who sent it, in a few words: the session or the step, the agent and the project. */
export function senderLabel(s) {
  if (!s) return 'an agent';
  const where = s.kind === 'session' ? `live session "${s.name ?? s.id}" [${s.id}]` : s.kind === 'step' ? `step ${s.step ?? '?'} of run ${s.id}${s.name ? ` "${s.name}"` : ''}` : 'an agent';
  return [where, s.agent ? `agent ${s.agent}` : '', s.project ? `project ${s.project}` : '', s.tool ? s.tool : ''].filter(Boolean).join(', ');
}

/**
 * Records a defect an agent reported. sender: { kind, id, step, name, agent, project, tool } (see agentSender in
 * src/manager.mjs). Returns { defect, repeated }: a repeat of an open defect only counts; a new one (or one closed and
 * reported again) is news for the manager.
 */
export function reportDefect(text, sender = null, { config } = {}) {
  const said = clip(String(text ?? '').trim(), MAX_TEXT);
  if (!said) throw new Error('Write the defect: what happened and what was expected.');
  const list = readDefects();
  const at = now();
  const reporter = { ...(sender ?? {}), at };
  const matches = list.filter(d => likeness(d.text, said) >= SAME);
  const same = matches.find(d => d.status === 'open') ?? matches.sort((a, b) => b.last.localeCompare(a.last))[0];
  if (same?.status === 'open') {
    Object.assign(same, { count: (same.count ?? 1) + 1, last: at, reporters: [...(same.reporters ?? []), reporter].slice(-MAX_REPORTERS) });
    saveDefects(list);
    return { defect: same, repeated: true };
  }
  let defect;
  if (same) {
    // Closed, and here again: the fix did not hold.
    defect = Object.assign(same, { status: 'open', reopened: at, count: (same.count ?? 1) + 1, last: at, reporters: [...(same.reporters ?? []), reporter].slice(-MAX_REPORTERS), closed: null, note: null });
  } else {
    defect = { id: list.reduce((max, d) => Math.max(max, d.id), 0) + 1, text: said, status: 'open', first: at, last: at, count: 1, reporters: [reporter] };
    list.push(defect);
  }
  saveDefects(list);
  reportEvent('defect', `${defect.reopened === at ? `Defect #${defect.id}, closed before, reported again` : `New defect #${defect.id}`} by ${senderLabel(sender)}: ${clip(said, 600)}`, { config });
  return { defect, repeated: false };
}

/** Closes a defect once its fix is in. note: what fixed it. */
export function closeDefect(id, note = '', by = 'manager') {
  const list = readDefects();
  const defect = list.find(d => d.id === Number(id));
  if (!defect) throw new Error(`No defect #${id}.`);
  if (defect.status === 'closed') throw new Error(`Defect #${id} is already closed.`);
  Object.assign(defect, { status: 'closed', closed: now(), closedBy: by, note: clip(String(note ?? '').trim(), 500) || null });
  saveDefects(list);
  return defect;
}

export const openDefects = () => readDefects().filter(d => d.status === 'open');

/** The open defects, for the manager's situation; empty when there are none. */
export function defectsLine() {
  const open = openDefects().sort((a, b) => b.last.localeCompare(a.last));
  if (!open.length) return '';
  const one = d => `#${d.id}${d.count > 1 ? ` (reported ${d.count} times)` : ''}, last ${formatDateTime(d.last)} by ${senderLabel(d.reporters?.at(-1))}: ${clip(d.text, 240)}`;
  return `Open defects of Chiefmate, reported by the agents (node src/cli.mjs defect list; close each with node src/cli.mjs defect close <id> --note "<what fixed it>" once its fix is in): ${open.slice(0, 8).map(one).join('; ')}${open.length > 8 ? `; and ${open.length - 8} more` : ''}.`;
}
