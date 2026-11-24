// The Chiefmate app: fetches the state every 2.5 seconds and redraws only what changed.
import { face } from './faces.js';
import { language, locale, setLanguage, t, translatePage } from './i18n.js';

const $ = selector => document.querySelector(selector);
let state = null;
let online = false;
let started = false;
let serverStarted = null; // when the Chiefmate that served this app started
const signatures = {};
let selectedRun = null;
let detail = null;

async function api(route, body) {
  const r = await fetch(
    route,
    body
      ? { method: 'POST', headers: { 'content-type': 'application/json', 'x-chiefmate': '1' }, body: JSON.stringify(body) }
      : { cache: 'no-store' },
  );
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || t('Error {code}', { code: r.status }));
  return data;
}

function toast(text) {
  const box = $('#toast');
  box.textContent = text;
  box.classList.add('visible');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => box.classList.remove('visible'), 4000);
}

function confirmDialog(title, text, yes) {
  const dialog = $('#confirm');
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  $('#confirm-yes').textContent = yes;
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'yes'), { once: true }));
}

// ---------- Text and formats ----------

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
}

/** Simple markdown: paragraphs, headings, lists, code and tables (shown as fixed text). */
function md(text) {
  const parts = [];
  let paragraph = [];
  let list = null;
  let code = null;
  let table = null;
  const closeParagraph = () => {
    if (paragraph.length) parts.push(`<p>${paragraph.map(inline).join('<br>')}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (list) parts.push(`<${list.tag}>${list.items.map(i => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`);
    list = null;
  };
  const closeTable = () => {
    if (table) parts.push(`<pre>${esc(table.join('\n'))}</pre>`);
    table = null;
  };
  for (const line of String(text ?? '').replace(/\r/g, '').split('\n')) {
    if (code) {
      if (line.startsWith('```')) {
        parts.push(`<pre>${esc(code.join('\n'))}</pre>`);
        code = null;
      } else code.push(line);
      continue;
    }
    if (line.startsWith('```')) {
      closeParagraph(); closeList(); closeTable();
      code = [];
      continue;
    }
    if (/^\s*\|/.test(line)) {
      closeParagraph(); closeList();
      (table ??= []).push(line);
      continue;
    }
    closeTable();
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      closeParagraph(); closeList();
      parts.push(`<h4>${inline(heading[1])}</h4>`);
      continue;
    }
    const item = line.match(/^\s*(?:[-*]|(\d+)[.)])\s+(.*)$/);
    if (item) {
      closeParagraph();
      const tag = item[1] ? 'ol' : 'ul';
      if (list && list.tag !== tag) closeList();
      (list ??= { tag, items: [] }).items.push(item[2]);
      continue;
    }
    if (!line.trim()) {
      closeParagraph(); closeList();
      continue;
    }
    if (/^-{3,}$/.test(line.trim())) {
      closeParagraph(); closeList();
      parts.push('<hr>');
      continue;
    }
    closeList();
    paragraph.push(line);
  }
  if (code) parts.push(`<pre>${esc(code.join('\n'))}</pre>`);
  closeParagraph(); closeList(); closeTable();
  return parts.join('');
}

const clockTime = iso => (iso ? new Date(iso).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }) : '');
const shortDate = iso =>
  iso ? new Date(iso).toLocaleString(locale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(',', '') : '—';
const percent = v => (typeof v === 'number' ? `${Math.round(v * 100)}%` : '—');
function bytes(n) {
  const mb = (n ?? 0) / 1024 ** 2;
  return mb >= 1024 ? `${(mb / 1024).toLocaleString(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} GB` : `${Math.round(mb)} MB`;
}
const shortModel = m =>
  String(m ?? '').replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2').replace(/-(\d+)$/, ' $1').replace(/^\w/, c => c.toUpperCase());

function relative(iso) {
  const minutes = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
  const format = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
  if (Math.abs(minutes) < 1) return t('now');
  if (Math.abs(minutes) < 60) return format.format(minutes, 'minute');
  if (Math.abs(minutes) < 1440) return format.format(Math.round(minutes / 60), 'hour');
  return format.format(Math.round(minutes / 1440), 'day');
}

function elapsed(from, to = Date.now()) {
  if (!from) return '—';
  const minutes = Math.max(0, Math.floor((new Date(to).getTime() - new Date(from).getTime()) / 60000));
  if (minutes < 60) return t('{minutes} min', { minutes });
  return t('{hours} h {minutes} min', { hours: Math.floor(minutes / 60), minutes: String(minutes % 60).padStart(2, '0') });
}

/** A stopwatch that counts live: 4:07, 1:02:09. Marked with data-since, it is updated every second by tickClocks(). */
let skew = 0; // the server's clock minus this one, so the count matches the server's times
function stopwatch(from) {
  const s = Math.max(0, Math.floor((Date.now() + skew - new Date(from).getTime()) / 1000));
  const two = n => String(n).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}` : `${Math.floor(s / 60)}:${two(s % 60)}`;
}
const ticking = from => (from ? `<span class="num" data-since="${esc(from)}">${stopwatch(from)}</span>` : '—');
function tickClocks() {
  for (const el of document.querySelectorAll('[data-since]')) el.textContent = stopwatch(el.dataset.since);
}

function runState(status) {
  switch (status) {
    case 'queued': return [t('Queued'), 'info'];
    case 'running': return [t('Running'), 'info'];
    case 'waiting': return [t('Waiting for the limit'), 'warn'];
    case 'paused': return [t('Paused'), 'warn'];
    case 'done': return [t('Done'), 'ok'];
    case 'failed': return [t('Failed'), 'error'];
    case 'canceled': return [t('Canceled'), 'neutral'];
    case 'pending': return [t('Pending'), 'neutral'];
    default: return [status ?? '', 'neutral'];
  }
}

/** A run's state, with "Waiting for you" while one of its steps waits for the owner. */
const runLabel = r => (r?.needsYou && ['running', 'queued', 'waiting', 'paused'].includes(r.status) ? [t('Waiting for your action'), 'warn'] : runState(r?.status));

const stateHtml = ([label, kind]) => `<span class="state state-${kind}">${esc(label)}</span>`;

function originLabel(origin) {
  switch (origin) {
    case 'app': return t('From the app');
    case 'manager': return t('Asked by the manager');
    case 'schedule': return t('Scheduled');
    case 'schedule-late': return t('Scheduled (late)');
    default: return origin ?? '';
  }
}

const projectName = id => state?.projects.find(p => p.id === id)?.name ?? id;

function draw(selector, signature, html) {
  if (signatures[selector] === signature) return false;
  signatures[selector] = signature;
  $(selector).innerHTML = html;
  return true;
}

function meter(label, value, text, extra = '') {
  const v = Math.min(1, Math.max(0, value ?? 0));
  const level = v >= 0.85 ? 'critical' : v >= 0.6 ? 'high' : '';
  return `<div class="meter"><div class="meter-top"><span>${esc(label)}</span><span class="num">${esc(text)}</span></div><div class="track"><span class="${level}" style="width:${Math.round(v * 100)}%"></span></div>${extra ? `<div class="hint">${extra}</div>` : ''}</div>`;
}

/** How full a conversation's context is: a bar with the share, then the tokens and the compactions. */
function contextMeter(label, c, more = []) {
  const measured = c?.used > 0 && c.window > 0;
  const tokens = n => Number(n ?? 0).toLocaleString(locale());
  const hint = [
    measured ? t('{used} of {window} tokens', { used: tokens(c.used), window: tokens(c.window) }) : t('not measured yet'),
    t('{count} compaction(s)', { count: c?.compactions ?? 0 }),
    ...more,
  ];
  return meter(label, measured ? c.used / c.window : 0, measured ? percent(c.used / c.window) : '—', esc(hint.join(' · ')));
}

function managerContextMeter() {
  const c = state.manager.context ?? {};
  let renewal = t('renews above {percent}', { percent: percent(c.renewAt) });
  if (c.renewing) renewal = t('writing the summary to renew it…');
  else if (c.renewed && !c.used) renewal = t('renewed {when}, with a summary', { when: relative(c.renewed) });
  return contextMeter(t('Context: Chiefmate'), c, [renewal]);
}

const agentContextMeter = a => contextMeter(t('Context: {agent}', { agent: agentName(a.agent, a.project) }), a.context, [projectName(a.project)]);

// ---------- The crew ----------

const FALLBACK_MANAGER = { id: 'manager', name: 'Chiefmate', title: 'Manager', color: '#c9a45d', face: 'cap', status: 'idle' };
function member(id, project) {
  const team = project ? state?.teams?.find(x => x.project === project) : null;
  return team?.members.find(a => a.id === id)
    ?? state?.crew.find(a => a.id === id)
    ?? state?.teams?.flatMap(x => x.members).find(a => a.id === id)
    ?? (id === 'manager' ? FALLBACK_MANAGER : { id, name: id });
}
const agentName = (id, project) => t(member(id, project).name ?? id);
const faceState = agent => (online ? agent.status ?? 'idle' : 'offline');
const stepFace = step => ({ running: step.review ? 'reviewing' : 'working', done: 'done', failed: 'failed', pending: 'queued' })[step.status] ?? 'still';

function agentStatus(agent) {
  if (!online) return [t('Offline'), 'error'];
  switch (agent.status) {
    case 'working': return [t('Working'), 'info'];
    case 'reviewing': return [t('Reviewing'), 'info'];
    case 'thinking': return [t('Thinking'), 'info'];
    case 'queued': return [t('Next in line'), 'neutral'];
    case 'waiting': return [t('Waiting for the limit'), 'warn'];
    case 'offline': return [t('Offline'), 'error'];
    default: return [agent.id === 'manager' ? t('Waiting for you') : t('Standing by'), 'ok'];
  }
}

function agentDetail(agent) {
  if (!online) return t('No connection to Chiefmate');
  switch (agent.status) {
    case 'working':
    case 'reviewing': return t('On {title}', { title: agent.run ?? '' });
    case 'thinking': return t('Answering you');
    case 'queued': return t('Next: {title}', { title: agent.run ?? '' });
    case 'waiting': return t("Waiting for the account's limit to reset");
    case 'offline': return t('Claude Code not found');
    default:
      if (!agent.last) return t('No work yet');
      return agent.last.chat ? t('Last answer {when}', { when: relative(agent.last.at) }) : t('Last work {when}', { when: relative(agent.last.at) });
  }
}

const nextMission = () => state.missions.filter(m => m.next).sort((x, y) => x.next.localeCompare(y.next))[0];

/** The queue in the order it will run, as the server picks: the runs ready to start by age, then the others by start time. */
function queueOrder() {
  const ready = r => !r.notBefore || new Date(r.notBefore).getTime() <= Date.now() + skew;
  const later = state.queue.filter(r => !ready(r)).sort((x, y) => x.notBefore.localeCompare(y.notBefore));
  return [...state.queue.filter(ready), ...later];
}

const liveDot = () => '<span class="live-dot" aria-hidden="true"></span>';

/** The runs going on now, oldest first (runs of different projects go on at the same time). */
const going = () => (online && state ? state.running ?? (state.current ? [state.current] : []) : []);
const stepLine = a => t('{title}: {agent} (step {n} of {total})', { title: a.title, agent: a.agent ? agentName(a.agent, a.project) : t('preparing'), n: a.step ?? 1, total: a.steps.length });
const toolName = tool => (tool === 'codex' ? 'Codex' : 'Claude Code');

// ---------- Navigation ----------

const VIEWS = ['manager', 'operations', 'planning', 'missions', 'crew', 'projects', 'log', 'usage'];
const currentView = () => (VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'manager');
function showView() {
  const view = currentView();
  for (const v of VIEWS) $(`#view-${v}`).classList.toggle('active', v === view);
  for (const a of document.querySelectorAll('.nav a')) a.classList.toggle('active', a.dataset.view === view);
  if (view === 'manager') setTimeout(() => $('#message').focus(), 0);
}
window.addEventListener('hashchange', showView);

