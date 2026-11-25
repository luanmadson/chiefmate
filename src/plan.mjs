// The plan's free resets, the week's pace, and the alerts about your account and this computer.
// Alerts only warn (a band in the app and a Windows notification, once each): they never pause anything.
import { loadConfig, saveConfig } from './config.mjs';
import { formatDateTime, formatPercent, t } from './i18n.mjs';
import { computer, formatBytes, freeShare, processes } from './machine.mjs';
import { reportEvent } from './news.mjs';
import { notify } from './notify.mjs';
import { readState, readUsage, saveState } from './store.mjs';
import { readerSettings, readerStatus, readWhenDue } from './usagepage.mjs';
import { now } from './util.mjs';

const DAY = 86400_000;
const WEEK = 7 * DAY;
export const RAM_LOW = 0.15; // an episode of low memory starts below 15% free...
const RAM_BACK = 0.2; // ...and ends above 20%
const USAGE_STEPS = [0.9, 0.7];
const WINDOWS = [
  ['five_hour', () => t('The 5-hour window')],
  ['seven_day', () => t("The plan's week")],
];

/** A window still running (its value is not from before a reset). */
export const current = w => typeof w?.used === 'number' && (!w.resets || Date.parse(w.resets) > Date.now());

// ---------- Free resets of the plan ----------

/** "2026-12-01" is the end of that day, in local time; anything else is read as a date and time. */
export function parseExpiry(text) {
  const s = String(text ?? '').trim();
  const day = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const d = day ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]), 23, 59) : new Date(s);
  if (!s || Number.isNaN(d.getTime())) throw new Error(t('Invalid date: {text}. Use YYYY-MM-DD.', { text: s }));
  return d.toISOString();
}

/**
 * "plan_resets" in the settings: [{ kind: "full", expires: ISO, used: false, note }]. Claude Code doesn't report them,
 * so you record them (or the optional claude.ai reading does). Each comes back with its number, from 1.
 */
export const planResets = (config = loadConfig()) =>
  (config.plan_resets ?? []).map((g, i) => ({ ...g, index: i + 1, available: !g.used && (!g.expires || Date.parse(g.expires) > Date.now()) }));

export const availableResets = config =>
  planResets(config).filter(g => g.available).sort((a, b) => (a.expires ?? '9').localeCompare(b.expires ?? '9'));

/** action: "add" (expires, note), "used" or "remove" (index, from 1). */
export function changeResets({ action, index, expires, note }) {
  const config = loadConfig();
  const list = config.plan_resets ?? [];
  if (action === 'add') list.push({ kind: 'full', expires: parseExpiry(expires), used: false, note: String(note ?? '').trim(), source: 'manual' });
  else {
    const i = Number(index) - 1;
    if (!list[i]) throw new Error(t('There is no free reset number {index}.', { index }));
    if (action === 'used') Object.assign(list[i], { used: true, used_at: now() });
    else if (action === 'remove') list.splice(i, 1);
    else throw new Error(t('Unknown action: {action}', { action }));
  }
  config.plan_resets = list;
  saveConfig(config);
  return planResets(config);
}

/** The week's pace: the share used against the share of the week gone by. */
export function weekPace(usage = readUsage()) {
  const w = usage.seven_day;
  if (!current(w) || !w.resets) return null;
  const elapsed = Math.min(1, Math.max(0, 1 - (Date.parse(w.resets) - Date.now()) / WEEK));
  const margin = elapsed - w.used;
  return { used: w.used, elapsed, margin, status: margin >= 0.05 ? 'slack' : margin > -0.05 ? 'even' : 'ahead' };
}

// ---------- Alerts ----------

function ramText(c) {
  const share = c.memory.free / c.memory.total;
  const top = c.projects.filter(p => p.ram > 0).slice(0, 3).map(p => `${p.name} ${formatBytes(p.ram)}`);
  return [
    t('Free memory on this computer is down to {percent} ({free} of {total}).', { percent: formatPercent(share), free: formatBytes(c.memory.free), total: formatBytes(c.memory.total) }),
    top.length ? t('Using the most: {list}.', { list: top.join(', ') }) : '',
  ].filter(Boolean).join(' ');
}

const usageText = (name, w) =>
  t('{window} of your account is at {percent}.', { window: name, percent: formatPercent(w.used) }) +
  (w.resets ? ` ${t('It resets {when}.', { when: formatDateTime(w.resets) })}` : '');

const suggestText = (week, grant) =>
  t("The plan's week is at {percent} and you have a free reset available until {when}: a good time to use it.", {
    percent: formatPercent(week.used), when: grant.expires ? formatDateTime(grant.expires) : '—',
  });

const expiryText = grant =>
  t('A free reset of your plan expires {when}, still unused.', { when: formatDateTime(grant.expires) }) + (grant.note ? ` (${grant.note})` : '');

