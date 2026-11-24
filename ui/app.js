// The Chiefmate app: fetches the state every 2.5 seconds and redraws only what changed.
import { face } from './faces.js';
import { language, locale, setLanguage, t, translatePage } from './i18n.js';

const $ = selector => document.querySelector(selector);
let state = null;
let online = false;
let started = false;
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

// ---------- The crew ----------

const FALLBACK_MANAGER = { id: 'manager', name: 'Chiefmate', title: 'Manager', color: '#c9a45d', face: 'cap', status: 'idle' };
const member = id => state?.crew.find(a => a.id === id) ?? (id === 'manager' ? FALLBACK_MANAGER : { id, name: id });
const agentName = id => t(member(id).name ?? id);
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

// ---------- Navigation ----------

const VIEWS = ['manager', 'operations', 'missions', 'crew', 'log', 'usage'];
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
  else if (state.current) [text, kind, look] = [t('On duty: {title}', { title: state.current.title }), 'info', 'working'];
  else if (state.manager.responding) [text, kind, look] = [t('Thinking…'), 'info', 'thinking'];
  else [text, kind, look] = [t('Online · waiting for you'), 'ok', 'idle'];
  const html = `${face(manager, look, 22, text)}${stateHtml([text, kind])}`;
  draw('#presence', html, html);
}

function drawCounters() {
  const a = state.current;
  draw('#counter-operations', `${!!a}-${state.queue.length}`, a ? '●' : state.queue.length ? String(state.queue.length) : '');
  draw('#counter-manager', String(state.manager.responding), state.manager.responding ? '…' : '');
}

function drawStatusbar() {
  if (!online) {
    draw('#statusbar', 'off', `<div class="group">${stateHtml([t('No connection to Chiefmate. Trying again…'), 'error'])}</div>`);
    return;
  }
  const a = state.current;
  const { account } = state.usage;
  let left;
  if (a) left = stateHtml([t('{title}: {agent} (step {n} of {total})', { title: a.title, agent: a.agent ? agentName(a.agent) : t('preparing'), n: a.step ?? 1, total: a.steps.length }), 'info']);
  else if (state.queue.some(r => r.status === 'waiting')) left = stateHtml([t("Waiting for the account's limit to reset"), 'warn']);
  else if (state.queue.length) left = stateHtml([t('{count} in the queue', { count: state.queue.length }), 'info']);
  else left = stateHtml([t('Idle'), 'ok']);
  const claude = state.ai.claude;
  const right = [
    claude.found ? `Claude Code <span class="num">${esc(claude.version ?? '')}</span>` : esc(claude.found === false ? t('Claude Code not found') : t('Checking Claude Code…')),
    `${esc(t('5-hour window'))} <span class="num">${percent(account.five_hour?.used)}</span>`,
    `${esc(t("Plan's week"))} <span class="num">${percent(account.seven_day?.used)}</span>`,
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
    const meta = [clockTime(m.at), m.model ? shortModel(m.model) : ''].filter(Boolean).join(' · ');
    html += `<div class="msg ${you ? 'you' : 'manager'}${m.error ? ' error' : ''}"><div class="msg-head">${you ? '' : face(manager, m.error ? 'failed' : 'still', 20)}<span class="msg-author">${esc(you ? t('You') : t(manager.name))}</span><span class="msg-meta">${esc(meta)}</span></div><div class="msg-body">${md(m.text)}</div></div>`;
  }
  if (g.responding) {
    html += `<div class="msg manager typing"><div class="msg-head">${face(manager, 'thinking', 20)}<span class="msg-author">${esc(t(manager.name))}</span><span class="msg-meta">${esc(t('answering…'))}</span></div><div class="msg-body">${g.partial ? md(g.partial) : `<span class="hint">${esc(t('Looking at the situation…'))}</span>`}</div>${g.actions.length ? `<div class="manager-actions">${g.actions.slice(-4).map(esc).join('<br>')}</div>` : ''}</div>`;
  }
  const signature = JSON.stringify([g.messages.length, g.messages.at(-1)?.at, g.responding, g.partial, g.actions.length]);
  if (draw('#chat', signature, html) && (atBottom || !chatScrolled)) {
    box.scrollTop = box.scrollHeight;
    chatScrolled = true;
  }
  $('#send').disabled = g.responding || !online;
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
  const a = state.current;
  const { account } = state.usage;
  const next = nextMission();
  const html = `
    <div class="label">${esc(t('Situation'))}</div>
    <div class="block"><div class="hint">${esc(t('Operations'))}</div><div class="value">${a ? `${esc(a.title)}<br><span class="hint">${esc(a.agent ? agentName(a.agent) : t('preparing'))}, ${esc(t('step {n} of {total}', { n: a.step ?? 1, total: a.steps.length }))}</span>` : esc(t('Nothing running'))}</div></div>
    <div class="block"><div class="hint">${esc(t('Queue'))}</div><div class="value">${state.queue.length ? esc(t('{count} run(s)', { count: state.queue.length })) : esc(t('Empty'))}</div></div>
    <div class="block"><div class="hint">${esc(t('Next scheduled mission'))}</div><div class="value">${next ? `${esc(next.name)}<br><span class="num hint">${shortDate(next.next)} (${esc(relative(next.next))})</span>` : esc(t('None'))}</div></div>
    <div class="block">${meter(t('Account, 5-hour window'), account.five_hour?.used, percent(account.five_hour?.used))}${meter(t("Plan's week"), account.seven_day?.used, percent(account.seven_day?.used))}</div>`;
  draw('#situation', JSON.stringify([a?.id, a?.step, state.queue.length, next?.next, account.updated, Math.floor(Date.now() / 60000)]), html);
}