// ---------- Fixed parts: presence, counters and the status bar ----------

function drawPresence() {
  const manager = member('manager');
  let text, kind, look;
  if (!online) [text, kind, look] = [t('No connection to Chiefmate'), 'error', 'offline'];
  else if (state.ai.claude.found === false) [text, kind, look] = [t('Claude Code not found'), 'error', 'offline'];
  else if (state.ai.account.status === 'rejected') [text, kind, look] = [t('Account limit reached'), 'warn', 'waiting'];
  else if (going().length > 1) [text, kind, look] = [t('On duty: {count} runs at once', { count: going().length }), 'info', 'working'];
  else if (going().length) [text, kind, look] = [t('On duty: {title}', { title: going()[0].title }), 'info', 'working'];
  else if (state.manager.responding) [text, kind, look] = [t('Thinking…'), 'info', 'thinking'];
  else [text, kind, look] = [t('Online · waiting for you'), 'ok', 'idle'];
  const html = `${face(manager, look, 22, text)}${stateHtml([text, kind])}`;
  draw('#presence', html, html);
}

/** The project in focus: the run going on now, else the next one in the queue. */
function drawFocus() {
  const f = online ? state.focus : null;
  const label = `<span class="label">${esc(t('Focus'))}</span>`;
  if (!f) {
    const text = online ? t('No project in focus') : '—';
    const html = `${label}<span class="focus-none">${esc(text)}</span>`;
    $('#focus').title = text;
    draw('#focus', html, html);
    return;
  }
  const parts = [f.kind === 'mission' ? t('Mission') : t('Task'), f.title];
  if (f.state === 'running') parts.push(f.agent ? agentName(f.agent) : t('preparing'), t('for {time}', { time: elapsed(f.since) }));
  else {
    parts.unshift(t('Next in the queue'));
    if (f.agent) parts.push(agentName(f.agent));
    if (f.notBefore && new Date(f.notBefore).getTime() > Date.now()) parts.push(t('not before {when}', { when: shortDate(f.notBefore) }));
  }
  const others = f.others ?? [];
  if (others.length) parts.push(t('and {count} more: {list}', { count: others.length, list: others.map(o => o.projectName).join(', ') }));
  const html = `${label}${f.state === 'running' ? liveDot() : ''}<span class="focus-project">${esc(f.projectName)}</span><span class="focus-detail">${parts.map(esc).join(' · ')}</span>`;
  $('#focus').title = [f.projectName, ...parts].join(' · ');
  draw('#focus', html, html);
}

function drawCounters() {
  const runs = going().length;
  const count = online ? state.queue.length : 0;
  const waiting = count ? t('{count} in the queue', { count }) : '';
  draw('#counter-operations', `${runs}-${count}`, runs ? `${liveDot()}${count ? `<span>${count}</span>` : ''}` : count ? String(count) : '');
  const link = $('#counter-operations').parentElement;
  link.classList.toggle('running', !!runs);
  link.title = [runs ? t('{count} running', { count: runs }) : '', waiting].filter(Boolean).join(' · ');
  if (!online) return;
  draw('#counter-manager', String(state.manager.responding), state.manager.responding ? '…' : '');
  const running = state.computer.projects.filter(p => p.running || p.agent).length;
  draw('#counter-projects', String(running), running ? String(running) : '');
}

/** The window's title and icon, to see from afar: ● while a run goes on, ○ with runs only waiting in the queue. */
const baseIcon = new Image();
baseIcon.src = '/icon-32.png';
let iconMode = '';
function drawFavicon(mode) {
  // Not loaded yet, or broken (drawImage would throw and stop the rest of the refresh): try again next time.
  if (mode === iconMode || (mode && !(baseIcon.complete && baseIcon.naturalWidth))) return;
  const links = document.querySelectorAll('link[rel="icon"]');
  let href = '';
  if (mode) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 32;
    const g = canvas.getContext('2d');
    g.drawImage(baseIcon, 0, 0, 32, 32);
    g.fillStyle = '#0b0d10';
    g.fillRect(17, 17, 15, 15);
    g.fillStyle = g.strokeStyle = '#c9a45d';
    if (mode === 'running') g.fillRect(19, 19, 11, 11);
    else if (mode === 'needs') {
      g.fillRect(17, 17, 15, 15);
      g.fillStyle = '#0b0d10';
      g.fillRect(23, 19, 3, 7);
      g.fillRect(23, 28, 3, 2);
    } else {
      g.lineWidth = 2;
      g.strokeRect(20, 20, 9, 9);
    }
    href = canvas.toDataURL('image/png');
  }
  for (const link of links) {
    link.dataset.href ??= link.getAttribute('href');
    link.href = href || link.dataset.href;
  }
  iconMode = mode;
}

function drawTitle() {
  const runs = going();
  const a = runs[0];
  const count = online ? state?.queue.length ?? 0 : 0;
  const waiting = count ? t('{count} in the queue', { count }) : '';
  let title = 'Chiefmate';
  if (runs.length > 1) title = `● ${[t('{count} running', { count: runs.length }), waiting, 'Chiefmate'].filter(Boolean).join(' · ')}`;
  else if (a) title = `● ${[`${a.agent ? agentName(a.agent, a.project) : t('preparing')} ${a.step ?? 1}/${a.steps.length}`, waiting, 'Chiefmate'].filter(Boolean).join(' · ')}`;
  else if (count) title = `○ ${waiting} · Chiefmate`;
  const needs = online ? state?.needs?.length ?? 0 : 0;
  if (needs) title = `! ${t('Needs you ({count})', { count: needs })} · ${title.replace(/^[●○] /, '')}`;
  if (document.title !== title) document.title = title;
  drawFavicon(needs ? 'needs' : a ? 'running' : count ? 'queued' : '');
  // The badge on the app's icon in the taskbar, where the browser supports it.
  if (needs !== drawTitle.badge && 'setAppBadge' in navigator) {
    (needs ? navigator.setAppBadge(needs) : navigator.clearAppBadge()).catch(() => {});
    drawTitle.badge = needs;
  }
}

/** The band of alerts at the top: low memory, the account's usage, free resets. They warn; nothing is paused. */
function drawAlerts() {
  const list = online ? state.alerts ?? [] : [];
  const needs = (online ? state.needs ?? [] : []).map(n => `
    <div class="needs" role="alert">
      <div class="needs-text"><span class="needs-label">${esc(t('Needs you'))}</span>${esc(t('{task}: {what}', { task: n.title, what: n.what }))}
        <span class="hint">${esc([n.agent ? agentName(n.agent, n.project) : '', projectName(n.project), relative(n.at)].filter(Boolean).join(' · '))}${n.url ? ` · <a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(t('Open the address'))}</a>` : ''}${n.openError ? ` · ${esc(n.openError)}` : ''}</span>
      </div>
      <button type="button" class="button" ${n.session ? `data-needs-session="${esc(n.session)}"` : `data-needs-done="${esc(n.run)}"`} data-request="${esc(n.id)}">${esc(t('Mark as done'))}</button>
    </div>`).join('');
  const html = needs + list.map(a => `<a class="alert" href="#${esc(a.view ?? 'manager')}">${stateHtml([a.text, a.level === 'critical' ? 'error' : 'warn'])}</a>`).join('');
  draw('#alerts', html, html);
}

function drawStatusbar() {
  if (!online) {
    draw('#statusbar', 'off', `<div class="group">${stateHtml([t('No connection to Chiefmate. Trying again…'), 'error'])}</div>`);
    return;
  }
  const runs = going();
  const { account } = state.usage;
  let left;
  if (runs.length > 1) left = stateHtml([t('{count} runs going on: {list}', { count: runs.length, list: runs.map(r => projectName(r.project)).join(', ') }), 'info']);
  else if (runs.length) left = stateHtml([stepLine(runs[0]), 'info']);
  else if (state.queue.some(r => r.status === 'waiting')) left = stateHtml([t("Waiting for the account's limit to reset"), 'warn']);
  else if (state.queue.length) left = stateHtml([t('{count} in the queue', { count: state.queue.length }), 'info']);
  else left = stateHtml([t('Idle'), 'ok']);
  const claude = state.ai.claude;
  const right = [
    claude.found ? `Claude Code <span class="num">${esc(claude.version ?? '')}</span>` : esc(claude.found === false ? t('Claude Code not found') : t('Checking Claude Code…')),
    `${esc(t('5-hour window'))} <span class="num">${percent(account.five_hour?.used)}</span>`,
    `${esc(t("Plan's week"))} <span class="num">${percent(account.seven_day?.used)}</span>`,
    `${esc(t('Free memory'))} <span class="num">${percent(state.computer.memory.free / state.computer.memory.total)}</span>`,
  ].map(s => `<span>${s}</span>`).join('');
  const html = `<div class="group">${left}</div><div class="group">${right}</div>`;
  draw('#statusbar', html, html);
}

