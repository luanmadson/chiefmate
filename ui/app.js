// The Chiefmate app: fetches the state every 2.5 seconds (once a minute with the tab hidden) and redraws only what changed.
import { face } from './faces.js';
import { language, locale, setLanguage, t, translatePage } from './i18n.js';
import { Dictation, recognizer } from './voice.js';

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

// A file's path in a text, which opens the viewer: absolute (C:\… or C:/…), or relative with a folder and a known
// extension, with an optional ":line"; inside `code`, a file's name alone too.
const FILE_EXT = 'png|jpe?g|gif|webp|svg|bmp|avif|ico|pdf|md|markdown|txt|log|csv|tsv|xlsx|xlsm|json|jsonl|ya?ml|xml|html?|css|m?js|cjs|tsx?|jsx|py|ps1|sh|toml|ini|sql|docx?|pptx?|zip';
const LINE = '(?::\\d+(?:-\\d+)?)?';
const ABS_PATH = /^[A-Za-z]:[\\/](?![\\/])[^\s<>"'`|*?]*$/;
const REL_PATH = new RegExp(`^(?:\\.[\\\\/])?(?:[\\w@.-]+[\\\\/])+[\\w@.-]+\\.(?:${FILE_EXT})${LINE}$`, 'i');
const NAME_PATH = new RegExp(`^[\\w@.-]+\\.(?:${FILE_EXT})${LINE}$`, 'i');
const ABS_IN_TEXT = /(^|[\s(“"'])([A-Za-z]:[\\/](?![\\/])[^\s<>"'`|*?]+)/g;
const REL_IN_TEXT = new RegExp(`(^|[\\s(“"'])((?:\\.[\\\\/])?(?:[\\w@.-]+[\\\\/])+[\\w@.-]+\\.(?:${FILE_EXT})${LINE})(?=$|[\\s),.;:!?”"'])`, 'gi');
const fileLink = (p, label) => `<a class="file-link" role="button" tabindex="0" data-file="${esc(p)}">${label}</a>`;

function inline(s) {
  // Code and paths first, kept aside so the rest of the formatting doesn't touch them.
  const kept = [];
  const keep = html => `\u0000${kept.push(html) - 1}\u0000`;
  const text = String(s ?? '').replace(/\u0000/g, '')
    .replace(/`([^`]+)`/g, (m, c) => keep(ABS_PATH.test(c) || REL_PATH.test(c) || NAME_PATH.test(c) ? fileLink(c, `<code>${esc(c)}</code>`) : `<code>${esc(c)}</code>`))
    .replace(ABS_IN_TEXT, (m, before, p) => {
      const tail = p.match(/[.,;:!?)\]]+$/)?.[0] ?? '';
      const file = p.slice(0, p.length - tail.length);
      return `${before}${keep(fileLink(file, esc(file)))}${tail}`;
    })
    .replace(REL_IN_TEXT, (m, before, p) => `${before}${keep(fileLink(p, esc(p)))}`);
  return esc(text)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    // A web address never takes in a kept piece: its HTML would land inside the href.
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)\u0000]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)\u0000]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>')
    .replace(/\u0000(\d+)\u0000/g, (m, i) => kept[Number(i)]);
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
// The tool a member's steps run on (Claude Code, Codex or Grok), as a mark beside its model.
const TOOL_LABELS = { claude: 'Claude', codex: 'Codex', grok: 'Grok' };
function toolTitle(a) {
  const name = TOOL_LABELS[a.tool] ?? a.tool;
  if (a.toolReason === 'expired') return t('{tool} was available until {date}: back on Claude Code', { tool: TOOL_LABELS[a.toolAsked] ?? a.toolAsked, date: a.toolUntil });
  if (a.toolReason === 'off' || a.toolReason === 'unknown') return t('{tool} is not available: on Claude Code', { tool: TOOL_LABELS[a.toolAsked] ?? a.toolAsked });
  return a.toolUntil ? t('Runs on {tool} until {date}', { tool: name, date: a.toolUntil }) : t('Runs on {tool}', { tool: name });
}
const toolBadge = a => (a?.tool ? `<span class="tool-mark" data-tool="${esc(a.tool)}" title="${esc(toolTitle(a))}">${esc(TOOL_LABELS[a.tool] ?? a.tool)}</span>` : '');
/** A model's short name; none: the tool's own default. */
const modelLabel = a => (a.model ? shortModel(a.model) : t('default model'));

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

/** A final summary (of a step or a run): what was done, what changes for you, and whether you are needed. */
function outcomeHtml(o) {
  if (!o) return '';
  return `<div class="outcome">
      <div><span class="label">${esc(t('What was done'))}</span>${o.done?.length ? `<ul>${o.done.map(d => `<li>${inline(d)}</li>`).join('')}</ul>` : '<p>—</p>'}</div>
      <div><span class="label">${esc(t('What changes for you'))}</span><p>${inline(o.change || '—')}</p></div>
      <div><span class="label">${esc(t('Needs you?'))}</span><p>${o.needs ? `${stateHtml([t('Yes'), 'warn'])} ${esc(o.needs)}` : esc(t('No'))}</p></div>
    </div>`;
}

/** A run's summary, one line under its title in the lists (whole on hover). */
const summaryLine = r => (r.summary ? `<span class="secondary run-line" title="${esc(r.summary)}">${esc(r.summary)}</span>` : '');

/** A run's title for a link (the planning board's items), from the runs the app knows; else its id. */
const runTitle = id => allRuns().find(r => r.id === id)?.title ?? id;

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
  // What the owner opened ([data-keep-open] details) stays open when the content is drawn again.
  const opened = [...$(selector).querySelectorAll('details[data-keep-open][open]')].map(d => d.dataset.keepOpen);
  $(selector).innerHTML = html;
  for (const d of $(selector).querySelectorAll('details[data-keep-open]')) if (opened.includes(d.dataset.keepOpen)) d.open = true;
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
const agentName = (id, project) => (id ? t(member(id, project).name ?? id) : ''); // none: an item with no agent yet
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
const VIEWS = ['manager', 'decisions', 'operations', 'planning', 'radar', 'missions', 'crew', 'projects', 'builder', 'log', 'usage', 'project', 'session'];
const pageProject = () => (location.hash.startsWith('#project/') ? decodeURIComponent(location.hash.slice('#project/'.length).split('/')[0]) : null);
const PROJECT_TABS = ['overview', 'charge', 'live', 'crew', 'tasks', 'planning', 'files', 'context', 'builder'];
const pageTab = () => {
  const tab = location.hash.startsWith('#project/') ? location.hash.slice('#project/'.length).split('/')[1] : null;
  return PROJECT_TABS.includes(tab) ? tab : 'overview';
};
const builderHash = () => /^#builder(\/|$)/.test(location.hash);
const builderProjectOf = () => (location.hash.startsWith('#builder/') ? decodeURIComponent(location.hash.slice('#builder/'.length)) : '');
// The project the prompt builder is shown for: its own view's, or the project's whose "builder" tab is open (null: hidden).
const builderTarget = () => (builderHash() ? builderProjectOf() : pageProject() && pageTab() === 'builder' ? pageProject() : null);
// A live session's conversation: "#project/<id>/live/<session>" for a project's, "#session/<id>" for the others.
const pageSession = () => (location.hash.startsWith('#session/') ? decodeURIComponent(location.hash.slice('#session/'.length)) : null);
const pageLiveSession = () => (location.hash.startsWith('#project/') ? decodeURIComponent(location.hash.slice('#project/'.length).split('/')[2] ?? '') : '');
const currentView = () => (pageProject() ? 'project' : pageSession() ? 'session' : builderHash() ? 'builder' : VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'manager');
const touchScreen = () => matchMedia('(pointer: coarse)').matches;
const phoneQuery = matchMedia('(max-width: 600px)'); // the phone layout of ui/style.css
/** In a message field, Enter sends and Shift+Enter starts a new line; on a touch screen, Enter starts a new line and the Send button sends. */
const enterSends = event => event.key === 'Enter' && !event.shiftKey && !event.isComposing && !touchScreen();
/** The fields' hints: "Enter sends" only where there is a keyboard to press it (not on a touch screen nor a phone's layout). */
function drawPlaceholders() {
  const touch = touchScreen() || phoneQuery.matches || (navigator.maxTouchPoints > 0 && matchMedia('(hover: none)').matches);
  $('#message').placeholder = touch ? t('Write to the manager.') : t('Write to the manager. Enter sends; Shift+Enter starts a new line.');
  $('#live-text').placeholder = touch ? t('Write to the agent.') : t('Write to the agent. Enter sends; Shift+Enter starts a new line.');
  $('#agent-form').text.placeholder = touch ? t('Write to the agent.') : t('Write to the agent. Enter sends, Shift+Enter breaks the line.');
}
/** Phones: the bottom bar holds the main sections, and "More" opens the others above it. */
function setNavMore(open) {
  $('#nav-more').setAttribute('aria-expanded', String(open));
  $('.nav').classList.toggle('open', open);
}
// Focus mode: the conversation alone, on the whole window (html.chat-focus). The other sections only show, on one
// thin line above it, the ones that need you, with their marks; Esc or "Leave focus" brings everything back.
const FOCUS_KEY = 'chiefmate.focus';
const focusMode = () => document.documentElement.classList.contains('chat-focus');
function setFocusMode(on) {
  document.documentElement.classList.toggle('chat-focus', on);
  $('#focus-mode').setAttribute('aria-pressed', String(on));
  try {
    if (on) localStorage.setItem(FOCUS_KEY, '1');
    else localStorage.removeItem(FOCUS_KEY);
  } catch {
    // no storage (a private window): the mode lasts until the page is reloaded
  }
  if (state) {
    drawAlerts();
    drawFocusBar();
  }
  if (on && !touchScreen()) $('#message').focus();
}
$('#focus-mode').addEventListener('click', () => setFocusMode(!focusMode()));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && focusMode() && !document.querySelector('dialog[open]') && !agentPanel.run) setFocusMode(false);
});
$('#focus-bar').addEventListener('click', event => {
  if (event.target.closest('[data-focus-leave]')) return setFocusMode(false);
  if (event.target.closest('a[href]')) setFocusMode(false); // a section that needs you: it opens, with everything back
});

/** The focus mode's line: the manager's state, the sections that need you (each with its mark) and the way out. */
function drawFocusBar() {
  if (!focusMode()) return draw('#focus-bar', '', '');
  const chips = navSections().filter(x => x.view !== 'manager' && x.mark)
    .map(x => `<a class="focus-chip" href="#${x.view}">${x.mark}<span>${esc(x.name)}</span></a>`).join('');
  const html = `<span class="focus-bar-state">${stateHtml(presence().slice(0, 2))}</span>
    <span class="focus-chips">${chips || `<span class="hint">${esc(t('Nothing needs you now.'))}</span>`}</span>
    <button type="button" class="button secondary small" data-focus-leave title="Esc">${esc(t('Leave focus'))}</button>`;
  draw('#focus-bar', html, html);
}

function showView() {
  const view = currentView();
  if (view !== 'manager' && focusMode()) setFocusMode(false);
  if (view !== 'session' && !(view === 'project' && ['live', 'charge'].includes(pageTab()))) stopLive();
  if (view === 'session' && state) drawSessionPage();
  for (const v of VIEWS) $(`#view-${v}`).classList.toggle('active', v === view);
  // A project's page lights Projects; a session's page, Operations (where the sessions are listed).
  const section = { project: 'projects', session: 'operations' }[view] ?? view;
  for (const a of document.querySelectorAll('.nav a')) a.classList.toggle('active', a.dataset.view === section);
  $('#nav-more').classList.toggle('active', !!document.querySelector('.nav a.nav-extra.active'));
  setNavMore(false);
  if (state) drawAlerts();
  $('#project-jump').value = pageProject() ?? '';
  // Not on a touch screen: the keyboard would cover half of it at every visit.
  if (view === 'manager' && !touchScreen()) setTimeout(() => $('#message').focus(), 0);
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
phoneQuery.addEventListener('change', () => {
  drawPlaceholders();
  if (state) drawAlerts();
});

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

/** The manager's presence in words: [text, kind, the face's look]. */
function presence() {
  let text, kind, look;
  if (!online) [text, kind, look] = [t('No connection to Chiefmate'), 'error', 'offline'];
  else if (state.ai.claude.found === false) [text, kind, look] = [t('Claude Code not found'), 'error', 'offline'];
  else if (state.ai.account.status === 'rejected') [text, kind, look] = [t('Account limit reached'), 'warn', 'waiting'];
  else if (going().length > 1) [text, kind, look] = [t('On duty: {count} runs at once', { count: going().length }), 'info', 'working'];
  else if (going().length) [text, kind, look] = [t('On duty: {title}', { title: going()[0].title }), 'info', 'working'];
  else if (state.manager.responding) [text, kind, look] = [t('Thinking…'), 'info', 'thinking'];
  else [text, kind, look] = [t('Online · waiting for you'), 'ok', 'idle'];
  return [text, kind, look];
}

function drawPresence() {
  const [text, kind, look] = presence();
  const html = `${face(member('manager'), look, 22, text)}${stateHtml([text, kind])}`;
  draw('#presence', html, html);
}

// A crescent moon in line art.
const MOON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 10.2A6 6 0 0 1 5.8 2.5a6 6 0 1 0 7.7 7.7z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';

/** The away mode's button (src/news.mjs): tells the manager the owner stepped out or is back. */
function drawAway() {
  const button = $('#away');
  button.hidden = !online;
  if (!online) return;
  const away = state.away;
  const label = away ? t('Away since {time}', { time: clockTime(away.since) }) : t('Away mode');
  const help = away
    ? t('Away mode is on: notices that can wait are kept for you ({count} so far). Click when you are back: the manager writes you a summary.', { count: away.held })
    : t('Stepping out or going to sleep? The manager is told, the work goes on alone, and notices that can wait come as a summary when you are back.');
  button.setAttribute('aria-pressed', String(!!away));
  button.title = help;
  button.setAttribute('aria-label', `${label}. ${help}`);
  draw('#away', label, `${MOON}<span class="away-label">${esc(label)}</span>`);
}

$('#away').addEventListener('click', async () => {
  const on = !state?.away;
  const button = $('#away');
  button.disabled = true;
  try {
    await api('/api/away', { on });
    if (on) toast(t('Away mode on: the manager knows, and notices that can wait are kept for a summary.'));
    else {
      toast(t('Welcome back: the manager is writing the summary of the time away.'));
      location.hash = '#manager';
    }
    refresh();
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
});

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
  if (f.state === 'running') parts.push(f.agent ? agentName(f.agent, f.project) : t('preparing'), ...(f.doing ? [f.doing] : []), t('for {time}', { time: elapsed(f.since) }));
  else {
    parts.unshift(t('Next in the queue'));
    if (f.agent) parts.push(agentName(f.agent, f.project));
    if (f.notBefore && new Date(f.notBefore).getTime() > Date.now()) parts.push(t('not before {when}', { when: shortDate(f.notBefore) }));
  }
  const others = f.others ?? [];
  if (others.length) parts.push(t('and {count} more: {list}', { count: others.length, list: others.map(o => o.projectName).join(', ') }));
  const html = `${label}${f.state === 'running' ? liveDot() : ''}<span class="focus-project">${projectLink(f.project, f.projectName)}</span><span class="focus-detail">${parts.map(esc).join(' · ')}</span>`;
  $('#focus').title = [f.projectName, ...parts, f.summary].filter(Boolean).join(' · ');
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
    // The colors of the attention levels (style.css): urgent red, important lit brass, info grey.
    g.fillStyle = g.strokeStyle = mode === 'urgent' ? '#ff5c52' : mode === 'important' ? '#e8bd5f' : mode === 'info' ? '#8a93a0' : '#c9a45d';
    if (mode === 'running') g.fillRect(19, 19, 11, 11);
    else if (mode === 'info') g.fillRect(21, 21, 7, 7);
    else if (mode === 'urgent' || mode === 'important') {
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
  // The most urgent notice first: "!!" when urgent, "!" when important (the info ones stay out of the title).
  const fresh = unseen(attnItems());
  const level = topLevel(fresh);
  const first = fresh.find(i => i.level === level);
  if (level === 'urgent' || level === 'important') {
    const more = fresh.filter(i => i.level !== 'info').length - 1;
    title = `${level === 'urgent' ? '!!' : '!'} ${first.title}${more > 0 ? ` (+${more})` : ''} · ${title.replace(/^[●○] /, '')}`;
  }
  if (document.title !== title) document.title = title;
  drawFavicon(level === 'urgent' || level === 'important' ? level : a ? 'running' : count ? 'queued' : level ?? '');
  // The badge on the app's icon in the taskbar, where the browser supports it: the urgent and important notices.
  const needs = fresh.filter(i => i.level !== 'info').length;
  if (needs !== drawTitle.badge && 'setAppBadge' in navigator) {
    (needs ? navigator.setAppBadge(needs) : navigator.clearAppBadge()).catch(() => {});
    drawTitle.badge = needs;
  }
}

/**
 * A step's request, answered from the app: a question has one button per option (the recommended one in brass), an
 * action the owner takes outside the app has "I did it".
 */
function requestButtons(run, q, size = '') {
  if (!q.options?.length) return `<button type="button" class="button${size}" data-needs-done="${esc(run)}" data-request="${esc(q.id)}">${esc(t('I did it'))}</button>`;
  const option = o => {
    const recommended = o === q.recommend;
    const marks = recommended ? ` title="${esc(t('Recommended by the agent'))}" aria-label="${esc(t('{option} (recommended)', { option: o }))}"` : '';
    return `<button type="button" class="button${recommended ? '' : ' secondary'}${size}" data-needs-done="${esc(run)}" data-request="${esc(q.id)}" data-answer="${esc(o)}"${marks}>${esc(o)}</button>`;
  };
  return `<span class="request-options">${q.options.map(option).join('')}</span>`;
}

/** A question's recommendation and its reason, in one line ("Recommends: Resend. Simpler to set up."). */
const requestWhy = q => (q?.options?.length && (q.recommend || q.why)
  ? `<span class="request-why">${esc([q.recommend ? t('Recommends: {what}', { what: q.recommend }) : '', q.why ?? ''].filter(Boolean).join('. '))}</span>`
  : '');

/** A request's buttons: a step's (requestButtons), "I did it" (Codex to sign in), or Allow and See (a session's permission). */
function needsButtons(n, size) {
  if (n.kind === 'permission') {
    return `<span class="compose-buttons"><a class="button secondary${size}" href="${esc(sessionHash({ id: n.session, project: n.project }))}">${esc(t('See'))}</a><button type="button" class="button${size}" data-needs-session="${esc(n.session)}" data-request="${esc(n.id)}">${esc(t('Allow'))}</button></span>`;
  }
  if (n.session) return `<button type="button" class="button${size}" data-needs-session="${esc(n.session)}" data-request="${esc(n.id)}">${esc(t('I did it'))}</button>`;
  return requestButtons(n.run, n, size);
}

/** A permission asked, in plain words: where, what changes, whether it can be undone and the risk; the command folded. */
function permissionFacts(x, id = '') {
  if (!x) return '';
  const risk = { low: t('Low risk'), medium: t('Medium risk'), high: t('High risk') }[x.risk] ?? t('Unknown risk');
  const fact = (label, text) => (text ? `<dt>${esc(label)}</dt><dd>${text}</dd>` : '');
  return `<div class="perm">
      <dl class="perm-facts">${fact(t('Where'), esc(x.where))}${fact(t('What changes'), esc(x.change))}${fact(t('Can it be undone?'), esc(x.undo))}${fact(t('Risk'), `<span class="perm-risk" data-risk="${esc(x.risk ?? 'unknown')}">${esc(risk)}</span> ${esc(x.why ?? '')}`)}</dl>
      <span class="hint">${esc(t('Allowed, it is told to go ahead; the permission lasts for this session.'))}</span>
      ${x.command ? `<details class="perm-command" data-keep-open="${esc(id)}"><summary>${esc(t('See the command'))}</summary><pre>${esc(x.command)}</pre></details>` : ''}
    </div>`;
}

// ---------- Attention: what needs you, in three levels ----------
// One component for the whole app (the mark and the notice, styled by "data-level"): urgent (bright red, a soft
// pulse), important (lit brass) and info (discreet). The server decides the level (src/attention.mjs).

const LEVELS = ['urgent', 'important', 'info'];
const levelName = level => ({ urgent: t('Urgent'), important: t('Important'), info: t('For your information') })[level] ?? '';
const attnItems = () => (online ? state?.attention?.items ?? [] : []);
const unseen = list => list.filter(i => !i.seen);
const topLevel = list => LEVELS.find(l => list.some(i => i.level === l && !i.seen)) ?? null;
const ofProject = (id, name) => i => i.project === id || (name && i.project === name);

/** The mark: a square in the level's color, with a count when there is more than one ("count": always, as in the menu). */
function attnMark(list, label = '', count = false) {
  const level = topLevel(list);
  if (!level) return '';
  const n = unseen(list).length;
  const text = [levelName(level), label, n > 1 ? t('{count} notices', { count: n }) : ''].filter(Boolean).join(' · ');
  return `<span class="attn-mark" data-level="${level}" role="img" aria-label="${esc(text)}" title="${esc(text)}">${n > 1 || count ? n : ''}</span>`;
}

/**
 * A notice: its level, what happened, where and when, and what to do (act, open, or mark as seen). "brief" (the band at
 * the top): a permission asked without its facts nor Allow, only the way to the page that shows them.
 */
function attnNotice(i, brief = false) {
  const r = i.request;
  const where = [r?.agent ? agentName(r.agent, i.project) : '', i.project ? projectName(i.project) : '', i.at ? relative(i.at) : ''].filter(Boolean).join(' · ');
  const links = [
    r?.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(t('Open the address'))}</a>` : '',
    r?.openError ? esc(r.openError) : '',
    i.url ? `<a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(t('Open the pull request'))}</a>` : '',
  ].filter(Boolean);
  const open = i.view === 'log' && i.run ? `href="#log" data-select="${esc(i.run)}"` : `href="#${esc(i.view)}"`;
  // A notice with a decision card: "Decide" opens it in Decisions.
  const decide = !r && currentView() !== 'decisions' && decisionsNow().some(c => c.id === i.id);
  // In the band at the top, a question leads to Operations, where its options come with the recommendation and its reason.
  const actions = r && brief && r.kind === 'permission'
    ? `<a class="button small" href="${esc(sessionHash({ id: r.session, project: i.project }))}">${esc(t('See'))}</a>`
    : r && brief && r.options?.length ? `<a class="button small" href="#${esc(i.view)}">${esc(t('Answer'))}</a>`
    : r ? needsButtons({ ...r, project: i.project }, ' small')
    : decide ? `<a class="button small" href="#decisions">${esc(t('Decide'))}</a>`
    : `${currentView() === i.view ? '' : `<a class="button secondary small" ${open}>${esc(t('Open'))}</a>`}${i.seenable && !i.seen ? `<button type="button" class="button secondary small" data-attn-seen="${esc(i.id)}">${esc(t('Mark as seen'))}</button>` : ''}`;
  return `<div class="attn" data-level="${i.level}"${i.seen ? ' data-seen' : ''}>
      <span class="attn-level"><span class="attn-mark" data-level="${i.level}" aria-hidden="true"></span>${esc(i.seen ? t('Seen') : levelName(i.level))}</span>
      <div class="attn-text"><span class="attn-title">${esc(i.title)}</span> ${esc(i.text)}${brief ? '' : requestWhy(r)}${where || links.length ? `<span class="hint">${[esc(where), ...links].filter(Boolean).join(' · ')}</span>` : ''}${brief ? '' : permissionFacts(r?.explain, r?.id)}</div>
      <div class="attn-actions">${actions}</div>
    </div>`;
}

/** The small link to what no longer needs you ("Archived (N)"), opening the archive; empty with nothing archived. */
const attnArchivedLink = () => {
  const n = online ? state?.attention?.archived ?? 0 : 0;
  return n ? `<button type="button" class="attn-archived" data-attn-archived>${esc(t('Archived ({count})', { count: n }))}</button>` : '';
};

/**
 * A list of notices under a label ("Waiting for you"), for a section or a project; empty when there are none, unless
 * "archived" asks for the link to the archive even then.
 */
function attnList(list, label, { archived = false } = {}) {
  const link = archived ? attnArchivedLink() : '';
  if (!list.length) return link ? `<div class="attn-archived-only">${link}</div>` : '';
  const head = `<div class="attn-head">${attnMark(list)}<span class="label">${esc(t('{label} ({count})', { label, count: unseen(list).length }))}</span>${link}</div>`;
  return `<div class="attn-list"${topLevel(list) === 'urgent' ? ' role="alert"' : ''}>${head}${list.map(attnNotice).join('')}</div>`;
}

/** Why a notice went to the archive (src/attention.mjs). */
const archivedWhy = reason => ({
  merged: t('Pull request merged'), closed: t('Pull request closed'), branch: t('Branch already merged'),
  seen: t('Seen'), expired: t('A day went by'), resolved: t('No longer needed'),
})[reason] ?? '';

/** The archive's notices: what each was, where, when it was archived and why. */
function archiveHtml(items) {
  if (!items.length) return `<div class="attn" data-level="info"><div class="attn-text">${esc(t('Nothing archived yet.'))}</div></div>`;
  return items.map(i => {
    const hint = [i.project ? projectName(i.project) : '', i.at ? relative(i.at) : '', `${archivedWhy(i.reason)} · ${t('archived {when}', { when: relative(i.archived) })}`].filter(Boolean).map(esc);
    if (i.url) hint.push(`<a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(t('Open the pull request'))}</a>`);
    return `<div class="attn" data-level="${esc(i.level)}" data-seen>
      <span class="attn-level"><span class="attn-mark" data-level="${esc(i.level)}" aria-hidden="true"></span>${esc(levelName(i.level))}</span>
      <div class="attn-text"><span class="attn-title">${esc(i.title)}</span> ${esc(i.text)}<span class="hint">${hint.join(' · ')}</span></div>
    </div>`;
  }).join('');
}

let attnOpen = false; // the band shows every notice, not only the most urgent
/** The band at the top: the most urgent notice and how many others, opening into all of them. Nothing is paused. */
function drawAlerts() {
  // The notices with a decision card are left to the Decisions tab, and those a page lists (Operations, Planning, a
  // project) to that page. The conversation shows only its own notices (the others mark their tabs), and none in focus
  // mode. A permission asked shows there without its facts, as a way to them. On a phone, the band keeps its room for
  // what needs the owner: the info notices stay in each section's list.
  const phone = phoneQuery.matches;
  const carded = cardedIds();
  const view = currentView();
  const listed = { operations: ['operations', 'log'], planning: ['planning'] }[view] ?? [];
  const skip = i => (view === 'manager' ? i.view !== 'manager' : listed.includes(i.view) || (view === 'project' && ofProject(pageProject())(i)));
  const list = focusMode() ? [] : attnItems().filter(i => !carded.has(i.id) && !(phone && i.level === 'info') && !skip(i));
  const fresh = unseen(list);
  if (!fresh.length && !attnOpen) return draw('#alerts', '', '');
  const others = fresh.length - 1;
  const toggle = list.length > 1 || attnOpen
    ? `<button type="button" class="button secondary small" data-attn-more aria-expanded="${attnOpen}">${esc(attnOpen ? t('Show less') : others > 0 ? t('+{count} more', { count: others }) : t('See all'))}</button>`
    : '';
  const all = fresh.some(i => i.seenable) ? `<button type="button" class="button secondary small" data-attn-seen="${esc(fresh.filter(i => i.seenable).map(i => i.id).join(' '))}">${esc(t('Mark all as seen'))}</button>` : '';
  const shown = attnOpen ? list : fresh.slice(0, 1);
  const html = `<div class="attn-band" data-level="${topLevel(list) ?? 'info'}"${topLevel(list) === 'urgent' ? ' role="alert"' : ''}>
      ${shown.map(i => attnNotice(i, true)).join('') || `<div class="attn" data-level="info"><div class="attn-text">${esc(t('Nothing needs you now.'))}</div></div>`}
      ${toggle || (attnOpen && all) ? `<div class="attn-more">${attnOpen ? attnArchivedLink() : ''}${toggle}${attnOpen ? all : ''}</div>` : ''}
    </div>`;
  draw('#alerts', html, html);
}

/** The notices that have a decision card: they count in the Decisions tab, not in their own section's. */
const cardedIds = () => new Set(decisionsNow().map(c => c.id));

/** Each section of the menu with what needs you there: the decision cards for Decisions, the notices for the others. */
function navSections() {
  const carded = cardedIds();
  const list = attnItems().filter(i => !carded.has(i.id));
  return [...document.querySelectorAll('.nav a[data-view]')].map(a => {
    const view = a.dataset.view;
    const name = a.firstElementChild?.textContent ?? '';
    // Decisions counts what needs you: the cards of level 1 are the manager's to settle.
    const items = view === 'decisions' ? decisionsNow().filter(c => !c.seen && !managerSettles(c)) : list.filter(i => i.view === view);
    return { a, view, name, items, level: topLevel(items), mark: attnMark(items, name, true) };
  });
}

/** A mark beside each section in the menu: the color of its most urgent notice and how many there are (urgent pulses). */
function drawNavAttention() {
  const sections = navSections();
  for (const { a, mark, level } of sections) {
    let slot = a.querySelector('.nav-attn');
    if (!slot) a.append((slot = Object.assign(document.createElement('span'), { className: 'nav-attn' })));
    if (slot.innerHTML !== mark) slot.innerHTML = mark;
    if (level) a.dataset.level = level;
    else delete a.dataset.level;
  }
  // On phones, "More" carries the marks of the sections it holds.
  const more = attnMark(sections.filter(x => x.a.classList.contains('nav-extra')).flatMap(x => x.items), t('More'), true);
  if ($('#nav-more-attn').innerHTML !== more) $('#nav-more-attn').innerHTML = more;
  drawFocusBar();
}

function drawStatusbar() {
  $('#statusbar').classList.toggle('offline', !online); // phones show the bar only then
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

// ---------- Decisions: what waits for your decision, as cards ----------
// Built by the server (src/decisions.mjs) from the notices: a pull request or branch to merge, a proposal the manager
// triaged, a question the manager asked. They have a tab of their own (Decisions), as compact cards: what it is, where,
// the recommendation's verdict and the buttons; what changes, the risk and the rest folded under Details. "Not now"
// fades a card to the end, under "Left for later".

const decisionsNow = () => (online ? state?.decisions ?? [] : []);
const decisionKind = c => ({ merge: c.thirdParty ? t('Waiting for a third-party review') : t('Merge'), decision: t('Proposal'), question: t('Question'), push: t('Push') })[c.kind] ?? '';
// The approval level the manager gave a card (src/decisions.mjs): 1 is the manager's to settle, 2 and 3 are yours.
const managerSettles = c => c.approval === 1;
const approvalBadge = c => {
  const text = { 1: t('Level 1 · the manager settles it'), 2: t('Level 2 · needs you'), 3: t('Level 3 · only you') }[c.approval] ?? t('Level ?');
  return `<span class="decision-approval" data-approval="${esc(c.approval ?? 'none')}">${esc(text)}</span>`;
};

function decisionCardHtml(c) {
  const facts = [
    [t('If you approve'), c.change],
    [t('Watch out'), c.risk],
    [t('The manager recommends'), c.recommend],
  ].filter(([, text]) => text);
  const links = [
    c.url ? `<a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(t('Open the pull request'))}</a>` : '',
    c.run ? `<a href="#log" data-select="${esc(c.run)}">${esc(t('See the run'))}</a>` : '',
    c.item ? `<a href="#planning">${esc(t('See on the board'))}</a>` : '',
  ].filter(Boolean);
  // A label with a short form, shown on phones instead: "Not now" becomes "Later".
  const label = (long, short = long) => (short === long ? esc(long) : `<span class="long">${esc(long)}</span><span class="short">${esc(short)}</span>`);
  const button = (action, text, kind = '', extra = '') => `<button type="button" class="button${kind}" data-decide="${esc(action)}" data-card="${esc(c.id)}"${extra}>${text}</button>`;
  const choices = c.kind === 'question'
    ? c.options.map(o => button('answer', esc(o), o === c.recommend ? '' : ' secondary', ` data-option="${esc(o)}"${o === c.recommend ? ` title="${esc(t('Recommended by the manager'))}"` : ''}`)).join('')
    : c.approve ? button('approve', label(c.kind === 'push' ? t('Allow push') : t('Approve'))) : '';
  const buttons = [
    choices,
    // Someone else's review only informs: "Hide" sends it to the archive. A push the manager asks is allowed or refused.
    c.seen || c.kind === 'push' ? '' : button('later', c.thirdParty ? label(t('Hide')) : label(t('Not now'), t('Later')), ' secondary'),
    c.thirdParty ? '' : button('discard', label(c.kind === 'push' ? t('Refuse') : t('Discard')), ' danger'),
    button('talk', label(t('Talk about this'), t('Talk')), ' secondary'),
  ].join('');
  const about = [esc(c.label), c.at ? esc(relative(c.at)) : ''].filter(Boolean).join(' · ');
  // The recommendation's verdict only ("Approve with caveats", src/decisions.mjs); its reason is under Details.
  const verdict = c.recommendShort || c.recommend;
  const detail = [
    c.what && c.what !== c.title ? `<p class="decision-what">${esc(c.what)}</p>` : '',
    facts.length ? `<dl class="decision-facts">${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>` : '',
    c.detail ? `<div class="decision-detail-body">${md(c.detail)}</div>` : '',
    links.length ? `<div class="hint">${links.join(' · ')}</div>` : '',
  ].join('');
  return `<article class="decision" data-level="${esc(c.level)}" data-card="${esc(c.id)}"${c.seen ? ' data-seen' : ''}>
      <div class="decision-head"><span class="attn-mark" data-level="${esc(c.level)}" aria-hidden="true"></span>${approvalBadge(c)}<span class="decision-kind">${esc(decisionKind(c))}</span><span class="decision-about">${about}</span>${c.seen ? `<span class="tag">${esc(t('left for later'))}</span>` : ''}</div>
      <div class="decision-title">${esc(c.title)}</div>
      ${verdict ? `<div class="decision-verdict">${esc(t('Recommends: {what}', { what: verdict }))}</div>` : ''}
      ${c.thirdParty ? `<p class="decision-third">${esc(t('Someone else reviews and merges the work of this project: nothing for you to approve here.'))}</p>` : ''}
      <div class="decision-buttons">${buttons}</div>
      ${detail ? `<details class="decision-detail" data-detail="${esc(c.id)}"><summary>${esc(t('Details'))}</summary>${detail}</details>` : ''}
    </article>`;
}

/**
 * The Decisions tab: the cards that need you not decided yet, the ones left for later (folded), then the ones of level 1,
 * the manager's to settle (folded).
 */
function drawDecisions() {
  const cards = decisionsNow();
  const box = $('#decisions');
  const yours = cards.filter(c => !managerSettles(c));
  const fresh = yours.filter(c => !c.seen);
  const later = yours.filter(c => c.seen);
  const managers = cards.filter(managerSettles);
  const fold = (key, title, list) => (list.length ? `<details class="decisions-later" data-detail="${key}"><summary>${esc(title)}</summary>${list.map(decisionCardHtml).join('')}</details>` : '');
  const rest = fold('later', t('Left for later ({count})', { count: later.length }), later)
    + fold('manager', t('The manager will settle it ({count})', { count: managers.length }), managers);
  const html = cards.length
    ? `${fresh.length ? '' : `<div class="panel empty">${esc(t('Nothing needs your decision now.'))}</div>`}${fresh.map(decisionCardHtml).join('')}${rest}`
    : `<div class="panel empty">${esc(t('Nothing waits for your decision. New pull requests, proposals and questions from the manager show up here.'))}</div>`;
  // What you opened stays open when the cards are drawn again.
  const opened = [...box.querySelectorAll('details[open]')].map(d => d.dataset.detail);
  if (draw('#decisions', JSON.stringify([cards, language()]), html)) {
    for (const d of box.querySelectorAll('details')) if (opened.includes(d.dataset.detail)) d.open = true;
  }
}

/** "Talk about this": the conversation with the manager, your message started with the item quoted. */
function talkAbout(c) {
  if (currentView() !== 'manager') location.hash = '#manager';
  const box = $('#message');
  const quote = t('About {what} ("{title}"): ', { what: c.label, title: c.title });
  if (!box.value.includes(quote)) box.value = `${quote}${box.value}`;
  box.focus();
  box.setSelectionRange(box.value.length, box.value.length);
}

$('#decisions').addEventListener('click', async event => {
  const button = event.target.closest('[data-decide]');
  if (!button) return;
  const c = decisionsNow().find(x => x.id === button.dataset.card);
  if (!c) return;
  const action = button.dataset.decide;
  if (action === 'talk') return talkAbout(c);
  // Merging and closing a pull request are confirmed: the click is your authorization (src/merge.mjs).
  const how = c.url ? t('Chiefmate merges the pull request on GitHub.') : t('Chiefmate merges the branch into the branch checked out in your clone; nothing is sent to GitHub.');
  if (c.kind === 'merge' && action === 'approve' && !(await confirmDialog(t('Approve and merge'), `${c.label}: ${c.title}. ${how}`, t('Approve')))) return;
  const closes = c.url ? t('The pull request is closed on GitHub; it can be reopened there.') : t('The branch stays in your clone, not merged.');
  if (c.kind === 'merge' && action === 'discard' && !(await confirmDialog(t('Discard this work'), `${c.label}: ${c.title}. ${closes}`, t('Discard')))) return;
  // Allowing a push is confirmed too: it lets the manager send that branch to GitHub once.
  if (c.kind === 'push' && action === 'approve' && !(await confirmDialog(t('Allow this push'), `${c.title}. ${c.what} ${c.change}`, t('Allow push')))) return;
  const card = button.closest('.decision');
  for (const b of card.querySelectorAll('button')) b.disabled = true;
  try {
    const r = await api('/api/decide', { card: c.id, action, option: button.dataset.option });
    toast({
      merged: [t('Merged.'), r.merge?.copiesNote].filter(Boolean).join(' '), later: c.thirdParty ? t('Hidden: it is in the archive.') : t('Left for later: the card stays at the end, faded.'), discarded: t('Discarded.'),
      approved: t('Approved: it becomes a task for its agent, in its turn.'), allowed: t('Allowed: the manager may send it once now.'), refused: t('Refused: the manager is told.'), answered: t('Answer sent to the manager: {answer}', { answer: r.answer ?? '' }),
    }[r.done] ?? '');
  } catch (error) {
    toast(error.message);
    for (const b of card.querySelectorAll('button')) b.disabled = false;
  }
  await refresh();
});

// ---------- Manager ----------

// The events Chiefmate tells the manager about (src/news.mjs), as the app names them.
const newsEvent = kind => ({
  run_finished: t('run finished'), run_failed: t('run failed'), run_paused: t('run paused'), pr_ready: t('pull request ready'), merged: t('merged'),
  merge_failed: t('merge failed'), needs_you: t('needs you'), update_installed: t('update installed'), update_blocked: t('update blocked'),
  memory_alert: t('memory alert'), usage_alert: t('usage alert'), session_ended: t('live session ended'), plan_proposed: t('new proposal'),
  idle: t('empty queue'), autopilot_report: t('autopilot report'), watchdog: t('watchdog'),
  away: t('away mode on'), back: t('back from away mode'), owner_decided: t('your decision'), push_allowed: t('push allowed'), owner_request: t('request from an agent in charge'),
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
    // Pausing: the runs it still waits for, each with what it is doing (a download, a step's action).
    const waiting = (job.waitingFor ?? []).map(w => (w.doing ? `${w.title ?? w.run} (${w.doing})` : w.title ?? w.run));
    if (job.stage === 'pausing' && waiting.length) updateLine = t('Updating: waiting for {runs} to pause at a safe point…', { runs: waiting.join('; ') }) + paused;
    else if (job.stage === 'pausing') updateLine = t('Updating: pausing the work going on at a safe point…') + paused;
    else if (job.stage === 'manager') updateLine = (job.interruptManager ? t("Updating: interrupting the manager's answer…") : t("Updating: waiting for the manager's answer to end…")) + paused;
    else updateLine = t('Updating: checking the new version; Chiefmate restarts by itself…') + paused;
  }
  let updateButton = '';
  if (job?.stage === 'manager' && !job.interruptManager) updateButton = `<button type="button" class="button secondary small" data-update-now="interrupt">${esc(t("Interrupt the manager's answer"))}</button>`;
  else if (online && !job && update.waiting && !['changes', 'merge'].includes(update.blocked)) updateButton = `<button type="button" class="button small" data-update-now="now">${esc(t('Update now'))}</button>`;
  const roster = others.map(a => {
    const s = agentStatus(a);
    return `<li>${face(a, faceState(a), 30, `${t(a.name)}: ${s[0]}`)}<div><div class="roster-name"><span>${esc(t(a.name))}</span>${stateHtml(s)}</div><div class="hint">${esc(agentDetail(a))} · ${esc(TOOL_LABELS[a.tool] && a.tool !== 'claude' ? `${TOOL_LABELS[a.tool]} · ` : '')}${esc(modelLabel(a))}</div></div></li>`;
  });
  const html = `
    <div class="bridge-head">${face(manager, faceState(manager), 72, `${t(manager.name)}: ${status[0]}`)}
      <div><div class="bridge-name">${esc(t(manager.name))}</div>
        <div class="hint">${esc(t(manager.title ?? 'Manager'))} · <span class="model">${esc(shortModel(manager.model))}</span></div>
        ${stateHtml(status)}</div></div>
    <div class="label">${esc(t('Crew on board'))}</div>
    <ul class="roster">${roster.join('')}</ul>
    <div class="connection hint">${esc(claudeLine)}<br>${esc(accountLine)}${online && account.updated ? ` · ${esc(t('measured {when}', { when: relative(account.updated) }))}` : ''}${updateLine ? `<br>${esc(updateLine)}` : ''}${updateButton ? `<div class="actions left update-actions">${updateButton}</div>` : ''}</div>`;
  const signature = JSON.stringify([online, (state?.crew ?? []).map(a => [a.id, a.status, a.run, a.last?.at, a.model, a.tool]), claude, account, update, Math.floor(Date.now() / 60000)]);
  draw('#bridge', signature, html);
}

/** Beside Operations: what its list doesn't show (the next mission, the account's usage, the contexts' fill). */
function drawSituation() {
  const runs = going();
  const { account } = state.usage;
  const next = nextMission();
  const html = `
    <div class="label">${esc(t('Situation'))}</div>
    <div class="block"><div class="hint">${esc(t('Next scheduled mission'))}</div><div class="value">${next ? `${esc(next.name)}<br><span class="num hint">${shortDate(next.next)} (${esc(relative(next.next))})</span>` : esc(t('None'))}</div></div>
    <div class="block">${meter(t('Account, 5-hour window'), account.five_hour?.used, percent(account.five_hour?.used))}${meter(t("Plan's week"), account.seven_day?.used, percent(account.seven_day?.used))}</div>
    <div class="block">${managerContextMeter()}${runs.filter(a => a.agent).map(agentContextMeter).join('')}</div>`;
  draw('#situation', JSON.stringify([runs.map(a => [a.id, a.title, a.step, a.agent, a.context, a.doing]), state.manager.context, state.queue.length, next?.next, account.updated, Math.floor(Date.now() / 60000)]), html);
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
      <td>${i === 0 ? `<span class="tag">${esc(t('Next'))}</span>` : ''}<span class="primary">${esc(r.title)}</span>${summaryLine(r)}<span class="secondary">${esc([projectName(r.project), r.note].filter(Boolean).join(' · '))}</span></td>
      <td>${stateHtml(runState(r.status))}</td>
      <td class="num">${r.notBefore && new Date(r.notBefore).getTime() > Date.now() + skew ? `${shortDate(r.notBefore)} (${esc(relative(r.notBefore))})` : esc(expected(r))}</td>
      <td class="row-actions"><button type="button" class="button danger small" data-cancel="${esc(r.id)}">${esc(t('Cancel'))}</button></td>
    </tr>`);
  const html = list.length
    ? `<div class="label" style="margin-top:24px">${esc(t('Queue'))}</div>
    <table class="table queue"><thead><tr><th>#</th><th>${esc(t('Run'))}</th><th>${esc(t('Status'))}</th><th>${esc(t('Expected start'))}</th><th></th></tr></thead><tbody>${rows.join('')}</tbody></table>`
    : '';
  draw('#op-queue', JSON.stringify([going().map(a => a.project), state.parallel, list.map(r => [r.id, r.title, r.summary, r.status, r.notBefore, r.note]), Math.floor(Date.now() / 60000)]), html);
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
        <div class="live-title" title="${esc(a.title)}">${esc(a.title)}</div>
        ${a.summary ? `<div class="live-summary" title="${esc(a.summary)}">${esc(a.summary)}</div>` : ''}
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

/** What the agent is doing now, in plain words; the last action itself shows on hover and in the logbook. */
function lastAction(a) {
  const p = a.actions.at(-1);
  const text = a.doing || (p ? p.text : t('Preparing…'));
  return `<span class="label">${esc(t('Doing now'))}</span><time>${p ? clockTime(p.at) : ''}</time><span class="text" title="${esc(p ? `${t('Last action')}: ${p.text}` : text)}">${esc(text)}</span>`;
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
  // A run waiting for you stands out with the urgent level.
  const block = $(`#${k}-live`)?.closest('.run-block');
  if (block && block.dataset.level !== (a.needsYou ? 'urgent' : '')) block.dataset.level = a.needsYou ? 'urgent' : '';
  const statuses = a.steps.map(s => s.status);
  const working = a.agent ? member(a.agent, a.project) : null;
  if (draw(`#${k}-live`, JSON.stringify([online, a.title, a.summary, a.step, a.agent, a.stepStarted, statuses, working?.status]), liveCard(a, k))) delete signatures[`#${k}-last`];
  const last = a.actions.at(-1);
  draw(`#${k}-last`, JSON.stringify([last?.at, last?.text, a.doing]), lastAction(a));
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
  const skeleton = `<div id="op-attention"></div>${head}${runs.length ? `<div class="runs${runs.length > 1 ? ' several' : ''}">${runs.map(runBlock).join('')}</div>` : '<div class="panel" id="op-idle"></div>'}<div id="op-queue"></div><div id="op-sessions"></div>`;
  if (draw('#operations', JSON.stringify([runs.map(a => a.id), parallel]), skeleton)) {
    for (const key of Object.keys(signatures)) if (key.startsWith('#op-')) delete signatures[key];
  }
  // What needs you in the crew's work (requests, failed runs, pull requests, finished tasks), above the runs.
  const carded = cardedIds(); // the pull requests waiting for you are in Decisions
  const notices = attnList(attnItems().filter(i => ['operations', 'log'].includes(i.view) && !carded.has(i.id)), t('Waiting for you'), { archived: true });
  draw('#op-attention', notices, notices);
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
  if (x.mode === 'app') {
    return {
      working: [t('Working'), 'info'], paused: [t('Paused for an update'), 'info'], permission: [t('Asks your permission'), 'warn'], waiting: [t('Your turn'), 'ok'], ended: [t('Ended'), 'neutral'],
    }[x.phase] ?? [t('Open'), 'ok'];
  }
  if (x.alive) return [t('Open'), 'ok'];
  if (x.status === 'starting' || x.status === 'open') return [t('Opening…'), 'info'];
  return [t('Ended'), 'neutral'];
}

const sessionWhere = x => (x.project ? projectName(x.project) : x.folder ?? x.cwd ?? '');

/** The sessions open, as a table (or a line saying there is none): in the app (with its conversation) or in a window. */
function sessionTable(open) {
  const rows = open.map(x => `<tr>
      <td><span class="primary">${x.mode === 'app' ? `<a href="${esc(sessionHash(x))}">${esc(x.name)}</a>` : esc(x.name)}</span><span class="secondary">${esc([toolName(x.tool), x.mode === 'app' ? t('in the app') : t('in a window'), sessionWhere(x), x.missing?.length ? t('not in the prompt builder: {list}', { list: x.missing.join(', ') }) : ''].filter(Boolean).join(' · '))}</span></td>
      <td>${stateHtml(sessionState(x))}</td>
      <td class="num">${x.status === 'login' ? '—' : ticking(x.started)}</td>
      <td class="num">${x.ram ? bytes(x.ram) : '—'}</td>
      <td class="row-actions">${x.mode === 'app' ? `<a class="button secondary small" href="${esc(sessionHash(x))}">${esc(t('Conversation'))}</a> ` : ''}<button type="button" class="button danger small" data-session-end="${esc(x.id)}">${esc(x.status === 'login' ? t('Cancel') : t('End'))}</button></td>
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
      <p class="hint">${esc(t('A conversation with Claude Code or Codex here in the app, for work you do together, while the crew works in the background. It starts with the blocks of the prompt builder its profile names.'))}</p>
      ${sessionTable(s.open)}
      ${profiles.length ? `<div class="session-profiles">${profileCards(profiles)}</div>` : `<p class="hint">${esc(t('No session profiles yet: add them under "sessions" in the settings (see the README).'))}</p>`}
    </div>`;
  draw('#op-sessions', JSON.stringify([s.open.map(x => [x.id, x.status, x.phase, x.alive, Math.round(x.ram / 1048576), x.started]), profiles]), html);
}

// ---------- A live session's conversation, in the app ----------

// The conversation shown: its session, its history (read in pieces, from "next" on) and the timer that follows it.
const liveChat = { id: null, items: [], next: 0, data: null, timer: null, loading: false, scrolled: false, firstOpen: false };

const sessionHash = x => (!x.project || !state?.projects.some(p => p.id === x.project) ? `#session/${encodeURIComponent(x.id)}`
  : x.charge ? `#project/${encodeURIComponent(x.project)}/charge` : `#project/${encodeURIComponent(x.project)}/live/${encodeURIComponent(x.id)}`);
const allSessions = () => [...(state?.sessions?.open ?? []), ...(state?.sessions?.recent ?? [])];
/** A project's sessions in the app (not its talk with the agent in charge, in a tab of its own): those open first, then the latest ended ones. */
const liveSessionsOf = id => allSessions().filter(x => x.project === id && x.mode === 'app' && !x.charge);

/** The conversation lives in a project's Live tab or in the session's own view: it is moved to where it is shown. */
function placeLive(home) {
  const body = $('#live-body');
  if (body.parentElement !== home) home.append(body);
  body.hidden = false;
}

function stopLive() {
  clearInterval(liveChat.timer);
  Object.assign(liveChat, { id: null, items: [], next: 0, data: null, timer: null, scrolled: false, firstOpen: false });
  $('#live-body').hidden = true;
}

/** Shows a session's conversation and follows it every 1.5 seconds. */
function openLive(id) {
  if (liveChat.id !== id) {
    clearInterval(liveChat.timer);
    Object.assign(liveChat, { id, items: [], next: 0, data: null, scrolled: false, firstOpen: false });
    for (const part of ['#live-head', '#live-feed', '#live-asks', '#live-queue']) delete signatures[part];
    $('#live-text').value = '';
    liveChat.timer = setInterval(pollLive, 1500);
    pollLive();
  }
  drawLive();
}

async function pollLive() {
  const id = liveChat.id;
  if (!id || liveChat.loading || document.hidden) return;
  liveChat.loading = true;
  try {
    const data = await api(`/api/session/${encodeURIComponent(id)}${liveChat.data ? `?from=${liveChat.next}` : ''}`);
    if (liveChat.id !== id) return;
    liveChat.items = [...liveChat.items, ...data.history.items].slice(-600);
    liveChat.next = data.history.next;
    liveChat.data = data;
    drawLive();
  } catch (error) {
    if (liveChat.id === id) liveChat.data = { error: error.message };
    drawLive();
  } finally {
    liveChat.loading = false;
  }
}

/** A session's phase, in words, for the line above the conversation. */
function livePhaseLine(x) {
  if (x.status === 'login') return t('Sign in to Codex ("codex login" in a terminal): the session starts by itself afterwards.');
  return {
    working: t('The agent is working. Your messages wait in the queue and go when it finishes this turn.'),
    paused: t('Paused at a safe point for an update of Chiefmate: the agent carries on by itself after the restart. Your messages wait in the queue.'),
    permission: t('The agent asks your permission for something: see below.'),
    waiting: t('Your turn: the agent waits for your message.'),
    ended: x.resumable ? t('Ended. Resume, or simply write: it carries on in the same conversation.') : t('Ended.'),
  }[x.phase] ?? '';
}

function liveFeedHtml(x) {
  const agent = x.charge && state.charge?.[x.project] ? t(state.charge[x.project].name) : toolName(x.tool);
  let html = '';
  let actions = [];
  const flush = () => {
    if (actions.length) html += `<div class="live-actions">${actions.join('')}</div>`;
    actions = [];
  };
  for (const e of liveChat.items) {
    if (e.kind === 'action') {
      actions.push(`<div class="live-action${e.failed ? ' failed' : ''}"><time>${esc(clockTime(e.at))}</time><span>${esc(e.text)}</span></div>`);
      continue;
    }
    flush();
    if (e.kind === 'owner' && e.first) {
      html += `<details class="msg you first" data-live-first${liveChat.firstOpen ? ' open' : ''}><summary class="msg-head"><span class="msg-author">${esc(t('You'))}</span><span class="msg-meta">${esc(`${clockTime(e.at)} · ${t('first message, {count} characters', { count: e.text.length })}`)}</span></summary><div class="msg-body">${md(e.text)}</div></details>`;
    } else if (e.kind === 'owner') {
      html += `<div class="msg you"><div class="msg-head"><span class="msg-author">${esc(e.by === 'manager' ? t('Manager, at your request') : t('You'))}</span><span class="msg-meta">${esc(clockTime(e.sent ?? e.at))}</span></div><div class="msg-body">${md(e.text)}</div></div>`;
    } else if (e.kind === 'say') {
      html += `<div class="msg manager"><div class="msg-head"><span class="msg-author">${esc(agent)}</span><span class="msg-meta">${esc(clockTime(e.at))}</span></div><div class="msg-body">${md(e.text)}</div></div>`;
    } else if (e.kind === 'request') {
      html += `<div class="msg system ask">${esc(e.text)}</div>`;
    } else if (e.kind === 'permission') {
      const said = { open: t('The agent asked your permission: {what}', { what: e.text }), done: t('You allowed: {what}', { what: e.text }), refused: t('You refused: {what}', { what: e.text }) }[e.status] ?? e.text;
      html += `<div class="msg system ask">${esc(said)}</div>`;
    } else {
      html += `<div class="msg system${e.error ? ' error' : ''}">${esc(e.text)}</div>`;
    }
  }
  flush();
  if (!liveChat.items.length) html += `<div class="msg system">${esc(liveChat.data ? t('No messages yet. Write below to start.') : t('Loading…'))}</div>`;
  if (x.phase === 'working') {
    const last = x.turn?.last;
    html += `<div class="msg manager typing"><div class="msg-head"><span class="msg-author">${esc(agent)}</span><span class="msg-meta">${esc(t('working…'))} · ${ticking(x.turn?.since)}</span></div><div class="live-last"><span class="label">${esc(t('Last action'))}</span><time>${esc(last ? clockTime(last.at) : '')}</time><span class="text">${esc(last ? last.text : t('No action yet: reading your message.'))}</span></div></div>`;
  }
  return html;
}

function drawLive() {
  const d = liveChat.data;
  if (!liveChat.id) return;
  if (d?.error) {
    const html = `<div class="empty">${esc(d.error)}</div>`;
    draw('#live-head', html, html);
    return;
  }
  // The session from the app's state (memory, from the latest reading) or, until it has it, from the conversation.
  const x = { ...(d?.session ?? {}), ...(allSessions().find(s => s.id === liveChat.id) ?? {}), ...(d?.session ? { phase: d.session.phase, turn: d.session.turn } : {}) };
  if (!x.id) return;
  const ended = x.status === 'ended';
  const actions = [
    ended && x.resumable ? `<button type="button" class="button small" data-live-resume="${esc(x.id)}">${esc(t('Resume'))}</button>` : '',
    !ended ? `<button type="button" class="button danger small" data-session-end="${esc(x.id)}">${esc(t('End'))}</button>` : '',
  ].join('');
  const head = `<div class="live-title"><span class="primary">${esc(x.name)}</span><span class="secondary">${esc([toolName(x.tool), sessionWhere(x), x.cwd ?? '', x.model ?? ''].filter(Boolean).join(' · '))}</span></div>
    <div class="live-facts">${stateHtml(sessionState(x))}<span>${esc(t('Memory'))} <span class="num">${x.ram ? bytes(x.ram) : '—'}</span></span><span>${esc(t('Open for'))} ${ended ? '—' : ticking(x.started)}</span><span>${esc(t('{count} turn(s)', { count: x.turns ?? 0 }))}</span><span class="compose-buttons">${actions}</span></div>
    <div class="live-phase${['permission', 'login'].includes(x.phase) || x.status === 'login' ? ' warn' : ''}">${esc(livePhaseLine(x))}</div>`;
  draw('#live-head', JSON.stringify([x.id, x.status, x.phase, x.ram, x.turns, x.resumable, language()]), head);

  const box = $('#live-feed');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  if (draw('#live-feed', JSON.stringify([x.id, liveChat.next, liveChat.items.length, x.phase, x.turn?.since, x.turn?.last?.at, !!d, language()]), liveFeedHtml(x))) {
    if (atBottom || !liveChat.scrolled) {
      box.scrollTop = box.scrollHeight;
      liveChat.scrolled = !!d;
    }
  }

  // What the agent asks of you: each permission, with Allow and Refuse.
  const asks = (d?.requests ?? []).filter(r => r.kind === 'permission').map(r => `<div class="needs live-ask" role="alert">
      <div class="needs-text"><span class="needs-label">${esc(t('Needs you'))}</span>${r.explain ? `<strong class="perm-what">${esc(r.explain.summary)}</strong>${permissionFacts(r.explain, r.id)}` : `${esc(t('The agent asks to: {what}', { what: r.what }))}<span class="hint">${esc(t('Allowed, it is told to go ahead; the permission lasts for this session.'))}</span>`}</div>
      <span class="compose-buttons"><button type="button" class="button secondary small" data-live-refuse="${esc(r.id)}">${esc(t('Refuse'))}</button><button type="button" class="button small" data-live-allow="${esc(r.id)}">${esc(t('Allow'))}</button></span>
    </div>`).join('');
  draw('#live-asks', JSON.stringify([x.id, d?.requests ?? [], language()]), asks);

  const queue = d?.queue ?? [];
  $('#live-queue').hidden = !queue.length;
  const queued = `<div class="chat-queue-head"><span class="label">${esc(t('In the queue'))}</span><span class="hint">${esc(t('They go together, in order, when the agent finishes this turn.'))}</span></div>${queue.map(m => `<div class="queued-msg">
      <div class="msg-head"><span class="tag">${esc(m.first ? t('first message') : t('queued'))}</span><span class="msg-meta">${esc(clockTime(m.at))}</span>
        ${m.first ? '' : `<span class="queued-actions"><button type="button" class="button danger small" data-live-unqueue="${esc(m.id)}">${esc(t('Remove'))}</button></span>`}</div>
      <div class="msg-body">${m.first ? esc(t('{count} characters', { count: m.text.length })) : md(m.text)}</div></div>`).join('')}`;
  draw('#live-queue', JSON.stringify([x.id, queue, language()]), queue.length ? queued : '');

  const working = x.phase === 'working';
  $('#live-send').disabled = !online;
  $('#live-send').textContent = working || queue.length || x.status === 'login' ? t('Add to the queue') : ended ? t('Resume and send') : t('Send');
  $('#live-interrupt').hidden = !online || !working;
  $('#live-hint').textContent = working ? t('Interrupt stops the agent now; the conversation goes on.') : '';
}

/** A project's Live tab: its sessions in the app, a new one with each tool, and the conversation of the one chosen. */
function drawProjectLive(id) {
  const sessions = liveSessionsOf(id);
  const open = sessions.filter(x => x.status !== 'ended');
  const earlier = sessions.filter(x => x.status === 'ended').slice(0, 4);
  const chosen = sessions.find(x => x.id === pageLiveSession()) ?? open[0] ?? null;
  const profiles = (state.sessions?.profiles ?? []).filter(p => p.project === id && !open.some(x => x.profile === p.id));
  const noClone = noCloneAttr(projectPage.data?.id === id ? projectPage.data : null);
  const card = x => `<a class="live-card${chosen?.id === x.id ? ' active' : ''}" href="${esc(sessionHash(x))}">
      <span class="primary">${esc(toolName(x.tool))}</span>${stateHtml(sessionState(x))}
      <span class="hint">${esc([x.status === 'ended' ? t('ended {when}', { when: relative(x.ended) }) : t('open since {time}', { time: clockTime(x.started) }), x.ram ? bytes(x.ram) : ''].filter(Boolean).join(' · '))}</span></a>`;
  const html = `<div class="live-list">
      ${open.map(card).join('')}
      ${profiles.map(p => `<button type="button" class="button secondary" data-session-open="${esc(p.id)}"${noClone} title="${esc(p.name)}">${esc(t('New session: {tool}', { tool: toolName(p.tool) }))}</button>`).join('')}
    </div>
    ${earlier.length ? `<div class="live-earlier"><span class="label">${esc(t('Earlier'))}</span>${earlier.map(card).join('')}</div>` : ''}
    ${sessions.length ? '' : `<p class="hint">${esc(t("A conversation with Claude Code or Codex here in the app, in your clone of the project: you see what it says and each action (commands, files read and edited) as it happens. It starts with the project's blocks of the prompt builder."))}</p>`}`;
  draw('#project-live-list', JSON.stringify([id, sessions.map(x => [x.id, x.status, x.phase, Math.round(x.ram / 1048576)]), chosen?.id, profiles.map(p => p.id), !!noClone, language()]), html);
  if (!chosen) {
    stopLive();
    return;
  }
  placeLive($('#project-live'));
  openLive(chosen.id);
}

/** A session's own view ("#session/<id>"), for the sessions outside the projects (a library folder, a folder of their own). */
function drawSessionPage() {
  const id = pageSession();
  const x = allSessions().find(s => s.id === id);
  const html = `<div class="view-header"><div><h1>${esc(x?.name ?? t('Live session'))}</h1><p>${esc(t('A conversation with the agent, here in the app.'))} <a href="#operations">${esc(t('All the sessions, in Operations'))}</a></p></div></div>`;
  draw('#session-page', JSON.stringify([id, x?.name, language()]), html);
  placeLive($('#view-session'));
  openLive(id);
}

async function sendLive() {
  const text = $('#live-text').value;
  if (!text.trim() || !liveChat.id) return;
  stopDictation($('#live-text'));
  $('#live-send').disabled = true;
  try {
    const m = await api('/api/session/say', { id: liveChat.id, text });
    $('#live-text').value = '';
    fitField($('#live-text'));
    if (m.queued) toast(t('In the queue: it goes when the agent finishes this turn.'));
    await pollLive();
    refresh();
  } catch (error) {
    toast(error.message);
  } finally {
    $('#live-send').disabled = !online;
  }
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
        <div class="crew-top"><div><h2>${esc(t(a.name))}</h2><div class="hint">${esc(t(a.title ?? ''))}</div></div><span class="marks">${toolBadge(a)}<span class="model" title="${esc(a.model ?? '')}">${esc(modelLabel(a))}</span></span></div>
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
      <td><span class="primary">${esc(r.title)}</span>${summaryLine(r)}<span class="secondary">${esc(details)}</span></td>
      <td>${stateHtml(runLabel(r))}</td>
      <td class="num">${r.started ? esc(elapsed(r.started, r.ended ?? Date.now())) : '—'}</td>
    </tr>`;
  });
  const html = list.length
    ? `<table class="table"><thead><tr><th>${esc(t('Date'))}</th><th>${esc(t('Run'))}</th><th>${esc(t('Status'))}</th><th>${esc(t('Time'))}</th></tr></thead><tbody>${rows.join('')}</tbody></table>`
    : `<div class="empty">${esc(t('No runs yet.'))}</div>`;
  draw('#log-list', JSON.stringify([selectedRun, list.map(r => [r.id, r.title, r.summary, r.status, r.ended, r.pullRequest, r.needsYou]), Math.floor(Date.now() / 60000)]), html);
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
    const facts = [s.tool && s.tool !== 'claude' ? TOOL_LABELS[s.tool] ?? s.tool : '', s.model ? shortModel(s.model) : '', s.durationMs ? t('{minutes} min', { minutes: Math.round(s.durationMs / 60000) }) : '', s.turns ? t('{count} turns', { count: s.turns }) : '', s.subagents ? t('{count} subagent(s)', { count: s.subagents }) : ''].filter(Boolean);
    let body = s.report || s.error;
    if (!body) body = s.status === 'pending' ? t('Not started yet.') : s.status === 'running' ? t('Working…') : t('No report.');
    return `
      <div class="report">
        <div class="report-top"><div class="report-who">${face(member(s.agent, r.project), stepFace(s), 26)}<strong>${i + 1}. ${esc(agentName(s.agent, r.project))}${stepRole(s) ? `, ${esc(stepRole(s))}` : ''}</strong></div>${stateHtml(runState(s.status))}</div>
        <div class="hint num">${facts.map(esc).join(' · ')}${s.status !== 'pending' ? ` · <button type="button" class="button secondary small" data-context="${esc(r.id)}" data-step="${i + 1}">${esc(t('Context received'))}</button>` : ''}</div>
        ${s.outcome
          ? `${outcomeHtml(s.outcome)}<details class="report-full"><summary>${esc(t('Full report'))}</summary><div class="body">${md(body)}</div></details>`
          : `<div class="body">${md(body)}</div>`}
      </div>`;
  });
  // What the crew asked of the owner during the run.
  const requests = (r.requests ?? []).length
    ? `<div class="report"><div class="report-top"><strong>${esc(t('Asked of you'))}</strong></div>${r.requests.map(q => `<div>${stateHtml(q.status === 'open' ? [t('Waiting for your action'), 'warn'] : [t('Done'), 'ok'])} ${esc(q.what)}${q.url ? ` · <a href="${esc(q.url)}" target="_blank" rel="noopener">${esc(t('Open the address'))}</a>` : ''}${q.status === 'open' ? `${requestWhy(q)} ${requestButtons(r.id, q, ' small')}` : q.answer ? ` · ${esc(t('Your answer: {answer}', { answer: q.answer }))}` : ''}</div>`).join('')}</div>`
    : '';
  const checks = r.checks?.length
    ? `<div class="report"><div class="report-top"><strong>${esc(t('Checks'))}</strong></div>${r.checks.map(c => `<div>${stateHtml(c.ok ? [t('Passed'), 'ok'] : [t('Failed'), 'error'])} <code>${esc(c.command)}</code></div>`).join('')}</div>`
    : '';
  const html = `
    <h2>${esc(r.title)}</h2>
    ${r.summary ? `<p class="run-summary">${esc(r.summary)}</p>` : ''}
    <div class="hint">${stateHtml(runLabel({ ...r, needsYou: (r.requests ?? []).filter(x => x.status === 'open').length }))} · <span class="num">${shortDate(r.created)}</span> · ${esc(projectName(r.project))} · ${esc(originLabel(r.origin))}${r.started ? ` · <span class="num">${esc(elapsed(r.started, r.ended ?? Date.now()))}</span>` : ''}</div>
    ${r.result ? `<p>${esc(r.result)}</p>` : ''}${r.note ? `<p class="hint">${esc(r.note)}</p>` : ''}
    ${r.outcome ? `<div class="label">${esc(t('Final summary'))}</div>${outcomeHtml(r.outcome)}` : ''}
    ${r.instruction ? `<details class="report-full"><summary>${esc(t('Full instruction'))}</summary><p class="hint">${esc(r.instruction)}</p></details>` : ''}
    <div class="actions left">
      ${r.pullRequest ? `<a class="button" href="${esc(r.pullRequest)}" target="_blank" rel="noopener">${esc(t('Open pull request'))}</a>` : ''}
      ${r.status === 'done' && (r.pullRequest || r.delivered) && !r.merged ? `<button type="button" class="button secondary" data-merge="${esc(r.id)}">${esc(t('Merge'))}</button>` : ''}
      ${r.merged ? `<span class="hint">${stateHtml([t('Merged'), 'ok'])} <span class="num">${shortDate(r.merged.at)}</span> · ${esc(r.merged.by === 'manager' ? t('by the manager, with your authorization') : r.merged.by === 'outside' ? (r.merged.how === 'pr' ? t('on GitHub') : t('in your clone')) : t('by you'))}</span>` : ''}
      ${canResume ? `<button type="button" class="button secondary" data-resume="${esc(r.id)}">${esc(t('Resume'))}</button>` : ''}
      ${r.status === 'paused' ? `<button type="button" class="button secondary" data-resume="${esc(r.id)}" data-ignore>${esc(t('Resume past the limit'))}</button>` : ''}
      ${canCancel ? `<button type="button" class="button danger" data-cancel="${esc(r.id)}">${esc(t('Cancel'))}</button>` : ''}
    </div>
    ${runFilesHtml(r)}${requests}${reports.join('')}${checks}`;
  $('#log-detail').dataset.filesRun = r.id; // the paths in its reports are looked for in the run's files first
  draw('#log-detail', JSON.stringify([r.id, r.updated, r.status, runFilesCache.get(r.id)?.at]), html);
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

// ---------- The autopilot ----------

/** Why the autopilot waits now (src/autopilot.mjs, blockInfo). */
function autopilotWait(b) {
  switch (b?.reason) {
    case 'quiet': return t('Waiting: quiet hours ({hours}).', { hours: b.quiet });
    case 'window': return t('Waiting: the 5-hour window is at {used}, and the autopilot stops at {limit}.', { used: percent(b.used), limit: percent(b.limit) });
    case 'week': return t("Waiting: the plan's week is at {used} with {elapsed} of it gone, ahead of the pace that ends it at {target}.", { used: percent(b.used), elapsed: percent(b.elapsed), target: percent(b.target) });
    default: return '';
  }
}

function autopilotItemState(status) {
  if (status === 'archived') return [t('Archived item'), 'neutral'];
  if (status === 'removed') return [t('Off the board'), 'neutral'];
  return planState(status);
}

function drawAutopilot() {
  const a = state.autopilot;
  if (!a) return;
  const now = !a.enabled ? [t('Off'), 'neutral'] : a.blocked ? [t('On, waiting'), 'warn'] : [t('On, ready'), 'ok'];
  const line = !a.enabled
    ? t('Nothing goes on the queue without you. Approved items still start by themselves, one per project at a time.')
    : a.blocked ? autopilotWait(a.blocked)
    : t('When the queue of a project empties, the manager puts its next item triaged "do now" on the queue.');
  const items = a.queued.map(e => `<li>
      <span>${clockTime(e.at)}</span>
      <span><span class="primary">#${e.item} ${esc(e.title)}</span><span class="secondary">${projectLink(e.project)} · ${esc(e.agent ?? '')}${e.pr ? ` · <a href="${esc(e.pr)}" target="_blank" rel="noopener">${esc(t('Pull request'))}</a>` : ''}</span></span>
      ${stateHtml(autopilotItemState(e.status))}
    </li>`);
  const woke = [...new Set(a.wakes.map(w => w.project))];
  const html = `<div class="label">${esc(t('Autopilot'))}</div>
    <div class="autopilot-head">
      ${stateHtml(now)}
      <button type="button" class="button ${a.enabled ? 'secondary' : ''} small" data-autopilot="${a.enabled ? 'off' : 'on'}">${esc(a.enabled ? t('Turn off') : t('Turn on'))}</button>
    </div>
    <p>${esc(line)}</p>
    ${a.enabled && !a.idle_news ? `<p class="hint state-warn">${esc(t('The "empty queue" news is off in manager_updates: the manager is never woken, so only the items you approved start.'))}</p>` : ''}
    <div class="label autopilot-today-label">${esc(t('Today'))}</div>
    ${items.length ? `<ul class="autopilot-today">${items.join('')}</ul>` : `<p class="hint">${esc(t('It put nothing on the queue today.'))}</p>`}
    <p class="hint">${esc(woke.length ? t('It woke the manager {count} time(s) for an empty queue: {projects}.', { count: a.wakes.length, projects: woke.map(projectName).join(', ') }) : t('It woke the manager for no empty queue today.'))}${items.length ? ` <a href="#planning">${esc(t('See on the board'))}</a>` : ''}</p>
    <p class="hint">${esc(t('Items recommended "later" always wait for you. With the away mode on, it carries on within these limits; the daily report tells you what it did.'))}</p>`;
  draw('#autopilot', html, html);
  // the form follows the settings (changed here, on the command line or by hand) unless it is being edited
  const form = $('#autopilot-form');
  const settings = JSON.stringify([a.stop_at_5h_window, a.week_pace, a.quiet_hours, a.daily_report]);
  if (!form.contains(document.activeElement) && form.dataset.filled !== settings) {
    const [from = '', to = ''] = a.quiet_hours ? a.quiet_hours.split('-').map(x => x.trim().padStart(5, '0')) : [];
    form.window.value = Math.round(a.stop_at_5h_window * 100);
    form.pace.value = Math.round(a.week_pace * 100);
    form.quietFrom.value = from;
    form.quietTo.value = to;
    form.report.value = a.daily_report ? a.daily_report.padStart(5, '0') : '';
    form.dataset.filled = settings;
  }
}

$('#autopilot-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.target;
  const from = form.quietFrom.value;
  const to = form.quietTo.value;
  if (!from !== !to) return toast(t('Fill in both quiet hours, or leave both empty.'));
  try {
    await api('/api/autopilot', {
      stop_at_5h_window: Number(form.window.value) / 100,
      week_pace: Number(form.pace.value) / 100,
      quiet_hours: from ? `${from}-${to}` : 'off',
      daily_report: form.report.value || 'off',
    });
    delete form.dataset.filled;
    toast(t("Autopilot's limits saved."));
    refresh();
  } catch (error) {
    toast(error.message);
  }
});

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

const PAGE_PARTS = ['#project-title', '#project-more', '#project-status', '#project-actions', '#project-needs', '#project-tabs', '#project-summary', '#project-facts', '#project-team', '#project-runs', '#project-history', '#project-planning', '#project-computer', '#project-sessions', '#project-live-list', '#project-charge-top'];
// Each tab and the part of the page it shows.
const TAB_PARTS = { overview: '#project-overview', charge: '#project-charge', live: '#project-live', crew: '#project-crew', tasks: '#project-tasks', planning: '#project-planning', files: '#project-files', context: '#project-context', builder: '#project-builder' };

const projectHash = (id, tab = 'overview') => `#project/${encodeURIComponent(id)}${tab === 'overview' ? '' : `/${tab}`}`;
const projectOpenItems = (id, p) => planItemsNow().filter(i => openItem(i) && (i.project === id || i.project === p?.name));
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
  const live = liveSessionsOf(id).filter(x => x.status !== 'ended');
  const tabs = [
    ['overview', t('At a glance')], ...(state.charge?.[id] ? [['charge', t('In charge'), chargeOpen(id).length]] : []), ['live', t('Live'), live.length], ['crew', t('Crew')], ['tasks', t('Tasks and history'), working], ['planning', t('Planning'), projectOpenItems(id, p).length],
    ['files', t('Files')], ['context', t('Context')], ...(builderOn ? [['builder', t('Builder')]] : []),
  ].map(([key, label, n]) => `<a href="${projectHash(id, key)}" class="tab${key === tab ? ' active' : ''}"${key === tab ? ' aria-current="page"' : ''}>${esc(label)}${count(n)}</a>`).join('');
  draw('#project-tabs', tabs, tabs);
  for (const [key, part] of Object.entries(TAB_PARTS)) $(part).hidden = key !== tab;
  $('#view-project').dataset.filesProject = id; // the paths on its page are looked for in its folders
  if (tab === 'files') drawProjectFiles(id);
  else if (tab === 'context') {
    if (projectContext.id !== id) openProjectContext(id);
    else drawProjectContext();
  } else if (tab === 'builder') {
    placeBuilder(true);
    if (builder.project !== id || !builder.data) openBuilder(id);
    else drawBuilderTop();
  } else if (tab === 'charge') {
    drawProjectCharge(id);
  } else if (tab === 'live') {
    drawProjectLive(id);
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
  const c = state.charge?.[id];
  const charge = c ? big(`data-charge-open="${esc(id)}"`, t('Talk to the agent in charge'), t('{name} plans with you; the manager authorizes', { name: t(c.name) }), ' accent') : '';
  const html = [charge, live, big('data-project-task', t('New task for the crew'), t('Someone of the crew does it, you approve')), devAction].join('');
  draw('#project-actions', html, html);
}

// ---------- The project's agent in charge: the conversation and its requests to the manager ----------

/** A request's state, in words and color. */
function requestState(r) {
  if (r.status === 'approved') return r.merged ? [t('Done'), 'ok'] : [t('Authorized'), 'ok'];
  return {
    pending: [t('With the manager'), 'info'], waiting: [t('Waiting'), 'warn'], owner: [t('With you'), 'accent'], rejected: [t('Refused'), 'neutral'],
  }[r.status] ?? [r.status, 'neutral'];
}

/** The requests still open (with the manager, waiting, or with you): the tab's counter. */
const chargeOpen = id => (state.charge?.[id]?.requests ?? []).filter(r => ['pending', 'waiting', 'owner'].includes(r.status));

function requestRow(id, r) {
  const size = { S: t('Size S'), M: t('Size M'), L: t('Size L') }[r.size] ?? r.size;
  const risk = { low: t('Low risk'), medium: t('Medium risk'), high: t('High risk') }[r.risk] ?? r.risk;
  const who = r.by === 'owner' ? t('You') : t('Manager');
  const run = r.run ? `<a href="${esc(projectHash(id, 'tasks'))}">${esc(t('Run: {title}', { title: r.runTitle ?? r.run }))}</a>${r.runStatus ? ` · ${esc(runState(r.runStatus)[0])}` : ''}` : '';
  return `<div class="charge-request">
      <div class="charge-request-main"><span class="primary">${esc(r.plan)}</span>
        <span class="hint">${esc([`#${r.id}`, size, risk, r.urgency ? t('you said: can be done now') : '', relative(r.at)].filter(Boolean).join(' · '))}</span>
        ${r.note ? `<span class="hint">${esc(`${who}: ${r.note}`)}</span>` : ''}${run ? `<span class="hint">${run}</span>` : ''}</div>
      <div class="charge-request-state">${stateHtml(requestState(r))}${r.status === 'owner' ? ` <a class="button small" href="#decisions">${esc(t('Decide'))}</a>` : ''}</div>
    </div>`;
}

/** The "In charge" tab: who is in charge, its requests to the manager with their state, and the conversation. */
function drawProjectCharge(id) {
  const c = state.charge?.[id];
  const open = chargeOpen(id);
  const closed = (c?.requests ?? []).filter(r => !open.includes(r));
  const html = !c ? `<p class="hint">${esc(t('This project has no one in its crew to be in charge.'))}</p>` : `<div class="charge-head">
      <div><span class="label">${esc(t('Agent in charge'))}</span><strong class="charge-name">${esc(t(c.name))}</strong>
        <p class="hint">${esc(c.lead ? t('The team lead of this project, with its memory.') : t("The main member of this project's crew."))} ${esc(t('Talk, ask and plan here. It changes nothing by itself: what is to be done goes to the manager as a request, and the manager authorizes it, asks to wait or brings it to you.'))}</p></div>
      ${c.session ? '' : `<button type="button" class="button" data-charge-open="${esc(id)}">${esc(t('Start the conversation'))}</button>`}
    </div>
    ${open.length || closed.length ? `<div class="label">${esc(t('Requests to the manager'))}</div>` : ''}
    ${open.length ? `<div class="charge-requests">${open.map(r => requestRow(id, r)).join('')}</div>` : ''}
    ${closed.length ? `<details class="charge-earlier"${open.length ? '' : ' open'}><summary>${esc(t('Answered ({count})', { count: closed.length }))}</summary><div class="charge-requests">${closed.map(r => requestRow(id, r)).join('')}</div></details>` : ''}`;
  draw('#project-charge-top', JSON.stringify([id, c, language()]), html);
  if (!c?.session) {
    stopLive();
    return;
  }
  placeLive($('#project-charge'));
  openLive(c.session);
}

/** The secondary actions, in the "More" menu: the folder, VS Code and a live session with each tool. */
function drawProjectMore(id, info) {
  // Kept while open, so a refresh doesn't close it under the pointer.
  if ($('#project-more .menu[open]')) return;
  const profiles = (state.sessions?.profiles ?? []).filter(x => x.project === id);
  const noClone = noCloneAttr(info);
  const item = (attrs, label) => `<button type="button" class="menu-item" ${attrs}>${esc(label)}</button>`;
  const session = (tool, window = false) => {
    const profile = profiles.find(x => x.tool === tool);
    if (!profile) return '';
    return window
      ? item(`data-session-open="${esc(profile.id)}" data-window="1"${noClone}`, t('Open in an external window: {tool}', { tool: toolName(tool) }))
      : item(`data-session-open="${esc(profile.id)}"${noClone}`, t('Live session: {tool}', { tool: toolName(tool) }));
  };
  const items = [
    item(`data-project-open="folder"${noClone}`, t('Open folder')),
    info?.vscode ? item(`data-project-open="vscode"${noClone}`, t('Open in VS Code')) : '',
    session('claude'),
    session('codex'),
    session('claude', true),
    session('codex', true),
  ].join('');
  const html = `<details class="menu"><summary class="button secondary">${esc(t('More'))}</summary><div class="menu-list">${items}</div></details>`;
  draw('#project-more', html, html);
}

/** What waits for you in this project, at the top: its notices (requests, failures, pull requests, the board's items). */
function drawProjectNeeds(id, p) {
  const html = attnList(attnItems().filter(ofProject(id, p.name)), t('Waiting for you'));
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
      <div style="min-width:0"><div class="name">${liveDot()} ${esc(a.title)}</div><div class="hint">${esc(stepLine(a))} · ${ticking(a.started)}</div>${a.doing ? `<div class="hint">${esc(t('Now: {what}', { what: a.doing }))}</div>` : ''}</div>
      <button type="button" class="button danger small" data-cancel="${esc(a.id)}">${esc(t('Cancel run'))}</button>
    </div>`);
  const waiting = queue.map(r => `<div class="project-run">
      <span></span>
      <div style="min-width:0"><div class="name" title="${esc(r.summary ?? '')}">${esc(r.title)}</div><div class="hint">${stateHtml(runLabel(r))}${r.notBefore && new Date(r.notBefore).getTime() > Date.now() + skew ? ` · ${esc(t('not before {when}', { when: shortDate(r.notBefore) }))}` : ''}</div></div>
      <button type="button" class="button danger small" data-cancel="${esc(r.id)}">${esc(t('Cancel'))}</button>
    </div>`);
  const html = `<div class="panel">
      <div class="label">${esc(t('Running now'))}</div>${live.join('') || `<div class="hint">${esc(t('Nothing running for this project.'))}</div>`}
      <div class="label" style="margin-top:16px">${esc(t('Queue'))}</div>${waiting.join('') || `<div class="hint">${esc(t('Nothing in the queue for this project.'))}</div>`}
    </div>`;
  draw('#project-runs', JSON.stringify([online, runs.map(a => [a.id, a.title, a.step, a.agent, a.status, a.doing, member(a.agent ?? 'manager', a.project).status]), queue.map(r => [r.id, r.title, r.summary, r.status, r.notBefore, r.needsYou])]), html);
}

/** The project's latest runs, each with its result and a link to its reports in the Log. */
function drawProjectHistory(info) {
  const list = info?.history ?? [];
  const rows = list.map(r => `<tr>
      <td class="num">${shortDate(r.created)}</td>
      <td><span class="primary">${esc(r.title)}</span>${summaryLine(r)}<span class="secondary">${esc(r.outcome?.change || r.result || r.note || '')}</span></td>
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
  const items = planItemsNow().filter(i => openItem(i) && (i.project === id || i.project === p.name));
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
      <p class="hint">${esc(t("Claude Code or Codex in your clone of the project, starting with the project's block of the prompt builder and the environment. The conversation is in the Live tab."))}</p>
      ${sessionTable(open)}
      ${profiles.length ? `<div class="session-profiles">${profileCards(profiles)}</div>` : ''}
    </div>`;
  draw('#project-sessions', JSON.stringify([open.map(x => [x.id, x.status, x.phase, x.alive, Math.round(x.ram / 1048576), x.started]), profiles]), html);
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
    case 'tool': return t('The tool it runs on');
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
        <dt>${esc(t('Model'))}</dt><dd>${m.tool && m.tool !== 'claude' ? `${toolBadge(m)} ` : ''}${esc(m.model ? shortModel(m.model) : '—')}${m.effort ? ` · ${esc(t('effort {effort}', { effort: m.effort }))}` : ''} · ${esc(t('up to {minutes} min per step', { minutes: m.maxMinutes }))}</dd>
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
    toast(session.status === 'login' ? t('Codex is not signed in: see the request at the top.') : t('Session opened here in the app.'));
    await refresh();
    location.hash = sessionHash(session);
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
    case 'proposed': return [t('Proposed'), 'neutral'];
    case 'triaged': return [t('Waiting for your decision'), 'warn'];
    case 'approved': return [t('Approved, waiting its turn'), 'info'];
    case 'discarded': return [t('Discarded'), 'neutral'];
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
const CLOSED_ITEMS = ['done', 'discarded'];
const openItem = i => !i.archived && !CLOSED_ITEMS.includes(i.status);
const byRank = (a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || a.id - b.id;
const waitingItems = () => planItemsNow().filter(i => !i.archived && i.status === 'waiting_owner');
// The manager's triaged proposals, in the owner's order: what the owner decides with "Do", "Later" or "Discard".
const decisionItems = () => planItemsNow().filter(i => !i.archived && i.status === 'triaged').sort(byRank);
const approvedItems = () => planItemsNow().filter(i => !i.archived && i.status === 'approved').sort(byRank);
const recommendLabel = r => ({ now: t('Do now'), later: t('Later'), discard: t('Discard') })[r] ?? r ?? '';
const firstLine = text => String(text ?? '').split('\n').find(l => l.trim())?.trim() ?? '';
let discarding = null; // the decision being discarded: its reason is asked in place
let dragging = null; // the decision being dragged: the panel is not redrawn meanwhile

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
  if (i.run) parts.push(`<a href="#log" data-select="${esc(i.run)}" title="${esc(i.run)}">${esc(runTitle(i.run))}</a>${i.run_status ? ` ${stateHtml(runState(i.run_status))}` : ''}`);
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
  // Who proposed it, who would do it, the manager's recommendation and, when discarded, why.
  const about = [
    i.proposed_by === 'owner' ? t('Proposed by you') : i.proposed_by ? t('Proposed by {who}', { who: agentName(i.proposed_by, i.project) }) : '',
    i.agent ? t('for {agent}', { agent: agentName(i.agent, i.project) }) : '',
    i.recommend ? t('manager: {recommendation}', { recommendation: recommendLabel(i.recommend) }) + (i.recommend_note ? ` (${i.recommend_note})` : '') : '',
    i.status === 'discarded' ? t('discarded: {reason}', { reason: i.discard_reason || t('no reason given') }) : '',
  ].filter(Boolean).join(' · ');
  return `<tr class="plan-row plan-${esc(i.status)}${i.archived ? ' archived' : ''}" data-item="${i.id}">
    <td class="num">#${i.id}</td>
    <td><span class="primary">${esc(i.title)}</span>${i.description ? `<span class="secondary plan-description">${esc(i.description)}</span>` : ''}${about ? `<span class="secondary">${esc(about)}</span>` : ''}<span class="secondary">${esc(dates)}${i.archived ? ` · ${esc(t('archived {when}', { when: shortDate(i.archived) }))}` : ''}</span></td>
    <td>${projectLink(i.project)}</td>
    <td><select class="inline-select priority-${esc(i.priority)}" data-plan-field="priority" aria-label="${esc(t('Priority'))}">${planOptions(priorities, i.priority)}</select></td>
    <td><select class="inline-select state-${planState(i.status)[1]}" data-plan-field="status" aria-label="${esc(t('Status'))}">${planOptions(statuses, i.status)}</select></td>
    <td>${planLinks(i)}</td>
    <td class="row-actions"><div class="plan-actions">${i.archived || i.status === 'discarded'
      ? `<button type="button" class="button secondary small" data-plan-restore="${i.id}">${esc(t('Restore'))}</button>`
      : `<button type="button" class="button secondary small" data-plan-edit="${i.id}">${esc(t('Edit'))}</button><button type="button" class="button secondary small" data-plan-archive="${i.id}">${esc(t('Archive'))}</button>`}</div></td>
  </tr>`;
}

function visibleItems() {
  const f = planFilter;
  const list = planItemsNow().filter(i =>
    (f.status === 'archived' ? !!i.archived : !i.archived)
    && (f.status === 'open' ? !CLOSED_ITEMS.includes(i.status)
      : f.status === 'waiting' ? ['triaged', 'waiting_owner'].includes(i.status)
      : ['all', 'archived'].includes(f.status) || i.status === f.status)
    && (!f.project || i.project === f.project) && (!f.priority || i.priority === f.priority));
  if (f.sort === 'updated') list.sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? ''));
  else if (f.sort === 'number') list.sort((a, b) => a.id - b.id);
  return list; // "priority": the server's order (priority, then what needs you, then the number)
}

function drawPlanning(force = false) {
  if (!state?.planning) return;
  const items = planItemsNow();
  const waiting = waitingItems();
  const deciding = decisionItems();
  const approved = approvedItems();
  // The menu shows how many wait for you with the attention mark (drawNavAttention).
  const needs = waiting.length + deciding.length;
  $('#counter-planning').parentElement.title = needs ? t('{count} item(s) waiting for you', { count: needs }) : '';

  // First, what needs you: the decisions (in your order, which you can drag), then the other notices.
  const decision = i => discarding === i.id
    ? `<li class="plan-decision" data-item="${i.id}"><div class="plan-decision-text"><span class="primary">#${i.id} ${esc(i.title)}</span>
        <label class="plan-reason"><span>${esc(t('Why discard it? (optional, one line)'))}</span><input type="text" maxlength="200" data-discard-reason></label></div>
        <div class="plan-decide"><button type="button" class="button danger" data-plan-decide="discard" data-confirm>${esc(t('Discard'))}</button><button type="button" class="button secondary" data-plan-decide="cancel">${esc(t('Cancel'))}</button></div></li>`
    : `<li class="plan-decision" data-item="${i.id}" draggable="true" title="${esc(t('Drag to change the order'))}">
        <span class="plan-grip" aria-hidden="true">⋮⋮</span>
        ${face(member(i.agent, i.project), 'still', 22)}
        <div class="plan-decision-text">
          <span class="primary">#${i.id} ${esc(i.title)}</span>
          ${i.description ? `<span class="secondary">${esc(firstLine(i.description))}</span>` : ''}
          <span class="hint">${projectLink(i.project)} · ${esc(t('for {agent}', { agent: agentName(i.agent, i.project) }))} · ${esc(priorityLabel(i.priority))}</span>
          <span class="plan-recommend recommend-${esc(i.recommend ?? '')}">${esc(t('Manager: {recommendation}', { recommendation: recommendLabel(i.recommend) }))}${i.recommend_note ? ` · ${esc(i.recommend_note)}` : ''}</span>
        </div>
        <div class="plan-decide"><button type="button" class="button" data-plan-decide="approve">${esc(t('Do'))}</button><button type="button" class="button secondary" data-plan-decide="later">${esc(t('Later'))}</button><button type="button" class="button danger" data-plan-decide="discard">${esc(t('Discard'))}</button></div>
      </li>`;
  const decisions = deciding.length
    ? `<div class="panel plan-decisions"><div class="label">${esc(t('Decide ({count})', { count: deciding.length }))}</div>
      <p class="hint">${esc(t('Proposals from the crew, triaged by the manager. "Do" makes a task for the agent shown; one at a time per project, in this order.'))}</p>
      <ol>${deciding.map(decision).join('')}</ol></div>`
    : '';
  const turn = approved.length
    ? `<div class="plan-turn hint">${esc(t('Approved, waiting their turn:'))} ${approved.map(i => `<span class="num">#${i.id}</span> ${esc(i.title)}${i.agent ? ` (${esc(agentName(i.agent, i.project))})` : ''}`).join(' · ')}</div>`
    : '';
  // The other notices of the board (pull requests, items waiting for your action) as attention notices; the
  // proposals to decide are in the Decide block.
  const notices = attnList(attnItems().filter(i => i.view === 'planning' && i.kind !== 'decision'), t('Waiting for you'));
  const highlight = decisions + turn + notices;
  if (!$('#planning-waiting').contains(document.activeElement) && !dragging) draw('#planning-waiting', highlight, highlight);

  // Quick filters: the proposals, what waits for you and what was discarded, each with its count.
  const count = status => items.filter(i => !i.archived && (status === 'waiting' ? ['triaged', 'waiting_owner'].includes(i.status) : i.status === status)).length;
  const quick = [['open', t('Open items')], ['proposed', t('Proposed items'), count('proposed')], ['waiting', t('Needs you'), count('waiting')], ['discarded', t('Discarded items'), count('discarded')], ['all', t('All')]]
    .map(([key, label, n]) => `<button type="button" class="tab${planFilter.status === key ? ' active' : ''}" data-plan-quick="${key}">${esc(label)}${n ? `<span class="counter">${n}</span>` : ''}</button>`).join('');
  draw('#planning-quick', quick, quick);

  const projects = planProjects();
  const filters = `<label><span>${esc(t('Project'))}</span><select data-plan-filter="project">${planOptions([['', t('All projects')], ...projects], planFilter.project)}</select></label>
    <label><span>${esc(t('Priority'))}</span><select data-plan-filter="priority">${planOptions([['', t('All priorities')], ...state.planning.priorities.map(p => [p, priorityLabel(p)])], planFilter.priority)}</select></label>
    <label><span>${esc(t('Status'))}</span><select data-plan-filter="status">${planOptions([['open', t('Open (not completed)')], ['waiting', t('Needs you')], ['all', t('All')], ...state.planning.statuses.map(s => [s, planState(s)[0]]), ['archived', t('Archived')]], planFilter.status)}</select></label>
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

$('#planning-quick').addEventListener('click', event => {
  const button = event.target.closest('[data-plan-quick]');
  if (!button) return;
  planFilter.status = button.dataset.planQuick;
  delete signatures['#planning-filters'];
  drawPlanning(true);
});

// The decisions: "Do", "Later" and "Discard" (which asks for a reason in place), and the order, by dragging.
$('#planning-waiting').addEventListener('click', async event => {
  const button = event.target.closest('[data-plan-decide]');
  const row = button?.closest('[data-item]');
  if (!row) return;
  const id = Number(row.dataset.item);
  const decision = button.dataset.planDecide;
  if (decision === 'cancel' || (decision === 'discard' && !('confirm' in button.dataset))) {
    discarding = decision === 'cancel' ? null : id;
    delete signatures['#planning-waiting'];
    drawPlanning(true);
    $('#planning-waiting [data-discard-reason]')?.focus();
    return;
  }
  const reason = row.querySelector('[data-discard-reason]')?.value ?? '';
  for (const b of row.querySelectorAll('button')) b.disabled = true;
  discarding = null;
  const done = { approve: t('Approved: it becomes a task for its agent, in its turn.'), later: t('Left for later. It is under "Future".'), discard: t('Discarded. It is under "Discarded", where you can restore it.') }[decision];
  if (document.activeElement) document.activeElement.blur();
  await changeItem({ action: decision, id, reason }, done);
});
$('#planning-waiting').addEventListener('keydown', event => {
  if (event.key === 'Enter' && event.target.matches('[data-discard-reason]')) event.target.closest('[data-item]').querySelector('[data-confirm]').click();
});
$('#planning-waiting').addEventListener('dragstart', event => {
  const row = event.target.closest('.plan-decision[draggable]');
  if (!row) return;
  dragging = row;
  row.classList.add('dragging');
  event.dataTransfer.effectAllowed = 'move';
});
$('#planning-waiting').addEventListener('dragover', event => {
  const over = event.target.closest('.plan-decision');
  if (!dragging || !over || over === dragging) return;
  event.preventDefault();
  const { top, height } = over.getBoundingClientRect();
  over.parentElement.insertBefore(dragging, event.clientY > top + height / 2 ? over.nextSibling : over);
});
$('#planning-waiting').addEventListener('dragend', async () => {
  if (!dragging) return;
  const list = dragging.parentElement;
  dragging.classList.remove('dragging');
  dragging = null;
  const ids = [...list.querySelectorAll('[data-item]')].map(r => Number(r.dataset.item));
  if (ids.join() !== decisionItems().map(i => i.id).join()) await changeItem({ action: 'reorder', ids }, t('Order saved.'));
  else drawPlanning(true);
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

// ---------- Project radar ----------

function radarState(status) {
  switch (status) {
    case 'new': return [t('New idea'), 'info'];
    case 'studying': return [t('In study'), 'warn'];
    case 'chosen': return [t('Chosen'), 'accent'];
    case 'project': return [t('Became a project'), 'ok'];
    case 'discarded': return [t('Idea discarded'), 'neutral'];
    default: return [status ?? '', 'neutral'];
  }
}
const RADAR_ORDER = ['new', 'studying', 'chosen', 'project', 'discarded'];
const radarIdeasNow = () => state?.radar?.ideas ?? []; // the server's order: highest potential first
const scoreLabel = key => ({ potential: t('Potential'), effort: t('Effort'), risk: t('Risk') })[key];
const radarLink = l => (l.url ? `<a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.name || l.url)}</a>` : esc(l.name));

/** A score from 1 to 5 as five squares, with the number for those who don't count them. */
function radarScore(key, value) {
  const pips = [1, 2, 3, 4, 5].map(n => `<i${n <= value ? ' class="on"' : ''}></i>`).join('');
  return `<span class="radar-score score-${key}" title="${esc(`${scoreLabel(key)}: ${value}/5`)}"><span class="radar-score-name">${esc(scoreLabel(key))}</span><span class="radar-pips" aria-hidden="true">${pips}</span><span class="num">${value}/5</span></span>`;
}

/** The trend series as a small line, with its first and last points written out. */
function radarSpark(series) {
  if (!series?.length || series.length < 2) return '';
  const values = series.map(p => p.value);
  const [low, high] = [Math.min(...values), Math.max(...values)];
  const [w, h] = [120, 28];
  const x = n => 2 + (n * (w - 4)) / (series.length - 1);
  const y = v => (high === low ? h / 2 : h - 3 - ((v - low) * (h - 6)) / (high - low));
  const points = series.map((p, n) => `${x(n).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const [first, last] = [series[0], series.at(-1)];
  const title = series.map(p => `${p.label}: ${p.value}`).join(' · ');
  return `<div class="radar-trend" title="${esc(title)}"><span class="radar-score-name">${esc(t('Trend'))}</span>
    <svg class="radar-spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(title)}"><polyline points="${points}"/><circle cx="${x(series.length - 1).toFixed(1)}" cy="${y(last.value).toFixed(1)}" r="2.5"/></svg>
    <span class="hint">${esc(`${first.label}: ${first.value} → ${last.label}: ${last.value}`)}</span></div>`;
}

/** Potential (up) by effort (right): the best bets are up and to the left. Each point is an idea's number. */
function radarChart(ideas) {
  if (!ideas.length) return '';
  const [w, h, left, bottom, top, right] = [420, 250, 44, 36, 12, 12];
  const x = v => left + ((v - 0.5) * (w - left - right)) / 5;
  const y = v => h - bottom - ((v - 0.5) * (h - bottom - top)) / 5;
  const grid = [1, 2, 3, 4, 5].map(v => `<line class="grid" x1="${x(v)}" x2="${x(v)}" y1="${top}" y2="${h - bottom}"/><line class="grid" x1="${left}" x2="${w - right}" y1="${y(v)}" y2="${y(v)}"/>
    <text class="tick" x="${x(v)}" y="${h - bottom + 14}" text-anchor="middle">${v}</text><text class="tick" x="${left - 8}" y="${y(v) + 4}" text-anchor="end">${v}</text>`).join('');
  // Ideas on the same spot sit side by side.
  const spots = new Map();
  for (const i of ideas) {
    const key = `${i.scores.effort}-${i.scores.potential}`;
    spots.set(key, [...(spots.get(key) ?? []), i]);
  }
  const points = [...spots.values()].flatMap(group => group.map((i, n) => {
    const [cx, cy] = [x(i.scores.effort) + (n - (group.length - 1) / 2) * 20, y(i.scores.potential)];
    const tip = `#${i.id} ${i.title} · ${radarState(i.status)[0]} · ${t('Potential')} ${i.scores.potential} · ${t('Effort')} ${i.scores.effort} · ${t('Risk')} ${i.scores.risk}`;
    return `<g class="radar-point state-${radarState(i.status)[1]}" data-radar-goto="${i.id}" tabindex="0"><title>${esc(tip)}</title><circle class="hit" cx="${cx}" cy="${cy}" r="12"/><circle cx="${cx}" cy="${cy}" r="8"/><text x="${cx}" y="${cy + 3.5}" text-anchor="middle">${i.id}</text></g>`;
  })).join('');
  const best = `<rect class="radar-best" x="${x(0.5)}" y="${y(5.5)}" width="${x(2.5) - x(0.5)}" height="${y(3.5) - y(5.5)}"/><text class="radar-best-label" x="${x(0.5) + 6}" y="${y(5.5) + 14}">${esc(t('Best bets'))}</text>`;
  const statuses = [...new Set(ideas.map(i => i.status))];
  const legend = statuses.map(s => stateHtml(radarState(s))).join('');
  return `<div class="panel radar-chart"><div class="label">${esc(t('Potential × effort'))}</div>
    <svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(t('Potential × effort'))}">${best}${grid}
      <text class="axis" x="${(left + w - right) / 2}" y="${h - 4}" text-anchor="middle">${esc(t('Effort (1 small, 5 large)'))}</text>
      <text class="axis" transform="translate(12 ${(top + h - bottom) / 2}) rotate(-90)" text-anchor="middle">${esc(t('Potential'))}</text>${points}</svg>
    <div class="radar-legend">${legend}</div>
    <p class="hint">${esc(t('Each point is an idea, by its number. Up and to the left: more potential for less effort. Click a point to see its card.'))}</p></div>`;
}

function radarCard(i) {
  const f = i.fundamentals ?? {};
  const field = (label, value) => (value ? `<dt>${esc(label)}</dt><dd>${esc(value)}</dd>` : '');
  const linkList = list => list.map(l => `<li>${radarLink(l)}</li>`).join('');
  const actions = ['new', 'studying'].includes(i.status)
    ? `<div class="radar-actions"><button type="button" class="button" data-radar="choose">${esc(t('I want this'))}</button>${i.status === 'new' ? `<button type="button" class="button secondary" data-radar="later">${esc(t('Later'))}</button>` : ''}<button type="button" class="button danger" data-radar="discard">${esc(t('Discard'))}</button></div>`
    : i.status === 'chosen'
      ? `<p class="radar-note">${esc(t('Chosen: on the planning board as #{n}, for the manager to turn into a project.', { n: i.plan ?? '?' }))} <a href="#planning">${esc(t('Open the planning'))}</a></p>`
      : `<p class="radar-note">${esc(t('It became a project.'))} ${i.project ? projectLink(i.project) : ''}</p>`;
  return `<article class="panel radar-card" id="radar-idea-${i.id}" data-idea="${i.id}">
    <div class="radar-head"><span class="num">#${i.id}</span><h3>${esc(i.title)}</h3>${stateHtml(radarState(i.status))}</div>
    <p class="radar-summary">${esc(i.summary)}</p>
    <div class="radar-scores">${['potential', 'effort', 'risk'].map(k => radarScore(k, i.scores[k])).join('')}</div>
    ${radarSpark(i.series)}
    ${actions}
    <details class="radar-more"><summary>${esc(t('Fundamentals and sources'))}</summary><dl>
      ${field(t('Problem'), i.problem)}${field(t('Audience'), i.audience)}${field(t('Market or demand'), f.market)}
      ${f.competitors?.length ? `<dt>${esc(t('Competitors'))}</dt><dd><ul>${linkList(f.competitors)}</ul></dd>` : ''}
      ${field(t('Search trend or interest'), f.trend)}${i.series?.length ? field(t('Trend series'), i.series.map(p => `${p.label}: ${p.value}`).join(' · ')) : ''}
      ${field(t('Revenue model'), f.revenue)}${field(t('Advantage of {owner}', { owner: state.owner || t('the owner') }), f.advantage)}${field(t('Risks'), f.risks)}
      <dt>${esc(t('Sources'))}</dt><dd><ul>${linkList(i.sources ?? [])}</ul></dd>
      ${field(t('Added'), shortDate(i.created))}
    </dl></details>
  </article>`;
}

function drawRadar() {
  if (!state?.radar) return;
  const ideas = radarIdeasNow();
  const shown = ideas.filter(i => i.status !== 'discarded');
  const discarded = ideas.filter(i => i.status === 'discarded');
  const fresh = ideas.filter(i => i.status === 'new').length;
  draw('#counter-radar', String(fresh), fresh ? String(fresh) : '');
  $('#counter-radar').parentElement.title = fresh ? t('{count} new idea(s) on the radar', { count: fresh }) : '';

  // First the plain summary: how many ideas, and what is up to you.
  const counts = RADAR_ORDER.map(s => [s, ideas.filter(i => i.status === s).length]).filter(([, n]) => n);
  const summary = ideas.length
    ? `<div class="panel radar-overview"><p>${esc(fresh ? t('{count} new idea(s) wait for you. Start at the top: the highest potential comes first.', { count: fresh }) : t('No new idea waiting for you. The crew adds more each week.'))}</p>
      <div class="radar-counts">${counts.map(([s, n]) => `${stateHtml(radarState(s))}<span class="num">${n}</span>`).join('')}</div></div>`
    : `<div class="empty">${esc(t('The radar is empty. A weekly mission researches 2 to 4 ideas, with sources; ask the manager to create it.'))}</div>`;
  draw('#radar-summary', summary, summary);
  const chart = radarChart(shown);
  draw('#radar-chart', chart, chart);
  const list = `${shown.map(radarCard).join('')}${discarded.length
    ? `<details class="panel radar-discarded"><summary>${esc(t('Discarded ideas ({count})', { count: discarded.length }))}</summary><ul>${discarded.map(i => `<li data-idea="${i.id}"><span><span class="num">#${i.id}</span> ${esc(i.title)}${i.discard_reason ? ` <span class="hint">· ${esc(i.discard_reason)}</span>` : ''}</span><button type="button" class="button secondary small" data-radar="restore">${esc(t('Back to the radar'))}</button></li>`).join('')}</ul></details>`
    : ''}`;
  draw('#radar-list', list, list);
}
$('#radar-chart').addEventListener('click', event => {
  const id = event.target.closest('[data-radar-goto]')?.dataset.radarGoto;
  if (id) document.getElementById(`radar-idea-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
});
$('#radar-chart').addEventListener('keydown', event => {
  if (event.key === 'Enter') event.target.closest('[data-radar-goto]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});

// "I want this", "Later", "Discard" and "Back to the radar".
$('#radar-list').addEventListener('click', async event => {
  const button = event.target.closest('[data-radar]');
  const row = button?.closest('[data-idea]');
  if (!row) return;
  const action = button.dataset.radar;
  const id = Number(row.dataset.idea);
  for (const b of row.querySelectorAll('button')) b.disabled = true;
  const done = {
    choose: t('Chosen: the manager gets it on the planning board to turn into a project.'),
    later: t('Left in study. It stays on the radar.'),
    discard: t('Discarded. It is at the bottom, where you can bring it back.'),
    restore: t('Back on the radar as a new idea.'),
  }[action];
  try {
    await api('/api/radar', { action, id });
    toast(done);
  } catch (error) {
    toast(error.message);
  }
  await refresh();
  delete signatures['#radar-list']; // the buttons come back after an error too
  drawRadar();
});

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
  stopDictation($('#agent-form').text);
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
      <div class="hint" title="${esc([f.title, f.summary].filter(Boolean).join(' · '))}">${esc(f.title)}</div>
      ${f.live && f.doing ? `<div class="hint">${esc(t('Now: {what}', { what: f.doing }))}</div>` : ''}
      <div class="hint">${esc(where)}${f.live && f.stepStatus === 'running' && f.stepStarted ? ` · ${ticking(f.stepStarted)}` : ''}</div>
      ${stateHtml(status)}
    </div>`;
  draw('#agent-head', JSON.stringify([online, f.run, f.title, f.doing, f.step, f.agent, f.stepStatus, f.live, f.status]), html);
  $('#agent-form').querySelector('button').disabled = !f.talking;
  $('#agent-form-hint').textContent = f.talking
    ? t('Your message reaches the agent at a safe point: it answers here and goes on with its work.')
    : f.live ? t('The agent is between two steps: write again in a moment.') : t('This run is no longer going on.');
}

function drawAgentTalk(f) {
  const open = new Map(f.requests.map(r => [r.id, r]));
  const entries = f.talk.map(m => {
    const meta = [clockTime(m.at), t('step {n}', { n: m.step })];
    if (m.who === 'owner') {
      const status = { pending: t('waiting for a safe point'), delivered: m.via === 'request' ? t('delivered as the answer to the request') : t('delivered'), undelivered: t('not delivered') }[m.status];
      return `<div class="talk owner"><div class="talk-head"><span class="talk-who">${esc(t('You'))}</span> · ${esc([...meta, status].filter(Boolean).join(' · '))}</div><div class="talk-text">${esc(m.text)}</div></div>`;
    }
    const asking = m.kind === 'request';
    const request = asking ? open.get(m.request) : null;
    // A question's options go under its text; "I did it" stays beside the agent's name.
    const button = request && !request.options?.length ? ` ${requestButtons(f.run, request, ' small')}` : '';
    const choices = request?.options?.length ? `<div class="talk-options">${requestWhy(request)}${requestButtons(f.run, request, ' small')}</div>` : '';
    const hint = !request ? '' : request.options?.length ? t('Choose an option, or write your answer below.') : t('Answer below: your message goes to the agent as the answer.');
    return `<div class="talk${asking ? ' request' : ''}"><div class="talk-head"><span class="talk-who">${esc(agentName(m.agent, f.project))}</span> · ${esc([...meta, asking ? t('asks for your help') : ''].filter(Boolean).join(' · '))}${button}</div><div class="talk-text">${esc(m.text)}</div>${choices}${hint ? `<div class="hint">${esc(hint)}</div>` : ''}</div>`;
  });
  const html = entries.join('') || `<div class="hint">${esc(t('Nothing yet. Write below: the agent pauses at a safe point, reads your message and goes on in the same session, on the same branch.'))}</div>`;
  if (draw('#agent-talk', JSON.stringify([f.run, f.talk.map(m => [m.id, m.status]), [...open.keys()]]), html)) $('#agent-talk').scrollTop = $('#agent-talk').scrollHeight;
}

async function pollAgent() {
  const id = agentPanel.run;
  if (!id || agentPanel.loading || document.hidden) return;
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
  stopDictation(area);
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
  if (enterSends(event)) {
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
  drawAway();
  drawFocus();
  drawAlerts();
  drawNavAttention();
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

let stateTag = null; // the tag of the last state read: an unchanged state answers 304, with no body

/** The state, or the one already here when it did not change. */
async function fetchState() {
  const r = await fetch('/api/state', { cache: 'no-store', headers: stateTag && state ? { 'if-none-match': stateTag } : {} });
  if (r.status === 304) return state;
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || t('Error {code}', { code: r.status }));
  stateTag = r.headers.get('etag');
  return data;
}

async function refresh() {
  let next;
  try {
    next = await fetchState();
  } catch {
    drawOffline();
    return;
  }
  const fresh = next !== state;
  if (!started) {
    await setLanguage(next.language);
    translatePage();
    drawPlaceholders();
    drawSuggestions();
    drawClock();
    started = true;
    // Focus mode as it was left, on the conversation only
    try {
      if (localStorage.getItem(FOCUS_KEY) && currentView() === 'manager') setFocusMode(true);
    } catch {
      // no storage
    }
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
  if (fresh && state.now) skew = new Date(state.now).getTime() - Date.now();
  $('#version').textContent = `Chiefmate ${state.version}`;
  drawPresence();
  drawAway();
  drawFocus();
  drawMics();
  drawAlerts();
  drawNavAttention();
  drawCounters();
  drawTitle();
  drawStatusbar();
  drawChat();
  drawDecisions();
  drawBridge();
  drawSituation();
  drawOperations();
  drawMissions();
  drawCrew();
  drawLog();
  drawUsage();
  drawAutopilot();
  drawComputer();
  drawPlan();
  drawPlanning();
  drawRadar();
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
  if (currentView() === 'session') drawSessionPage();
  tickClocks();
  if (currentView() === 'log') refreshDetail();
}

// ---------- Actions ----------

async function sendMessage(text) {
  const message = text.trim();
  if (!message) return;
  stopDictation($('#message'));
  try {
    const sent = await api('/api/manager', { message });
    $('#message').value = '';
    fitField($('#message'));
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
  if (enterSends(event)) {
    event.preventDefault();
    sendMessage($('#message').value);
  }
});

$('#live-form').addEventListener('submit', event => {
  event.preventDefault();
  sendLive();
});
$('#live-text').addEventListener('keydown', event => {
  if (enterSends(event)) {
    event.preventDefault();
    sendLive();
  }
});
$('#live-feed').addEventListener('toggle', event => {
  if (event.target.matches?.('[data-live-first]')) liveChat.firstOpen = event.target.open;
}, true);
$('#live-interrupt').addEventListener('click', async () => {
  $('#live-interrupt').disabled = true;
  try {
    await api('/api/session/interrupt', { id: liveChat.id });
    await pollLive();
  } catch (error) {
    toast(error.message);
  } finally {
    $('#live-interrupt').disabled = false;
  }
});
$('#live-body').addEventListener('click', async event => {
  const target = event.target.closest('[data-live-resume],[data-live-allow],[data-live-refuse],[data-live-unqueue]');
  if (!target || !liveChat.id) return;
  target.disabled = true;
  try {
    if (target.dataset.liveResume) {
      await api('/api/session/resume', { id: liveChat.id });
      toast(t('Session resumed: write to carry on.'));
    } else if (target.dataset.liveAllow || target.dataset.liveRefuse) {
      const allow = !!target.dataset.liveAllow;
      await api('/api/session/permission', { id: liveChat.id, request: target.dataset.liveAllow ?? target.dataset.liveRefuse, allow });
      toast(allow ? t('Allowed: the agent is told to go ahead.') : t('Refused. Tell the agent what to do instead, if you like.'));
    } else if (target.dataset.liveUnqueue) {
      await api('/api/session/queue/remove', { id: liveChat.id, item: target.dataset.liveUnqueue });
    }
    await pollLive();
    refresh();
  } catch (error) {
    toast(error.message);
    target.disabled = false;
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
  const target = event.target.closest('[data-run],[data-assign],[data-select],[data-cancel],[data-resume],[data-merge],[data-suggestion],[data-stop],[data-expand],[data-reset-used],[data-reset-remove],[data-reader],[data-autopilot],[data-needs-done],[data-needs-session],[data-attn-seen],[data-attn-more],[data-attn-archived],[data-context],[data-prompts-sync],[data-session-open],[data-session-end],[data-project-open],[data-project-dev],[data-project-planning],[data-project-task],[data-project-live],[data-charge-open]');
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
    } else if (target.dataset.chargeOpen) {
      // The conversation with the project's agent in charge: the one open (or the latest) carries on; else a new one.
      const id = target.dataset.chargeOpen;
      if (!state.charge?.[id]?.session) {
        target.disabled = true;
        await api('/api/session', { profile: state.charge[id].profile });
        await refresh();
      }
      location.hash = projectHash(id, 'charge');
      $('#live-text').focus();
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
    } else if (target.dataset.merge) {
      // The click is the owner's authorization: Chiefmate merges (src/merge.mjs).
      const m = await api('/api/merge', { run: target.dataset.merge, preview: true });
      const where = m.kind === 'pr' ? t('The pull request {address} is merged on GitHub.', { address: m.url }) : t('The branch {branch} is merged into {base} in {path}. Nothing is sent to GitHub.', { branch: m.branch, base: m.base, path: m.dir });
      const checks = m.failedChecks ? ` ${t('{count} check(s) failed.', { count: m.failedChecks })}` : '';
      if (!(await confirmDialog(t('Merge'), `${where}${checks}`, t('Merge')))) return;
      target.disabled = true;
      const done = await api('/api/merge', { run: target.dataset.merge });
      toast([t('Merged.'), done.copiesNote].filter(Boolean).join(' '));
      if (selectedRun === target.dataset.merge) await refreshDetail(true);
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
      const answer = target.dataset.answer ?? null;
      await api('/api/needs-you/done', { run: target.dataset.needsDone, id: target.dataset.request, answer });
      toast(answer ? t('Answer sent: {answer}. The crew goes on.', { answer }) : t('Marked as done. The crew goes on.'));
      if (selectedRun === target.dataset.needsDone) await refreshDetail(true);
    } else if (target.dataset.needsSession) {
      const permission = (state.needs ?? []).some(n => n.id === target.dataset.request && n.kind === 'permission');
      await api('/api/needs-you/done', { session: target.dataset.needsSession, id: target.dataset.request });
      toast(permission ? t('Allowed: the agent is told to go ahead.') : t('Marked as done. The session opens now.'));
    } else if (target.dataset.attnSeen) {
      await api('/api/attention/seen', { ids: target.dataset.attnSeen.split(' ') });
      await refresh();
    } else if (target.hasAttribute('data-attn-archived')) {
      const { items } = await api('/api/attention/archived');
      $('#archive-list').innerHTML = archiveHtml(items ?? []);
      $('#archive-dialog').showModal();
      return;
    } else if (target.hasAttribute('data-attn-more')) {
      attnOpen = !attnOpen;
      drawAlerts();
    } else if (target.dataset.sessionOpen) {
      target.disabled = true;
      const window = !!target.dataset.window;
      const session = await api('/api/session', { profile: target.dataset.sessionOpen, window });
      if (session.status === 'login') toast(t('Codex is not signed in: see the request at the top.'));
      else toast(window ? t('Session opened in a window of its own.') : session.existing ? t('This session was already open: here it is.') : t('Session opened here in the app.'));
      if (!window) location.hash = sessionHash(session);
    } else if (target.dataset.sessionEnd) {
      const x = allSessions().find(o => o.id === target.dataset.sessionEnd);
      const text = x?.mode === 'app'
        ? t('"{name}" ends, and anything the agent is doing stops. Its history stays here, and Resume carries on in the same conversation.', { name: x?.name ?? '' })
        : t('The window of "{name}" closes, and anything the agent is doing stops. The conversation itself stays in the history of the tool.', { name: x?.name ?? '' });
      const ok = await confirmDialog(t('End session'), text, t('End'));
      if (!ok) return;
      await api('/api/session/end', { id: target.dataset.sessionEnd });
      toast(t('Session ended.'));
      if (liveChat.id === target.dataset.sessionEnd) pollLive();
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
    } else if (target.dataset.autopilot) {
      const on = target.dataset.autopilot === 'on';
      await api('/api/autopilot', { enabled: on });
      toast(on ? t('Autopilot turned on.') : t('Autopilot turned off.'));
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

// ---------- The file viewer ----------
// Read only (src/files.mjs): images with zoom and a gallery, PDF in the browser's own reader, Markdown, text, and CSV
// or XLSX as a table; any other file shows only its facts. It opens from the paths in texts (fileLink), from a run's
// Files and from a project's Files tab. A reference is { path } on the disk or { run, file } in a run's branch, with
// "run" and "project" as the places to look for a relative path.

const viewer = { info: null, gallery: [], index: -1, zoom: false, sheet: 0, token: 0 };
const fileUrl = (what, ref, extra = {}) =>
  `/api/files/${what}?${new URLSearchParams(Object.entries({ ...ref, ...extra }).filter(([k, v]) => ['path', 'run', 'file', 'project', 'sheet'].includes(k) && v !== undefined && v !== null && v !== ''))}`;
const sameRef = (a, b) => (a.file ? a.run === b.run && a.file === b.file : !b.file && String(a.path ?? '').toLowerCase() === String(b.path ?? '').toLowerCase());
const baseName = p => String(p ?? '').split(/[\\/]/).pop();
// Opened in a tab or downloaded: what the browser can't show safely goes as a download (see rawHeaders in src/files.mjs).
const downloads = info => ['table', 'other'].includes(info.kind) || /\.(html?|xml|svg)$/i.test(info.name);

function fileSize(n) {
  if (n === null || n === undefined) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${Math.round(n / 1024).toLocaleString(locale())} KB`;
  return `${(n / 1024 ** 2).toLocaleString(locale(), { maximumFractionDigits: 1 })} MB`;
}

async function openFile(ref, { gallery = null } = {}) {
  const token = ++viewer.token;
  let info;
  try {
    info = await api(fileUrl('info', ref));
  } catch (error) {
    toast(error.message);
    return;
  }
  if (token !== viewer.token) return;
  const list = gallery ?? (info.gallery ?? []).map(g => ({ path: g.path, name: g.name }));
  const index = list.findIndex(g => sameRef(g, info.ref));
  Object.assign(viewer, { info, zoom: false, sheet: 0, gallery: index < 0 ? [] : list, index });
  if (!$('#viewer').open) $('#viewer').showModal();
  drawViewer(token);
}

function stepGallery(by) {
  const { gallery, index } = viewer;
  if (gallery.length < 2) return;
  openFile(gallery[(index + by + gallery.length) % gallery.length], { gallery });
}

function drawViewer(token = viewer.token) {
  const { info } = viewer;
  const raw = fileUrl('raw', info.ref);
  $('#viewer-name').textContent = info.name;
  $('#viewer-name').title = info.ref.path ?? info.ref.file;
  // The copy a relative path was found in: the newest, when several copies of the project have it (src/files.mjs).
  const from = info.from ? (info.copies > 1 ? t('from {place}, the newest of {count} copies', { place: info.from.name, count: info.copies }) : t('from {place}', { place: info.from.name })) : '';
  $('#viewer-facts').textContent = [viewer.gallery.length > 1 ? `${viewer.index + 1} / ${viewer.gallery.length}` : '', fileSize(info.size), info.mtime ? shortDate(info.mtime) : '', from]
    .filter(Boolean).join(' · ');
  $('#viewer-tools').innerHTML = [
    info.kind === 'image' ? `<button type="button" class="button secondary small" data-viewer="zoom" aria-pressed="${viewer.zoom}">${esc(viewer.zoom ? t('Fit to screen') : t('Actual size'))}</button>` : '',
    info.dir ? '' : `<a class="button secondary small" href="${esc(raw)}" target="_blank" rel="noopener"${downloads(info) ? ' download' : ''}>${esc(downloads(info) ? t('Download') : t('Open in a tab'))}</a>`,
  ].join('');
  const body = $('#viewer-body');
  body.dataset.kind = info.kind;
  body.scrollTop = 0;
  const loading = `<div class="empty">${esc(t('Loading…'))}</div>`;
  const failed = error => token === viewer.token && (body.innerHTML = `<div class="empty">${esc(error.message)}</div>`);
  if (info.dir) {
    body.innerHTML = loading;
    api(fileUrl('list', { path: info.ref.path })).then(data => token === viewer.token && (body.innerHTML = folderHtml(data, true)), failed);
  } else if (info.kind === 'image') {
    const nav = viewer.gallery.length > 1
      ? `<button type="button" class="viewer-nav prev" data-viewer="prev" aria-label="${esc(t('Previous'))}">‹</button><button type="button" class="viewer-nav next" data-viewer="next" aria-label="${esc(t('Next'))}">›</button>`
      : '';
    body.innerHTML = `<div class="viewer-stage${viewer.zoom ? ' zoomed' : ''}"><img src="${esc(raw)}" alt="${esc(info.name)}" data-viewer="zoom"></div>${nav}`;
  } else if (info.kind === 'pdf') {
    // Phones have no PDF reader inside a page: the PDF opens in a tab of its own.
    body.innerHTML = touchScreen()
      ? `<div class="empty"><a class="button" href="${esc(raw)}" target="_blank" rel="noopener">${esc(t('Open the PDF'))}</a></div>`
      : `<iframe class="viewer-pdf" src="${esc(raw)}" title="${esc(info.name)}"></iframe>`;
  } else if (info.kind === 'markdown' || info.kind === 'text') {
    body.innerHTML = loading;
    api(fileUrl('text', info.ref)).then(data => {
      if (token !== viewer.token) return;
      const note = data.truncated ? `<p class="hint viewer-note">${esc(t('Only the beginning of this file is shown.'))}</p>` : '';
      body.innerHTML = note + (info.kind === 'markdown' ? `<div class="viewer-doc body">${md(data.text)}</div>` : `<pre class="viewer-text">${esc(data.text)}</pre>`);
    }, failed);
  } else if (info.kind === 'table') {
    body.innerHTML = loading;
    api(fileUrl('table', info.ref, { sheet: viewer.sheet })).then(data => token === viewer.token && (body.innerHTML = tableHtml(data)), failed);
  } else {
    body.innerHTML = `<div class="empty">${esc(t('This kind of file is not shown here.'))}<br><span class="hint">${esc(info.ref.path ?? info.ref.file)}</span></div>`;
  }
}

/** A table's preview: the sheets as tabs, the first row as the fixed header, a note when only the first rows are shown. */
function tableHtml(data) {
  const tabs = data.sheets.length > 1
    ? `<div class="tabs viewer-sheets">${data.sheets.map((s, i) => `<button type="button" class="tab${i === data.sheet ? ' active' : ''}" data-viewer-sheet="${i}">${esc(s)}</button>`).join('')}</div>`
    : '';
  if (!data.rows.length) return `${tabs}<div class="empty">${esc(t('This table is empty.'))}</div>`;
  const width = Math.max(1, ...data.rows.map(r => r.length));
  const [head, ...rows] = data.rows;
  const cells = (r, tag) => Array.from({ length: width }, (_, i) => `<${tag}>${esc(r[i] ?? '')}</${tag}>`).join('');
  const note = data.truncated ? `<p class="hint viewer-note">${esc(t('Showing the first {shown} of {total} rows.', { shown: data.rows.length, total: data.total }))}</p>` : '';
  return `${tabs}${note}<div class="viewer-table"><table><thead><tr><th class="num">1</th>${cells(head, 'th')}</tr></thead><tbody>${rows.map((r, i) => `<tr><td class="num">${i + 2}</td>${cells(r, 'td')}</tr>`).join('')}</tbody></table></div>`;
}

/** A folder's list: up to its parent, then its folders and files (images with a thumbnail). inViewer: inside the viewer. */
function folderHtml(data, inViewer = false) {
  const up = data.parent ? `<li><button type="button" class="file-row" data-folder="${esc(data.parent)}"><span class="file-icon">↑</span><span>${esc(t('Up one folder'))}</span></button></li>` : '';
  const rows = data.entries.map(e => `<li><button type="button" class="file-row" ${e.dir ? 'data-folder' : 'data-file-path'}="${esc(e.path)}">
      <span class="file-icon">${e.kind === 'image' ? `<img loading="lazy" src="${esc(fileUrl('raw', { path: e.path }))}" alt="">` : e.dir ? '▸' : ''}</span>
      <span class="file-name">${esc(e.name)}</span><span class="hint num">${e.dir ? '' : esc(fileSize(e.size))}</span><span class="hint num file-date">${esc(shortDate(e.mtime))}</span>
    </button></li>`).join('');
  const empty = data.entries.length ? '' : `<li class="empty">${esc(t('This folder is empty.'))}</li>`;
  const more = data.more ? `<li class="hint">${esc(t('Only the first {count} items are listed.', { count: data.entries.length }))}</li>` : '';
  return `<ul class="file-browser${inViewer ? ' in-viewer' : ''}">${up}${rows}${empty}${more}</ul>`;
}

// What a run created or changed, by run: { at, status, data, loading }. Read again when its status changes, and every
// 30 seconds while it goes on.
const runFilesCache = new Map();

async function loadRunFiles(r) {
  const entry = runFilesCache.get(r.id) ?? {};
  runFilesCache.set(r.id, Object.assign(entry, { loading: true }));
  try {
    entry.data = await api(`/api/files/run/${encodeURIComponent(r.id)}`);
  } catch {
    entry.data = null;
  }
  Object.assign(entry, { at: Date.now(), status: r.status, loading: false });
  if (selectedRun === r.id) refreshDetail();
}

const fileStatus = s => (s === 'A' ? [t('new'), 'ok'] : s === 'D' ? [t('deleted'), 'error'] : [t('changed'), 'info']);

/** A run's Files: thumbnails of its images, then every file it created or changed, each opening the viewer. */
function runFilesHtml(r) {
  const c = runFilesCache.get(r.id);
  if (!c?.loading && (!c?.at || c.status !== r.status || (r.status === 'running' && Date.now() - c.at > 30_000))) loadRunFiles(r);
  const files = c?.data?.files ?? [];
  if (!files.length) return '';
  const images = files.filter(f => f.kind === 'image' && f.status !== 'D');
  const thumbs = images.length
    ? `<div class="file-thumbs">${images.slice(0, 12).map(f => `<button type="button" class="file-thumb" data-run-file="${esc(f.file)}" title="${esc(f.file)}"><img loading="lazy" src="${esc(fileUrl('raw', { run: r.id, file: f.file }))}" alt="${esc(baseName(f.file))}"></button>`).join('')}</div>`
    : '';
  const row = f => {
    const name = f.status === 'D' ? `<span class="secondary">${esc(f.file)}</span>` : `<a class="file-link" role="button" tabindex="0" data-run-file="${esc(f.file)}">${esc(f.file)}</a>`;
    return `<li>${stateHtml(fileStatus(f.status))} ${name} <span class="hint num">${esc(fileSize(f.size))}</span></li>`;
  };
  const shown = files.slice(0, 15).map(row).join('');
  const rest = files.length > 15 ? `<details><summary>${esc(t('{count} more', { count: files.length - 15 }))}</summary><ul class="file-list">${files.slice(15).map(row).join('')}</ul></details>` : '';
  const more = c.data.more ? `<p class="hint">${esc(t('Only the first {count} files are listed.', { count: files.length }))}</p>` : '';
  return `<div class="report run-files"><div class="report-top"><strong>${esc(t('Files'))}</strong><span class="hint">${esc(t('{count} created or changed by this run', { count: files.length }))}</span></div>${thumbs}<ul class="file-list">${shown}</ul>${rest}${more}</div>`;
}

const runImages = run => (runFilesCache.get(run)?.data?.files ?? []).filter(f => f.kind === 'image' && f.status !== 'D').map(f => ({ run, file: f.file, name: baseName(f.file) }));

// A project's Files tab: its folders (the crew's working copy, your clone), the libraries and the extra folders.
const browser = { project: null, roots: null, data: null, error: null };
const rootLabel = r => (r.kind === 'workspace' ? t("Crew's working copy") : r.kind === 'clone' ? t('Your clone') : r.kind === 'library' ? t('Libraries') : r.label);

async function browseTo(target) {
  const id = browser.project;
  try {
    browser.roots ??= (await api(`/api/files/roots?project=${encodeURIComponent(id)}`)).roots;
    const where = target ?? browser.roots[0]?.path;
    browser.data = where ? await api(fileUrl('list', { path: where })) : null;
    browser.error = null;
  } catch (error) {
    browser.error = error.message;
  }
  if (browser.project === id && pageProject() === id) drawProjectFiles(id);
}

function drawProjectFiles(id) {
  if (browser.project !== id) {
    Object.assign(browser, { project: id, roots: null, data: null, error: null });
    browseTo();
  }
  const { roots, data, error } = browser;
  const choices = (roots ?? []).map(r => `<button type="button" class="tab${data && data.root.path === r.path ? ' active' : ''}" data-browse-root="${esc(r.path)}" title="${esc(r.path)}">${esc(rootLabel(r))}</button>`).join('');
  // Where the list is, from its root: each folder on the way opens with a click.
  let crumbs = '';
  if (data) {
    const rel = data.path.slice(data.root.path.length).split(/[\\/]/).filter(Boolean);
    const sep = data.root.path.includes('\\') ? '\\' : '/';
    const at = i => data.root.path.replace(/[\\/]$/, '') + rel.slice(0, i).map(x => sep + x).join('');
    crumbs = `<div class="file-crumbs hint">${[`<button type="button" class="link-button" data-folder="${esc(data.root.path)}">${esc(rootLabel(data.root))}</button>`,
      ...rel.map((name, i) => `<button type="button" class="link-button" data-folder="${esc(at(i + 1))}">${esc(name)}</button>`)].join(' / ')}</div>`;
  }
  const html = `<div class="panel">
      <div class="label">${esc(t('Files'))}</div>
      <p class="hint">${esc(t('Read only: open images, PDFs, tables and texts. Private files (.env, keys, .git) never show.'))}</p>
      ${roots && !roots.length ? `<div class="empty">${esc(t('No folder of this project on this computer yet.'))}</div>` : ''}
      ${choices ? `<div class="tabs file-roots">${choices}</div>` : ''}
      ${error ? `<div class="empty">${esc(error)}</div>` : data ? `${crumbs}${folderHtml(data)}` : roots?.length !== 0 ? `<div class="empty">${esc(t('Loading…'))}</div>` : ''}
    </div>`;
  draw('#project-files', html, html);
}

document.addEventListener('click', event => {
  const el = event.target.closest('.file-link, [data-run-file], [data-folder], [data-file-path], [data-viewer], [data-viewer-sheet], [data-browse-root]');
  if (!el) return;
  event.preventDefault();
  const inViewer = !!el.closest('#viewer');
  if (el.dataset.viewer === 'prev' || el.dataset.viewer === 'next') stepGallery(el.dataset.viewer === 'next' ? 1 : -1);
  else if (el.dataset.viewer === 'zoom') {
    // Without drawing again: the image is not read a second time.
    viewer.zoom = !viewer.zoom;
    $('.viewer-stage')?.classList.toggle('zoomed', viewer.zoom);
    const button = $('#viewer-tools [data-viewer="zoom"]');
    button.textContent = viewer.zoom ? t('Fit to screen') : t('Actual size');
    button.setAttribute('aria-pressed', String(viewer.zoom));
  } else if (el.dataset.viewerSheet) {
    viewer.sheet = Number(el.dataset.viewerSheet);
    drawViewer();
  } else if (el.dataset.browseRoot) browseTo(el.dataset.browseRoot);
  else if (el.dataset.folder) {
    if (inViewer) openFile({ path: el.dataset.folder });
    else browseTo(el.dataset.folder);
  } else if (el.dataset.filePath) {
    const images = [...el.closest('.file-browser').querySelectorAll('[data-file-path]')].map(b => b.dataset.filePath).filter(p => /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i.test(p));
    openFile({ path: el.dataset.filePath }, { gallery: images.includes(el.dataset.filePath) ? images.map(p => ({ path: p, name: baseName(p) })) : null });
  } else if (el.dataset.runFile) {
    const run = el.closest('[data-files-run]')?.dataset.filesRun;
    const gallery = runImages(run);
    openFile({ run, file: el.dataset.runFile }, { gallery: gallery.some(g => g.file === el.dataset.runFile) ? gallery : null });
  } else if (el.dataset.file) {
    // A path in a text: looked for in the run or the project the text belongs to, if any.
    openFile({ path: el.dataset.file, run: el.closest('[data-files-run]')?.dataset.filesRun, project: el.closest('[data-files-project]')?.dataset.filesProject });
  }
});
document.addEventListener('keydown', event => {
  if (event.key === 'Enter' && event.target.matches?.('.file-link')) event.target.click();
  if (!$('#viewer').open) return;
  if (event.key === 'ArrowRight') stepGallery(1);
  if (event.key === 'ArrowLeft') stepGallery(-1);
});
$('#viewer-close').addEventListener('click', () => $('#viewer').close());
$('#viewer').addEventListener('close', () => {
  viewer.token++;
  $('#viewer-body').innerHTML = ''; // stops a PDF or a large image from staying in memory
});
// Phones: a swipe to the side goes to the next or previous image.
{
  let from = null;
  $('#viewer-body').addEventListener('touchstart', event => {
    from = event.touches.length === 1 && !viewer.zoom ? { x: event.touches[0].clientX, y: event.touches[0].clientY } : null;
  }, { passive: true });
  $('#viewer-body').addEventListener('touchend', event => {
    if (!from || viewer.info?.kind !== 'image') return;
    const dx = event.changedTouches[0].clientX - from.x;
    const dy = event.changedTouches[0].clientY - from.y;
    from = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) stepGallery(dx < 0 ? 1 : -1);
  }, { passive: true });
}

$('#nav-more').addEventListener('click', () => setNavMore(!$('.nav').classList.contains('open')));
document.addEventListener('click', event => {
  if ($('.nav').classList.contains('open') && (!event.target.closest('.nav') || event.target.closest('.nav a'))) setNavMore(false);
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && $('.nav').classList.contains('open')) setNavMore(false);
});

// Phones: the app fits the visible area (above the on-screen keyboard too), and the conversations take the height
// of their screen (--view-h). With the keyboard open over a field, the app is in typing mode: the bottom bar and the
// notices step aside (html.typing); in a conversation, so do the headers and the decisions, leaving its last messages
// and the field (html.typing-chat). The keyboard is open when the visible area is well shorter than the screen.
const root = document.documentElement;
const typingField = el => !!el?.matches?.('textarea, input:not([type=checkbox], [type=radio], [type=button], [type=submit], [type=range], [type=file])');
const screenSize = { width: 0, height: 0 }; // the tallest visible area seen at this width: the screen without the keyboard
function keyboardOpen() {
  if (!window.visualViewport) return true; // no way to tell: the focus decides
  if (innerWidth !== screenSize.width) Object.assign(screenSize, { width: innerWidth, height: 0 });
  const visible = visualViewport.height * visualViewport.scale;
  screenSize.height = Math.max(screenSize.height, innerHeight, visible);
  return screenSize.height - visible > 120;
}
let typingFrom = null; // the screen and its scroll before typing in a conversation, given back after
function fitTyping() {
  const field = document.activeElement;
  const typing = touchScreen() && typingField(field) && keyboardOpen();
  const chat = typing && !!field.closest('.chat-column');
  if (root.classList.contains('typing') === typing && root.classList.contains('typing-chat') === chat) return;
  const view = $('.view.active');
  if (chat && !typingFrom) typingFrom = { view, top: view.scrollTop };
  root.classList.toggle('typing', typing);
  root.classList.toggle('typing-chat', chat);
  for (const area of [$('#message'), $('#live-text')]) fitField(area);
  root.style.setProperty('--view-h', `${Math.round($('.content').clientHeight)}px`); // now, not a frame later
  if (chat) view.scrollTop = 0;
  else if (typingFrom) {
    if (typingFrom.view === view) view.scrollTop = typingFrom.top;
    typingFrom = null;
  }
}
if (window.visualViewport) {
  const fit = () => {
    if (visualViewport.scale > 1.01) return; // zoomed in by the owner: leave the layout as it is
    root.style.setProperty('--app-h', `${Math.round(visualViewport.height)}px`);
    if (scrollY) scrollTo(0, 0);
    fitTyping();
  };
  visualViewport.addEventListener('resize', fit);
  fit();
}
new ResizeObserver(([entry]) => root.style.setProperty('--view-h', `${Math.round(entry.contentRect.height)}px`)).observe($('.content'));
document.addEventListener('focusin', fitTyping);
document.addEventListener('focusout', () => setTimeout(fitTyping, 0));

// A conversation whose box changes height (the keyboard, the field growing) keeps the same last line in view.
const feedBottoms = new WeakMap();
const keepBottom = new ResizeObserver(entries => {
  for (const { target: feed } of entries) {
    const was = feedBottoms.get(feed);
    if (!feed.clientHeight) continue; // hidden with its screen
    if (was?.height !== feed.clientHeight) feed.scrollTop = feed.scrollHeight - feed.clientHeight - (was?.below ?? 0);
  }
});
for (const feed of [$('#chat'), $('#live-feed')]) {
  // How far the last line seen is from the end, and the box's height then
  const remember = () => feed.clientHeight && feedBottoms.set(feed, { below: feed.scrollHeight - feed.scrollTop - feed.clientHeight, height: feed.clientHeight });
  feed.addEventListener('scroll', remember, { passive: true });
  keepBottom.observe(feed);
}

/** Phones: a conversation's field grows with its text up to five lines (its max-height), then scrolls inside. */
function fitField(area) {
  area.style.height = '';
  if (phoneQuery.matches && area.scrollHeight > area.clientHeight) area.style.height = `${area.scrollHeight + area.offsetHeight - area.clientHeight}px`;
}
for (const area of [$('#message'), $('#live-text')]) area.addEventListener('input', () => fitField(area));
// While typing, Send doesn't take the focus: the keyboard stays open for the next message.
for (const button of [$('#send'), $('#live-send')]) button.addEventListener('mousedown', event => root.classList.contains('typing') && event.preventDefault());

// ---------- Dictation ----------
// A microphone by each message field (ui/voice.js): one tap listens, another stops, a silence stops it too.
// The browser's own voice service transcribes, so the first use says so once; "ui.voice_input": false hides it.
const Recognition = recognizer(window);
const VOICE_NOTICE_KEY = 'chiefmate.voice-notice';
const MIC_ICON = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="5.5" y="1.5" width="5" height="8.5" rx="2.5"/><path d="M3 7.5a5 5 0 0 0 10 0M8 12.5V15M5.5 15h5"/></svg>';
const dictations = new Map(); // field → { button, dictation }
const voiceOn = () => !!Recognition && state?.ui?.voice_input !== false;
const voiceError = code => ({
  'not-allowed': t('The microphone is blocked for this page. Allow it in the browser to dictate.'),
  'service-not-allowed': t('The microphone is blocked for this page. Allow it in the browser to dictate.'),
  'audio-capture': t('No microphone was found.'),
  network: t("The browser's voice service didn't answer. Dictation needs the internet."),
  'no-speech': t('Nothing was heard.'),
  'language-not-supported': t("The browser's voice service doesn't have this language."),
})[code] ?? t('Dictation stopped ({error}).', { error: code });

function drawMic(field) {
  const { button, dictation } = dictations.get(field);
  const on = dictation?.listening ?? false;
  button.hidden = !voiceOn();
  button.setAttribute('aria-pressed', String(on));
  button.setAttribute('aria-label', on ? t('Stop dictating') : t('Dictate'));
  button.title = on ? t('Stop dictating (Ctrl+M)') : t('Dictate (Ctrl+M)');
  button.querySelector('.mic-state').textContent = on ? t('Listening…') : '';
}

/** Called on every refresh: the buttons follow the setting, and a dictation stops when it is turned off. */
function drawMics() {
  for (const [field, { dictation }] of dictations) {
    if (!voiceOn()) dictation?.abort();
    drawMic(field);
  }
}

function stopDictation(field) {
  dictations.get(field)?.dictation?.abort();
}

/** The first use only: the browser's voice service transcribes the audio. Dictate, cancel or turn dictation off. */
async function voiceNoticeAccepted() {
  try {
    if (localStorage.getItem(VOICE_NOTICE_KEY)) return true;
  } catch {
    // no storage: asked every time
  }
  const dialog = $('#voice-notice');
  dialog.returnValue = '';
  dialog.showModal();
  const answer = await new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true }));
  if (answer === 'off') {
    try {
      state.ui = (await api('/api/voice-input', { enabled: false })).ui;
      drawMics();
      toast(t('Dictation is off. To turn it back on: "ui": { "voice_input": true } in config/chiefmate.json.'));
    } catch (error) {
      toast(error.message);
    }
    return false;
  }
  if (answer !== 'yes') return false;
  try {
    localStorage.setItem(VOICE_NOTICE_KEY, '1');
  } catch {
    // no storage
  }
  return true;
}

async function toggleDictation(field) {
  const entry = dictations.get(field);
  if (entry.dictation?.listening) return entry.dictation.stop();
  if (!voiceOn() || entry.dictation?.state === 'stopping' || !(await voiceNoticeAccepted())) return;
  for (const other of dictations.keys()) if (other !== field) stopDictation(other);
  const dictation = new Dictation({
    Recognition,
    field,
    lang: locale(),
    // Phones end on their own at a pause, and repeat words when kept listening
    continuous: !touchScreen(),
    onState: next => {
      drawMic(field);
      // Stopped by the owner or a silence: back to the field, ready to review (not on a phone: that opens the keyboard)
      if (next === 'idle' && !dictation.aborted && !touchScreen()) field.focus();
    },
    onError: code => toast(voiceError(code)),
  });
  entry.dictation = dictation;
  dictation.start();
}

for (const [field, place] of [[$('#message'), $('#send')], [$('#live-text'), $('#live-send')], [$('#agent-form').text, $('#agent-form button[type=submit]')]]) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'button secondary mic';
  button.innerHTML = `${MIC_ICON}<span class="mic-state" aria-hidden="true"></span>`;
  button.hidden = true;
  place.before(button);
  dictations.set(field, { button, dictation: null });
  button.addEventListener('mousedown', event => event.preventDefault()); // the field keeps its focus and caret
  button.addEventListener('click', () => toggleDictation(field));
}
// Ctrl+M in a message field starts or stops its dictation; anywhere else, it stops the one listening.
document.addEventListener('keydown', event => {
  if (!event.ctrlKey || event.altKey || event.shiftKey || event.metaKey || event.key.toLowerCase() !== 'm' || !voiceOn()) return;
  const field = dictations.has(event.target) ? event.target : [...dictations].find(([, d]) => d.dictation?.listening)?.[0];
  if (!field) return;
  event.preventDefault();
  toggleDictation(field);
});
// Another page: the dictation stops there
window.addEventListener('hashchange', () => dictations.forEach((d, field) => stopDictation(field)));

showView();
drawClock();
setInterval(drawClock, 15_000);
setInterval(tickClocks, 1000);
refresh();
// With the tab hidden (or the phone's screen off), the state is read once a minute, enough for the title and the
// app's badge; the open conversation and agent panel wait. Back in view, everything is read at once.
let lastRefresh = Date.now();
setInterval(() => {
  if (document.hidden && Date.now() - lastRefresh < 60_000) return;
  lastRefresh = Date.now();
  refresh();
}, 2500);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  lastRefresh = Date.now();
  refresh();
  pollLive();
  pollAgent();
});
