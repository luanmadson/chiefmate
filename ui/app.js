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
    case 'skipped': return [t('Skipped'), 'neutral'];
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
  return (team?.lead?.id === id ? team.lead : null)
    ?? team?.members.find(a => a.id === id)
    ?? state?.crew.find(a => a.id === id)
    ?? state?.teams?.flatMap(x => x.members).find(a => a.id === id)
    ?? (id === 'manager' ? FALLBACK_MANAGER : { id, name: id });
}
const agentName = (id, project) => t(member(id, project).name ?? id);
const faceState = agent => (online ? agent.status ?? 'idle' : 'offline');
const stepFace = step => ({
  running: step.review || step.role === 'review' ? 'reviewing' : step.role === 'plan' ? 'planning' : 'working', done: 'done', failed: 'failed', pending: 'queued',
})[step.status] ?? 'still';
/** A step's role, said after its agent's name: the final review, or a team lead's planning or first review. */
const stepRole = s => (s.review ? t('review') : s.role === 'plan' ? t('planning') : s.role === 'review' ? t('first review') : '');
/** What kind of run: a mission, a request to a project's team lead, or a one-off task. */
const kindLabel = kind => (kind === 'mission' ? t('Mission') : kind === 'ask' ? t('Request') : t('Task'));

/** Whom a step waiting its turn waits for: the agent at work on its run, or the project of the run ahead of it. */
const waitingWho = w => (w.agent ? agentName(w.agent, w.project) : projectName(w.project));

/** The attribute that opens the agent's panel on a click, for a member at work on a run. */
const opensPanel = runId => (runId ? ` data-agent-run="${esc(runId)}" title="${esc(t('Click to watch live and talk to the agent'))}"` : '');

function agentStatus(agent) {
  if (!online) return [t('Offline'), 'error'];
  switch (agent.status) {
    case 'working': return [t('Working'), 'info'];
    case 'reviewing': return [t('Reviewing'), 'info'];
    case 'planning': return [t('Planning tasks'), 'info'];
    case 'thinking': return [t('Thinking'), 'info'];
    case 'queued': return [agent.waitingFor ? t('Waiting for {who}: {task}', { who: waitingWho(agent.waitingFor), task: agent.waitingFor.task }) : t('Next in line'), 'neutral'];
    case 'waiting': return [t('Waiting for the limit'), 'warn'];
    case 'offline': return [t('Offline'), 'error'];
    default: return [agent.id === 'manager' ? t('Waiting for you') : t('Standing by'), 'ok'];
  }
}