function drawClock() {
  $('#clock').textContent = new Date().toLocaleString(locale(), { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// ---------- Manager ----------

let chatScrolled = false;
function drawChat() {
  const g = state.manager;
  const manager = member('manager');
  const box = $('#chat');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  let html = g.messages.length ? '' : `<div class="msg system">${esc(t('No messages yet. Ask the manager how things are going, or ask for a job.'))}</div>`;
  for (const m of g.messages) {
    if (m.who === 'system') {
      html += `<div class="msg system">${esc(m.text)}</div>`;
      continue;
    }
    const you = m.who === 'you';
    const meta = [
      clockTime(m.at),
      m.queued ? t('delivered {time}', { time: clockTime(m.delivered) }) : '',
      m.edited ? t('edited') : '',
      m.model ? shortModel(m.model) : '',
    ].filter(Boolean).join(' · ');
    const tag = m.interrupted ? `<span class="tag">${esc(t('interrupted'))}</span>` : '';
    html += `<div class="msg ${you ? 'you' : 'manager'}${m.error ? ' error' : ''}"><div class="msg-head">${you ? '' : face(manager, m.error ? 'failed' : 'still', 20)}<span class="msg-author">${esc(you ? t('You') : t(manager.name))}</span><span class="msg-meta">${esc(meta)}</span>${tag}</div><div class="msg-body">${md(m.text)}</div></div>`;
  }
  const renewing = !!g.context?.renewing;
  if (g.responding) {
    const waiting = renewing ? t('Writing a short summary to renew the conversation…') : t('Looking at the situation…');
    const doing = g.interrupting ? t('interrupting…') : renewing ? t('renewing the conversation…') : t('answering…');
    html += `<div class="msg manager typing"><div class="msg-head">${face(manager, 'thinking', 20)}<span class="msg-author">${esc(t(manager.name))}</span><span class="msg-meta">${esc(doing)}${g.since ? ` · ${ticking(g.since)}` : ''}</span></div><div class="msg-body">${g.partial && !renewing ? md(g.partial) : `<span class="hint">${esc(waiting)}</span>`}</div><div class="live-last" id="manager-last"></div></div>`;
  }
  const signature = JSON.stringify([g.messages.length, g.messages.at(-1)?.at, g.responding, renewing, g.interrupting, g.since, g.partial]);
  if (draw('#chat', signature, html)) {
    delete signatures['#manager-last'];
    if (atBottom || !chatScrolled) {
      box.scrollTop = box.scrollHeight;
      chatScrolled = true;
    }
  }
  // What the manager is doing now, redrawn alone, like the last action of the crew at work.
  if (g.responding) draw('#manager-last', JSON.stringify([g.lastAction?.at, g.lastAction?.text]), managerLastAction(g));
  drawChatQueue();
  $('#send').disabled = !online;
  $('#send').textContent = g.responding || g.pending?.length ? t('Add to the queue') : t('Send');
  $('#interrupt').hidden = !online || !g.responding;
  $('#interrupt').disabled = !!g.interrupting;
}

function managerLastAction(g) {
  const p = g.lastAction;
  const text = p ? p.text : t('No action yet: reading your message and the situation.');
  return `<span class="label">${esc(t('Last action'))}</span><time>${p ? clockTime(p.at) : ''}</time><span class="text" title="${esc(text)}">${esc(text)}</span>`;
}

// The messages waiting for the manager. While you edit one, the list is not redrawn under you.
let editingPending = null;
function drawChatQueue() {
  const g = state.manager;
  const list = g.pending ?? [];
  if (editingPending) {
    if (list.some(m => m.id === editingPending)) return;
    editingPending = null;
    toast(t('The message you were editing is no longer in the queue: it was delivered or removed.'));
  }
  $('#chat-queue').hidden = !list.length;
  const head = `<div class="chat-queue-head"><span class="label">${esc(t('In the queue'))}</span><span class="hint">${esc(g.responding ? t('They go together, in order, when the manager finishes this answer.') : t('Being delivered…'))}</span></div>`;
  const items = list.map(m => `<div class="queued-msg" data-pending="${esc(m.id)}">
      <div class="msg-head"><span class="tag">${esc(t('queued'))}</span><span class="msg-meta">${esc([clockTime(m.at), m.edited ? t('edited') : ''].filter(Boolean).join(' · '))}</span>
        <span class="queued-actions"><button type="button" class="button secondary small" data-pending-edit="${esc(m.id)}">${esc(t('Edit'))}</button><button type="button" class="button danger small" data-pending-remove="${esc(m.id)}">${esc(t('Remove'))}</button></span></div>
      <div class="msg-body">${md(m.text)}</div>
    </div>`);
  draw('#chat-queue', JSON.stringify([list, g.responding, language()]), list.length ? head + items.join('') : '');
}

function drawSuggestions() {
  const list = [
    [t('Overview'), t('How are things going?')],
    [t('Last mission'), t('How did the last mission go? Summarize what the crew did.')],
    [t('Usage'), t('How much have we used this week, and how is my account doing?')],
  ];
  $('#suggestions').innerHTML = list.map(([label, text]) => `<button type="button" class="suggestion" data-suggestion="${esc(text)}">${esc(label)}</button>`).join('');
}

function drawBridge() {
  const manager = member('manager');
  const others = (state?.crew ?? []).filter(a => a.id !== 'manager');
  const status = agentStatus(manager);
  const claude = state?.ai.claude ?? {};
  const account = state?.ai.account ?? {};
  let claudeLine = t('Claude Code not found');
  if (!online) claudeLine = t('No connection to Chiefmate');
  else if (claude.found === null) claudeLine = t('Checking Claude Code…');
  else if (claude.found) claudeLine = t('Claude Code {version}, ready', { version: claude.version ?? '' });
  let accountLine = t('Account: limit reached');
  if (!account.status) accountLine = t('Account: not measured yet');
  else if (account.status === 'allowed') accountLine = t('Account: OK');
  else if (account.status === 'allowed_warning') accountLine = t('Account: close to the limit');
  const update = state?.update ?? {};
  let updateLine = online ? t('Chiefmate {version}, up to date', { version: state.version }) : '';
  if (online && update.waiting && update.blocked === 'changes') updateLine = t('Update waiting: files were changed by hand here');
  else if (online && update.waiting && update.blocked === 'checks') updateLine = t('Update not installed: the new version failed its checks');
  else if (online && update.waiting) updateLine = t('Update approved: it installs when the crew is free');
  const roster = others.map(a => {
    const s = agentStatus(a);
    return `<li>${face(a, faceState(a), 30, `${t(a.name)}: ${s[0]}`)}<div><div class="roster-name"><span>${esc(t(a.name))}</span>${stateHtml(s)}</div><div class="hint">${esc(agentDetail(a))} · ${esc(shortModel(a.model))}</div></div></li>`;
  });
  const html = `
    <div class="bridge-head">${face(manager, faceState(manager), 72, `${t(manager.name)}: ${status[0]}`)}
      <div><div class="bridge-name">${esc(t(manager.name))}</div>
        <div class="hint">${esc(t(manager.title ?? 'Manager'))} · <span class="model">${esc(shortModel(manager.model))}</span></div>
        ${stateHtml(status)}</div></div>
    <div class="label">${esc(t('Crew on board'))}</div>
    <ul class="roster">${roster.join('')}</ul>
    <div class="connection hint">${esc(claudeLine)}<br>${esc(accountLine)}${online && account.updated ? ` · ${esc(t('measured {when}', { when: relative(account.updated) }))}` : ''}${updateLine ? `<br>${esc(updateLine)}` : ''}</div>`;
  const signature = JSON.stringify([online, (state?.crew ?? []).map(a => [a.id, a.status, a.run, a.last?.at, a.model]), claude, account, update, Math.floor(Date.now() / 60000)]);
  draw('#bridge', signature, html);
}

function drawSituation() {
  const runs = going();
  const sessions = (state.sessions?.open ?? []).filter(x => x.status !== 'login');
  const { account } = state.usage;
  const next = nextMission();
  const html = `
    <div class="label">${esc(t('Situation'))}</div>
    <div class="block"><div class="hint">${esc(t('Operations'))}</div><div class="value">${runs.length ? runs.map(a => `${esc(a.title)}<br><span class="hint">${esc(projectName(a.project))} · ${esc(a.agent ? agentName(a.agent, a.project) : t('preparing'))}, ${esc(t('step {n} of {total}', { n: a.step ?? 1, total: a.steps.length }))}</span>`).join('<br>') : esc(t('Nothing running'))}</div></div>
    ${sessions.length ? `<div class="block"><div class="hint">${esc(t('Live sessions'))}</div><div class="value">${sessions.map(x => esc(`${x.name} (${toolName(x.tool)})`)).join('<br>')}</div></div>` : ''}
    <div class="block"><div class="hint">${esc(t('Queue'))}</div><div class="value">${state.queue.length ? esc(t('{count} run(s)', { count: state.queue.length })) : esc(t('Empty'))}</div></div>
    <div class="block"><div class="hint">${esc(t('Next scheduled mission'))}</div><div class="value">${next ? `${esc(next.name)}<br><span class="num hint">${shortDate(next.next)} (${esc(relative(next.next))})</span>` : esc(t('None'))}</div></div>
    <div class="block">${meter(t('Account, 5-hour window'), account.five_hour?.used, percent(account.five_hour?.used))}${meter(t("Plan's week"), account.seven_day?.used, percent(account.seven_day?.used))}</div>
    <div class="block">${managerContextMeter()}${runs.filter(a => a.agent).map(agentContextMeter).join('')}</div>`;
  draw('#situation', JSON.stringify([runs.map(a => [a.id, a.step, a.agent, a.context]), sessions.map(x => x.id), state.manager.context, state.queue.length, next?.next, account.updated, Math.floor(Date.now() / 60000)]), html);
}

// ---------- Operations ----------

/** The queue, numbered in the order it will run, with the next run marked. */
function drawQueue() {
  const list = queueOrder();
  // Runs of different projects go on at once, up to the limit; within a project, one at a time.
  const busy = new Set(going().map(a => a.project));
  let room = (state.parallel?.max ?? 1) - going().length;
  const expected = r => {
    if (busy.has(r.project)) return t('when the run of its project ends');
    busy.add(r.project);
    return room-- > 0 ? t('in a moment') : t('when a run ends');
  };
  const rows = list.map((r, i) => `<tr class="${i === 0 ? 'next' : ''}">
      <td class="num">${i + 1}</td>
      <td>${i === 0 ? `<span class="tag">${esc(t('Next'))}</span>` : ''}<span class="primary">${esc(r.title)}</span><span class="secondary">${esc([projectName(r.project), r.note].filter(Boolean).join(' · '))}</span></td>
      <td>${stateHtml(runState(r.status))}</td>
      <td class="num">${r.notBefore && new Date(r.notBefore).getTime() > Date.now() + skew ? `${shortDate(r.notBefore)} (${esc(relative(r.notBefore))})` : esc(expected(r))}</td>
      <td class="row-actions"><button type="button" class="button danger small" data-cancel="${esc(r.id)}">${esc(t('Cancel'))}</button></td>
    </tr>`);
  const html = list.length
    ? `<div class="label" style="margin-top:24px">${esc(t('Queue'))}</div>
    <table class="table queue"><thead><tr><th>#</th><th>${esc(t('Run'))}</th><th>${esc(t('Status'))}</th><th>${esc(t('Expected start'))}</th><th></th></tr></thead><tbody>${rows.join('')}</tbody></table>`
    : '';
  draw('#op-queue', JSON.stringify([going().map(a => a.project), state.parallel, list.map(r => [r.id, r.status, r.notBefore, r.note]), Math.floor(Date.now() / 60000)]), html);
}

/** A run going on: who is at work, the step out of how many, the time counting and the last action, all live. */
function liveCard(a, key) {
  const working = a.agent ? member(a.agent, a.project) : member('manager');
  const look = a.agent ? faceState(working) : online ? 'working' : 'offline';
  const step = a.steps[(a.step ?? 1) - 1];
  const who = a.agent ? agentName(a.agent, a.project) : t('Chiefmate, preparing the working copy');
  const segments = a.steps.map((s, i) => `<span class="${s.status}" title="${esc(`${i + 1}. ${agentName(s.agent, a.project)}: ${runState(s.status)[0]}`)}"></span>`);
  return `<div class="panel live${online ? '' : ' stalled'}">
      ${face(working, look, 56, `${who}: ${t('Running')}`)}
      <div class="live-main">
        <div class="live-label">${online ? liveDot() : ''}<span class="label">${esc(t('Running now'))}</span></div>
        <div class="live-title">${esc(a.title)}</div>
        <div class="hint">${esc([projectName(a.project), a.kind === 'mission' ? t('Mission') : t('Task'), t('started at {time}', { time: clockTime(a.started) })].join(' · '))}</div>
      </div>
      <div class="live-clock"><span class="label">${esc(t('Elapsed'))}</span><strong>${ticking(a.started)}</strong></div>
      <div class="live-progress">
        <div class="live-step"><strong>${esc(t('Step {n} of {total}', { n: a.step ?? 1, total: a.steps.length }))}</strong> · ${esc(who)}${step?.review ? ` · ${esc(t('review'))}` : ''}${a.agent && a.stepStarted ? ` · ${ticking(a.stepStarted)} ${esc(t('on this step'))}` : ''}</div>
        <div class="live-steps">${segments.join('')}</div>
      </div>
      <div class="live-last" id="${key}-last"></div>
    </div>`;
}

function lastAction(a) {
  const p = a.actions.at(-1);
  const text = p ? p.text : t('Preparing…');
  return `<span class="label">${esc(t('Last action'))}</span><time>${p ? clockTime(p.at) : ''}</time><span class="text${p?.type === 'say' ? ' say' : ''}" title="${esc(text)}">${esc(text)}</span>`;
}

// Operations is drawn in parts, each with its own signature (all with ids starting "op-"): what changes often (the
// last action, the logbook) is redrawn alone, so the animations of the rest run on without starting over. Each run
// going on has its own parts, named after it.
const opKey = id => `op-run-${String(id).replace(/[^\w-]/g, '_')}`;

function runBlock(a) {
  const k = opKey(a.id);
  return `<div class="run-block">
      <div id="${k}-live"></div>
      <div class="operations-grid">
        <div class="panel">
          <div class="label">${esc(t('Steps'))}</div>
          <ol class="steps" id="${k}-steps"></ol>
          <div id="${k}-context"></div>
          <div class="actions"><button type="button" class="button danger small" data-cancel="${esc(a.id)}">${esc(t('Cancel run'))}</button></div>
        </div>
        <div>
          <div class="logbook-head" id="${k}-head"></div>
          <div class="logbook" id="${k}-logbook"></div>
        </div>
      </div>
    </div>`;
}

function drawRun(a) {
  const k = opKey(a.id);
  const statuses = a.steps.map(s => s.status);
  const working = a.agent ? member(a.agent, a.project) : null;
  if (draw(`#${k}-live`, JSON.stringify([online, a.title, a.step, a.agent, a.stepStarted, statuses, working?.status]), liveCard(a, k))) delete signatures[`#${k}-last`];
  const last = a.actions.at(-1);
  draw(`#${k}-last`, JSON.stringify([last?.at, last?.text]), lastAction(a));
  const steps = a.steps.map((s, i) => `<li>${face(member(s.agent, a.project), online ? stepFace(s) : 'offline', 30)}<div><div class="name">${i + 1}. ${esc(agentName(s.agent, a.project))}${s.review ? `, ${esc(t('review'))}` : ''}</div><div class="hint">${esc(runState(s.status)[0])}${s.status === 'running' && a.stepStarted ? ` · ${ticking(a.stepStarted)}` : ''}</div></div></li>`);
  draw(`#${k}-steps`, JSON.stringify([online, statuses, a.stepStarted]), steps.join(''));
  draw(`#${k}-context`, JSON.stringify([a.agent, a.context]), a.agent ? `<div class="step-context">${agentContextMeter(a)}</div>` : '');
  const head = `${working ? face(working, faceState(working), 28) : ''}<div class="label">${esc(working ? t('Logbook: {agent} at work', { agent: t(working.name) }) : t('Logbook: preparing the working copy'))}</div>`;
  draw(`#${k}-head`, head, head);
  const before = $(`#${k}-logbook`);
  const atBottom = before.scrollHeight - before.scrollTop - before.clientHeight < 60 || !signatures[`#${k}-logbook`];
  const lines = a.actions.map(p => `<div><time>${clockTime(p.at)}</time><span class="${p.type === 'say' ? 'say' : ''}">${esc(p.text)}</span></div>`);
  // The server sends the last 80 actions: the signature looks at the newest one, not only at how many there are.
  const changed = draw(`#${k}-logbook`, JSON.stringify([a.actions.length, last?.at, last?.text]), lines.join('') || `<div><time></time><span>${esc(t('Preparing…'))}</span></div>`);
  if (changed && atBottom) before.scrollTop = before.scrollHeight;
}

function drawOperations() {
  const runs = going();
  const parallel = state.parallel?.max ?? 1;
  const head = runs.length > 1 || (runs.length && parallel > 1)
    ? `<div class="hint run-count">${esc(t('{count} of at most {max} runs at once, one per project.', { count: runs.length, max: parallel }))}</div>`
    : '';
  // With several runs, each logbook is shorter, so every run fits in view one after another.
  const skeleton = `${head}${runs.length ? `<div class="runs${runs.length > 1 ? ' several' : ''}">${runs.map(runBlock).join('')}</div>` : '<div class="panel" id="op-idle"></div>'}<div id="op-queue"></div><div id="op-sessions"></div>`;
  if (draw('#operations', JSON.stringify([runs.map(a => a.id), parallel]), skeleton)) {
    for (const key of Object.keys(signatures)) if (key.startsWith('#op-')) delete signatures[key];
  }
  drawQueue();
  drawSessions();
  if (!runs.length) {
    const next = nextMission();
    const crewLine = state.crew.map(x => `<span class="crew-chip">${face(x, faceState(x), 26, t(x.name))}<span class="hint">${esc(t(x.name))}</span></span>`).join('');
    const nextLine = next ? `<div class="hint">${esc(t('Next scheduled mission: {name}, {when} ({relative}).', { name: next.name, when: shortDate(next.next), relative: relative(next.next) }))}</div>` : '';
    const html = `<div class="empty">${esc(t('Nothing running. The crew is standing by.'))}</div>${nextLine}<div class="crew-line" style="margin-top:14px">${crewLine}</div>`;
    draw('#op-idle', JSON.stringify([online, state.crew.map(x => x.status), next?.next, Math.floor(Date.now() / 60000)]), html);
    return;
  }
  for (const a of runs) drawRun(a);
}

// ---------- Live sessions ----------

function sessionState(x) {
  if (x.status === 'login') return [t('Waiting for you to sign in'), 'warn'];
  if (x.alive) return [t('Open'), 'ok'];
  if (x.status === 'starting' || x.status === 'open') return [t('Opening…'), 'info'];
  return [t('Ended'), 'neutral'];
}

const sessionWhere = x => (x.project ? projectName(x.project) : x.folder ?? x.cwd ?? '');

/** The sessions open (process alive, memory, since when, End) and the profiles, each with its Open button. */
function drawSessions() {
  const s = state.sessions ?? { profiles: [], open: [] };
  const rows = s.open.map(x => `<tr>
      <td><span class="primary">${esc(x.name)}</span><span class="secondary">${esc([toolName(x.tool), sessionWhere(x), x.missing?.length ? t('not in the prompt builder: {list}', { list: x.missing.join(', ') }) : ''].filter(Boolean).join(' · '))}</span></td>
      <td>${stateHtml(sessionState(x))}</td>
      <td class="num">${x.status === 'login' ? '—' : ticking(x.started)}</td>
      <td class="num">${x.alive ? bytes(x.ram) : '—'}</td>
      <td class="row-actions"><button type="button" class="button danger small" data-session-end="${esc(x.id)}">${esc(x.status === 'login' ? t('Cancel') : t('End'))}</button></td>
    </tr>`);
  const profiles = s.profiles.map(p => `<div class="session-profile">
      <div><div class="name">${esc(p.name)}</div><div class="hint">${esc([toolName(p.tool), p.project ? projectName(p.project) : p.folder ?? '', p.blocks.length ? t('{count} block(s) of the prompt builder', { count: p.blocks.length }) : ''].filter(Boolean).join(' · '))}</div></div>
      <button type="button" class="button secondary small" data-session-open="${esc(p.id)}" title="${esc(p.blocks.join(', '))}">${esc(t('Open'))}</button>
    </div>`);
  const html = `<div class="label" style="margin-top:24px">${esc(t('Live sessions'))}</div>
    <div class="panel sessions">
      <p class="hint">${esc(t('A conversation with Claude Code or Codex in a window of its own, for work you do together, while the crew works in the background. It starts with the blocks of the prompt builder its profile names.'))}</p>
      ${rows.length ? `<table class="table"><thead><tr><th>${esc(t('Session'))}</th><th>${esc(t('Status'))}</th><th>${esc(t('Open for'))}</th><th>${esc(t('Memory'))}</th><th></th></tr></thead><tbody>${rows.join('')}</tbody></table>` : `<div class="empty">${esc(t('No session open.'))}</div>`}
      ${profiles.length ? `<div class="session-profiles">${profiles.join('')}</div>` : `<p class="hint">${esc(t('No session profiles yet: add them under "sessions" in the settings (see the README).'))}</p>`}
    </div>`;
  draw('#op-sessions', JSON.stringify([s.open.map(x => [x.id, x.status, x.alive, Math.round(x.ram / 1048576), x.started]), s.profiles]), html);
}

// ---------- Missions ----------

function drawMissions() {
  const html = state.missions.map(m => `
    <div class="panel mission">
      <div class="mission-top">
        <div><h2>${esc(m.name)}</h2><div class="hint">${esc(m.description ?? '')}</div></div>
        <button type="button" class="button" data-run="${esc(m.id)}">${esc(t('Run now'))}</button>
      </div>
      <dl class="facts">
        <dt>${esc(t('Project'))}</dt><dd>${esc(projectName(m.project))}</dd>
        <dt>${esc(t('Crew, in order'))}</dt><dd><div class="crew-line">${m.crew.map(id => `<span class="crew-chip">${face(member(id, m.project), 'still', 22)}${esc(agentName(id, m.project))}</span>`).join('<span class="arrow">→</span>')}</div></dd>
        <dt>${esc(t('Schedule'))}</dt><dd>${esc(m.schedule)}</dd>
        <dt>${esc(t('Next run'))}</dt><dd class="num">${m.next ? `${shortDate(m.next)} (${esc(relative(m.next))})` : '—'}</dd>
        <dt>${esc(t('Last run'))}</dt><dd>${m.last ? `${stateHtml(runState(m.last.status))} <span class="num hint">${shortDate(m.last.created)}</span>${m.last.pullRequest ? ` · <a href="${esc(m.last.pullRequest)}" target="_blank" rel="noopener">${esc(t('pull request'))}</a>` : ''}` : '—'}</dd>
      </dl>
    </div>`).join('') || `<div class="empty">${esc(t('No missions yet. Add one in config/chiefmate.json, or ask the manager.'))}</div>`;
  draw('#missions', html, html);
}

// ---------- Crew ----------

function drawCrew() {
  const cards = state.crew.map(a => {
    const status = agentStatus(a);
    const busy = online && a.status !== 'idle';
    let last = t('No work yet');
    if (a.last) last = a.last.chat ? t('Answered you {when}', { when: relative(a.last.at) }) : t('{when}: {title}', { when: relative(a.last.at), title: a.last.title });
    return `<article class="crew-card" style="--agent:${esc(a.color ?? '#8a93a0')}">
      ${face(a, faceState(a), 72, `${t(a.name)}: ${status[0]}`)}
      <div>
        <div class="crew-top"><div><h2>${esc(t(a.name))}</h2><div class="hint">${esc(t(a.title ?? ''))}</div></div><span class="model" title="${esc(a.model)}">${esc(shortModel(a.model))}</span></div>
        ${stateHtml(status)}
        ${busy ? `<div class="crew-now">${esc(agentDetail(a))}</div>` : ''}
        <p class="crew-role">${esc(t(a.role ?? ''))}</p>
        <dl class="facts">
          <dt>${esc(t('Last work'))}</dt><dd>${esc(last)}</dd>
          <dt>${esc(t('This week'))}</dt><dd>${esc(a.id === 'manager' ? t('{count} answer(s) · {steps} review(s)', { count: a.week.answers, steps: a.week.steps }) : t('{count} step(s) · {minutes} min', { count: a.week.steps, minutes: a.week.minutes }))}</dd>
          <dt>${esc(t('Time limit'))}</dt><dd class="num">${a.maxMinutes ? esc(t('{minutes} min per step', { minutes: a.maxMinutes })) : '—'}</dd>
        </dl>
        <div class="actions left">${a.id === 'manager' ? `<a href="#manager" class="button secondary small">${esc(t('Talk'))}</a>` : `<button type="button" class="button secondary small" data-assign="${esc(a.id)}">${esc(t('Assign a task'))}</button>`}</div>
      </div>
    </article>`;
  });
  const html = `<div class="crew-grid">${cards.join('')}</div>`;
  draw('#crew', html, html);
  drawTeams();
  drawPromptBuilder();
  if (!$('#task-project').options.length) {
    $('#task-project').innerHTML = state.projects.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
    fillTaskAgents();
  }
}

/** The task form's agents: the crew of the project chosen (its own, or the general crew). */
function fillTaskAgents() {
  const select = $('#task-agent');
  const kept = select.value;
  const team = state.teams?.find(x => x.project === $('#task-project').value);
  const members = team?.members ?? state.crew.filter(a => a.id !== 'manager');
  select.innerHTML = members.map(a => `<option value="${esc(a.id)}">${esc(t(a.name))}: ${esc(t(a.title ?? ''))}</option>`).join('');
  if (members.some(a => a.id === kept)) select.value = kept;
}

function drawTeams() {
  const teams = state.teams ?? [];
  const html = `<div class="teams">${teams.map(team => `
    <div class="team">
      <div class="team-top"><h3>${esc(team.name)}</h3><span class="hint">${esc(team.own ? t('Own crew') : t('General crew'))}</span></div>
      ${team.members.map(a => `<div class="team-member">${face(a, faceState(a), 30)}<div><div class="name">${esc(t(a.name))}</div><div class="hint">${esc([a.base && a.base !== a.id ? t('Based on {agent}', { agent: agentName(a.base) }) : t(a.title ?? ''), a.extra ? t('with instructions for this project') : '', (a.mcp ?? []).length ? t('tools: {list}', { list: a.mcp.join(', ') }) : ''].filter(Boolean).join(' · '))}</div></div>${stateHtml(agentStatus(a))}</div>`).join('') || `<div class="hint">${esc(t('No members.'))}</div>`}
    </div>`).join('')}</div>`;
  draw('#teams', html, html);
}

function drawPromptBuilder() {
  const p = state.prompts ?? {};
  let html = '';
  if (p.configured) {
    const copy = p.sync?.synced_at
      ? t('Copied from Google Docs on {when}.', { when: shortDate(p.sync.synced_at) })
      : p.exists ? t('Copy on this computer from {when}.', { when: shortDate(p.modified) }) : t('No copy on this computer yet: the steps use the projects\' notes.');
    html = `<div class="panel">
      <div class="label">${esc(t('Prompt builder'))}</div>
      <p>${esc(copy)}${p.environment ? ` ${esc(t('Environment: {name}.', { name: p.environment }))}` : ''}</p>
      ${p.sync?.ok === false ? `<p>${stateHtml([p.sync.error, 'error'])}</p>` : ''}
      <div class="actions left"><button type="button" class="button secondary small" data-prompts-sync ${p.syncing || !p.docId || !p.cdp ? 'disabled' : ''}>${esc(p.syncing ? t('Copying…') : t('Copy from Google Docs'))}</button>
      ${!p.docId || !p.cdp ? `<span class="hint">${esc(t('Needs "prompt_builder.doc_id" and "browser_cdp" in the settings.'))}</span>` : ''}</div>
    </div>`;
  }
  draw('#prompt-builder', html, html);
}

// ---------- Log ----------

function allRuns() {
  const list = [...going(), ...state.queue, ...state.history];
  const seen = new Set();
  return list.filter(r => !seen.has(r.id) && seen.add(r.id)).sort((x, y) => (y.created ?? '').localeCompare(x.created ?? ''));
}

function drawLog() {
  const list = allRuns();
  const rows = list.map(r => {
    const details = [r.kind === 'mission' ? t('Mission') : t('Task'), projectName(r.project), originLabel(r.origin), r.pullRequest ? t('pull request opened') : ''].filter(Boolean).join(' · ');
    return `<tr class="clickable${r.id === selectedRun ? ' selected' : ''}" data-select="${esc(r.id)}">
      <td class="num">${shortDate(r.created)}</td>
      <td><span class="primary">${esc(r.title)}</span><span class="secondary">${esc(details)}</span></td>
      <td>${stateHtml(runLabel(r))}</td>
      <td class="num">${r.started ? esc(elapsed(r.started, r.ended ?? Date.now())) : '—'}</td>
    </tr>`;
  });
  const html = list.length
    ? `<table class="table"><thead><tr><th>${esc(t('Date'))}</th><th>${esc(t('Run'))}</th><th>${esc(t('Status'))}</th><th>${esc(t('Time'))}</th></tr></thead><tbody>${rows.join('')}</tbody></table>`
    : `<div class="empty">${esc(t('No runs yet.'))}</div>`;
  draw('#log-list', JSON.stringify([selectedRun, list.map(r => [r.id, r.status, r.ended, r.pullRequest, r.needsYou]), Math.floor(Date.now() / 60000)]), html);
}

async function refreshDetail(force = false) {
  if (!selectedRun) {
    draw('#log-detail', 'none', `<div class="empty">${esc(t("Pick a run to see each step's report."))}</div>`);
    return;
  }
  const brief = allRuns().find(r => r.id === selectedRun);
  const stale = force || !detail || detail.id !== selectedRun || ['running', 'queued', 'waiting'].includes(brief?.status) || detail.status !== brief?.status;
  if (stale) {
    try {
      detail = await api(`/api/run/${encodeURIComponent(selectedRun)}`);
    } catch (error) {
      draw('#log-detail', 'error', `<div class="empty">${esc(error.message)}</div>`);
      return;
    }
  }
  const r = detail;
  const steps = [...r.steps, ...(r.review ? [{ ...r.review, review: true }] : [])];
  const canResume = ['paused', 'waiting', 'failed', 'canceled'].includes(r.status);
  const canCancel = ['running', 'queued', 'waiting', 'paused'].includes(r.status);
  const reports = steps.map((s, i) => {
    const facts = [s.model ? shortModel(s.model) : '', s.durationMs ? t('{minutes} min', { minutes: Math.round(s.durationMs / 60000) }) : '', s.turns ? t('{count} turns', { count: s.turns }) : '', s.subagents ? t('{count} subagent(s)', { count: s.subagents }) : ''].filter(Boolean);
    let body = s.report || s.error;
    if (!body) body = s.status === 'pending' ? t('Not started yet.') : s.status === 'running' ? t('Working…') : t('No report.');
    return `
      <div class="report">
        <div class="report-top"><div class="report-who">${face(member(s.agent, r.project), stepFace(s), 26)}<strong>${i + 1}. ${esc(agentName(s.agent, r.project))}${s.review ? `, ${esc(t('review'))}` : ''}</strong></div>${stateHtml(runState(s.status))}</div>
        <div class="hint num">${facts.map(esc).join(' · ')}${s.status !== 'pending' ? ` · <button type="button" class="button secondary small" data-context="${esc(r.id)}" data-step="${i + 1}">${esc(t('Context received'))}</button>` : ''}</div>
        <div class="body">${md(body)}</div>
      </div>`;
  });
  // What the crew asked of the owner during the run.
  const requests = (r.requests ?? []).length
    ? `<div class="report"><div class="report-top"><strong>${esc(t('Asked of you'))}</strong></div>${r.requests.map(q => `<div>${stateHtml(q.status === 'open' ? [t('Waiting for your action'), 'warn'] : [t('Done'), 'ok'])} ${esc(q.what)}${q.url ? ` · <a href="${esc(q.url)}" target="_blank" rel="noopener">${esc(t('Open the address'))}</a>` : ''}${q.status === 'open' ? ` <button type="button" class="button small" data-needs-done="${esc(r.id)}" data-request="${esc(q.id)}">${esc(t('Mark as done'))}</button>` : ''}</div>`).join('')}</div>`
    : '';
  const checks = r.checks?.length
    ? `<div class="report"><div class="report-top"><strong>${esc(t('Checks'))}</strong></div>${r.checks.map(c => `<div>${stateHtml(c.ok ? [t('Passed'), 'ok'] : [t('Failed'), 'error'])} <code>${esc(c.command)}</code></div>`).join('')}</div>`
    : '';
  const html = `
    <h2>${esc(r.title)}</h2>
    <div class="hint">${stateHtml(runLabel({ ...r, needsYou: (r.requests ?? []).filter(x => x.status === 'open').length }))} · <span class="num">${shortDate(r.created)}</span> · ${esc(projectName(r.project))} · ${esc(originLabel(r.origin))}${r.started ? ` · <span class="num">${esc(elapsed(r.started, r.ended ?? Date.now()))}</span>` : ''}</div>
    ${r.result ? `<p>${esc(r.result)}</p>` : ''}${r.note ? `<p class="hint">${esc(r.note)}</p>` : ''}
    ${r.instruction ? `<p class="hint">${esc(t('Instruction: {text}', { text: r.instruction }))}</p>` : ''}
    <div class="actions left">
      ${r.pullRequest ? `<a class="button" href="${esc(r.pullRequest)}" target="_blank" rel="noopener">${esc(t('Open pull request'))}</a>` : ''}
      ${canResume ? `<button type="button" class="button secondary" data-resume="${esc(r.id)}">${esc(t('Resume'))}</button>` : ''}
      ${r.status === 'paused' ? `<button type="button" class="button secondary" data-resume="${esc(r.id)}" data-ignore>${esc(t('Resume past the limit'))}</button>` : ''}
      ${canCancel ? `<button type="button" class="button danger" data-cancel="${esc(r.id)}">${esc(t('Cancel'))}</button>` : ''}
    </div>
    ${requests}${reports.join('')}${checks}`;
  draw('#log-detail', JSON.stringify([r.id, r.updated, r.status]), html);
}

// ---------- Usage ----------

function drawUsage() {
  const { limits: l, account: u } = state.usage;
  const resets = w => (w?.resets ? t('Resets {when} ({relative}).', { when: shortDate(w.resets), relative: relative(w.resets) }) : '');
  const measured = u.updated
    ? t('Measured {when}, from what Claude Code reports on every run.', { when: shortDate(u.updated) })
    : t('Measured on the next agent run, from what Claude Code reports.');
  const html = `<div class="usage-grid">
    <div class="panel">
      <div class="label">${esc(t('Your Claude account'))}</div>
      ${meter(t('5-hour window'), u.five_hour?.used, percent(u.five_hour?.used), esc(resets(u.five_hour)))}
      ${meter(t("Plan's week"), u.seven_day?.used, percent(u.seven_day?.used), esc(resets(u.seven_day)))}
      <div class="hint">${esc(measured)}</div>
    </div>
    <div class="panel">
      <div class="label">${esc(t('How Chiefmate looks after your plan'))}</div>
      <p class="hint">${esc(t("Before every step, Chiefmate checks your account. If the 5-hour window is above {window} or the plan's week above {week}, the run waits for the reset and then carries on by itself.", { window: percent(l.pause_at_5h_window), week: percent(l.pause_at_plan_week) }))}</p>
      <p class="hint">${esc(t('If the account runs out in the middle of a step, that step starts over after the reset. Each step also has a time limit, in case an agent gets stuck.'))}</p>
    </div>
  </div>`;
  draw('#usage', html, html);
  const form = $('#limits-form');
  if (!form.contains(document.activeElement) && !form.dataset.filled) {
    form.window.value = Math.round((l.pause_at_5h_window ?? 0.85) * 100);
    form.week.value = Math.round((l.pause_at_plan_week ?? 0.9) * 100);
    form.dataset.filled = '1';
  }
}

// ---------- Projects on this computer ----------

const expanded = new Set();

function projectState(p) {
  if (p.agent) return [p.running ? t('Crew at work, and running on this computer') : t('Crew at work'), 'info'];
  if (p.running) return [t('Running on this computer'), 'ok'];
  if (p.session) return [t('Live session'), 'info'];
  if (p.queued) return [t('In the queue'), 'neutral'];
  return [t('Stopped'), 'neutral'];
}

function processRows(p) {
  const flag = x => (x.crew ? t('crew') : x.session ? t('session') : x.guarded ? t('kept') : '');
  const rows = p.processes.map(x =>
    `<tr><td>${esc(x.name)}${flag(x) ? ` <span class="hint">· ${esc(flag(x))}</span>` : ''}</td><td class="num">${x.pid}</td><td class="num">${bytes(x.ram)}</td><td class="command">${esc(x.command)}</td></tr>`);
  return `<tr class="processes"><td colspan="4"><table class="table inner"><thead><tr><th>${esc(t('Process'))}</th><th>PID</th><th>${esc(t('Memory'))}</th><th>${esc(t('Command line'))}</th></tr></thead><tbody>${rows.join('')}</tbody></table></td></tr>`;
}

function drawComputer() {
  const c = state.computer;
  const notes = [
    c.supported ? '' : t("The projects' processes are read on Windows only."),
    c.error ? t("Couldn't read the processes: {error}", { error: c.error }) : '',
  ].filter(Boolean);
  const rows = c.projects.map(p => {
    const has = p.processes.length > 0;
    const open = has && expanded.has(p.id);
    const canStop = p.processes.some(x => !x.crew && !x.guarded);
    return `<tr class="${has ? 'clickable' : ''}${open ? ' selected' : ''}"${has ? ` data-expand="${esc(p.id)}"` : ''}>
      <td><span class="primary">${has ? (open ? '▾ ' : '▸ ') : ''}${esc(p.name)}</span><span class="secondary">${esc(t('{count} process(es)', { count: p.processes.length }))}</span></td>
      <td>${stateHtml(projectState(p))}</td>
      <td class="num">${p.ram ? bytes(p.ram) : '—'}</td>
      <td class="row-actions">${canStop ? `<button type="button" class="button danger small" data-stop="${esc(p.id)}">${esc(t('Stop'))}</button>` : ''}</td>
    </tr>${open ? processRows(p) : ''}`;
  });
  const html = `<div class="usage-grid">
      <div class="panel">
        <div class="label">${esc(t('This computer'))}</div>
        ${meter(t('Memory in use'), 1 - c.memory.free / c.memory.total, t('{free} free of {total}', { free: bytes(c.memory.free), total: bytes(c.memory.total) }))}
        <dl class="facts">
          <dt>${esc(t('Chiefmate itself'))}</dt><dd class="num">${bytes(c.chiefmate.ram)}</dd>
          <dt>${esc(t('Processes read'))}</dt><dd class="num">${c.measured ? clockTime(c.measured) : '—'}</dd>
        </dl>
        ${notes.map(n => `<div class="hint">${esc(n)}</div>`).join('')}
      </div>
      <div class="panel">
        <div class="label">${esc(t('How it works'))}</div>
        <p class="hint">${esc(t("A project is running when a process's command line or program is in one of its folders: your clone, Documents/GitHub/<repository> or its working copy in workspaces. What that process started counts too. Read every 15 seconds while the app is open."))}</p>
        <p class="hint">${esc(t('Stop ends the processes of a project after you confirm the list. Chiefmate and the crew at work are never stopped: to stop the crew, cancel the run.'))}</p>
      </div>
    </div>
    <table class="table" style="margin-top:20px"><thead><tr><th>${esc(t('Project'))}</th><th>${esc(t('Status'))}</th><th>${esc(t('Memory'))}</th><th></th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
  draw('#computer', html, html);
}

// ---------- The plan's free resets and the claude.ai reading ----------

function paceText(p) {
  if (!p) return t("No pace yet: the plan's week is measured on the next agent run.");
  const values = { used: percent(p.used), elapsed: percent(p.elapsed), points: Math.round(Math.abs(p.margin) * 100) };
  if (p.status === 'slack') return t('{used} of the week used with {elapsed} of it gone: {points} points of slack.', values);
  if (p.status === 'even') return t('{used} of the week used with {elapsed} of it gone: right on pace.', values);
  return t('{used} of the week used with only {elapsed} of it gone: {points} points ahead of pace.', values);
}

function readerPanel(reader) {
  const status = reader.status ?? {};
  let line = reader.enabled ? t('On, every {hours} h.', { hours: reader.everyHours }) : t('Off.');
  if (!reader.signedIn) line += ` ${t('Not signed in yet: run node src/cli.mjs claude-login.')}`;
  if (reader.reading) line += ` ${t('Reading now…')}`;
  const read = [];
  if (status.read_at) read.push(t('Last read {when}: session {session}, week {week}.', { when: shortDate(status.read_at), session: percent(status.five_hour), week: percent(status.seven_day) }));
  if (status.error) read.push(t('The last attempt failed ({when}): {error}', { when: shortDate(status.attempted), error: status.error }));
  else if (status.warning) read.push(status.warning);
  return `<div class="panel">
      <div class="label">${esc(t('Reading claude.ai (optional)'))}</div>
      <p>${esc(line)}</p>
      ${read.map(r => `<p class="hint">${esc(r)}</p>`).join('')}
      ${status.excerpt?.length ? `<details><summary class="hint">${esc(t('What was read'))}</summary><pre>${esc(status.excerpt.join('\n'))}</pre></details>` : ''}
      <p class="hint">${esc(t("When on, Chiefmate itself (never an agent) opens your account's usage page every few hours, with no window, in a browser profile of its own, and only reads it: it never clicks anything on your account. It updates the free resets when the page shows them. See the risks in the README."))}</p>
      <div class="actions left">
        <button type="button" class="button secondary small" data-reader="${reader.enabled ? 'off' : 'on'}">${esc(reader.enabled ? t('Turn off') : t('Turn on'))}</button>
        ${reader.signedIn ? `<button type="button" class="button secondary small" data-reader="now"${reader.reading ? ' disabled' : ''}>${esc(t('Read now'))}</button>` : ''}
      </div>
    </div>`;
}

function drawPlan() {
  const { resets, pace, reader } = state.plan;
  const resetState = g => (g.used ? [t('Used'), 'neutral'] : g.available ? [t('Available'), 'ok'] : [t('Expired'), 'neutral']);
  const rows = resets.map(g => `<tr>
      <td class="num">${g.index}</td>
      <td class="num">${g.expires ? `${shortDate(g.expires)}${g.available ? ` (${esc(relative(g.expires))})` : ''}` : esc(t('unknown'))}</td>
      <td>${stateHtml(resetState(g))}</td>
      <td>${esc(g.note ?? '')}${g.source === 'claude.ai' ? `<span class="secondary">${esc(t('read on claude.ai'))}</span>` : ''}</td>
      <td class="row-actions">${g.available ? `<button type="button" class="button secondary small" data-reset-used="${g.index}">${esc(t('Mark used'))}</button>` : ''}<button type="button" class="button danger small" data-reset-remove="${g.index}">${esc(t('Remove'))}</button></td>
    </tr>`);
  const html = `<div class="usage-grid" style="margin-top:20px">
      <div class="panel">
        <div class="label">${esc(t("The plan's free resets"))}</div>
        ${meter(t("The week's pace"), pace?.used, pace ? t('{used} used · {elapsed} of the week gone', { used: percent(pace.used), elapsed: percent(pace.elapsed) }) : '—')}
        <p class="hint">${esc(paceText(pace))}</p>
        ${resets.length ? `<table class="table"><thead><tr><th>#</th><th>${esc(t('Expires'))}</th><th>${esc(t('Status'))}</th><th>${esc(t('Note'))}</th><th></th></tr></thead><tbody>${rows.join('')}</tbody></table>` : `<div class="empty">${esc(t('No free resets recorded.'))}</div>`}
        <p class="hint">${esc(t("Claude Code doesn't report them: record them below or with node src/cli.mjs reset-grant. You get an alert when the week passes 90% with one available, and 3 days and 1 day before one expires unused."))}</p>
      </div>
      ${readerPanel(reader)}
    </div>`;
  draw('#plan', html, html);
}

// ---------- Planning ----------

const priorityLabel = p => ({ high: t('High'), medium: t('Medium'), low: t('Low') })[p] ?? p;
function planState(status) {
  switch (status) {
    case 'future': return [t('Future'), 'neutral'];
    case 'todo': return [t('To do'), 'neutral'];
    case 'queued': return [t('Queued'), 'info'];
    case 'in_progress': return [t('In progress'), 'info'];
    case 'waiting_owner': return [t('Waiting for your action'), 'warn'];
    case 'done': return [t('Completed'), 'ok'];
    default: return [status ?? '', 'neutral'];
  }
}
const planFilter = { project: '', priority: '', status: 'open', sort: 'priority' };
let editingItem = null; // the item being edited in place: the list is not redrawn meanwhile
const planOptions = (list, selected) => list.map(([value, label]) => `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${esc(label)}</option>`).join('');
const planItemsNow = () => state?.planning?.items ?? [];
const waitingItems = () => planItemsNow().filter(i => !i.archived && i.status === 'waiting_owner');

/** The projects in the settings, then any other name the items use (from the board the manager kept before). */
function planProjects() {
  const list = state.projects.map(p => [p.id, p.name ?? p.id]);
  for (const i of planItemsNow()) if (i.project && !list.some(([id]) => id === i.project)) list.push([i.project, i.project]);
  return list;
}

function prLink(pr) {
  if (!pr) return '';
  const number = /\/pull\/(\d+)/.exec(pr)?.[1];
  const text = number ? `PR #${number}` : pr;
  return /^https?:\/\//.test(pr) ? `<a href="${esc(pr)}" target="_blank" rel="noopener">${esc(text)}</a>` : esc(text);
}

function planLinks(i) {
  const parts = [];
  if (i.run) parts.push(`<a href="#log" data-select="${esc(i.run)}" class="num">${esc(i.run)}</a>${i.run_status ? ` ${stateHtml(runState(i.run_status))}` : ''}`);
  if (i.pr) parts.push(prLink(i.pr));
  return parts.map(p => `<div>${p}</div>`).join('') || '<span class="hint">—</span>';
}

function planRow(i) {
  if (editingItem === i.id) {
    return `<tr class="plan-row editing" data-item="${i.id}"><td class="num">#${i.id}</td><td colspan="6">
      <div class="fields">
        <label><span>${esc(t('Title'))}</span><input data-edit="title" type="text" maxlength="200" value="${esc(i.title)}"></label>
        <label><span>${esc(t('Project'))}</span><select data-edit="project">${planOptions(planProjects(), i.project)}</select></label>
      </div>
      <label><span>${esc(t('Description (optional)'))}</span><textarea data-edit="description" rows="3" maxlength="4000">${esc(i.description ?? '')}</textarea></label>
      <div class="fields">
        <label><span>${esc(t('Run (optional)'))}</span><input data-edit="run" type="text" maxlength="80" value="${esc(i.run ?? '')}"></label>
        <label><span>${esc(t('Pull request (optional)'))}</span><input data-edit="pr" type="text" maxlength="300" value="${esc(i.pr ?? '')}"></label>
      </div>
      <div class="actions left"><button type="button" class="button small" data-plan-save="${i.id}">${esc(t('Save'))}</button><button type="button" class="button secondary small" data-plan-cancel>${esc(t('Cancel'))}</button></div>
    </td></tr>`;
  }
  const dates = t('Created {created} · updated {updated}', { created: shortDate(i.created), updated: shortDate(i.updated) });
  const priorities = state.planning.priorities.map(p => [p, priorityLabel(p)]);
  const statuses = state.planning.statuses.map(s => [s, planState(s)[0]]);
  return `<tr class="plan-row plan-${esc(i.status)}${i.archived ? ' archived' : ''}" data-item="${i.id}">
    <td class="num">#${i.id}</td>
    <td><span class="primary">${esc(i.title)}</span>${i.description ? `<span class="secondary plan-description">${esc(i.description)}</span>` : ''}<span class="secondary">${esc(dates)}${i.archived ? ` · ${esc(t('archived {when}', { when: shortDate(i.archived) }))}` : ''}</span></td>
    <td>${esc(projectName(i.project))}</td>
    <td><select class="inline-select priority-${esc(i.priority)}" data-plan-field="priority" aria-label="${esc(t('Priority'))}">${planOptions(priorities, i.priority)}</select></td>
    <td><select class="inline-select state-${planState(i.status)[1]}" data-plan-field="status" aria-label="${esc(t('Status'))}">${planOptions(statuses, i.status)}</select></td>
    <td>${planLinks(i)}</td>
    <td class="row-actions"><div class="plan-actions">${i.archived
      ? `<button type="button" class="button secondary small" data-plan-restore="${i.id}">${esc(t('Restore'))}</button>`
      : `<button type="button" class="button secondary small" data-plan-edit="${i.id}">${esc(t('Edit'))}</button><button type="button" class="button secondary small" data-plan-archive="${i.id}">${esc(t('Archive'))}</button>`}</div></td>
  </tr>`;
}

function visibleItems() {
  const f = planFilter;
  const list = planItemsNow().filter(i =>
    (f.status === 'archived' ? !!i.archived : !i.archived)
    && (f.status === 'open' ? i.status !== 'done' : ['all', 'archived'].includes(f.status) || i.status === f.status)
    && (!f.project || i.project === f.project) && (!f.priority || i.priority === f.priority));
  if (f.sort === 'updated') list.sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? ''));
  else if (f.sort === 'number') list.sort((a, b) => a.id - b.id);
  return list; // "priority": the server's order (priority, then what needs you, then the number)
}

function drawPlanning(force = false) {
  if (!state?.planning) return;
  const items = planItemsNow();
  const waiting = waitingItems();
  draw('#counter-planning', String(waiting.length), waiting.length ? String(waiting.length) : '');
  $('#counter-planning').parentElement.title = waiting.length ? t('{count} item(s) waiting for you', { count: waiting.length }) : '';

  const highlight = waiting.length
    ? `<div class="panel plan-waiting"><div class="label">${esc(t('Waiting for you ({count})', { count: waiting.length }))}</div><ul>${waiting.map(i =>
      `<li><span class="num">#${i.id}</span> <span class="hint">${esc(projectName(i.project))}</span> <span class="primary">${esc(i.title)}</span>${i.pr ? ` · ${prLink(i.pr)}` : ''}</li>`).join('')}</ul></div>`
    : '';
  draw('#planning-waiting', highlight, highlight);

  const projects = planProjects();
  const filters = `<label><span>${esc(t('Project'))}</span><select data-plan-filter="project">${planOptions([['', t('All projects')], ...projects], planFilter.project)}</select></label>
    <label><span>${esc(t('Priority'))}</span><select data-plan-filter="priority">${planOptions([['', t('All priorities')], ...state.planning.priorities.map(p => [p, priorityLabel(p)])], planFilter.priority)}</select></label>
    <label><span>${esc(t('Status'))}</span><select data-plan-filter="status">${planOptions([['open', t('Open (not completed)')], ['all', t('All')], ...state.planning.statuses.map(s => [s, planState(s)[0]]), ['archived', t('Archived')]], planFilter.status)}</select></label>
    <label><span>${esc(t('Order'))}</span><select data-plan-filter="sort">${planOptions([['priority', t('By priority')], ['updated', t('Recently updated')], ['number', t('By number')]], planFilter.sort)}</select></label>`;
  if (!$('#planning-filters').contains(document.activeElement)) draw('#planning-filters', filters, filters);

  // The form's lists: filled again only when the projects change, so what you chose stays.
  const formProjects = projects.map(([id]) => id).join('|');
  if ($('#plan-project').dataset.list !== formProjects) {
    const chosen = $('#plan-project').value;
    $('#plan-project').innerHTML = planOptions(projects, chosen || projects[0]?.[0]);
    $('#plan-project').dataset.list = formProjects;
  }
  if (!$('#plan-priority').options.length) $('#plan-priority').innerHTML = planOptions(state.planning.priorities.map(p => [p, priorityLabel(p)]), 'medium');
  if (!$('#plan-status').options.length) $('#plan-status').innerHTML = planOptions(state.planning.statuses.map(s => [s, planState(s)[0]]), 'todo');

  // Not while you edit an item or have one of its lists open.
  if (!force && (editingItem !== null || $('#planning-list').contains(document.activeElement))) return;
  const list = visibleItems();
  const empty = items.length ? t('No item matches these filters.') : t('The board is empty. Add the first item below, or ask the manager.');
  const html = list.length
    ? `<table class="table plan-table"><thead><tr><th>#</th><th>${esc(t('Item'))}</th><th>${esc(t('Project'))}</th><th>${esc(t('Priority'))}</th><th>${esc(t('Status'))}</th><th>${esc(t('Run or PR'))}</th><th></th></tr></thead><tbody>${list.map(planRow).join('')}</tbody></table>`
    : `<div class="empty">${esc(empty)}</div>`;
  if (force) delete signatures['#planning-list'];
  draw('#planning-list', html, html);
}

$('#planning-filters').addEventListener('change', event => {
  const key = event.target.dataset.planFilter;
  if (!key) return;
  planFilter[key] = event.target.value;
  event.target.blur();
  drawPlanning(true);
});

async function changeItem(body, done) {
  try {
    await api('/api/planning', body);
    if (done) toast(done);
  } catch (error) {
    toast(error.message);
  }
  if (document.activeElement && $('#planning-list').contains(document.activeElement)) document.activeElement.blur();
  await refresh();
  drawPlanning(true);
}

$('#planning-list').addEventListener('change', event => {
  const field = event.target.dataset.planField;
  const row = event.target.closest('[data-item]');
  if (!field || !row) return;
  changeItem({ action: 'set', id: Number(row.dataset.item), [field]: event.target.value });
});

$('#planning-list').addEventListener('click', event => {
  const button = event.target.closest('[data-plan-edit],[data-plan-save],[data-plan-cancel],[data-plan-archive],[data-plan-restore]');
  if (!button) return;
  const { planEdit, planSave, planArchive, planRestore } = button.dataset;
  if (planEdit) {
    editingItem = Number(planEdit);
    drawPlanning(true);
    $('#planning-list [data-edit="title"]')?.focus();
  } else if (planSave) {
    const row = button.closest('[data-item]');
    const body = { action: 'set', id: Number(planSave) };
    for (const input of row.querySelectorAll('[data-edit]')) body[input.dataset.edit] = input.value;
    api('/api/planning', body).then(
      () => {
        editingItem = null;
        toast(t('Item saved.'));
        return refresh().then(() => drawPlanning(true));
      },
      error => toast(error.message),
    );
  } else if (planArchive) changeItem({ action: 'archive', id: Number(planArchive) }, t('Archived. It is under the "Archived" filter.'));
  else if (planRestore) changeItem({ action: 'restore', id: Number(planRestore) }, t('Back on the board.'));
  else {
    editingItem = null;
    drawPlanning(true);
  }
});

$('#plan-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.target.elements; // "elements": a form's own "title" would hide the field's
  const body = { action: 'add', project: form.project.value, title: form.title.value, description: form.description.value, priority: form.priority.value, status: form.status.value };
  if (form.run.value.trim()) body.run = form.run.value;
  if (form.pr.value.trim()) body.pr = form.pr.value;
  try {
    const { item } = await api('/api/planning', body);
    for (const name of ['title', 'description', 'run', 'pr']) form[name].value = '';
    toast(t('Item #{id} added.', { id: item.id }));
    await refresh();
    drawPlanning(true);
  } catch (error) {
    toast(error.message);
  }
});

