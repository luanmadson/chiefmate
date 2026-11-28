// Short, plain words for the owner: each run's title and summary, and the final summary of each step and run
// ("What was done", "What changes for you", "Needs you?"). Titles, summaries and a run's final summary come from the
// lightest model ("quick_model", Haiku by default: one short call, no tools), with the instruction's first sentence
// (or the steps' own summaries) when it is off or fails.
import path from 'node:path';
import { runClaude } from './claude.mjs';
import { t } from './i18n.mjs';
import { clip, DATA, ensureDir, languageName } from './util.mjs';

export const TITLE_MAX = 60;

/** The model of the short calls: "quick_model" in the settings ("haiku" when missing); false or "" turns them off. */
export const quickModel = config => (config.quick_model === undefined ? 'haiku' : config.quick_model || null);

const plain = text => String(text ?? '')
  .replace(/```[\s\S]*?```/g, ' ')
  .replace(/^\s*(#+|[-*>]|\d+[.)])\s+/gm, '')
  .replace(/[*_`]/g, '')
  .trim();

/** The first sentence of a text (its first line, at most), without markdown. */
export function firstSentence(text) {
  const line = plain(text).split(/\n/).map(x => x.trim()).find(Boolean) ?? '';
  const end = line.search(/[.!?](\s|$)/);
  return end > 0 ? line.slice(0, end + 1).trim() : line;
}

/** A title from a text: its first sentence, cut at a word to TITLE_MAX characters. */
export function shortTitle(text, size = TITLE_MAX) {
  const flat = firstSentence(text).replace(/[.!?]$/, '').replace(/\s+/g, ' ');
  if (flat.length <= size) return flat;
  const cut = flat.slice(0, size - 1);
  return `${cut.slice(0, cut.lastIndexOf(' ') > size / 2 ? cut.lastIndexOf(' ') : cut.length).replace(/[\s,;:–-]+$/, '')}…`;
}

/** A summary from a text: its first one or two sentences, short. */
export function shortSummary(text) {
  const flat = plain(text).replace(/\s+/g, ' ');
  const sentences = flat.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [flat];
  let out = sentences[0].trim();
  if (out.length < 90 && sentences[1]) out = `${out} ${sentences[1].trim()}`;
  return clip(out, 220);
}

// The short calls go one at a time: a burst of new (or old) runs never starts many processes at once.
let chain = Promise.resolve();

/** One short call to the quick model, with no tools. Returns its text, or null (off, missing, failed). */
export function askQuick(prompt, config) {
  const model = quickModel(config);
  if (!model) return Promise.resolve(null);
  const call = async () => {
    const r = await runClaude({
      dir: ensureDir(path.join(DATA, 'quick')), prompt, model, noTools: true, tools: [], disallowed: [], maxMinutes: 2,
      attribution: config.attribution !== false,
    }).promise;
    return r.ok && r.text.trim() ? r.text.trim() : null;
  };
  const next = chain.then(call, call);
  chain = next.catch(() => null);
  return next.catch(() => null);
}

/** The JSON object in a model's answer (it may come inside a code fence), or null. */
export function jsonIn(text) {
  const s = String(text ?? '');
  const from = s.indexOf('{');
  const to = s.lastIndexOf('}');
  if (from < 0 || to <= from) return null;
  try {
    return JSON.parse(s.slice(from, to + 1));
  } catch {
    return null;
  }
}

/**
 * A run's title and summary from the quick model: { title, summary }, or null. what: the instruction (or the mission's
 * steps); project: its name.
 */
export async function generateBrief({ what, project, config }) {
  const lang = languageName(config.language || 'en');
  const prompt = [
    `An AI agent crew is about to work on the project "${project}". Write a title and a summary of this work for the project's owner, an administrator who must understand it in seconds.`,
    `Reply with JSON only: {"title": "...", "summary": "..."}, both in plain ${lang}, with no jargon.`,
    `- title: at most ${TITLE_MAX} characters, saying what will be done. When the work is about one part of the project, start with that part, as in "Prompt builder: read from the library and highlight blocks". No agent names, no quotes, no final period.`,
    '- summary: one or two short sentences: what it is and why.',
    '',
    'The work:',
    '"""',
    clip(what, 6000),
    '"""',
  ].join('\n');
  const data = jsonIn(await askQuick(prompt, config));
  const title = clip(data?.title, TITLE_MAX + 10).replace(/^["']|["'.]$/g, '');
  const summary = clip(data?.summary, 300);
  return title && summary ? { title, summary } : null;
}

// ---------- The final summary ----------

/** The final summary's headings, in a language. */
export const outcomeLabels = lang => ({
  done: t('What was done', {}, lang), change: t('What changes for you', {}, lang), needs: t('Needs you?', {}, lang), full: t('Full report', {}, lang),
});

/** How a report starts: the final summary's block, to fill in (for the crew's rules and the final review). */
export function outcomeTemplate(lang) {
  const l = outcomeLabels(lang);
  return [`### ${l.done}`, '- (up to 3 short items)', `### ${l.change}`, '(one sentence)', `### ${l.needs}`, `(${t('No', {}, lang)}, or ${t('Yes', {}, lang)}: what)`, `### ${l.full}`, '(the rest of the report)'].join('\n');
}

/** A final summary as markdown, in a language. */
export function outcomeMarkdown(outcome, lang) {
  if (!outcome) return '';
  const l = outcomeLabels(lang);
  return [
    `### ${l.done}`, ...(outcome.done.length ? outcome.done.map(d => `- ${d}`) : ['- —']), '',
    `### ${l.change}`, outcome.change || '—', '',
    `### ${l.needs}`, outcome.needs ? `${t('Yes', {}, lang)}: ${outcome.needs}` : t('No', {}, lang),
  ].join('\n');
}

/** A step's report whole: its final summary (kept apart, in step.outcome) and the rest. */
export const fullReport = step => (step.outcome ? `${outcomeMarkdown(step.outcome, step.outcome.lang)}\n\n${step.report ?? ''}`.trim() : step.report);

/** One line of a final summary, for a notification or the manager: what changes, and what the owner must do. */
export const outcomeLine = (outcome, lang) => [outcome?.change, outcome?.needs ? t('Needs you: {what}', { what: outcome.needs }, lang) : ''].filter(Boolean).join(' ');

/** The verdict's headings: the manager's final review, or a team lead's in a delegated review (src/leads.mjs). */
const VERDICTS = { manager: "Manager's verdict", lead: "Team lead's verdict" };

/**
 * The verdict section of the text that goes to the owner (a pull request's, or the note of a branch), in English or
 * Portuguese: { text, by ('manager' or 'lead') }, or null when it has none.
 */
export function verdictIn(text) {
  const source = String(text ?? '');
  for (const [by, title] of Object.entries(VERDICTS)) {
    const titles = [...new Set(['en', 'pt-BR'].map(lang => t(title, {}, lang)))].map(s => s.replace(/[.*+?^${}()|[\]\\']/g, '\\$&'));
    const found = source.match(new RegExp(`^(#+)\\s*(?:${titles.join('|')})\\s*$`, 'im'));
    if (!found) continue;
    const after = source.slice(found.index + found[0].length);
    const end = after.search(new RegExp(`^#{1,${found[1].length}}\\s`, 'm'));
    const body = clip((end < 0 ? after : after.slice(0, end)).trim(), 1200);
    if (body) return { text: body, by };
  }
  return null;
}

const key = s => String(s ?? '').toLowerCase().replace(/[#*_:`\s]+/g, ' ').trim();
/** "Needs you?" as text: null for no, else what the owner must do. */
function needsOf(text) {
  const s = plain(text).replace(/\s+/g, ' ').trim();
  if (!s || /^[—-]+$/.test(s) || /^(no|não|nao|nada|nothing|none|nenhum|nenhuma)\b/i.test(s)) return null;
  return clip(s.replace(/^(yes|sim)\b\s*[:,.–-]?\s*/i, ''), 300) || clip(s, 300);
}

/** A clean final summary from loose fields (the model's JSON or a parsed report), or null. */
export function cleanOutcome(o) {
  if (!o) return null;
  const done = (Array.isArray(o.done) ? o.done : String(o.done ?? '').split('\n')).map(x => clip(plain(x), 160)).filter(Boolean).slice(0, 3);
  const change = clip(plain(o.change), 300);
  const needs = typeof o.needs === 'object' && o.needs ? (o.needs.yes ? clip(o.needs.what || '', 300) || '?' : null) : needsOf(o.needs);
  return done.length || change ? { done, change, needs } : null;
}

/**
 * The final summary at the top of a report: { outcome, rest }. It is found by its headings in any of the languages
 * given (English always); without them, outcome is null and rest is the whole text.
 */
export function parseOutcome(text, langs = []) {
  const source = String(text ?? '');
  const sets = [...new Set([...langs.filter(Boolean), 'en'])].map(outcomeLabels);
  const lines = source.split(/\r?\n/);
  const heading = line => {
    const m = line.match(/^\s*(#{1,6}\s*|\*\*)(.+?)(\*\*)?\s*:?\s*(\*\*)?\s*$/);
    if (!m) return null;
    const k = key(m[2]);
    for (const l of sets) for (const field of ['done', 'change', 'needs', 'full']) if (k === key(l[field])) return field;
    return /^#{1,6}/.test(line.trim()) ? 'other' : null;
  };
  const found = {};
  let current = null;
  let end = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = heading(line);
    if (h === 'full') {
      end = i + 1;
      break;
    }
    if (h && h !== 'other') {
      if (found[h] !== undefined) break;
      current = h;
      found[h] = [];
      end = i + 1;
      continue;
    }
    if (h === 'other') {
      if (current) break;
      continue; // a heading before the summary (the report's own title)
    }
    if (!line.trim()) {
      // "What changes" and "Needs you?" are one paragraph each: the text after it is the report.
      if (current && current !== 'done' && found[current]?.length) current = 'closed';
      continue;
    }
    if (!current || current === 'closed') break;
    if (current === 'done' && !/^\s*([-*]|\d+[.)])\s+/.test(line)) break;
    found[current].push(line);
    end = i + 1;
  }
  if (!found.done && !found.change) return { outcome: null, rest: source };
  const outcome = cleanOutcome({
    done: (found.done ?? []).filter(x => x.trim()).map(x => x.replace(/^\s*([-*]|\d+[.)])\s*/, '')),
    change: (found.change ?? []).join(' '),
    needs: (found.needs ?? []).join(' '),
  });
  return outcome ? { outcome, rest: lines.slice(end).join('\n').replace(/^\s+/, '') } : { outcome: null, rest: source };
}

/**
 * A run's final summary from the quick model, from what its steps reported: { owner, pr } (pr only when the pull
 * request's language differs, with a title in it), or null.
 */
export async function generateOutcome({ run, steps, config, prLang }) {
  const ownerLang = config.language || 'en';
  const other = prLang && prLang !== ownerLang;
  const shape = '{"done": ["up to 3 short items"], "change": "one sentence", "needs": {"yes": false, "what": ""}}';
  const reports = steps.map(s => `## ${s.agent} (${s.status})\n${s.outcome ? outcomeMarkdown(s.outcome, ownerLang) : clip(s.report || s.error || '(no report)', 2500)}`);
  const prompt = [
    `An AI agent crew finished a run on a project: "${run.title}". Summarize it for the project's owner, an administrator who must understand it in seconds, in plain ${languageName(ownerLang)} with no jargon.`,
    `Reply with JSON only: ${other ? `{"owner": ${shape}, "pr": ${shape.replace('{', `{"title": "at most ${TITLE_MAX} characters", `)}}` : shape}.`,
    '- done: what was done, at most 3 short items.',
    '- change: what changes for the people who use the project, in one sentence.',
    '- needs: whether the owner must do something besides reviewing the result, and what.',
    ...(other ? [`- "pr" is the same summary in ${languageName(prLang)}, for the pull request, with its title.`] : []),
    '',
    `Result: ${run.result ?? run.status}${run.checks?.length ? `. Checks: ${run.checks.map(c => `${c.command} ${c.ok ? 'passed' : 'failed'}`).join(', ')}` : ''}.`,
    '',
    clip(reports.join('\n\n'), 12000),
  ].join('\n');
  const data = jsonIn(await askQuick(prompt, config));
  const owner = cleanOutcome(other ? data?.owner : data);
  if (!owner) return null;
  const pr = other ? cleanOutcome(data?.pr) : null;
  return { owner, pr: pr ? { ...pr, title: clip(data.pr.title, TITLE_MAX + 10) || null } : null };
}

/** A run's final summary without the model: the steps' own summaries put together, or null. */
export function mergeOutcomes(steps) {
  const list = steps.map(s => s.outcome).filter(Boolean);
  if (!list.length) return null;
  return {
    done: list.flatMap(o => o.done).slice(0, 3),
    change: list.at(-1).change,
    needs: list.map(o => o.needs).filter(Boolean).join(' ') || null,
  };
}