function agentDetail(agent) {
  if (!online) return t('No connection to Chiefmate');
  switch (agent.status) {
    case 'working':
    case 'planning':
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

// A project's page is "#project/<id>", and each of its tabs "#project/<id>/<tab>"; the prompt builder is "#builder",
// or "#builder/<id>" for a project (also shown in the project's "builder" tab).
const VIEWS = ['manager', 'operations', 'planning', 'missions', 'crew', 'projects', 'builder', 'log', 'usage', 'project'];
const pageProject = () => (location.hash.startsWith('#project/') ? decodeURIComponent(location.hash.slice('#project/'.length).split('/')[0]) : null);
const PROJECT_TABS = ['overview', 'crew', 'tasks', 'planning', 'context', 'builder'];
const pageTab = () => {
  const tab = location.hash.startsWith('#project/') ? location.hash.slice('#project/'.length).split('/')[1] : null;
  return PROJECT_TABS.includes(tab) ? tab : 'overview';
};
const builderHash = () => /^#builder(\/|$)/.test(location.hash);
const builderProjectOf = () => (location.hash.startsWith('#builder/') ? decodeURIComponent(location.hash.slice('#builder/'.length)) : '');
// The project the prompt builder is shown for: its own view's, or the project's whose "builder" tab is open (null: hidden).
const builderTarget = () => (builderHash() ? builderProjectOf() : pageProject() && pageTab() === 'builder' ? pageProject() : null);
const currentView = () => (pageProject() ? 'project' : builderHash() ? 'builder' : VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'manager');
function showView() {
  const view = currentView();
  for (const v of VIEWS) $(`#view-${v}`).classList.toggle('active', v === view);
  for (const a of document.querySelectorAll('.nav a')) a.classList.toggle('active', a.dataset.view === view);
  $('#project-jump').value = pageProject() ?? '';
  if (view === 'manager') setTimeout(() => $('#message').focus(), 0);
  if (view === 'project' && state) {
    if (projectPage.data?.id !== pageProject()) projectPage.data = null;
    drawProjectPage();
    refreshProjectPage();
    // The Context tab is read again each time it is opened (not on every refresh of the app).
    if (pageTab() === 'context') openProjectContext(pageProject());
  }
  if (view === 'builder' && state) {
    placeBuilder(false);
    openBuilder(builderProjectOf());
  }
}
window.addEventListener('hashchange', showView);

/** A project's name that opens its page; any other name (an old board's project, a library) stays plain text. */
const projectLink = (id, label = projectName(id)) =>
  state?.projects.some(p => p.id === id) ? `<a class="project-link" href="#project/${encodeURIComponent(id)}" title="${esc(t("Open the project's page"))}">${esc(label)}</a>` : esc(label);

/** The selector at the top: every project, to go straight to its page. */
function drawProjectJump() {
  const options = `<option value="">${esc(t('Projects…'))}</option>${state.projects.map(p => `<option value="${esc(p.id)}">${esc(p.name ?? p.id)}</option>`).join('')}`;
  if (draw('#project-jump', options, options)) $('#project-jump').value = pageProject() ?? '';
}
$('#project-jump').addEventListener('change', event => {
  const id = event.target.value;
  if (id) location.hash = `#project/${encodeURIComponent(id)}`;
  event.target.blur();
});

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
  // A run going on in focus: a click opens the panel of its agent at work.
  if (f?.state === 'running') $('#focus').dataset.agentRun = f.run;
  else delete $('#focus').dataset.agentRun;
  if (!f) {
    const text = online ? t('No project in focus') : '—';
    const html = `${label}<span class="focus-none">${esc(text)}</span>`;
    $('#focus').title = text;
    draw('#focus', html, html);
    return;
  }
  const parts = [kindLabel(f.kind), f.title];
  if (f.state === 'running') parts.push(f.agent ? agentName(f.agent, f.project) : t('preparing'), t('for {time}', { time: elapsed(f.since) }));
  else {
    parts.unshift(t('Next in the queue'));
    if (f.agent) parts.push(agentName(f.agent, f.project));
    if (f.notBefore && new Date(f.notBefore).getTime() > Date.now()) parts.push(t('not before {when}', { when: shortDate(f.notBefore) }));
  }
  const others = f.others ?? [];
  if (others.length) parts.push(t('and {count} more: {list}', { count: others.length, list: others.map(o => o.projectName).join(', ') }));
  const html = `${label}${f.state === 'running' ? liveDot() : ''}<span class="focus-project">${projectLink(f.project, f.projectName)}</span><span class="focus-detail">${parts.map(esc).join(' · ')}</span>`;
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

// The events Chiefmate tells the manager about (src/news.mjs), as the app names them.
const newsEvent = kind => ({
  run_finished: t('run finished'), run_failed: t('run failed'), run_paused: t('run paused'), pr_ready: t('pull request ready'),
  needs_you: t('needs you'), update_installed: t('update installed'), update_blocked: t('update blocked'),
  memory_alert: t('memory alert'), usage_alert: t('usage alert'), session_ended: t('live session ended'),
}[kind] ?? kind);

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
    // A notice: the manager's own news to you, after something happened (it was not an answer to a message of yours).
    const news = !you && m.news ? `<span class="tag news">${esc(t('notice'))}</span><span class="msg-events">${esc(m.news.map(newsEvent).join(' · '))}</span>` : '';
    html += `<div class="msg ${you ? 'you' : 'manager'}${news ? ' news' : ''}${m.error ? ' error' : ''}"><div class="msg-head">${you ? '' : face(manager, m.error ? 'failed' : 'still', 20)}<span class="msg-author">${esc(you ? t('You') : t(manager.name))}</span><span class="msg-meta">${esc(meta)}</span>${news}${tag}</div><div class="msg-body">${md(m.text)}</div></div>`;
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
  const items = list.map(m => (m.from === 'chiefmate'
    // Chiefmate's news for the manager: not a message of yours, so it can't be edited (only removed).
    ? `<div class="queued-msg news" data-pending="${esc(m.id)}">
      <div class="msg-head"><span class="tag news">${esc(t('news for the manager'))}</span><span class="msg-meta">${esc(clockTime(m.at))}</span>
        <span class="queued-actions"><button type="button" class="button danger small" data-pending-remove="${esc(m.id)}">${esc(t('Remove'))}</button></span></div>
      <div class="msg-body">${(m.events ?? []).map(e => `<div class="news-event"><time>${esc(clockTime(e.at))}</time> ${esc(newsEvent(e.kind))}</div>`).join('')}</div>
    </div>`
    : `<div class="queued-msg" data-pending="${esc(m.id)}">
      <div class="msg-head"><span class="tag">${esc(t('queued'))}</span><span class="msg-meta">${esc([clockTime(m.at), m.edited ? t('edited') : ''].filter(Boolean).join(' · '))}</span>
        <span class="queued-actions"><button type="button" class="button secondary small" data-pending-edit="${esc(m.id)}">${esc(t('Edit'))}</button><button type="button" class="button danger small" data-pending-remove="${esc(m.id)}">${esc(t('Remove'))}</button></span></div>
      <div class="msg-body">${md(m.text)}</div>
    </div>`));
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
  else if (online && update.waiting && update.blocked === 'merge') updateLine = t("Update waiting: this installation's branch has commits of its own");
  else if (online && update.waiting && update.mode === 'wait') updateLine = t('Update approved: it installs when the crew is free');
  else if (online && update.waiting) updateLine = t('Update approved: it installs on the next check, pausing the work going on');
  // An update going on: what it is doing now. Waiting for the manager, the owner may interrupt its answer.
  const job = online ? update.installing : null;
  if (job) {
    const paused = job.paused?.length ? ` ${t('{count} run(s) paused for it resume after the restart.', { count: job.paused.length })}` : '';
    if (job.stage === 'pausing') updateLine = t('Updating: pausing the work going on at a safe point…') + paused;
    else if (job.stage === 'manager') updateLine = (job.interruptManager ? t("Updating: interrupting the manager's answer…") : t("Updating: waiting for the manager's answer to end…")) + paused;
    else updateLine = t('Updating: checking the new version; Chiefmate restarts by itself…') + paused;
  }
  let updateButton = '';
  if (job?.stage === 'manager' && !job.interruptManager) updateButton = `<button type="button" class="button secondary small" data-update-now="interrupt">${esc(t("Interrupt the manager's answer"))}</button>`;
  else if (online && !job && update.waiting && !['changes', 'merge'].includes(update.blocked)) updateButton = `<button type="button" class="button small" data-update-now="now">${esc(t('Update now'))}</button>`;
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
    <div class="connection hint">${esc(claudeLine)}<br>${esc(accountLine)}${online && account.updated ? ` · ${esc(t('measured {when}', { when: relative(account.updated) }))}` : ''}${updateLine ? `<br>${esc(updateLine)}` : ''}${updateButton ? `<div class="actions left update-actions">${updateButton}</div>` : ''}</div>`;
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
  return `<div class="panel live${online ? '' : ' stalled'}"${a.agent ? opensPanel(a.id) : ''}>
      ${face(working, look, 56, `${who}: ${t('Running')}`)}
      <div class="live-main">
        <div class="live-label">${online ? liveDot() : ''}<span class="label">${esc(t('Running now'))}</span></div>
        <div class="live-title">${esc(a.title)}</div>
        <div class="hint">${esc([projectName(a.project), kindLabel(a.kind), t('started at {time}', { time: clockTime(a.started) })].join(' · '))}</div>
      </div>
      <div class="live-clock"><span class="label">${esc(t('Elapsed'))}</span><strong>${ticking(a.started)}</strong></div>
      <div class="live-progress">
        <div class="live-step"><strong>${esc(t('Step {n} of {total}', { n: a.step ?? 1, total: a.steps.length }))}</strong> · ${esc(who)}${step && stepRole(step) ? ` · ${esc(stepRole(step))}` : ''}${a.agent && a.stepStarted ? ` · ${ticking(a.stepStarted)} ${esc(t('on this step'))}` : ''}</div>
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
          <div id="${k}-lead"></div>
          <div id="${k}-context"></div>
          <div class="actions"><button type="button" class="button secondary small" data-agent-run="${esc(a.id)}">${esc(t('Watch and talk'))}</button><button type="button" class="button danger small" data-cancel="${esc(a.id)}">${esc(t('Cancel run'))}</button></div>
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
  const steps = a.steps.map((s, i) => `<li${s.status === 'running' ? opensPanel(a.id) : ''}>${face(member(s.agent, a.project), online ? stepFace(s) : 'offline', 30)}<div><div class="name">${i + 1}. ${esc(agentName(s.agent, a.project))}${stepRole(s) ? `, ${esc(stepRole(s))}` : ''}</div><div class="hint">${esc(runState(s.status)[0])}${s.status === 'running' && a.stepStarted ? ` · ${ticking(a.stepStarted)}` : ''}</div></div></li>`);
  draw(`#${k}-steps`, JSON.stringify([online, statuses, a.stepStarted]), steps.join(''));
  draw(`#${k}-lead`, JSON.stringify([a.request, a.lead, statuses]), leadPlan(a));
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

/**
 * What a project's team lead decided in a run: the request, the tasks it planned for the crew (with what it left out
 * and why) and, after its first review, its opinion for the manager. Empty for a run without a lead.
 */
function leadPlan(a) {
  const plan = a.lead?.plan;
  const planning = a.steps.some(s => s.role === 'plan' && s.status === 'running');
  if (!a.request && !a.lead) return '';
  const who = agentName('lead', a.project);
  const parts = [`<div class="label">${esc(t("{lead}'s plan", { lead: who }))}</div>`];
  if (a.request) parts.push(`<p class="lead-request">${esc(a.request)}</p>`);
  if (plan) {
    parts.push(plan.tasks.length
      ? `<ol class="lead-tasks">${plan.tasks.map(x => `<li>${face(member(x.agent, a.project), 'still', 20)}<div><span class="name">${esc(agentName(x.agent, a.project))}</span><span class="hint">${esc(x.part)}</span></div></li>`).join('')}</ol>`
      : `<div class="hint">${esc(t('No task planned.'))}</div>`);
    if (plan.note) parts.push(`<div class="hint">${esc(plan.note)}</div>`);
    if (plan.error) parts.push(`<div class="hint">${esc(t('Problem with the plan: {error}', { error: plan.error }))}</div>`);
    if (plan.dropped?.length) parts.push(`<div class="hint">${esc(t('Left out: {list}', { list: plan.dropped.join('; ') }))}</div>`);
  } else parts.push(`<div class="hint">${esc(planning ? t('Planning the request into tasks for the crew…') : t('The plan comes after the planning step.'))}</div>`);
  if (a.lead?.opinion) parts.push(`<div class="label">${esc(t("{lead}'s opinion", { lead: who }))}</div><div class="hint lead-opinion">${esc(a.lead.opinion)}</div>`);
  return `<div class="lead-plan">${parts.join('')}</div>`;
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
/** The sessions open, as a table (or a line saying there is none). */
function sessionTable(open) {
  const rows = open.map(x => `<tr>
      <td><span class="primary">${esc(x.name)}</span><span class="secondary">${esc([toolName(x.tool), sessionWhere(x), x.missing?.length ? t('not in the prompt builder: {list}', { list: x.missing.join(', ') }) : ''].filter(Boolean).join(' · '))}</span></td>
      <td>${stateHtml(sessionState(x))}</td>
      <td class="num">${x.status === 'login' ? '—' : ticking(x.started)}</td>
      <td class="num">${x.alive ? bytes(x.ram) : '—'}</td>
      <td class="row-actions"><button type="button" class="button danger small" data-session-end="${esc(x.id)}">${esc(x.status === 'login' ? t('Cancel') : t('End'))}</button></td>
    </tr>`);
  return rows.length
    ? `<table class="table"><thead><tr><th>${esc(t('Session'))}</th><th>${esc(t('Status'))}</th><th>${esc(t('Open for'))}</th><th>${esc(t('Memory'))}</th><th></th></tr></thead><tbody>${rows.join('')}</tbody></table>`
    : `<div class="empty">${esc(t('No session open.'))}</div>`;
}

/** The profiles, each with its Open button. */
const profileCards = profiles => profiles.map(p => `<div class="session-profile">
      <div><div class="name">${esc(p.name)}</div><div class="hint">${esc([toolName(p.tool), p.project ? projectName(p.project) : p.folder ?? '', p.blocks.length ? t('{count} block(s) of the prompt builder', { count: p.blocks.length }) : '', p.auto ? t('automatic, in your clone') : ''].filter(Boolean).join(' · '))}</div></div>
      <button type="button" class="button secondary small" data-session-open="${esc(p.id)}" title="${esc(p.blocks.join(', '))}">${esc(t('Open'))}</button>
    </div>`).join('');

function drawSessions() {
  const s = state.sessions ?? { profiles: [], open: [] };
  // The automatic profiles of the projects are opened from each project's page.
  const profiles = s.profiles.filter(p => !p.auto);
  const html = `<div class="label" style="margin-top:24px">${esc(t('Live sessions'))}</div>
    <div class="panel sessions">
      <p class="hint">${esc(t('A conversation with Claude Code or Codex in a window of its own, for work you do together, while the crew works in the background. It starts with the blocks of the prompt builder its profile names.'))}</p>
      ${sessionTable(s.open)}
      ${profiles.length ? `<div class="session-profiles">${profileCards(profiles)}</div>` : `<p class="hint">${esc(t('No session profiles yet: add them under "sessions" in the settings (see the README).'))}</p>`}
    </div>`;
  draw('#op-sessions', JSON.stringify([s.open.map(x => [x.id, x.status, x.alive, Math.round(x.ram / 1048576), x.started]), profiles]), html);
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
        <dt>${esc(t('Project'))}</dt><dd>${projectLink(m.project)}</dd>
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
    return `<article class="crew-card" style="--agent:${esc(a.color ?? '#8a93a0')}"${online ? opensPanel(a.runs?.[0]) : ''}>
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

/** A project's team lead, above its crew: its base agent, its memory and what it is doing. */
function teamLead(a) {
  const facts = [
    t('Team lead'),
    a.base ? t('Based on {agent}', { agent: agentName(a.base) }) : '',
    a.extra ? t('with instructions for this project') : '',
    a.memory ? t('memory: {count} line(s), updated {when}', { count: a.memory.lines, when: relative(a.memory.updated) }) : t('no memory yet'),
  ];
  return `<div class="team-member team-lead"${online ? opensPanel(a.runs?.[0]) : ''}>${face(a, faceState(a), 34)}<div><div class="name">${esc(t(a.name))}</div><div class="hint">${esc(facts.filter(Boolean).join(' · '))}</div></div>${stateHtml(agentStatus(a))}</div>`;
}

/** A project's crew: its lead, then its members, each with what it is doing. */
function teamBody(team) {
  const members = team.members.map(a => `<div class="team-member"${online ? opensPanel(a.runs?.[0]) : ''}>${face(a, faceState(a), 30)}<div><div class="name">${esc(t(a.name))}</div><div class="hint">${esc([a.base && a.base !== a.id ? t('Based on {agent}', { agent: agentName(a.base) }) : t(a.title ?? ''), a.extra ? t('with instructions for this project') : '', (a.mcp ?? []).length ? t('tools: {list}', { list: a.mcp.join(', ') }) : ''].filter(Boolean).join(' · '))}</div></div>${stateHtml(agentStatus(a))}</div>`);
  return `${team.lead ? teamLead(team.lead) : ''}${members.join('') || `<div class="hint">${esc(t('No members.'))}</div>`}`;
}

function drawTeams() {
  const teams = state.teams ?? [];
  const html = `<div class="teams">${teams.map(team => `
    <div class="team">
      <div class="team-top"><h3>${projectLink(team.project, team.name)}</h3><span class="hint">${esc(team.own ? t('Own crew') : t('General crew'))}</span></div>
      ${teamBody(team)}
    </div>`).join('')}</div>`;
  draw('#teams', html, html);
}

function drawPromptBuilder() {
  const p = state.prompts ?? {};
  let html = '';
  if (p.configured) {
    const google = p.origin === 'google';
    const button = p.origin === 'library'
      ? `<button type="button" class="button secondary small" data-prompts-sync ${p.syncing ? 'disabled' : ''}>${esc(p.syncing ? t('Updating…') : t('Update from the library'))}</button>`
      : google ? `<button type="button" class="button secondary small" data-prompts-sync ${p.syncing || !p.cdp ? 'disabled' : ''}>${esc(p.syncing ? t('Copying…') : t('Copy from Google Docs'))}</button>
        ${!p.cdp ? `<span class="hint">${esc(t('Needs "prompt_builder.doc_id" and "browser_cdp" in the settings.'))}</span>` : ''}` : '';
    html = `<div class="panel">
      <div class="label">${esc(t('Prompt builder'))}</div>
      <p>${builderSourceLines(p).map(esc).join(' ')}${p.exists ? '' : ` ${esc(t("The steps use the projects' notes."))}`}${p.environment ? ` ${esc(t('Environment: {name}.', { name: p.environment }))}` : ''}</p>
      ${p.sync?.ok === false ? `<p>${stateHtml([p.sync.error, 'error'])}</p>` : ''}
      ${button ? `<div class="actions left">${button}</div>` : ''}
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
    const details = [kindLabel(r.kind), projectName(r.project), originLabel(r.origin), r.pullRequest ? t('pull request opened') : ''].filter(Boolean).join(' · ');
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
        <div class="report-top"><div class="report-who">${face(member(s.agent, r.project), stepFace(s), 26)}<strong>${i + 1}. ${esc(agentName(s.agent, r.project))}${stepRole(s) ? `, ${esc(stepRole(s))}` : ''}</strong></div>${stateHtml(runState(s.status))}</div>
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

/** A project's processes: name (and whose), PID, memory and command line. */
function processTable(p) {
  const flag = x => (x.crew ? t('crew') : x.session ? t('session') : x.dev ? t('development environment') : x.guarded ? t('kept') : '');
  const rows = p.processes.map(x =>
    `<tr><td>${esc(x.name)}${flag(x) ? ` <span class="hint">· ${esc(flag(x))}</span>` : ''}</td><td class="num">${x.pid}</td><td class="num">${bytes(x.ram)}</td><td class="command">${esc(x.command)}</td></tr>`);
  return `<table class="table inner"><thead><tr><th>${esc(t('Process'))}</th><th>PID</th><th>${esc(t('Memory'))}</th><th>${esc(t('Command line'))}</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

const processRows = p => `<tr class="processes"><td colspan="4">${processTable(p)}</td></tr>`;

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
      <td><span class="primary">${has ? (open ? '▾ ' : '▸ ') : ''}${projectLink(p.id, p.name)}</span><span class="secondary">${esc(t('{count} process(es)', { count: p.processes.length }))}</span></td>
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

// ---------- A project's page ----------

// What the page read of its project (GET /api/project/<id>): the facts, your clone and its branch, the development
// environment and the recent runs. The rest comes from the state.
const projectPage = { data: null, loading: false };

async function refreshProjectPage() {
  const id = pageProject();
  if (!id || projectPage.loading) return;
  projectPage.loading = true;
  try {
    const data = await api(`/api/project/${encodeURIComponent(id)}`);
    if (pageProject() === id) projectPage.data = data;
  } catch (error) {
    if (pageProject() === id) projectPage.data = { id, error: error.message };
  } finally {
    projectPage.loading = false;
  }
  if (pageProject() === id && state) drawProjectPage();
}

const PAGE_PARTS = ['#project-title', '#project-more', '#project-status', '#project-actions', '#project-needs', '#project-tabs', '#project-summary', '#project-facts', '#project-team', '#project-runs', '#project-history', '#project-planning', '#project-computer', '#project-sessions'];
// Each tab and the part of the page it shows.
const TAB_PARTS = { overview: '#project-overview', crew: '#project-crew', tasks: '#project-tasks', planning: '#project-planning', context: '#project-context', builder: '#project-builder' };

const projectHash = (id, tab = 'overview') => `#project/${encodeURIComponent(id)}${tab === 'overview' ? '' : `/${tab}`}`;
const projectOpenItems = (id, p) => planItemsNow().filter(i => !i.archived && i.status !== 'done' && (i.project === id || i.project === p?.name));
const noCloneAttr = info => (info && !info.clone ? ` disabled title="${esc(t('No clone of yours on this computer: set "local_clone" in its settings.'))}"` : '');

function drawProjectPage() {
  const id = pageProject();
  if (!id || !state) return;
  const p = state.projects.find(x => x.id === id);
  if (!p) {
    const html = `<h1>${esc(t('Unknown project: {id}', { id }))}</h1><p>${esc(t('It is not in the settings. Pick a project in the list at the top.'))}</p>`;
    draw('#project-title', html, html);
    for (const part of PAGE_PARTS.slice(1)) draw(part, '', '');
    for (const part of Object.values(TAB_PARTS)) $(part).hidden = true;
    return;
  }
  const info = projectPage.data?.id === id ? projectPage.data : null;
  const title = `<h1>${esc(p.name ?? id)}</h1><p>${esc(info?.error ?? (info ? info.about || t('No sentence about this project in its settings ("about").') : t('Loading…')))}</p>`;
  draw('#project-title', title, title);
  drawProjectStatus(id, info);
  drawProjectActions(id, info);
  drawProjectMore(id, info);
  drawProjectNeeds(id, p);
  const builderOn = !!state.prompts?.configured;
  const tab = pageTab() === 'builder' && !builderOn ? 'overview' : pageTab();
  const count = n => (n ? ` <span class="counter">${n}</span>` : '');
  const working = going().filter(a => a.project === id).length + (online ? queueOrder().filter(r => r.project === id).length : 0);
  const tabs = [
    ['overview', t('At a glance')], ['crew', t('Crew')], ['tasks', t('Tasks and history'), working], ['planning', t('Planning'), projectOpenItems(id, p).length],
    ['context', t('Context')], ...(builderOn ? [['builder', t('Builder')]] : []),
  ].map(([key, label, n]) => `<a href="${projectHash(id, key)}" class="tab${key === tab ? ' active' : ''}"${key === tab ? ' aria-current="page"' : ''}>${esc(label)}${count(n)}</a>`).join('');
  draw('#project-tabs', tabs, tabs);
  for (const [key, part] of Object.entries(TAB_PARTS)) $(part).hidden = key !== tab;
  if (tab === 'context') {
    if (projectContext.id !== id) openProjectContext(id);
    else drawProjectContext();
  } else if (tab === 'builder') {
    placeBuilder(true);
    if (builder.project !== id || !builder.data) openBuilder(id);
    else drawBuilderTop();
  } else if (tab === 'crew') {
    drawProjectTeam(id);
    drawProjectSessions(id);
  } else if (tab === 'tasks') {
    drawProjectRuns(id);
    drawProjectHistory(info);
    fillProjectTask(id);
  } else if (tab === 'planning') drawProjectPlanning(id, p);
  else {
    drawProjectSummary(id, p, info);
    drawProjectFacts(info);
    drawProjectComputer(id, info);
  }
}

/** One line under the name: whether the crew is working on it, in the queue or stopped; its memory; your branch. */
function drawProjectStatus(id, info) {
  const runs = going().filter(a => a.project === id);
  const queued = online ? queueOrder().filter(r => r.project === id).length : 0;
  const c = state.computer?.projects.find(x => x.id === id);
  const status = runs.length ? `${liveDot()} ${stateHtml([t('Running: {task}', { task: runs[0].title }), 'info'])}`
    : queued ? stateHtml([t('In the queue ({count})', { count: queued }), 'info'])
    : stateHtml([t('Stopped'), 'neutral']);
  const branch = info?.branch ? (info.branch === 'HEAD' ? t('no branch (detached)') : info.branch) : null;
  const html = [
    `<span class="project-status-run">${status}</span>`,
    `<span>${esc(t('Memory'))} <span class="num">${c?.ram ? bytes(c.ram) : '—'}</span></span>`,
    `<span>${esc(t('Branch'))} ${branch ? `<code>${esc(branch)}</code>` : '—'}</span>`,
  ].join('<span class="sep" aria-hidden="true">·</span>');
  draw('#project-status', html, html);
}

/** The three main actions: work live (the prompt builder with the usual blocks), a task for the crew, the environment. */
function drawProjectActions(id, info) {
  const noClone = noCloneAttr(info);
  const big = (attrs, title, hint, kind = '') => `<button type="button" class="action-big${kind}" ${attrs}><span class="action-title">${esc(title)}</span><span class="action-hint">${esc(hint)}</span></button>`;
  const claude = (state.sessions?.profiles ?? []).find(x => x.project === id && x.tool === 'claude');
  const live = state.prompts?.configured
    ? big('data-project-live', t('Work live'), t('The prompt builder with the usual blocks, then a live session'), ' primary')
    : claude ? big(`data-session-open="${esc(claude.id)}"${noClone}`, t('Work live'), t('Claude Code in your clone of the project'), ' primary') : '';
  const dev = info?.dev;
  const devAction = !info?.devStart
    ? big(`disabled title="${esc(t('None: set "dev_start" in its settings to start it from here.'))}"`, t('Start environment'), t('No command set'))
    : dev?.status === 'running' ? big('data-project-dev="stop"', t('Stop environment'), t('Running · {size}', { size: bytes(dev.ram) }), ' danger')
    : dev?.status === 'starting' ? big('disabled', t('Starting…'), info.devStart)
    : big(`data-project-dev="start"${noClone}`, t('Start environment'), info.devStart);
  const html = [live, big('data-project-task', t('New task for the crew'), t('Someone of the crew does it, you approve')), devAction].join('');
  draw('#project-actions', html, html);
}

/** The secondary actions, in the "More" menu: the folder, VS Code and a live session with each tool. */
function drawProjectMore(id, info) {
  // Kept while open, so a refresh doesn't close it under the pointer.
  if ($('#project-more .menu[open]')) return;
  const profiles = (state.sessions?.profiles ?? []).filter(x => x.project === id);
  const noClone = noCloneAttr(info);
  const item = (attrs, label) => `<button type="button" class="menu-item" ${attrs}>${esc(label)}</button>`;
  const session = tool => {
    const profile = profiles.find(x => x.tool === tool);
    return profile ? item(`data-session-open="${esc(profile.id)}"${noClone}`, t('Live session: {tool}', { tool: toolName(tool) })) : '';
  };
  const items = [
    item(`data-project-open="folder"${noClone}`, t('Open folder')),
    info?.vscode ? item(`data-project-open="vscode"${noClone}`, t('Open in VS Code')) : '',
    session('claude'),
    session('codex'),
  ].join('');
  const html = `<details class="menu"><summary class="button secondary">${esc(t('More'))}</summary><div class="menu-list">${items}</div></details>`;
  draw('#project-more', html, html);
}

/** What waits for you in this project, at the top: the crew's requests and the board's items waiting for you. */
function drawProjectNeeds(id, p) {
  const needs = (online ? state.needs ?? [] : []).filter(n => n.project === id);
  const items = projectOpenItems(id, p).filter(i => i.status === 'waiting_owner');
  const rows = [
    ...needs.map(n => `<div class="project-need">
      <div><span class="primary">${esc(n.what)}</span><span class="hint">${esc(n.title)}${n.url ? ` · <a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(t('Open the address'))}</a>` : ''}</span></div>
      <button type="button" class="button small" ${n.session ? `data-needs-session="${esc(n.session)}"` : `data-needs-done="${esc(n.run)}"`} data-request="${esc(n.id)}">${esc(t('Mark as done'))}</button></div>`),
    ...items.map(i => `<div class="project-need">
      <div><span class="primary">#${i.id} ${esc(i.title)}</span><span class="hint">${esc(t('On the board, waiting for you'))}</span></div>
      <a class="button secondary small" href="${projectHash(id, 'planning')}">${esc(t('See'))}</a></div>`),
  ];
  const html = rows.length ? `<div class="project-needs" role="alert"><div class="label">${esc(t('Waiting for you ({count})', { count: rows.length }))}</div>${rows.join('')}</div>` : '';
  draw('#project-needs', html, html);
}

/** At a glance: the crew now, the last run and the board, each opening its tab. */
function drawProjectSummary(id, p, info) {
  const runs = going().filter(a => a.project === id);
  const queued = online ? queueOrder().filter(r => r.project === id).length : 0;
  const last = info?.history?.[0];
  const items = projectOpenItems(id, p);
  const card = (tab, label, body) => `<a class="summary-card" href="${projectHash(id, tab)}"><span class="label">${esc(label)}</span>${body}</a>`;
  const crewNow = runs.length
    ? `<span class="primary">${liveDot()} ${esc(runs[0].title)}</span><span class="hint">${esc(stepLine(runs[0]))}</span>`
    : `<span class="primary">${esc(t('No one working on it'))}</span><span class="hint">${esc(queued ? t('{count} in the queue', { count: queued }) : t('Nothing in the queue'))}</span>`;
  const result = last
    ? `<span class="primary">${esc(last.title)}</span><span class="hint">${stateHtml(runLabel(last))} · <span class="num">${shortDate(last.created)}</span></span>`
    : `<span class="primary">${esc(info ? t('No runs yet') : t('Loading…'))}</span>`;
  const board = items.length
    ? `<span class="primary">${esc(t('{count} open item(s)', { count: items.length }))}</span><span class="hint">#${items[0].id} ${esc(items[0].title)}</span>`
    : `<span class="primary">${esc(t('Nothing open'))}</span>`;
  const html = `<div class="project-summary">${card('tasks', t('Crew now'), crewNow)}${card('tasks', t('Last run'), result)}${card('planning', t('Planning'), board)}</div>`;
  draw('#project-summary', html, html);
}

function drawProjectFacts(info) {
  if (!info || info.error) return draw('#project-facts', '', '');
  const link = url => (/^https?:\/\//.test(url ?? '') ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>` : esc(url ?? '—'));
  const from = info.mainBranch === 'current' ? t('from the branch checked out in your clone') : info.mainBranch ? t('from {branch}', { branch: info.mainBranch }) : '';
  const delivery = info.deliver === 'local' ? t('Local: a branch handed to your clone, nothing goes to GitHub') : t('A pull request for you to approve');
  const html = `<div class="panel"><dl class="facts project-facts">
      <dt>${esc(t('Local folder'))}</dt><dd>${info.clone ? `<code>${esc(info.clone)}</code>` : esc(t('No clone of yours on this computer: set "local_clone" in its settings.'))}</dd>
      <dt>${esc(t('Current branch'))}</dt><dd>${info.branch ? `<code>${esc(info.branch === 'HEAD' ? t('no branch (detached)') : info.branch)}</code>` : '—'}</dd>
      <dt>${esc(t('Delivery'))}</dt><dd>${esc([delivery, from].filter(Boolean).join(', '))}</dd>
      <dt>${esc(t('Repository'))}</dt><dd>${link(info.repository)}</dd>
      ${info.site ? `<dt>${esc(t('Site'))}</dt><dd>${link(info.site)}</dd>` : ''}
      ${info.docs ? `<dt>${esc(t('Personal documentation'))}</dt><dd><code>${esc(info.docs)}</code></dd>` : ''}
      <dt>${esc(t('Development environment'))}</dt><dd>${info.devStart ? `<code>${esc(info.devStart)}</code>` : esc(t('None: set "dev_start" in its settings to start it from here.'))}</dd>
    </dl></div>`;
  draw('#project-facts', html, html);
}

function drawProjectTeam(id) {
  const team = state.teams?.find(x => x.project === id);
  const html = team
    ? `<div class="team"><div class="team-top"><h3>${esc(t('Crew'))}</h3><span class="hint">${esc(team.own ? t('Own crew') : t('General crew'))}</span></div>${teamBody(team)}</div>`
    : '';
  draw('#project-team', html, html);
}

/** The project's runs going on (a click opens the agent's panel) and its runs in the queue. */
function drawProjectRuns(id) {
  const runs = going().filter(a => a.project === id);
  const queue = online ? queueOrder().filter(r => r.project === id) : [];
  const live = runs.map(a => `<div class="project-run"${a.agent ? opensPanel(a.id) : ''}>
      ${face(a.agent ? member(a.agent, a.project) : member('manager'), a.agent ? faceState(member(a.agent, a.project)) : 'working', 30)}
      <div style="min-width:0"><div class="name">${liveDot()} ${esc(a.title)}</div><div class="hint">${esc(stepLine(a))} · ${ticking(a.started)}</div></div>
      <button type="button" class="button danger small" data-cancel="${esc(a.id)}">${esc(t('Cancel run'))}</button>
    </div>`);
  const waiting = queue.map(r => `<div class="project-run">
      <span></span>
      <div style="min-width:0"><div class="name">${esc(r.title)}</div><div class="hint">${stateHtml(runLabel(r))}${r.notBefore && new Date(r.notBefore).getTime() > Date.now() + skew ? ` · ${esc(t('not before {when}', { when: shortDate(r.notBefore) }))}` : ''}</div></div>
      <button type="button" class="button danger small" data-cancel="${esc(r.id)}">${esc(t('Cancel'))}</button>
    </div>`);
  const html = `<div class="panel">
      <div class="label">${esc(t('Running now'))}</div>${live.join('') || `<div class="hint">${esc(t('Nothing running for this project.'))}</div>`}
      <div class="label" style="margin-top:16px">${esc(t('Queue'))}</div>${waiting.join('') || `<div class="hint">${esc(t('Nothing in the queue for this project.'))}</div>`}
    </div>`;
  draw('#project-runs', JSON.stringify([online, runs.map(a => [a.id, a.step, a.agent, a.status, member(a.agent ?? 'manager', a.project).status]), queue.map(r => [r.id, r.status, r.notBefore, r.needsYou])]), html);
}

/** The project's latest runs, each with its result and a link to its reports in the Log. */
function drawProjectHistory(info) {
  const list = info?.history ?? [];
  const rows = list.map(r => `<tr>
      <td class="num">${shortDate(r.created)}</td>
      <td><span class="primary">${esc(r.title)}</span><span class="secondary">${esc(r.result ?? r.note ?? '')}</span></td>
      <td>${stateHtml(runLabel(r))}</td>
      <td class="num">${r.started ? esc(elapsed(r.started, r.ended ?? Date.now())) : '—'}</td>
      <td class="row-actions"><div class="plan-actions">${r.pullRequest ? prLink(r.pullRequest) : ''}<a href="#log" class="button secondary small" data-select="${esc(r.id)}">${esc(t('Reports'))}</a></div></td>
    </tr>`);
  const html = info && !info.error
    ? `<h2 class="section-title">${esc(t('Recent history'))}</h2>${rows.length
      ? `<table class="table"><thead><tr><th>${esc(t('Date'))}</th><th>${esc(t('Run'))}</th><th>${esc(t('Status'))}</th><th>${esc(t('Time'))}</th><th></th></tr></thead><tbody>${rows.join('')}</tbody></table>`
      : `<div class="empty">${esc(t('No runs of this project yet.'))}</div>`}`
    : '';
  draw('#project-history', JSON.stringify([list.map(r => [r.id, r.status, r.ended, r.pullRequest, r.needsYou, r.result]), !!info && !info.error]), html);
}

/** The project's items on the planning board (open ones, in the board's order). */
function drawProjectPlanning(id, p) {
  const items = planItemsNow().filter(i => !i.archived && i.status !== 'done' && (i.project === id || i.project === p.name));
  const rows = items.map(i => `<tr>
      <td class="num">#${i.id}</td>
      <td><span class="primary">${esc(i.title)}</span>${i.description ? `<span class="secondary plan-description">${esc(i.description)}</span>` : ''}</td>
      <td>${esc(priorityLabel(i.priority))}</td>
      <td>${stateHtml(planState(i.status))}</td>
      <td>${planLinks(i)}</td>
    </tr>`);
  const html = `<div class="section-head"><h2 class="section-title">${esc(t('Planning'))}</h2><button type="button" class="button secondary small" data-project-planning="${esc(id)}">${esc(t('Open in Planning'))}</button></div>
    ${rows.length
      ? `<table class="table"><thead><tr><th>#</th><th>${esc(t('Item'))}</th><th>${esc(t('Priority'))}</th><th>${esc(t('Status'))}</th><th>${esc(t('Run or PR'))}</th></tr></thead><tbody>${rows.join('')}</tbody></table>`
      : `<div class="empty">${esc(t('No open item for this project on the board.'))}</div>`}`;
  draw('#project-planning', html, html);
}

/** The project on this computer: its state, its memory, its processes and its development environment. */
function drawProjectComputer(id, info) {
  const c = state.computer.projects.find(x => x.id === id);
  if (!c) return draw('#project-computer', '', '');
  const canStop = c.processes.some(x => !x.crew && !x.guarded);
  const dev = info?.dev;
  const devLine = !info?.devStart ? ''
    : `<div class="dev-line"><span class="label">${esc(t('Development environment'))}</span>${stateHtml(dev?.status === 'running' ? [t('Running'), 'ok'] : dev?.status === 'starting' ? [t('Starting…'), 'info'] : [t('Stopped'), 'neutral'])}${dev?.status === 'running' ? `<span class="num">${bytes(dev.ram)}</span><button type="button" class="button danger small" data-project-dev="stop">${esc(t('Stop'))}</button>` : dev?.status === 'starting' ? '' : `<button type="button" class="button secondary small" data-project-dev="start"${info.clone ? '' : ' disabled'}>${esc(t('Start'))}</button>`}</div>`;
  const notes = [state.computer.supported ? '' : t("The projects' processes are read on Windows only."), state.computer.error ? t("Couldn't read the processes: {error}", { error: state.computer.error }) : ''].filter(Boolean);
  const html = `<h2 class="section-title">${esc(t('On this computer'))}</h2>
    <div class="panel">
      <div class="computer-line">${stateHtml(projectState(c))}<span class="num">${c.ram ? bytes(c.ram) : '—'}</span><span class="hint">${esc(t('{count} process(es)', { count: c.processes.length }))}</span>${canStop ? `<button type="button" class="button danger small" data-stop="${esc(id)}">${esc(t('Stop processes'))}</button>` : ''}</div>
      ${devLine}
      ${notes.map(n => `<div class="hint">${esc(n)}</div>`).join('')}
      ${c.processes.length ? processTable(c) : ''}
    </div>`;
  draw('#project-computer', html, html);
}

/** The project's live sessions open, and its profiles (the automatic ones included). */
function drawProjectSessions(id) {
  const s = state.sessions ?? { profiles: [], open: [] };
  const open = s.open.filter(x => x.project === id);
  const profiles = s.profiles.filter(x => x.project === id);
  const html = `<h2 class="section-title">${esc(t('Live sessions'))}</h2>
    <div class="panel sessions">
      <p class="hint">${esc(t("Claude Code or Codex in a window of its own, in your clone of the project, starting with the project's block of the prompt builder and the environment."))}</p>
      ${sessionTable(open)}
      ${profiles.length ? `<div class="session-profiles">${profileCards(profiles)}</div>` : ''}
    </div>`;
  draw('#project-sessions', JSON.stringify([open.map(x => [x.id, x.status, x.alive, Math.round(x.ram / 1048576), x.started]), profiles]), html);
}

// ---------- A project's Context tab ----------

// What the tab read (GET /api/project/<id>/context), the member shown and the preview of the changes being written.
const projectContext = { id: null, data: null, loading: false, error: null, member: null, preview: null, busy: false, ticket: 0 };

async function openProjectContext(id) {
  if (projectContext.id !== id) Object.assign(projectContext, { id, data: null, error: null, member: null, preview: null });
  else if (projectContext.loading) return;
  // Only the latest reading counts (another project may have been opened meanwhile).
  const ticket = ++projectContext.ticket;
  projectContext.loading = true;
  drawProjectContext();
  try {
    const data = await api(`/api/project/${encodeURIComponent(id)}/context`);
    if (projectContext.ticket === ticket) Object.assign(projectContext, { data, error: null, preview: null });
  } catch (error) {
    if (projectContext.ticket === ticket) projectContext.error = error.message;
  } finally {
    if (projectContext.ticket === ticket) projectContext.loading = false;
  }
  if (projectContext.ticket !== ticket) return;
  if (!projectContext.data?.members.some(m => m.id === projectContext.member)) projectContext.member = projectContext.data?.members[0]?.id ?? null;
  drawProjectContext();
}

const tokenCount = n => t('~{count} tokens', { count: Number(n ?? 0).toLocaleString(locale()) });

function contextPartTitle(key) {
  switch (key) {
    case 'agent': return t("The agent's instructions");
    case 'installation': return t('Notes for this installation');
    case 'project-member': return t("Notes for this project's crew");
    case 'lead-role': return t("The team lead's role");
    case 'lead-notes': return t('Notes for the team lead');
    case 'header': return t('The run and the task');
    case 'memory': return t('Project memory');
    case 'lead': return t('How the team lead reviews');
    case 'playbook': return t("The mission's playbook");
    case 'builder': return t('Project instructions (prompt builder)');
    case 'notes': return t("The project's notes");
    case 'agent-notes': return t("The project's notes for this member");
    case 'libraries': return t('Libraries and personal documentation');
    case 'review': return t('The final review');
    case 'lead-review': return t("The team lead's plan and opinion");
    case 'reports': return t('The reports of the steps before');
    case 'rules': return t("Chiefmate's rules for the crew");
    default: return key;
  }
}

function blockHow(b) {
  const condition = b.condition ?? '';
  switch (b.how) {
    case 'chosen':
      if (b.role === 'project block') return t("chosen: the project's block");
      if (b.role === 'environment') return t('chosen: the environment');
      if (b.role === 'module') return t('chosen: a module of the project');
      if (b.role === 'profile') return t("chosen: in the session's profile");
      return t('chosen');
    case 'include-with': return t('by "include with": {condition}', { condition });
    case 'tags': return t('by a shared tag: {condition}', { condition });
    case 'requires': return t('by "requires": {condition}', { condition });
    default: return t('always');
  }
}

function fileKindLabel(kind) {
  switch (kind) {
    case 'start': return t('loaded at the start');
    case 'folder': return t('loaded when it works in that folder');
    case 'agents': return t('not loaded by Claude Code by itself (Codex reads it)');
    case 'settings': return t('settings of the repository');
    case 'ignored': return t('ignored (--strict-mcp-config)');
    default: return t('available to the agent');
  }
}

function memberRoleLabel(m) {
  if (m.kind === 'lead') return t('Team lead: first review of every run');
  if (m.kind === 'manager') return t('Manager: final review');
  return m.base && m.base !== m.id ? t('Crew member, based on {base}', { base: agentName(m.base) }) : t('Crew member');
}

/** A part of the context: its title, its source and its size; opened, its text. */
const contextPart = (title, source, tokens, body, extra = '') => `<details class="context-part">
    <summary><span class="context-part-title">${esc(title)}</span><code class="context-source">${esc(source ?? '')}</code><span class="num">${tokens == null ? '' : tokenCount(tokens)}</span></summary>
    ${extra}${body ? `<pre class="context-text">${esc(body)}</pre>` : ''}
  </details>`;

const contextBlocks = blocks => blocks?.length
  ? `<table class="table inner context-blocks"><thead><tr><th>${esc(t('Block'))}</th><th>${esc(t('How it came in'))}</th><th>${esc(t('Size'))}</th></tr></thead><tbody>${blocks.map(b => `<tr>
      <td><span class="primary">${esc(b.name)}</span><span class="secondary">${esc(b.section)}</span></td>
      <td>${esc(blockHow(b))}${b.adapted ? `<span class="secondary">${esc(t("{count} line(s) adapted to the crew's rules", { count: b.adapted }))}</span>` : ''}</td>
      <td class="num">${tokenCount(b.tokens)}</td></tr>`).join('')}</tbody></table>`
  : '';

const diffLines = (removed = [], added = [], max = 60) => {
  const lines = [...removed.map(l => `<span class="del">- ${esc(l)}</span>`), ...added.map(l => `<span class="add">+ ${esc(l)}</span>`)];
  if (!lines.length) return '';
  return `<pre class="context-diff">${lines.slice(0, max).join('\n')}${lines.length > max ? `\n${esc(t('… and {count} more line(s)', { count: lines.length - max }))}` : ''}</pre>`;
};

function contextChangeLabel(c) {
  const status = c.status === 'added' ? t('new') : c.status === 'removed' ? t('gone') : t('changed');
  switch (c.what) {
    case 'model': return t('Model and effort: {before} → {after}', { before: c.before || '—', after: c.after || '—' });
    case 'system': return t('System prompt: {status}', { status });
    case 'section': return t('Section "{name}": {status}', { name: c.name, status });
    case 'blocks': return t('Blocks of the prompt builder: {status}', { status });
    case 'folders': return t('Folders allowed: {status}', { status });
    case 'tools': return t('Tools allowed: {status}', { status });
    case 'denied': return t('Tools and paths denied: {status}', { status });
    case 'mcp': return t('External tools (MCP): {status}', { status });
    case 'files': return t("The repository's instruction files: {status}", { status });
    default: return `${c.what}: ${status}`;
  }
}

function contextDiffHtml(diff) {
  if (!diff) return `<p class="hint">${esc(t('No context recorded for this member in this project yet: the comparison starts with its next run.'))}</p>`;
  const head = `<p class="hint">${esc(t('Compared with what step {step} of "{title}" received ({when}).', { step: diff.step, title: diff.title, when: shortDate(diff.at) }))} <a href="#log" data-select="${esc(diff.run)}">${esc(t('Reports'))}</a>${diff.written ? ` · ${esc(t('That run had a prompt written in the prompt builder.'))}` : ''}${diff.modules?.length ? ` · ${esc(t('That run had extra modules: {list}', { list: diff.modules.join(', ') }))}` : ''}</p>`;
  if (!diff.changes.length) return `${head}${stateHtml([t('Nothing changed since then.'), 'ok'])}`;
  const items = diff.changes.map(c => {
    const lists = c.what !== 'section' && c.what !== 'system' && (c.added || c.removed) ? diffLines(c.removed, c.added) : '';
    const lines = c.what === 'section' || c.what === 'system' ? (c.status === 'changed' ? diffLines(c.removed, c.added) : `<span class="hint">${esc(tokenCount(c.tokens))}</span>`) : '';
    return `<li><span class="${c.status === 'removed' ? 'state state-error' : c.status === 'added' ? 'state state-ok' : 'state state-warn'}">${esc(contextChangeLabel(c))}</span>${lists}${lines}</li>`;
  });
  return `${head}<ul class="context-changes">${items.join('')}</ul>`;
}

function contextMemberHtml(m) {
  const repo = m.repository;
  const repoItems = !repo.exists
    ? `<p class="hint">${esc(t('The working copy ({path}) is created on the first run: no file read yet.', { path: repo.dir }))}</p>`
    : !repo.files.length
      ? `<p class="hint">${esc(t('None.'))}</p>`
      : repo.files.map(f => (f.text != null ? contextPart(f.file, fileKindLabel(f.kind), f.tokens, f.text) : `<div class="context-row"><code>${esc(f.file)}</code><span class="hint">${esc(fileKindLabel(f.kind))}</span></div>`)).join('');
  const prompt = m.prompt.map(p => {
    let extra = '';
    if (p.key === 'builder') {
      extra = contextBlocks(p.blocks)
        + (p.off?.length ? `<p class="hint">${esc(t('Turned off for this project: {list}', { list: p.off.join(', ') }))}</p>` : '')
        + (p.missing ?? []).map(x => `<p class="state state-warn">${esc(t('Not found: {what}', { what: x }))}</p>`).join('')
        + (p.unresolved?.length ? `<p class="state state-warn">${esc(t('Variables left unfilled: {list}', { list: p.unresolved.map(v => `{${v}}`).join(', ') }))}</p>` : '');
    }
    return contextPart(contextPartTitle(p.key), p.source, p.tokens, p.text, extra);
  }).join('');
  const a = m.access;
  const list = items => (items.length ? items.map(x => `<code>${esc(x)}</code>`).join(' ') : '—');
  return `<div class="panel context-member">
      <div class="section-head"><h3>${esc(t(m.name))} <span class="hint">${esc(memberRoleLabel(m))}</span></h3><span class="num">${esc(t('Total: {tokens}', { tokens: tokenCount(m.tokens.total) }))}</span></div>
      <div class="context-heading"><span>${esc(t("1. System prompt, added to Claude Code's own"))}</span><span class="num">${tokenCount(m.tokens.system)}</span></div>
      ${m.system.map(p => contextPart(contextPartTitle(p.key), p.source, p.tokens, p.text)).join('')}
      <div class="context-heading"><span>${esc(t("2. The repository's instruction files"))}</span><span class="num">${esc(t('{tokens} at the start', { tokens: tokenCount(m.tokens.repository) }))}</span></div>
      ${repoItems}
      <div class="context-heading"><span>${esc(t('3. First message'))}</span><span class="num">${tokenCount(m.tokens.prompt)}</span></div>
      ${prompt}
      <div class="context-heading"><span>${esc(t('4. Model, folders, tools and external tools'))}</span></div>
      <dl class="facts project-facts">
        <dt>${esc(t('Model'))}</dt><dd>${esc(m.model ? shortModel(m.model) : '—')}${m.effort ? ` · ${esc(t('effort {effort}', { effort: m.effort }))}` : ''} · ${esc(t('up to {minutes} min per step', { minutes: m.maxMinutes }))}</dd>
        <dt>${esc(t('Working copy'))}</dt><dd><code>${esc(a.workingCopy)}</code></dd>
        <dt>${esc(t('Folders allowed'))}</dt><dd>${list(a.addDirs)}</dd>
        <dt>${esc(t('Paths denied'))}</dt><dd><details><summary>${esc(t('{count} rule(s)', { count: a.deniedPaths.length }))}</summary><pre class="context-text">${esc(a.deniedPaths.join('\n'))}</pre></details></dd>
        <dt>${esc(t('Tools allowed'))}</dt><dd>${a.tools.length ? list(a.tools) : esc(t("the agent's defaults"))}</dd>
        <dt>${esc(t('Tools denied'))}</dt><dd>${list(a.deniedTools)}</dd>
        <dt>${esc(t('External tools (MCP)'))}</dt><dd>${list(a.mcp)}${a.mcpUnknown.length ? ` <span class="state state-warn">${esc(t('released but not configured: {list}', { list: a.mcpUnknown.join(', ') }))}</span>` : ''}</dd>
      </dl>
      <div class="context-heading"><span>${esc(t('5. Since the last run'))}</span></div>
      ${contextDiffHtml(m.diff)}
    </div>`;
}

function contextSummaryHtml(d) {
  const rows = d.members.map(m => `<tr class="clickable${m.id === projectContext.member ? ' selected' : ''}" data-context-member="${esc(m.id)}">
      <td><span class="primary">${esc(t(m.name))}</span><span class="secondary">${esc(memberRoleLabel(m))}</span></td>
      <td class="num">${tokenCount(m.tokens.system)}</td><td class="num">${tokenCount(m.tokens.repository)}</td><td class="num">${tokenCount(m.tokens.prompt)}</td>
      <td class="num"><strong>${tokenCount(m.tokens.total)}</strong></td>
      <td>${m.diff ? (m.diff.changes.length ? stateHtml([t('{count} change(s)', { count: m.diff.changes.length }), 'warn']) : stateHtml([t('as in the last run'), 'ok'])) : `<span class="hint">${esc(t('no run yet'))}</span>`}</td>
    </tr>`);
  return `<table class="table"><thead><tr><th>${esc(t('Who works on the project'))}</th><th>${esc(t('System prompt'))}</th><th>${esc(t('Repository'))}</th><th>${esc(t('First message'))}</th><th>${esc(t('Total'))}</th><th>${esc(t('Since the last run'))}</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

function contextBuilderLine(b) {
  if (b.used) return stateHtml([t('Prompt builder: block "{block}"{environment}', { block: b.block, environment: b.environment ? t(', environment "{name}"', { name: b.environment }) : '' }), 'ok']);
  if (b.error) return stateHtml([t("Couldn't read the prompt builder: {error}", { error: b.error }), 'error']);
  const why = !b.configured ? t('no document configured ("prompt_builder.file")') : !b.exists ? t('no copy of it on this computer') : t('no "prompt_block" for this project');
  return stateHtml([t("Prompt builder not used ({why}): the project's notes go instead", { why }), 'neutral']);
}

function contextSessionsHtml(sessions) {
  if (!sessions.length) return `<div class="empty">${esc(t('No live session profile for this project.'))}</div>`;
  return sessions.map(s => {
    if (s.error) return `<div class="context-row"><span class="primary">${esc(s.name)}</span><span class="state state-warn">${esc(s.error)}</span></div>`;
    const files = (s.repository?.files ?? []).filter(f => f.kind === 'start');
    const extra = contextBlocks(s.blocks)
      + (files.length ? `<p class="hint">${esc(t('Claude Code also loads at the start: {list}', { list: files.map(f => `${f.file} (${tokenCount(f.tokens)})`).join(', ') }))}</p>` : '')
      + (s.missing ?? []).map(x => `<p class="state state-warn">${esc(t('Not found: {what}', { what: x }))}</p>`).join('');
    return contextPart(`${s.name}`, `${toolName(s.tool)} · ${s.cwd}`, s.text == null ? null : s.tokens, s.text ?? t('No first message: the profile names no blocks of the prompt builder.'), extra);
  }).join('');
}

function extraScopeLabel(scope) {
  if (scope === 'lead') return t("The team lead's extra instructions, in this project");
  if (scope === 'project') return t("Extra instructions for this member, in this project's crew");
  return t('Extra instructions for this agent in every project of this installation');
}

function contextFormHtml(d) {
  const b = d.builder;
  const options = b.options;
  const blocks = options
    ? `<div class="context-options">
        <fieldset><legend>${esc(t('Optional modules of the prompt builder'))}</legend>${options.modules.map(o => `<label class="option"><input type="checkbox" name="module" value="${esc(o.name)}"${o.on ? ' checked' : ''}> ${esc(o.name)} <span class="hint">${esc(o.section)}</span></label>`).join('') || `<p class="hint">${esc(t('None in the document.'))}</p>`}</fieldset>
        <fieldset><legend>${esc(t('Automatic blocks'))}</legend>${options.automatic.map(o => `<label class="option"><input type="checkbox" name="automatic" value="${esc(o.name)}"${o.off ? '' : ' checked'}> ${esc(o.name)} <span class="hint">${esc(o.off ? t('turned off for this project') : o.active ? t('comes in now') : t("doesn't come in with this choice"))}</span></label>`).join('') || `<p class="hint">${esc(t('None in the document.'))}</p>`}</fieldset>
      </div>`
    : `<p class="hint">${esc(t("The prompt builder's blocks can be turned on or off here once the project has a block in it (\"prompt_block\") and the document has a copy on this computer."))}</p>`;
  const members = d.members.map(m => {
    const extra = d.settings.extra[m.id] ?? { text: '', scope: 'installation' };
    return `<details class="context-edit-member"><summary>${esc(t(m.name))} <span class="hint">${esc(memberRoleLabel(m))}</span></summary>
        <label><span>${esc(extraScopeLabel(extra.scope))} <code>${esc(extra.field ?? '')}</code></span><textarea rows="3" data-extra="${esc(m.id)}">${esc(extra.text)}</textarea></label>
        <label><span>${esc(t("This project's notes for this member"))} <code>projects.${esc(d.project.id)}.agent_notes.${esc(m.id)}</code></span><textarea rows="3" data-agent-notes="${esc(m.id)}">${esc(d.settings.agentNotes[m.id] ?? '')}</textarea></label>
      </details>`;
  }).join('');
  return `<form id="context-form" class="panel form context-form">
      <div class="label">${esc(t('Change the context'))}</div>
      <p class="hint">${esc(t('Preview first, then save: the changes go to the settings, and the next steps and live sessions of this project get them. Every saving is kept in the history below.'))}</p>
      ${blocks}
      <label><span>${esc(t('Notes for the project'))} <code>projects.${esc(d.project.id)}.notes</code></span><textarea name="notes" rows="4">${esc(d.settings.notes)}</textarea></label>
      ${b.used ? `<p class="hint">${esc(t("The prompt builder is used for this project, so these notes don't go to the crew; each member's notes below do."))}</p>` : ''}
      <div class="label" style="margin-top:12px">${esc(t('Each member'))}</div>
      ${members}
      <div class="actions left"><button type="button" class="button secondary" data-context-preview>${esc(t('Preview'))}</button><button type="button" class="button" data-context-save hidden>${esc(t('Save'))}</button></div>
    </form>
    <div id="context-preview"></div>`;
}

function contextHistoryHtml(history) {
  if (!history.length) return `<div class="empty">${esc(t('No change made from the app yet.'))}</div>`;
  const rows = history.map(h => `<tr>
      <td class="num">${shortDate(h.at)}</td><td>${esc(h.by === 'cli' ? t('command line') : t('app'))}</td>
      <td><details><summary>${esc(h.changes.map(c => c.field).join(', '))}</summary>${h.changes.map(c => `<div class="hint"><code>${esc(c.field)}</code></div>${diffLines(c.before ? c.before.split('\n') : [], c.after ? c.after.split('\n') : [])}`).join('')}</details></td>
    </tr>`);
  return `<table class="table"><thead><tr><th>${esc(t('Date'))}</th><th>${esc(t('From'))}</th><th>${esc(t('What changed'))}</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

function drawProjectContext() {
  const c = projectContext;
  if (!c.data) {
    const html = c.error ? `<div class="panel"><p class="state state-error">${esc(c.error)}</p><button type="button" class="button secondary small" data-context-refresh>${esc(t('Try again'))}</button></div>` : `<div class="empty">${esc(t('Loading…'))}</div>`;
    draw('#project-context', JSON.stringify(['empty', c.id, c.error]), html);
    return;
  }
  const d = c.data;
  const skeleton = `<div class="section-head context-top">
      <p class="hint">${esc(t("Everything each member of the crew gets when it works on this project, put together the way the runs do it, in order and with the source of each part. Sizes are estimates (about 4 characters per token); Claude Code's own system prompt and tool definitions are not counted."))}</p>
      <button type="button" class="button secondary small" data-context-refresh>${esc(t('Refresh'))}</button>
    </div>
    <div class="context-builder">${contextBuilderLine(d.builder)}</div>
    <div id="context-summary"></div>
    <div id="context-member"></div>
    <h2 class="section-title">${esc(t('Live sessions: first message'))}</h2>
    <div class="panel">${contextSessionsHtml(d.sessions)}</div>
    <h2 class="section-title">${esc(t('Change'))}</h2>
    ${contextFormHtml(d)}
    <h2 class="section-title">${esc(t('History of changes'))}</h2>
    ${contextHistoryHtml(d.history)}`;
  if (draw('#project-context', JSON.stringify(['data', c.id, d.generated]), skeleton)) drawContextPreview();
  const m = d.members.find(x => x.id === c.member) ?? d.members[0];
  draw('#context-summary', JSON.stringify([d.generated, m?.id]), contextSummaryHtml(d));
  draw('#context-member', JSON.stringify([d.generated, m?.id]), m ? contextMemberHtml(m) : '');
  const refresh = $('#project-context [data-context-refresh]');
  if (refresh) refresh.disabled = c.loading;
}

/** What the changes would do, under the form; "Save" shows once there is a preview of real changes. */
function drawContextPreview() {
  const box = $('#context-preview');
  const save = $('#project-context [data-context-save]');
  if (!box) return;
  const p = projectContext.preview;
  if (save) save.hidden = !p?.changed.length;
  if (!p) {
    box.innerHTML = '';
    return;
  }
  if (!p.changed.length) {
    box.innerHTML = `<div class="panel">${stateHtml([t('Nothing changed.'), 'neutral'])}</div>`;
    return;
  }
  const fields = p.changed.map(c => `<li><code>${esc(c.field)}</code>${diffLines(c.before ? c.before.split('\n') : [], c.after ? c.after.split('\n') : [])}</li>`).join('');
  const effect = list => list.map(x => {
    const changed = x.removed.length || x.added.length;
    return `<li><span class="primary">${esc(t(x.name))}</span> <span class="num">${tokenCount(x.before)} → ${tokenCount(x.after)}</span>${changed ? `<details><summary>${esc(t('{out} line(s) out, {in} in', { out: x.removed.length, in: x.added.length }))}</summary>${diffLines(x.removed, x.added, 120)}</details>` : ` <span class="hint">${esc(t('unchanged'))}</span>`}</li>`;
  }).join('');
  box.innerHTML = `<div class="panel context-preview">
      <div class="label">${esc(t('Preview: nothing is saved yet'))}</div>
      <ul class="context-changes">${fields}</ul>
      <div class="label" style="margin-top:12px">${esc(t('What each one would get'))}</div>
      <ul class="context-changes">${effect(p.members)}</ul>
      ${p.sessions.length ? `<div class="label" style="margin-top:12px">${esc(t('Live sessions'))}</div><ul class="context-changes">${effect(p.sessions)}</ul>` : ''}
    </div>`;
}

/** The form's changes, against the context read: only what really differs. */
function contextChanges() {
  const form = $('#context-form');
  const d = projectContext.data;
  const changes = {};
  const same = (x, y) => [...x].sort().join('\n') === [...y].sort().join('\n');
  const options = d.builder.options;
  if (options) {
    const listed = new Set([...options.modules, ...options.automatic].map(o => o.name));
    const modules = [...form.querySelectorAll('input[name="module"]:checked')].map(i => i.value);
    const off = [...form.querySelectorAll('input[name="automatic"]:not(:checked)')].map(i => i.value);
    // Names the document no longer has stay as they were.
    const keptModules = d.builder.modules.filter(n => !listed.has(n));
    const keptOff = d.builder.exclude.filter(n => !listed.has(n));
    if (!same([...modules, ...keptModules], d.builder.modules)) changes.modules = [...d.builder.modules.filter(n => modules.includes(n) || keptModules.includes(n)), ...modules.filter(n => !d.builder.modules.includes(n))];
    if (!same([...off, ...keptOff], d.builder.exclude)) changes.exclude = [...keptOff, ...off];
  }
  if (form.notes.value.trim() !== d.settings.notes.trim()) changes.notes = form.notes.value;
  for (const area of form.querySelectorAll('textarea[data-extra]')) {
    const id = area.dataset.extra;
    if (area.value.trim() !== (d.settings.extra[id]?.text ?? '').trim()) (changes.extra ??= {})[id] = area.value;
  }
  for (const area of form.querySelectorAll('textarea[data-agent-notes]')) {
    const id = area.dataset.agentNotes;
    if (area.value.trim() !== String(d.settings.agentNotes[id] ?? '').trim()) (changes.agentNotes ??= {})[id] = area.value;
  }
  return changes;
}

$('#project-context').addEventListener('click', async event => {
  const row = event.target.closest('[data-context-member]');
  if (row) {
    projectContext.member = row.dataset.contextMember;
    drawProjectContext();
    return;
  }
  if (event.target.closest('[data-context-refresh]')) {
    openProjectContext(projectContext.id);
    return;
  }
  const preview = event.target.closest('[data-context-preview]');
  const save = event.target.closest('[data-context-save]');
  if ((!preview && !save) || projectContext.busy) return;
  const id = projectContext.id;
  const changes = contextChanges();
  projectContext.busy = true;
  (preview ?? save).disabled = true;
  try {
    if (preview) {
      projectContext.preview = { ...(await api('/api/project/context/preview', { project: id, changes })), changes };
      drawContextPreview();
    } else {
      // What is saved is what was previewed: a change written after the preview needs a new one.
      if (JSON.stringify(changes) !== JSON.stringify(projectContext.preview?.changes)) {
        projectContext.preview = null;
        drawContextPreview();
        toast(t('The form changed after the preview: preview it again.'));
        return;
      }
      const result = await api('/api/project/context/save', { project: id, changes });
      if (projectContext.id === id) Object.assign(projectContext, { data: result.context, preview: null });
      toast(t('Saved: the next steps and live sessions of this project get it.'));
      drawProjectContext();
    }
  } catch (error) {
    toast(error.message);
  } finally {
    projectContext.busy = false;
    (preview ?? save).disabled = false;
  }
});

// Writing in the form after a preview: "Save" waits for a new preview.
$('#project-context').addEventListener('input', event => {
  if (!event.target.closest('#context-form') || !projectContext.preview) return;
  projectContext.preview = null;
  drawContextPreview();
});

// The team lead's choice in the task form: a request, which the lead plans into tasks for the crew.
const LEAD_REQUEST = '@lead';

/** The task form's members: the project's crew and, when it has a lead, a request for the lead. */
function fillProjectTask(id) {
  const select = $('#project-task-agent');
  const team = state.teams?.find(x => x.project === id);
  const members = team?.members ?? state.crew.filter(a => a.id !== 'manager');
  const list = [...(team?.lead ? [[LEAD_REQUEST, t('{lead}: a request, planned into tasks for the crew', { lead: t(team.lead.name) })]] : []), ...members.map(a => [a.id, `${t(a.name)}: ${t(a.title ?? '')}`])];
  const key = `${id}|${list.map(([value]) => value).join(',')}`;
  if (select.dataset.list === key) return;
  const kept = select.value;
  select.innerHTML = planOptions(list, list.some(([value]) => value === kept) ? kept : list[0]?.[0]);
  select.dataset.list = key;
}

$('#project-task-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.target;
  const project = pageProject();
  try {
    if (form.agent.value === LEAD_REQUEST) await api('/api/ask', { project, request: form.instruction.value });
    else await api('/api/task', { agent: form.agent.value, project, instruction: form.instruction.value, review: form.review.checked });
    form.instruction.value = '';
    toast(t('Task queued.'));
    refresh();
  } catch (error) {
    toast(error.message);
  }
});

// ---------- The prompt builder ----------

// The document of blocks, the choice made for the project and the prompt it gives. "chosen" are the blocks marked by
// hand, "off" the automatic blocks turned off; the server puts them together (src/prompts.mjs) and remembers the
// choice per project. The prompt can be edited before it goes to a live session, a task or the clipboard.
// "editing": the prompt shown as text to edit; "focus": the block marked or unmarked last, shown first.
const builder = { project: null, data: null, chosen: [], off: [], result: null, edited: false, editing: false, focus: null, usual: null, loading: null, seq: 0, allCombos: false };
const sameName = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
const hasName = (list, name) => (list ?? []).some(x => sameName(x, name));
const withoutName = (list, name) => list.filter(x => !sameName(x, name));
const builderSections = () => builder.data?.document?.sections ?? [];

async function openBuilder(project, { reload = false } = {}) {
  if (!reload && builder.project === project && builder.data) return drawBuilder();
  if (builder.loading === project) return;
  builder.loading = project;
  try {
    const data = await api(`/api/prompt-builder?project=${encodeURIComponent(project)}`);
    if (builderTarget() !== project) return;
    const keep = reload && builder.project === project;
    // "Work live" on the project's page asks for its usual blocks, not the last choice.
    const usual = builder.usual === project;
    builder.usual = null;
    Object.assign(builder, { project, data, result: null, edited: false, editing: false });
    if (!keep) {
      // The last choice made for the project; the first time, its block, the environment and its modules.
      startBuilder(usual || !data.last ? { chosen: data.defaults, off: data.defaultsOff ?? [] } : data.last);
      builder.allCombos = false;
      $('#builder-text').value = '';
    }
    drawBuilder();
    if (data.document) await composeBuilder({ remember: false });
  } catch (error) {
    Object.assign(builder, { project, data: { error: error.message }, result: null });
    drawBuilder();
  } finally {
    builder.loading = null;
  }
}

/** Starts the choice from a list of blocks (those still in the document). */
function startBuilder(start) {
  const names = builderSections().flatMap(s => s.blocks.map(b => b.name));
  builder.chosen = (start.chosen ?? []).filter(n => hasName(names, n));
  builder.off = (start.off ?? []).filter(n => hasName(names, n));
}

/** The prompt builder's screen lives in its own view or in a project's tab: it is moved to where it is shown. */
function placeBuilder(inProject) {
  const home = inProject ? $('#project-builder') : $('#view-builder');
  const body = $('#builder-body');
  if (body.parentElement !== home) home.append(body);
}

/** "Work live": the project's prompt builder with its usual blocks (its block, the environment and its modules). */
async function workLive(id) {
  const hash = `#project/${encodeURIComponent(id)}/builder`;
  if (builder.project === id && builder.data?.document) {
    startBuilder({ chosen: builder.data.defaults, off: builder.data.defaultsOff ?? [] });
    if (location.hash !== hash) {
      location.hash = hash;
      drawProjectPage();
    }
    await composeBuilder();
  } else {
    builder.usual = id;
    if (location.hash !== hash) location.hash = hash;
    else openBuilder(id, { reload: true });
  }
}

async function composeBuilder({ remember = true } = {}) {
  const seq = ++builder.seq;
  const before = builder.result?.blocks ?? null;
  try {
    const result = await api('/api/prompt-builder/compose', { project: builder.project, chosen: builder.chosen, off: builder.off, remember });
    if (seq !== builder.seq) return;
    // The parts that leave the prompt are marked in red for a moment before it is written again.
    const leaving = (before ?? []).filter(n => !hasName(result.blocks, n));
    if (leaving.length && (await markLeaving(leaving)) && seq !== builder.seq) return;
    Object.assign(builder, { result, edited: false, editing: false });
    $('#builder-text').value = result.text;
    drawBuilder();
    if (before) markEntering(result.blocks.filter(n => !hasName(before, n)));
    return;
  } catch (error) {
    toast(error.message);
  }
  drawBuilder();
}

const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const builderPart = name => [...document.querySelectorAll('#builder-view .builder-part')].find(el => sameName(el.dataset.block, name));
const firstPart = parts => parts.find(el => sameName(el.dataset.block, builder.focus)) ?? parts[0];

/** Marks the parts leaving the prompt in red for a moment; false when they are not shown. */
async function markLeaving(names) {
  const parts = names.map(builderPart).filter(Boolean);
  if (!parts.length || $('#builder-view').hidden) return false;
  for (const el of parts) el.classList.add('leaving');
  scrollToPart(firstPart(parts));
  await new Promise(resolve => setTimeout(resolve, calm() ? 400 : 650));
  return true;
}

/** Marks the parts that came into the prompt in brass, fading in about 2 seconds, and scrolls to them. */
function markEntering(names) {
  const parts = names.map(builderPart).filter(Boolean);
  if (!parts.length || $('#builder-view').hidden) return;
  for (const el of parts) {
    el.classList.add('entering');
    setTimeout(() => el.classList.remove('entering'), 2000);
  }
  scrollToPart(firstPart(parts));
}

/** Scrolls the prompt to a part, unless it is already in sight. */
function scrollToPart(el) {
  const view = $('#builder-view');
  const top = el.offsetTop - 8;
  const bottom = el.offsetTop + Math.min(el.offsetHeight, view.clientHeight - 16);
  if (top < view.scrollTop || bottom > view.scrollTop + view.clientHeight) view.scrollTo({ top, behavior: calm() ? 'auto' : 'smooth' });
}

// A color per block, the same on its checkbox and in the margin of its part of the prompt; muted, so brass stays the accent.
function blockColor(name) {
  const names = builderSections().flatMap(sec => sec.blocks.map(b => b.name));
  const i = Math.max(0, names.findIndex(n => sameName(n, name)));
  return `hsl(${Math.round((i * 137.508) % 360)} 38% 64%)`;
}

/** Why an automatic block came in by itself, from the details of the prompt put together. */
function automaticWhy(d) {
  switch (d?.how) {
    case 'include-with': return t('Came in by itself, with: {list}', { list: d.condition });
    case 'tags': return t('Came in by itself, sharing: {list}', { list: d.condition });
    case 'requires': return t('Came in by itself, as it requires: {list}', { list: d.condition });
    case 'always': return t('Always comes in by itself');
    default: return '';
  }
}

/** The final prompt, block by block: each part with its block's color in the margin, the automatic ones dashed. */
function drawBuilderView() {
  const r = builder.result;
  const editing = builder.editing || builder.edited;
  $('#builder-view').hidden = editing;
  $('#builder-text').hidden = !editing;
  const edit = $('#builder-edit');
  edit.hidden = builder.edited;
  edit.textContent = editing ? t('Show the blocks') : t('Edit');
  const details = r?.details ?? [];
  const unfilled = text => esc(text).replace(/\{([^{}\s]+)\}/g, (whole, name) => ((r.unresolved ?? []).includes(name) ? `<span class="unfilled">${whole}</span>` : whole));
  const html = details.length
    ? details.map(d => `<div class="builder-part${hasName(r.automatic, d.name) ? ' automatic' : ''}" data-block="${esc(d.name)}" style="--block: ${blockColor(d.name)}">${unfilled(d.text)}</div>`).join('')
    : `<div class="empty">${esc(t('Mark blocks to put the prompt together.'))}</div>`;
  draw('#builder-view', JSON.stringify([details.map(d => [d.name, d.text]), r?.automatic, r?.unresolved]), html);
}

/** Where the prompt builder's document comes from and how recent it is, a sentence each. */
function builderSourceLines(s) {
  const lines = [];
  const c = s.commit;
  if (s.source === 'library') {
    lines.push(t('Document {path}, in the library {name}.', { path: s.library.path, name: s.library.name }));
    if (c) lines.push(c.approximate ? t('Last change on {when} or before: {subject}', { when: shortDate(c.date), subject: c.subject }) : t('Last change on {when}: {subject}', { when: shortDate(c.date), subject: c.subject }));
    if (s.copied) lines.push(t("The library's copy was updated on {when}.", { when: shortDate(s.copied) }));
  } else if (s.origin === 'library') {
    lines.push(t('The library {name} has no {path} yet: the file on this computer is used.', { name: s.library.name, path: s.library.path }));
  } else if (s.origin === 'google') {
    lines.push(s.sync?.synced_at ? t('Copied from Google Docs on {when}.', { when: shortDate(s.sync.synced_at) }) : s.exists ? t('Copy on this computer from {when}.', { when: shortDate(s.modified) }) : t('No copy of the document on this computer yet.'));
  } else lines.push(s.exists ? t('Document on this computer, from {when}.', { when: shortDate(s.modified) }) : t('No copy of the document on this computer yet.'));
  return lines;
}

function drawBuilder() {
  if (!state) return;
  const list = [['', t('No project')], ...state.projects.map(p => [p.id, p.name ?? p.id])];
  const options = planOptions(list, builderProjectOf());
  if (!draw('#builder-project', options, options)) $('#builder-project').value = builderProjectOf();
  drawBuilderTop();
  drawBuilderSections();
  drawBuilderView();
  drawBuilderNotes();
  fillBuilderAgents();
}

/** The copy's date (with a warning when it is old), the reload button and the ready choices. */
function drawBuilderTop() {
  const d = builder.data;
  const p = state.prompts ?? {};
  let status;
  if (!d) status = `<div class="hint">${esc(t('Loading…'))}</div>`;
  else if (d.error) status = `<div class="panel">${stateHtml([d.error, 'error'])}</div>`;
  else if (!d.status.configured) status = `<div class="empty">${esc(t('No prompt builder set: add "prompt_builder" with the "file" of your document of blocks to the settings (see the README).'))}</div>`;
  else {
    // The status read with the page (with the document's last commit), the state's for what changes meanwhile.
    const s = { ...d.status, ...(p.configured ? { copied: p.copied, stale: p.stale, sync: p.sync, commit: p.commit ?? d.status.commit } : {}) };
    const syncing = p.syncing ?? d.syncing;
    const sync = s.sync ?? {};
    const library = s.origin === 'library';
    const title = library ? t("Updates the library's copy (git), then reads it.") : s.origin === 'google' && d.cdp ? t('Copies the document from Google Docs again, then reads it.') : t('Reads the copy on this computer again.');
    const stale = library ? t("The library's copy was last updated more than {days} days ago: reload it.", { days: s.staleDays }) : t('The copy is more than {days} days old: reload it to get your latest changes.', { days: s.staleDays });
    status = `<div class="builder-status"><p>${builderSourceLines(s).map(esc).join(' ')}</p>
      ${s.stale ? stateHtml([stale, 'warn']) : ''}
      ${sync.ok === false ? stateHtml([sync.error, 'error']) : ''}
      <button type="button" class="button secondary small" data-builder-reload title="${esc(title)}"${syncing ? ' disabled' : ''}>${esc(syncing ? (library ? t('Updating…') : t('Copying…')) : t('Reload document'))}</button></div>`;
  }
  draw('#builder-status', status, status);

  // The ready choices: the project's ones (those with its block), or all of them.
  const combos = d?.document?.combinations ?? [];
  const mine = d?.projectBlock ? combos.filter(c => hasName(c.blocks, d.projectBlock)) : combos;
  const shown = builder.allCombos || !mine.length ? combos : mine;
  const current = c => c.blocks.length === builder.chosen.length && c.blocks.every(b => hasName(builder.chosen, b));
  const html = combos.length
    ? `<div class="builder-combos"><span class="label">${esc(t('Ready choices'))}</span>${shown.map(c => `<button type="button" class="button small${current(c) ? '' : ' secondary'}" data-builder-combo="${esc(c.name)}" title="${esc(c.blocks.join(' + '))}">${esc(c.name)}</button>`).join('')}
      ${mine.length && mine.length < combos.length ? `<button type="button" class="button secondary small" data-builder-all-combos>${esc(builder.allCombos ? t('Only this project') : t('All ({count})', { count: combos.length }))}</button>` : ''}</div>`
    : '';
  draw('#builder-combos', html, html);
}

const selectionHint = kind => ({ one: t('choose one'), several: t('choose any'), automatic: t('come in by themselves') })[kind] ?? '';

/** Each section with its blocks: marked, automatic, turned off, or not allowed now ("requires" not met). */
function drawBuilderSections() {
  const d = builder.data;
  const r = builder.result;
  $('#builder-main').hidden = !d?.document;
  if (!d?.document) return draw('#builder-sections', '', '');
  const html = builderSections().map(s => `<div class="panel builder-section">
      <div class="label"><span>${esc(s.name)}</span><span class="hint">${esc(selectionHint(s.selection))}</span></div>
      ${s.blocks.map(b => {
        const on = r ? hasName(r.blocks, b.name) : hasName(builder.chosen, b.name);
        const automatic = !!r && hasName(r.automatic, b.name);
        const unavailable = !on && !!r && hasName(r.unavailable, b.name);
        const unmet = (r?.unmet ?? []).some(u => sameName(u.block, b.name));
        const why = automatic ? automaticWhy((r.details ?? []).find(x => sameName(x.name, b.name))) : '';
        const facts = [
          b.tags.length ? t('tags: {list}', { list: b.tags.join(', ') }) : '',
          b.access.length ? t('sign-in: {list}', { list: b.access.join(', ') }) : '',
          b.requires ? t('requires: {list}', { list: b.requires }) : '',
          b.includeWith ? t('comes with: {list}', { list: b.includeWith }) : '',
          hasName(builder.off, b.name) ? t('turned off') : '',
        ].filter(Boolean).join(' · ');
        return `<label class="builder-block${on ? ' included' : ''}${automatic ? ' automatic' : ''}${unavailable ? ' unavailable' : ''}${unmet ? ' unmet' : ''}" style="--block: ${blockColor(b.name)}" data-auto="${esc(t('automatic'))}" title="${esc(b.text.slice(0, 500))}">
          <input type="checkbox" data-builder-block="${esc(b.name)}" data-selection="${esc(b.selection)}" data-section="${esc(s.name)}"${on ? ' checked' : ''}${unavailable ? ' disabled' : ''}${why ? ` aria-description="${esc(why)}"` : ''}>
          <span class="name">${esc(b.name)}</span>${why ? `<span class="why">${esc(why)}</span>` : ''}${facts ? `<span class="hint">${esc(facts)}</span>` : ''}</label>`;
      }).join('')}
    </div>`).join('');
  draw('#builder-sections', html, html);
}

function drawBuilderNotes() {
  const r = builder.result;
  const notes = [];
  if (r?.unresolved?.length) notes.push([t('Variables without a value in the document: {list}', { list: r.unresolved.map(v => `{${v}}`).join(', ') }), 'warn']);
  for (const u of r?.unmet ?? []) notes.push([t('"{block}" requires {list}, which is not chosen.', { block: u.block, list: u.requires }), 'warn']);
  if (r?.missing?.length) notes.push([t('Not in the document: {list}', { list: r.missing.join(', ') }), 'warn']);
  if (builder.edited) notes.push([t('Edited by hand: changing the blocks writes the prompt again.'), 'info']);
  const html = notes.length ? `<div class="builder-notes">${notes.map(n => `<div>${stateHtml(n)}</div>`).join('')}</div>` : '';
  draw('#builder-notes', html, html);
  const empty = !$('#builder-text').value.trim();
  $('#builder-session').disabled = !builder.project || empty;
  $('#builder-task').querySelector('[type=submit]').disabled = !builder.project || empty;
  $('#builder-copy').disabled = empty;
}

/** The task's members: the project's crew (the team lead takes requests, not tasks). */
function fillBuilderAgents() {
  const select = $('#builder-agent');
  const team = state.teams?.find(x => x.project === builder.project);
  const members = builder.project ? team?.members ?? state.crew.filter(a => a.id !== 'manager') : [];
  const list = members.map(a => [a.id, `${t(a.name)}: ${t(a.title ?? '')}`]);
  const key = `${builder.project}|${list.map(([value]) => value).join(',')}`;
  if (select.dataset.list === key) return;
  const kept = select.value;
  select.innerHTML = planOptions(list, list.some(([value]) => value === kept) ? kept : list[0]?.[0]);
  select.dataset.list = key;
}

$('#builder-project').addEventListener('change', event => {
  const id = event.target.value;
  location.hash = id ? `#builder/${encodeURIComponent(id)}` : '#builder';
});

$('#builder-sections').addEventListener('change', event => {
  const input = event.target.closest('[data-builder-block]');
  if (!input) return;
  const name = input.dataset.builderBlock;
  builder.focus = name;
  if (input.checked) {
    builder.off = withoutName(builder.off, name);
    if (input.dataset.selection === 'one') {
      // One block per section: the others of the section leave the choice.
      const section = builderSections().find(s => s.name === input.dataset.section);
      for (const b of section?.blocks ?? []) if (b.selection === 'one' && !sameName(b.name, name)) builder.chosen = withoutName(builder.chosen, b.name);
    }
    builder.chosen = [...withoutName(builder.chosen, name), name];
  } else {
    builder.chosen = withoutName(builder.chosen, name);
    if (input.dataset.selection === 'automatic') builder.off = [...withoutName(builder.off, name), name];
  }
  composeBuilder();
});

$('#builder-text').addEventListener('input', () => {
  builder.edited = true;
  drawBuilderView();
  drawBuilderNotes();
});

$('#builder-edit').addEventListener('click', () => {
  builder.editing = !builder.editing;
  drawBuilderView();
  if (builder.editing) $('#builder-text').focus();
});

$('#builder-copy').addEventListener('click', async () => {
  const text = $('#builder-text').value;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    $('#builder-text').select();
    document.execCommand('copy');
  }
  toast(t('Prompt copied.'));
});

$('#builder-session').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const session = await api('/api/prompt-builder/session', { project: builder.project, tool: $('#builder-tool').value, prompt: $('#builder-text').value });
    toast(session.status === 'login' ? t('Codex is not signed in: see the request at the top.') : t('Session opened in a window of its own.'));
    refresh();
  } catch (error) {
    toast(error.message);
  }
  drawBuilderNotes();
});

$('#builder-task').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.target;
  try {
    await api('/api/task', { project: builder.project, agent: form.agent.value, instruction: form.instruction.value, review: form.review.checked, prompt: $('#builder-text').value });
    form.instruction.value = '';
    toast(t('Task queued.'));
    refresh();
  } catch (error) {
    toast(error.message);
  }
});