// ---------- Cycle ----------

function drawOffline() {
  online = false;
  drawPresence();
  drawFocus();
  drawAlerts();
  drawStatusbar();
  drawTitle();
  if (state) {
    drawCounters();
    drawBridge();
    drawOperations();
    $('#send').disabled = true;
    $('#interrupt').hidden = true;
  }
}

/** Something is being written, or a dialog is open: loading the app again now would lose it. */
function writing() {
  const field = document.activeElement;
  return (
    !!document.querySelector('dialog[open]') ||
    $('#message').value.trim() !== '' ||
    (['INPUT', 'TEXTAREA'].includes(field?.tagName) && field.value.trim() !== '')
  );
}

async function refresh() {
  let next;
  try {
    next = await api('/api/state');
  } catch {
    drawOffline();
    return;
  }
  if (!started) {
    await setLanguage(next.language);
    translatePage();
    drawSuggestions();
    drawClock();
    started = true;
    serverStarted = next.started;
  } else if ((next.language || 'en') !== language()) {
    location.reload();
    return;
  } else if (next.started !== serverStarted && !writing()) {
    // A new Chiefmate (after an update or a restart) brings its own app: load it.
    location.reload();
    return;
  }
  state = next;
  online = true;
  if (state.now) skew = new Date(state.now).getTime() - Date.now();
  $('#version').textContent = `Chiefmate ${state.version}`;
  drawPresence();
  drawFocus();
  drawAlerts();
  drawCounters();
  drawTitle();
  drawStatusbar();
  drawChat();
  drawBridge();
  drawSituation();
  drawOperations();
  drawMissions();
  drawCrew();
  drawLog();
  drawUsage();
  drawComputer();
  drawPlan();
  drawPlanning();
  tickClocks();
  if (currentView() === 'log') refreshDetail();
}