// ---------- Operations ----------

function queueTable() {
  if (!state.queue.length) return '';
  return `<div class="label" style="margin-top:24px">${esc(t('Queue'))}</div>
    <table class="table"><thead><tr><th>${esc(t('Run'))}</th><th>${esc(t('Status'))}</th><th>${esc(t('Expected start'))}</th><th></th></tr></thead><tbody>
    ${state.queue.map(r => `<tr><td><span class="primary">${esc(r.title)}</span>${r.note ? `<span class="secondary">${esc(r.note)}</span>` : ''}</td><td>${stateHtml(runState(r.status))}</td><td class="num">${r.notBefore ? `${shortDate(r.notBefore)} (${esc(relative(r.notBefore))})` : esc(t('in a moment'))}</td><td><button type="button" class="button danger small" data-cancel="${esc(r.id)}">${esc(t('Cancel'))}</button></td></tr>`).join('')}
    </tbody></table>`;
}

function drawOperations() {
  const a = state.current;
  const minute = Math.floor(Date.now() / 60000);
  const next = nextMission();
  if (!a) {
    const crewLine = state.crew.map(x => `<span class="crew-chip">${face(x, faceState(x), 26, t(x.name))}<span class="hint">${esc(t(x.name))}</span></span>`).join('');
    const nextLine = next ? `<div class="hint">${esc(t('Next scheduled mission: {name}, {when} ({relative}).', { name: next.name, when: shortDate(next.next), relative: relative(next.next) }))}</div>` : '';
    const html = `<div class="panel"><div class="empty">${esc(t('Nothing running. The crew is standing by.'))}</div>${nextLine}<div class="crew-line" style="margin-top:14px">${crewLine}</div></div>${queueTable()}`;
    draw('#operations', JSON.stringify(['idle', online, state.crew.map(x => x.status), state.queue.map(r => [r.id, r.status, r.notBefore]), next?.next, minute]), html);
    return;
  }
  const before = $('#logbook');
  const atBottom = !before || before.scrollHeight - before.scrollTop - before.clientHeight < 60;
  const working = a.agent ? member(a.agent) : null;
  const steps = a.steps.map((s, i) => `<li>${face(member(s.agent), online ? stepFace(s) : 'offline', 30)}<div><div class="name">${i + 1}. ${esc(agentName(s.agent))}${s.review ? `, ${esc(t('review'))}` : ''}</div><div class="hint">${esc(runState(s.status)[0])}${s.status === 'running' ? ` · ${esc(elapsed(a.stepStarted))}` : ''}</div></div></li>`);
  const lines = a.actions.map(p => `<div><time>${clockTime(p.at)}</time><span class="${p.type === 'say' ? 'say' : ''}">${esc(p.text)}</span></div>`);
  const html = `
    <div class="summary-row">
      <div>${esc(t('Run'))}<strong>${esc(a.title)}</strong></div>
      <div>${esc(t('Project'))}<strong>${esc(projectName(a.project))}</strong></div>
      <div>${esc(t('Started'))}<strong class="num">${shortDate(a.started)}</strong></div>
      <div>${esc(t('Elapsed'))}<strong class="num">${esc(elapsed(a.started))}</strong></div>
      <div>${esc(t('Steps done'))}<strong class="num">${a.steps.filter(s => s.status === 'done').length} / ${a.steps.length}</strong></div>
    </div>
    <div class="operations-grid">
      <div class="panel">
        <div class="label">${esc(t('Steps'))}</div>
        <ol class="steps">${steps.join('')}</ol>
        <div class="actions"><button type="button" class="button danger small" data-cancel="${esc(a.id)}">${esc(t('Cancel run'))}</button></div>
      </div>
      <div>
        <div class="logbook-head">${working ? face(working, faceState(working), 28) : ''}<div class="label">${esc(working ? t('Logbook: {agent} at work', { agent: t(working.name) }) : t('Logbook: preparing the working copy'))}</div></div>
        <div class="logbook" id="logbook">${lines.join('') || `<div><time></time><span>${esc(t('Preparing…'))}</span></div>`}</div>
      </div>
    </div>${queueTable()}`;
  const changed = draw('#operations', JSON.stringify([online, a.id, a.step, a.agent, a.actions.length, a.steps.map(s => s.status), state.queue.map(r => [r.id, r.status]), minute]), html);
  const logbook = $('#logbook');
  if (changed && logbook && atBottom) logbook.scrollTop = logbook.scrollHeight;
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
        <dt>${esc(t('Crew, in order'))}</dt><dd><div class="crew-line">${m.crew.map(id => `<span class="crew-chip">${face(member(id), 'still', 22)}${esc(agentName(id))}</span>`).join('<span class="arrow">→</span>')}</div></dd>
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
  const agentSelect = $('#task-agent');
  if (!agentSelect.options.length) {
    agentSelect.innerHTML = state.crew.filter(a => a.id !== 'manager').map(a => `<option value="${esc(a.id)}">${esc(t(a.name))}: ${esc(t(a.title ?? ''))}</option>`).join('');
    $('#task-project').innerHTML = state.projects.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  }
}