/** What the band at the top of the app shows now: { level: "warn" | "critical", text, view }. */
export function alerts(config, usage, c) {
  const list = [];
  if (c.memory.free / c.memory.total < RAM_LOW) list.push({ level: 'critical', text: ramText(c), view: 'projects' });
  for (const [key, name] of WINDOWS) {
    const w = usage[key];
    if (current(w) && w.used >= USAGE_STEPS.at(-1)) list.push({ level: w.used >= USAGE_STEPS[0] ? 'critical' : 'warn', text: usageText(name(), w), view: 'usage' });
  }
  const available = availableResets(config);
  if (available.length && current(usage.seven_day) && usage.seven_day.used >= 0.9) list.push({ level: 'warn', text: suggestText(usage.seven_day, available[0]), view: 'usage' });
  for (const g of available) if (g.expires && Date.parse(g.expires) - Date.now() <= 3 * DAY) list.push({ level: 'warn', text: expiryText(g), view: 'usage' });
  const reader = readerStatus();
  if (readerSettings(config).enabled && reader.error) list.push({ level: 'warn', text: t('Reading claude.ai: {problem}', { problem: reader.error }), view: 'usage' });
  return list;
}

/** Every 15 seconds: sends each alert to Windows once (per window and threshold, per reset, per episode of low memory). */
async function watch() {
  const config = loadConfig();
  const usage = readUsage();
  const state = readState();
  const before = JSON.stringify(state.alerts ?? null);
  const a = (state.alerts ??= { sent: {} });
  const fresh = key => !a.sent[key] && (a.sent[key] = now());
  const send = [];

  let lowMemory = false;
  const share = freeShare();
  if (share < RAM_LOW && !a.ram_low) lowMemory = a.ram_low = true;
  else if (share >= RAM_BACK && a.ram_low) a.ram_low = false;

  for (const [key, name] of WINDOWS) {
    const w = usage[key];
    if (!current(w)) continue;
    const step = USAGE_STEPS.find(s => w.used >= s);
    if (!step) continue;
    const keys = USAGE_STEPS.filter(s => s <= step).map(s => `usage:${key}:${w.resets}:${s}`);
    if (keys.map(fresh)[0]) send.push({ title: t('Account usage at {percent}', { percent: formatPercent(w.used) }), text: usageText(name(), w), target: 'chiefmate:usage', event: 'usage_alert', urgent: step >= 0.9 });
  }

  const available = availableResets(config);
  const week = usage.seven_day;
  if (available.length && current(week) && week.used >= 0.9 && fresh(`reset-suggest:${week.resets}`)) {
    send.push({ title: t('Free reset available'), text: suggestText(week, available[0]), target: 'chiefmate:usage', event: 'usage_alert' });
  }
  for (const g of available.filter(x => x.expires)) {
    const left = Date.parse(g.expires) - Date.now();
    const id = `reset-expiry:${g.expires}:${g.note ?? ''}`;
    const step = left <= DAY ? '1d' : left <= 3 * DAY ? '3d' : null;
    if (!step) continue;
    const keys = step === '1d' ? [`${id}:1d`, `${id}:3d`] : [`${id}:3d`];
    if (keys.map(fresh)[0]) send.push({ title: t('Free reset expiring'), text: expiryText(g), target: 'chiefmate:usage', event: 'usage_alert', urgent: step === '1d' });
  }

  for (const [key, at] of Object.entries(a.sent)) if (Date.now() - Date.parse(at) > 30 * DAY) delete a.sent[key];
  if (JSON.stringify(a) !== before) saveState(state);
  readWhenDue(config);

  if (lowMemory) {
    await processes(60_000).catch(() => {});
    send.unshift({ title: t('Low memory on this computer'), text: ramText(computer(config)), target: 'chiefmate:projects', event: 'memory_alert', urgent: true });
  }
  for (const n of send) {
    notify(n.title, n.text, n.target, { urgent: !!n.urgent });
    // The manager gets the alert as the owner does (in the owner's language): it only warns, nothing pauses.
    reportEvent(n.event, `Alert sent to the owner: ${n.title}. ${n.text}`, { config });
  }
}

export function startWatch() {
  const tick = () => watch().catch(error => console.error('Watch:', error.message));
  setInterval(tick, 15_000);
  tick();
}

// ---------- For the manager's situation ----------

export function computerLine(config) {
  const c = computer(config);
  const memory = `free memory ${formatPercent(c.memory.free / c.memory.total)} (${formatBytes(c.memory.free)} of ${formatBytes(c.memory.total)})`;
  if (!c.supported) return `This computer: ${memory}; the projects' processes are read on Windows only.`;
  const running = c.projects.filter(p => p.ram > 0).map(p => `${p.id} ${formatBytes(p.ram)}${[p.agent ? 'crew at work' : '', p.session ? 'live session' : ''].filter(Boolean).map(x => ` (${x})`).join('')}`);
  return `This computer: ${memory}; projects running here: ${running.join(', ') || 'none'}; Chiefmate itself ${formatBytes(c.chiefmate.ram)}.`;
}

export function planLine(config, usage) {
  const available = availableResets(config);
  const resets = available.length
    ? `${available.length} available (${available.map(g => `#${g.index} ${g.expires ? `until ${formatDateTime(g.expires)}` : 'expiry unknown'}${g.note ? `, ${g.note}` : ''}`).join('; ')})`
    : 'none available';
  const p = weekPace(usage);
  const pace = p
    ? `${formatPercent(p.used)} of the week used with ${formatPercent(p.elapsed)} of it gone (${p.status === 'slack' ? `${Math.round(p.margin * 100)} points of slack` : p.status === 'even' ? 'on pace' : `${Math.round(-p.margin * 100)} points ahead of pace`})`
    : 'not measured yet';
  return `Free plan resets: ${resets}. Week pace: ${pace}.`;
}