// ---------- Actions ----------

async function sendMessage(text) {
  const message = text.trim();
  if (!message) return;
  try {
    const sent = await api('/api/manager', { message });
    $('#message').value = '';
    if (sent.queued) toast(t('In the queue: it goes when the manager finishes this answer.'));
    setTimeout(refresh, 300);
  } catch (error) {
    toast(error.message);
  }
}

$('#interrupt').addEventListener('click', async () => {
  const waiting = state?.manager.pending?.length ?? 0;
  const text = `${t('The manager stops what it is doing now. The conversation goes on in the same session, and your next message tells it the answer was interrupted.')}${waiting ? ` ${t('The {count} message(s) in the queue go right after.', { count: waiting })}` : ''}`;
  if (!(await confirmDialog(t('Interrupt the answer'), text, t('Interrupt')))) return;
  try {
    const r = await api('/api/manager/interrupt', {});
    if (!r.interrupted) toast(t('The manager had already finished.'));
  } catch (error) {
    toast(error.message);
  }
  refresh();
});

// The queue: edit a message in place, or take it out.
$('#chat-queue').addEventListener('click', async event => {
  const button = event.target.closest('[data-pending-edit],[data-pending-remove],[data-pending-save],[data-pending-cancel]');
  if (!button) return;
  const { pendingEdit, pendingRemove, pendingSave } = button.dataset;
  const stopEditing = () => {
    editingPending = null;
    delete signatures['#chat-queue'];
    drawChatQueue();
  };
  try {
    if (pendingEdit) {
      if (editingPending) stopEditing();
      const item = state.manager.pending.find(m => m.id === pendingEdit);
      const box = $(`#chat-queue [data-pending="${CSS.escape(pendingEdit)}"]`);
      if (!item || !box) return;
      editingPending = pendingEdit;
      box.querySelector('.msg-body').innerHTML = `<textarea rows="3"></textarea><div class="actions left"><button type="button" class="button small" data-pending-save="${esc(item.id)}">${esc(t('Save'))}</button><button type="button" class="button secondary small" data-pending-cancel>${esc(t('Cancel'))}</button></div>`;
      const area = box.querySelector('textarea');
      area.value = item.text;
      area.focus();
    } else if (pendingSave) {
      const text = $(`#chat-queue [data-pending="${CSS.escape(pendingSave)}"] textarea`)?.value ?? '';
      await api('/api/manager/edit', { id: pendingSave, message: text });
      editingPending = null;
      await refresh();
    } else if (pendingRemove) {
      if (editingPending === pendingRemove) editingPending = null;
      await api('/api/manager/remove', { id: pendingRemove });
      await refresh();
    } else stopEditing();
  } catch (error) {
    toast(error.message);
    if (pendingSave || pendingRemove) {
      editingPending = null;
      await refresh();
    }
  }
});