// ---------- Log ----------

function allRuns() {
  const list = [...(state.current ? [state.current] : []), ...state.queue, ...state.history];
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
      <td>${stateHtml(runState(r.status))}</td>
      <td class="num">${r.started ? esc(elapsed(r.started, r.ended ?? Date.now())) : '—'}</td>
    </tr>`;
  });
  const html = list.length
    ? `<table class="table"><thead><tr><th>${esc(t('Date'))}</th><th>${esc(t('Run'))}</th><th>${esc(t('Status'))}</th><th>${esc(t('Time'))}</th></tr></thead><tbody>${rows.join('')}</tbody></table>`
    : `<div class="empty">${esc(t('No runs yet.'))}</div>`;
  draw('#log-list', JSON.stringify([selectedRun, list.map(r => [r.id, r.status, r.ended, r.pullRequest]), Math.floor(Date.now() / 60000)]), html);
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
        <div class="report-top"><div class="report-who">${face(member(s.agent), stepFace(s), 26)}<strong>${i + 1}. ${esc(agentName(s.agent))}${s.review ? `, ${esc(t('review'))}` : ''}</strong></div>${stateHtml(runState(s.status))}</div>
        <div class="hint num">${facts.map(esc).join(' · ')}</div>
        <div class="body">${md(body)}</div>
      </div>`;
  });
  const checks = r.checks?.length
    ? `<div class="report"><div class="report-top"><strong>${esc(t('Checks'))}</strong></div>${r.checks.map(c => `<div>${stateHtml(c.ok ? [t('Passed'), 'ok'] : [t('Failed'), 'error'])} <code>${esc(c.command)}</code></div>`).join('')}</div>`
    : '';
  const html = `
    <h2>${esc(r.title)}</h2>
    <div class="hint">${stateHtml(runState(r.status))} · <span class="num">${shortDate(r.created)}</span> · ${esc(projectName(r.project))} · ${esc(originLabel(r.origin))}${r.started ? ` · <span class="num">${esc(elapsed(r.started, r.ended ?? Date.now()))}</span>` : ''}</div>
    ${r.result ? `<p>${esc(r.result)}</p>` : ''}${r.note ? `<p class="hint">${esc(r.note)}</p>` : ''}
    ${r.instruction ? `<p class="hint">${esc(t('Instruction: {text}', { text: r.instruction }))}</p>` : ''}
    <div class="actions left">
      ${r.pullRequest ? `<a class="button" href="${esc(r.pullRequest)}" target="_blank" rel="noopener">${esc(t('Open pull request'))}</a>` : ''}
      ${canResume ? `<button type="button" class="button secondary" data-resume="${esc(r.id)}">${esc(t('Resume'))}</button>` : ''}
      ${r.status === 'paused' ? `<button type="button" class="button secondary" data-resume="${esc(r.id)}" data-ignore>${esc(t('Resume past the limit'))}</button>` : ''}
      ${canCancel ? `<button type="button" class="button danger" data-cancel="${esc(r.id)}">${esc(t('Cancel'))}</button>` : ''}
    </div>
    ${reports.join('')}${checks}`;
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

// ---------- Cycle ----------

function drawOffline() {
  online = false;
  drawPresence();
  drawStatusbar();
  if (state) {
    drawBridge();
    $('#send').disabled = true;
  }
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
  } else if ((next.language || 'en') !== language()) {
    location.reload();
    return;
  }
  state = next;
  online = true;
  $('#version').textContent = `Chiefmate ${state.version}`;
  drawPresence();
  drawCounters();
  drawStatusbar();
  drawChat();
  drawBridge();
  drawSituation();
  drawOperations();
  drawMissions();
  drawCrew();
  drawLog();
  drawUsage();
  if (currentView() === 'log') refreshDetail();
}

// ---------- Actions ----------

async function sendMessage(text) {
  const message = text.trim();
  if (!message) return;
  try {
    await api('/api/manager', { message });
    $('#message').value = '';
    setTimeout(refresh, 300);
  } catch (error) {
    toast(error.message);
  }
}

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
  const target = event.target.closest('[data-run],[data-assign],[data-select],[data-cancel],[data-resume],[data-suggestion]');
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
    }
    refresh();
  } catch (error) {
    toast(error.message);
  }
});

showView();
drawClock();
setInterval(drawClock, 15_000);
refresh();
setInterval(refresh, 2500);
