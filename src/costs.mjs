// Recorded project work, estimates of subscription usage, and expenses entered by hand.
import { randomUUID } from 'node:crypto';
import { readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { t } from './i18n.mjs';
import { listRuns, readUsage, stepsOf, USAGE_WINDOWS } from './store.mjs';
import { DATA, now, readJson, writeJson } from './util.mjs';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WINDOWS = { five_hour: 5 * HOUR, seven_day: 7 * DAY };
const EXPENSES = path.join(DATA, 'project-expenses');
const FREQUENCIES = ['once', 'weekly', 'monthly', 'yearly'];
const localDay = d => [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
const isoDay = ms => new Date(ms).toISOString().slice(0, 10);
const positive = n => Number.isFinite(n) && n > 0 ? n : 0;
const tokenCount = tokens => ['input', 'output', 'cacheRead', 'cacheWrite'].reduce((sum, key) => sum + positive(tokens?.[key]), 0);
function files(dir) {
  try {
    return readdirSync(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export function costActivity(result, tool, started, ended, durationMs = result.durationMs) {
  return { started, ended, durationMs: positive(durationMs), tokens: tokenCount(result.tokens), tool };
}

/** Legacy steps and pauses kept totals, with no timestamp for each turn. */
export function legacyStepCosts(step) {
  const totals = step.paused?.total ?? step;
  const ended = step.paused?.at ?? step.ended ?? step.started;
  if (!ended || !(positive(totals.durationMs) || tokenCount(totals.tokens))) return [];
  const started = step.started ?? new Date(Date.parse(ended) - positive(totals.durationMs)).toISOString();
  return [costActivity(totals, step.tool ?? 'claude', started, ended)];
}

function samplesSince(since) {
  const usage = readUsage();
  return Object.fromEntries(Object.keys(WINDOWS).map(kind => {
    const dir = path.join(USAGE_WINDOWS, kind);
    const samples = files(dir).filter(name => /^\d+\.json$/.test(name) && Number.parseInt(name, 10) > since)
      .map(name => readJson(path.join(dir, name), null)).filter(Boolean);
    const byReset = new Map(samples.map(sample => [sample.resets, sample]));
    if (usage[kind]) byReset.set(usage[kind].resets, usage[kind]);
    return [kind, [...byReset.values()]];
  }));
}

export const listExpenses = (dir = EXPENSES) => files(dir)
  .filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).map(name => readJson(path.join(dir, name), null)).filter(Boolean);

export function changeExpense(body, { projects, by, dir = EXPENSES }) {
  if (body.action === 'remove') {
    const id = String(body.id ?? '');
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error(t('Invalid expense ID.'));
    rmSync(path.join(dir, `${id}.json`), { force: true });
    return { id };
  }
  const { project, frequency } = body;
  const name = String(body.name ?? '').trim();
  const currency = String(body.currency ?? '').trim().toUpperCase();
  const amount = String(body.amount ?? '').trim();
  const due = String(body.due ?? '');
  const minor = Math.round(Number(amount) * 100);
  if (!Object.hasOwn(projects ?? {}, project ?? '')) throw new Error(t('Project not found.'));
  if (body.action !== 'add' || !name || name.length > 120 || !FREQUENCIES.includes(frequency)
    || !/^[A-Z]{3}$/.test(currency) || !/^\d+(?:\.\d{1,2})?$/.test(amount)
    || minor <= 0 || !Number.isSafeInteger(minor) || minor > 1_000_000_000_000
    || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(due) || !Number.isFinite(Date.parse(due)) || isoDay(Date.parse(due)) !== due) {
    throw new Error(t('Enter a name, a positive amount with up to two decimals, a three-letter currency, a frequency and a valid due date.'));
  }
  const expense = { id: randomUUID(), project, name, currency, minor, frequency, due, by, created: now() };
  writeJson(path.join(dir, `${expense.id}.json`), expense);
  return expense;
}

/** The first scheduled charge on or after a calendar date, clamped to the end of short months. */
export function nextExpenseDate(expense, from) {
  if (from <= expense.due) return expense.due;
  if (expense.frequency === 'once') return null;
  if (expense.frequency === 'weekly') {
    const start = Date.parse(expense.due);
    return isoDay(start + Math.ceil((Date.parse(from) - start) / (7 * DAY)) * 7 * DAY);
  }
  const [year, month, day] = expense.due.split('-').map(Number);
  const [currentYear, currentMonth] = from.split('-').map(Number);
  const period = expense.frequency === 'yearly' ? 12 : 1;
  const offset = Math.max(0, Math.floor(((currentYear - year) * 12 + currentMonth - month) / period) * period);
  const date = n => {
    const end = new Date(Date.UTC(year, month + n, 0)).getUTCDate();
    return isoDay(Date.UTC(year, month + n - 1, Math.min(day, end)));
  };
  const first = date(offset);
  return first >= from ? first : date(offset + period);
}

const share = (entry, start, end) => entry.end > entry.start
  ? Math.max(0, Math.min(end, entry.end) - Math.max(start, entry.start)) / (entry.end - entry.start)
  : Number(entry.end >= start && entry.end < end);

const bucket = () => ({ runs: 0, agentHours: 0, sessions: 0, liveHours: 0, windowHours: 0, expenses: {}, usage: {} });

export function projectCosts({ projects = {}, project, weeks = 8, at = Date.now(), runs = listRuns(), sessions = [], expenses = listExpenses(), samples } = {}) {
  weeks = Number(weeks);
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > 52) throw new Error(t('Choose between 1 and 52 weeks.'));
  const monday = new Date(at);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - (monday.getDay() + 6) % 7);
  const date = offset => new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + offset * 7);
  const periods = Array.from({ length: weeks }, (_, i) => ({
    start: +date(-i), end: +date(1 - i), from: localDay(date(-i)), until: localDay(date(1 - i)),
  }));
  const ids = [...new Set([...Object.keys(projects), ...runs.map(r => r.project), ...sessions.map(s => s.project), ...expenses.map(e => e.project)].filter(Boolean))];
  if (project != null && !ids.includes(project)) throw new Error(t('Project not found.'));
  const rows = new Map(ids.map(id => [id, {
    project: id, name: projects[id]?.name ?? id, configured: Object.hasOwn(projects, id), weeks: periods.map(p => ({ from: p.from, ...bucket() })), currentUsage: {},
    expenses: expenses.filter(e => e.project === id).map(e => ({ ...e, nextDue: nextExpenseDate(e, localDay(new Date(at))) })),
  }]));
  const activities = [];
  const add = (id, kind, records) => records.flatMap(record => {
    const end = Date.parse(record.ended);
    if (!id || !Number.isFinite(end)) return [];
    const entry = { ...record, project: id, kind, start: Math.min(end, Date.parse(record.started) || end), end };
    activities.push(entry);
    return [entry];
  });
  for (const run of runs) {
    const row = rows.get(run.project);
    if (!row) continue;
    const entries = add(run.project, 'agents', stepsOf(run).flatMap(s => s.costActivity ?? legacyStepCosts(s)));
    const started = Date.parse(run.started ?? stepsOf(run).map(s => s.started).filter(Boolean).sort()[0]);
    periods.forEach((p, i) => {
      if (entries.some(e => share(e, p.start, p.end)) || (started >= p.start && started < p.end)) row.weeks[i].runs++;
    });
  }
  for (const session of sessions) {
    const row = rows.get(session.project);
    if (!row) continue;
    const start = Date.parse(session.opened ?? session.started);
    const end = session.status === 'ended' ? Date.parse(session.ended) : at;
    const window = (session.mode ?? 'window') === 'window' && Number.isFinite(start) && end > start;
    const entries = add(session.project, 'live', session.costActivity ?? []);
    periods.forEach((p, i) => {
      const openMs = window ? Math.max(0, Math.min(p.end, end) - Math.max(p.start, start)) : 0;
      if (openMs || entries.some(e => share(e, p.start, p.end)) || (start >= p.start && start < p.end)) row.weeks[i].sessions++;
      row.weeks[i].windowHours += openMs / HOUR;
    });
  }
  for (const entry of activities) {
    const field = entry.kind === 'live' ? 'liveHours' : 'agentHours';
    periods.forEach((p, i) => { rows.get(entry.project).weeks[i][field] += entry.durationMs * share(entry, p.start, p.end) / HOUR; });
  }
  for (const row of rows.values()) {
    periods.forEach((p, i) => {
      for (const expense of row.expenses) {
        const due = nextExpenseDate(expense, p.from);
        if (due && due < p.until) row.weeks[i].expenses[expense.currency] = (row.weeks[i].expenses[expense.currency] ?? 0) + expense.minor;
      }
    });
  }
  // Allocate each observed window across all projects before applying a project filter.
  const oldest = periods.at(-1).start;
  const claude = activities.filter(e => e.tool === 'claude' && e.tokens && e.end >= oldest - WINDOWS.seven_day);
  for (const [kind, span] of Object.entries(WINDOWS)) {
    for (const sample of (samples ??= samplesSince(oldest))[kind] ?? []) {
      const end = Date.parse(sample.resets);
      if (!Number.isFinite(end) || end <= oldest || end - span > at || !Number.isFinite(sample.used)) continue;
      const start = end - span;
      const weights = claude.map(e => e.tokens * share(e, start, end));
      const total = weights.reduce((sum, n) => sum + n, 0);
      if (!total) continue;
      const current = at < end;
      const addUsage = (target, source, fraction) => {
        const bySource = (target[kind] ??= {});
        bySource[source] = (bySource[source] ?? 0) + sample.used * 100 * fraction / total;
      };
      claude.forEach((e, i) => {
        if (!weights[i]) return;
        const row = rows.get(e.project);
        if (current) addUsage(row.currentUsage, e.kind, weights[i]);
        periods.forEach((p, j) => {
          const weight = e.tokens * share(e, Math.max(start, p.start), Math.min(end, p.end));
          if (weight) addUsage(row.weeks[j].usage, e.kind, weight);
        });
      });
    }
  }
  return { projects: project == null ? [...rows.values()] : [rows.get(project)] };
}