$('#manager-form').addEventListener('submit', event => {
  event.preventDefault();
  sendMessage($('#message').value);
});
$('#message').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendMessage($('#message').value);
  }
});

$('#new-conversation').addEventListener('click', async () => {
  const ok = await confirmDialog(t('New conversation'), t('The manager forgets this conversation and starts another one. Its notes about your preferences stay.'), t('Start a new one'));
  if (!ok) return;
  await api('/api/new-conversation', {}).catch(error => toast(error.message));
  refresh();
});

$('#task-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.target;
  try {
    await api('/api/task', { agent: form.agent.value, project: form.project.value, instruction: form.instruction.value, review: form.review.checked });
    form.instruction.value = '';
    toast(t('Task queued.'));
    location.hash = '#operations';
    refresh();
  } catch (error) {
    toast(error.message);
  }
});

$('#task-project').addEventListener('change', fillTaskAgents);

$('#reset-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.target;
  try {
    await api('/api/reset-grants', { action: 'add', expires: form.expires.value, note: form.note.value });
    form.reset();
    toast(t('Free reset recorded.'));
    refresh();
  } catch (error) {
    toast(error.message);
  }
});

/** Shows what would stop, asks, and stops only what you saw. */
async function stopProject(id) {
  const { processes } = await api('/api/stop-project', { project: id, preview: true });
  if (!processes.length) return toast(t('Nothing of this project to stop.'));
  const shown = processes.slice(0, 12).map(x => `${x.name} (PID ${x.pid}, ${bytes(x.ram)})`);
  if (processes.length > shown.length) shown.push(t('and {count} more', { count: processes.length - shown.length }));
  const ok = await confirmDialog(
    t('Stop {project}', { project: projectName(id) }),
    `${t('These {count} process(es) will be ended, and anything unsaved in them is lost. Chiefmate and the crew at work are never stopped.', { count: processes.length })}\n\n${shown.join('\n')}`,
    t('Stop them'),
  );
  if (!ok) return;
  const { stopped } = await api('/api/stop-project', { project: id, pids: processes.map(x => x.pid) });
  toast(t('{count} process(es) stopped.', { count: stopped.length }));
}