$('#builder-body').addEventListener('click', async event => {
  const target = event.target.closest('[data-builder-combo],[data-builder-all-combos],[data-builder-reload]');
  if (!target) return;
  try {
    if (target.dataset.builderCombo) {
      const combo = (builder.data?.document?.combinations ?? []).find(c => c.name === target.dataset.builderCombo);
      if (!combo) return;
      Object.assign(builder, { chosen: [...combo.blocks], off: [] });
      await composeBuilder();
    } else if (target.hasAttribute('data-builder-all-combos')) {
      builder.allCombos = !builder.allCombos;
      drawBuilderTop();
    } else {
      target.disabled = true;
      const d = builder.data;
      const origin = d?.status?.origin;
      if (origin === 'library' || (origin === 'google' && d.cdp)) {
        toast(origin === 'library' ? t("Updating the library's copy…") : t('Copying the prompt builder…'));
        const status = await api('/api/prompts-sync', {});
        toast(status.ok ? (status.source === 'library' ? t('Document updated from the library.') : t('Prompt builder copied.')) : status.error);
      } else toast(t('Document read again.'));
      await openBuilder(builder.project, { reload: true });
    }
  } catch (error) {
    toast(error.message);
  }
});

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
    <td>${projectLink(i.project)}</td>
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
      `<li><span class="num">#${i.id}</span> <span class="hint">${projectLink(i.project)}</span> <span class="primary">${esc(i.title)}</span>${i.pr ? ` · ${prLink(i.pr)}` : ''}</li>`).join('')}</ul></div>`
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

// ---------- The agent's panel: live, and the direct talk ----------

// The run whose agent the panel shows, the step it reads and where its log was read up to.
const agentPanel = { run: null, step: null, next: null, timer: null, loading: false };

function openAgentPanel(id) {
  Object.assign(agentPanel, { run: id, step: null, next: null });
  $('#agent-feed').innerHTML = '';
  for (const key of ['#agent-head', '#agent-talk']) delete signatures[key];
  $('#agent-panel').hidden = false;
  clearInterval(agentPanel.timer);
  agentPanel.timer = setInterval(pollAgent, 1500);
  pollAgent();
  setTimeout(() => $('#agent-form').text.focus(), 0);
}

function closeAgentPanel() {
  clearInterval(agentPanel.timer);
  agentPanel.run = null;
  $('#agent-panel').hidden = true;
}

/** Adds what the agent did since the last reading, keeping the view at the end when it was there. */
function appendFeed(f, first) {
  const box = $('#agent-feed');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  const html = [];
  if (first) html.push(`<div class="feed-step">${esc(t('Step {n} of {total}', { n: f.step, total: f.total }))} · ${esc(f.agent ? agentName(f.agent, f.project) : t('preparing'))}</div>`);
  for (const i of f.items) {
    html.push(i.type === 'say'
      ? `<div class="feed-say">${md(i.text)}</div>`
      : `<div class="feed-action"><span class="feed-tool" title="${esc(i.tool)}">${esc(i.tool)}</span><span>${esc(i.text)}</span></div>`);
  }
  if (!html.length) return;
  box.insertAdjacentHTML('beforeend', html.join(''));
  while (box.childElementCount > 800) box.firstElementChild.remove();
  if (atBottom || first) box.scrollTop = box.scrollHeight;
}

function drawAgentHead(f) {
  const who = f.agent ? member(f.agent, f.project) : member('manager');
  const look = online ? stepFace({ status: f.stepStatus, review: f.review }) : 'offline';
  const status = f.live ? (f.stepStatus === 'running' ? [f.review ? t('Reviewing') : t('Working'), 'info'] : [t('Preparing…'), 'info']) : runState(f.status);
  const where = [projectName(f.project), t('Step {n} of {total}', { n: f.step, total: f.total })].join(' · ');
  const html = `${face(who, look, 40)}<div style="min-width:0">
      <div class="name">${esc(f.agent ? agentName(f.agent, f.project) : t('Chiefmate, preparing the working copy'))}</div>
      <div class="hint" title="${esc(f.title)}">${esc(f.title)}</div>
      <div class="hint">${esc(where)}${f.live && f.stepStatus === 'running' && f.stepStarted ? ` · ${ticking(f.stepStarted)}` : ''}</div>
      ${stateHtml(status)}
    </div>`;
  draw('#agent-head', JSON.stringify([online, f.run, f.step, f.agent, f.stepStatus, f.live, f.status]), html);
  $('#agent-form').querySelector('button').disabled = !f.talking;
  $('#agent-form-hint').textContent = f.talking
    ? t('Your message reaches the agent at a safe point: it answers here and goes on with its work.')
    : f.live ? t('The agent is between two steps: write again in a moment.') : t('This run is no longer going on.');
}

function drawAgentTalk(f) {
  const open = new Set(f.requests.map(r => r.id));
  const entries = f.talk.map(m => {
    const meta = [clockTime(m.at), t('step {n}', { n: m.step })];
    if (m.who === 'owner') {
      const status = { pending: t('waiting for a safe point'), delivered: m.via === 'request' ? t('delivered as the answer to the request') : t('delivered'), undelivered: t('not delivered') }[m.status];
      return `<div class="talk owner"><div class="talk-head"><span class="talk-who">${esc(t('You'))}</span> · ${esc([...meta, status].filter(Boolean).join(' · '))}</div><div class="talk-text">${esc(m.text)}</div></div>`;
    }
    const asking = m.kind === 'request';
    const waiting = asking && open.has(m.request);
    const button = waiting ? ` <button type="button" class="button small" data-needs-done="${esc(f.run)}" data-request="${esc(m.request)}">${esc(t('Mark as done'))}</button>` : '';
    return `<div class="talk${asking ? ' request' : ''}"><div class="talk-head"><span class="talk-who">${esc(agentName(m.agent, f.project))}</span> · ${esc([...meta, asking ? t('asks for your help') : ''].filter(Boolean).join(' · '))}${button}</div><div class="talk-text">${esc(m.text)}</div>${waiting ? `<div class="hint">${esc(t('Answer below: your message goes to the agent as the answer.'))}</div>` : ''}</div>`;
  });
  const html = entries.join('') || `<div class="hint">${esc(t('Nothing yet. Write below: the agent pauses at a safe point, reads your message and goes on in the same session, on the same branch.'))}</div>`;
  if (draw('#agent-talk', JSON.stringify([f.run, f.talk.map(m => [m.id, m.status]), [...open]]), html)) $('#agent-talk').scrollTop = $('#agent-talk').scrollHeight;
}

async function pollAgent() {
  const id = agentPanel.run;
  if (!id || agentPanel.loading) return;
  agentPanel.loading = true;
  let again = false;
  try {
    const query = new URLSearchParams();
    if (agentPanel.step) query.set('step', agentPanel.step);
    if (agentPanel.next != null) query.set('from', agentPanel.next);
    const f = await api(`/api/run/${encodeURIComponent(id)}/feed?${query}`);
    if (agentPanel.run !== id) return;
    // The run went on to another step: follow it, from the start of that step.
    if (agentPanel.step && f.live && f.current !== f.step) {
      Object.assign(agentPanel, { step: f.current, next: null });
      again = true;
      return;
    }
    const first = agentPanel.next == null;
    Object.assign(agentPanel, { step: f.step, next: f.next });
    appendFeed(f, first);
    drawAgentHead(f);
    drawAgentTalk(f);
  } catch (error) {
    $('#agent-form-hint').textContent = error.message;
  } finally {
    agentPanel.loading = false;
    if (again) pollAgent();
  }
}

async function sendToAgent() {
  const area = $('#agent-form').text;
  const text = area.value.trim();
  if (!text || !agentPanel.run) return;
  try {
    const sent = await api('/api/run/talk', { run: agentPanel.run, text });
    area.value = '';
    toast(sent.via === 'request' ? t("Sent as the answer to the agent's request.") : t('Sent. The agent reads it at the next safe point.'));
    pollAgent();
  } catch (error) {
    toast(error.message);
  }
}

$('#agent-form').addEventListener('submit', event => {
  event.preventDefault();
  sendToAgent();
});
$('#agent-form').text.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendToAgent();
  }
});
$('#agent-close').addEventListener('click', closeAgentPanel);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && agentPanel.run && !document.querySelector('dialog[open]')) closeAgentPanel();
});
// A click on an agent at work (in Operations, the crew, the teams or the focus) opens its panel; the buttons inside
// those places keep their own action.
document.addEventListener('click', event => {
  const target = event.target.closest('[data-agent-run]');
  if (!target) return;
  const control = event.target.closest('button, a, input, textarea, select, summary');
  if (control && control !== target) return;
  openAgentPanel(target.dataset.agentRun);
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
    $('#agent-form').text.value.trim() !== '' ||
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
  drawProjectJump();
  if (currentView() === 'project') {
    drawProjectPage();
    refreshProjectPage();
  }
  if (currentView() === 'builder') {
    placeBuilder(false);
    if (builder.project !== builderProjectOf() || !builder.data) openBuilder(builderProjectOf());
    else drawBuilderTop();
  }
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

// "Update now": installs the approved update without waiting for the crew, after a confirmation; while the update
// waits for the manager, the same place offers to interrupt its answer.
$('#bridge').addEventListener('click', async event => {
  const button = event.target.closest('[data-update-now]');
  if (!button) return;
  const interrupt = button.dataset.updateNow === 'interrupt';
  const runs = going().length;
  let text;
  if (interrupt) text = t("The manager stops its answer now, so the update can go in. The conversation goes on in the same session after the restart, and your next message tells it the answer was interrupted.");
  else {
    text = [
      runs ? t('The {count} run(s) going on pause at a safe point: each agent finishes the action under way, and its step resumes the same session after the update, told that Chiefmate was updated.', { count: runs }) : t('No run is going on.'),
      state.manager.responding ? t('The manager is answering: the update waits for the answer to end (you can interrupt it here meanwhile).') : '',
      t('Then Chiefmate installs the new version, checks it and restarts. The paused runs and the messages in the queue resume by themselves. If the checks fail, Chiefmate stays on the current version and resumes the same way.'),
    ].filter(Boolean).join(' ');
  }
  const ok = await confirmDialog(interrupt ? t("Interrupt the manager's answer") : t('Update now'), text, interrupt ? t('Interrupt') : t('Update now'));
  if (!ok) return;
  try {
    await api('/api/update-now', { interruptManager: interrupt });
    toast(interrupt ? t("Interrupting the manager's answer…") : t('Updating: the work going on pauses at a safe point.'));
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

document.addEventListener('click', event => {
  for (const menu of document.querySelectorAll('details.menu[open]')) if (!menu.contains(event.target) || event.target.closest('.menu-item')) menu.open = false;
});

document.addEventListener('click', async event => {
  const target = event.target.closest('[data-run],[data-assign],[data-select],[data-cancel],[data-resume],[data-suggestion],[data-stop],[data-expand],[data-reset-used],[data-reset-remove],[data-reader],[data-needs-done],[data-needs-session],[data-context],[data-prompts-sync],[data-session-open],[data-session-end],[data-project-open],[data-project-dev],[data-project-planning],[data-project-task],[data-project-live]');
  if (!target) return;
  // A project's name inside a row that opens on a click (Projects) goes to its page, and nothing else.
  if (event.target.closest('a.project-link') && !target.matches('a')) return;
  try {
    if (target.hasAttribute('data-project-task')) {
      // The form is in the "Tasks and history" tab.
      location.hash = `#project/${encodeURIComponent(pageProject())}/tasks`;
      drawProjectPage();
      $('#project-task-form').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest' });
      $('#project-task-form').instruction.focus();
      return;
    } else if (target.hasAttribute('data-project-live')) {
      await workLive(pageProject());
      return;
    } else if (target.dataset.projectPlanning) {
      planFilter.project = target.dataset.projectPlanning;
      location.hash = '#planning';
      drawPlanning(true);
      return;
    } else if (target.dataset.projectOpen) {
      const app = target.dataset.projectOpen;
      await api('/api/project/open', { project: pageProject(), app });
      toast(app === 'vscode' ? t('Opening VS Code…') : t('Opening the folder…'));
      return;
    } else if (target.dataset.projectDev) {
      const project = pageProject();
      if (target.dataset.projectDev === 'stop') {
        const ok = await confirmDialog(t('Stop the development environment'), t('The window of the development environment of {project} closes, with everything it started.', { project: projectName(project) }), t('Stop'));
        if (!ok) return;
        const r = await api('/api/project/dev', { project, action: 'stop' });
        toast(r.stopped ? t('Development environment stopped.') : t('It was no longer running.'));
      } else {
        target.disabled = true;
        await api('/api/project/dev', { project, action: 'start' });
        toast(t('Development environment starting in a window of its own.'));
      }
      await refreshProjectPage();
    } else if (target.dataset.run) {
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
      const library = state.prompts?.origin === 'library';
      toast(library ? t("Updating the library's copy…") : t('Copying the prompt builder…'));
      const status = await api('/api/prompts-sync', {});
      toast(status.ok ? (library ? t('Document updated from the library.') : t('Prompt builder copied.')) : status.error);
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