$('#limits-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.target;
  try {
    await api('/api/limits', {
      pause_at_5h_window: Number(form.window.value) / 100,
      pause_at_plan_week: Number(form.week.value) / 100,
    });
    toast(t('Limits saved.'));
    refresh();
  } catch (error) {
    toast(error.message);
  }
});

document.addEventListener('click', async event => {
  const target = event.target.closest('[data-run],[data-assign],[data-select],[data-cancel],[data-resume],[data-suggestion],[data-stop],[data-expand],[data-reset-used],[data-reset-remove],[data-reader],[data-needs-done],[data-needs-session],[data-context],[data-prompts-sync],[data-session-open],[data-session-end]');
  if (!target) return;
  try {
    if (target.dataset.run) {
      const mission = state.missions.find(m => m.id === target.dataset.run);
      const ok = await confirmDialog(
        t('Run mission'),
        t('Run "{name}" now? The crew works in sequence and, at the end, opens a pull request for you to approve.', { name: mission?.name ?? '' }),
        t('Run it'),
      );
      if (!ok) return;
      await api('/api/mission', { mission: target.dataset.run });
      toast(t('Mission queued.'));
      location.hash = '#operations';
    } else if (target.dataset.assign) {
      if (![...$('#task-agent').options].some(o => o.value === target.dataset.assign)) {
        const home = state.teams?.find(x => x.members.some(a => a.id === target.dataset.assign));
        if (home) $('#task-project').value = home.project;
        fillTaskAgents();
      }
      $('#task-agent').value = target.dataset.assign;
      $('#task-form').scrollIntoView({ behavior: 'smooth' });
      $('#task-form').instruction.focus();
    } else if (target.dataset.select) {
      selectedRun = target.dataset.select;
      drawLog();
      await refreshDetail(true);
    } else if (target.dataset.cancel) {
      const ok = await confirmDialog(t('Cancel run'), t('What has been done so far stays in the working copy, but it does not become a pull request.'), t('Cancel run'));
      if (!ok) return;
      const r = await api('/api/cancel', { id: target.dataset.cancel });
      toast(r.status === 'canceling' ? t('Canceling…') : t('Canceled.'));
    } else if (target.dataset.resume) {
      await api('/api/resume', { id: target.dataset.resume, ignoreLimits: target.hasAttribute('data-ignore') });
      toast(t('Back in the queue.'));
    } else if (target.dataset.suggestion) {
      sendMessage(target.dataset.suggestion);
    } else if (target.dataset.stop) {
      await stopProject(target.dataset.stop);
    } else if (target.dataset.expand) {
      const id = target.dataset.expand;
      if (!expanded.delete(id)) expanded.add(id);
      drawComputer();
      return;
    } else if (target.dataset.resetUsed) {
      await api('/api/reset-grants', { action: 'used', index: Number(target.dataset.resetUsed) });
      toast(t('Marked as used.'));
    } else if (target.dataset.resetRemove) {
      const ok = await confirmDialog(t('Remove free reset'), t('Remove free reset number {index} from the record?', { index: target.dataset.resetRemove }), t('Remove'));
      if (!ok) return;
      await api('/api/reset-grants', { action: 'remove', index: Number(target.dataset.resetRemove) });
    } else if (target.dataset.needsDone) {
      await api('/api/needs-you/done', { run: target.dataset.needsDone, id: target.dataset.request });
      toast(t('Marked as done. The crew goes on.'));
      if (selectedRun === target.dataset.needsDone) await refreshDetail(true);
    } else if (target.dataset.needsSession) {
      await api('/api/needs-you/done', { session: target.dataset.needsSession, id: target.dataset.request });
      toast(t('Marked as done. The session opens now.'));
    } else if (target.dataset.sessionOpen) {
      target.disabled = true;
      const session = await api('/api/session', { profile: target.dataset.sessionOpen });
      toast(session.status === 'login' ? t('Codex is not signed in: see the request at the top.') : t('Session opened in a window of its own.'));
    } else if (target.dataset.sessionEnd) {
      const x = state.sessions?.open.find(o => o.id === target.dataset.sessionEnd);
      const ok = await confirmDialog(t('End session'), t('The window of "{name}" closes, and anything the agent is doing stops. The conversation itself stays in the history of the tool.', { name: x?.name ?? '' }), t('End'));
      if (!ok) return;
      await api('/api/session/end', { id: target.dataset.sessionEnd });
      toast(t('Session ended.'));
    } else if (target.dataset.context) {
      const { text } = await api(`/api/run/${encodeURIComponent(target.dataset.context)}/context/${target.dataset.step}`);
      $('#context-text').textContent = text;
      $('#context-dialog').showModal();
      return;
    } else if (target.hasAttribute('data-prompts-sync')) {
      target.disabled = true;
      toast(t('Copying the prompt builder…'));
      const status = await api('/api/prompts-sync', {});
      toast(status.ok ? t('Prompt builder copied.') : status.error);
    } else if (target.dataset.reader) {
      const action = target.dataset.reader;
      await api('/api/usage-reader', action === 'now' ? { read: true } : { enabled: action === 'on' });
      toast(action === 'now' ? t('Reading claude.ai…') : action === 'on' ? t('Reading of claude.ai turned on.') : t('Reading of claude.ai turned off.'));
    }
    refresh();
  } catch (error) {
    toast(error.message);
  }
});

showView();
drawClock();
setInterval(drawClock, 15_000);
setInterval(tickClocks, 1000);
refresh();
setInterval(refresh, 2500);
