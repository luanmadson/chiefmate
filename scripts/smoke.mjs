// Starts a temporary Chiefmate on a spare port (only the app and the API: no queue, no schedule, no updates)
// and checks that everything answers. Usage: npm run smoke
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 47000 + Math.floor(Math.random() * 900);
const base = `http://localhost:${port}`;
// Records of its own, so nothing of the installation's conversation, runs or usage is read or changed; and a Claude
// Code that does not exist, so nothing here can start a real answer.
const data = mkdtempSync(path.join(os.tmpdir(), 'chiefmate-smoke-data-'));
Object.assign(process.env, { CHIEFMATE_DATA: data, CHIEFMATE_CLAUDE: path.join(data, 'no-claude.exe') });
mkdirSync(path.join(data, 'manager'), { recursive: true });
// The manager's old Markdown board, imported once into the planning board (made-up items).
writeFileSync(path.join(data, 'manager', 'plan.md'), [
  '# Plan', '', '| # | Projeto | Item | Prioridade | Situação |', '|---|---|---|---|---|',
  '| 3 | Sample | First thing | Alta | Em andamento |', '| 7 | Sample | Second thing | Baixa | Aguarda o dono decidir |', '| 8 | Other | Third thing | Média | Depende do item 3 |',
].join('\n'));
writeFileSync(path.join(data, 'manager', 'pending.json'), JSON.stringify([{ id: 'smoke1', text: 'Waiting', at: new Date().toISOString(), queued: true }]));
// A finished run with a step's log, for the agent's panel: a text, an action and a last line still being written.
mkdirSync(path.join(data, 'runs', 'smoke-feed'), { recursive: true });
writeFileSync(path.join(data, 'runs', 'smoke-feed.json'), JSON.stringify({
  id: 'smoke-feed', kind: 'task', project: 'none', title: 'Generalist: smoke', status: 'done', created: new Date().toISOString(),
  steps: [{ agent: 'generalist', status: 'done', started: new Date().toISOString() }],
}));
const feedLines = [
  { type: 'system', subtype: 'init', session_id: 's' },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'Reading the README first.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
].map(e => JSON.stringify(e)).join('\n');
const feedWhole = `${feedLines}\n`;
writeFileSync(path.join(data, 'runs', 'smoke-feed', '01-generalist.jsonl'), `${feedWhole}{"type":"assistant","message":{"content":[{"type":"text","text":"half`);
const child = spawn(process.execPath, [path.join(root, 'src', 'cli.mjs'), 'server'], {
  cwd: root,
  env: { ...process.env, CHIEFMATE_PORT: String(port), CHIEFMATE_SMOKE: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let output = '';
child.stdout.on('data', d => (output += d));
child.stderr.on('data', d => (output += d));

const failures = [];
const expect = (ok, what) => {
  if (!ok) failures.push(what);
};

async function started() {
  for (let i = 0; i < 75; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return true;
    } catch {
      // not up yet
    }
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

try {
  if (!(await started())) {
    failures.push('the server did not start');
  } else {
    const state = await (await fetch(`${base}/api/state`)).json();
    for (const key of ['now', 'version', 'language', 'ai', 'update', 'projects', 'missions', 'crew', 'teams', 'needs', 'prompts', 'focus', 'running', 'current', 'parallel', 'sessions', 'queue', 'history', 'usage', 'manager', 'computer', 'plan', 'planning', 'alerts']) {
      expect(key in state, `/api/state has no "${key}"`);
    }
    // What the app shows live (the run going on, its clock, its last action, the queue's order) comes from these.
    expect(!Number.isNaN(new Date(state.now).getTime()), "/api/state's \"now\" is not a date");
    expect(Array.isArray(state.queue) && state.queue.every(r => Array.isArray(r.steps) && r.created), 'a run in the queue has no steps or creation date');
    const c = state.current;
    expect(c === null || (Array.isArray(c.actions) && Array.isArray(c.steps) && 'step' in c && 'agent' in c && 'stepStarted' in c), 'the run going on has no step, agent, clock or actions');
    expect(Array.isArray(state.running) && state.parallel?.max >= 1, '/api/state has no list of the runs going on, or no limit of runs at once');
    expect(Array.isArray(state.sessions?.profiles) && Array.isArray(state.sessions?.open) && Array.isArray(state.computer?.sessions), '/api/state has no live sessions');
    expect(state.crew?.some(a => a.id === 'manager'), 'the crew has no manager');
    const context = state.manager?.context;
    expect(typeof context?.renewAt === 'number' && typeof context.renewing === 'boolean', "/api/state has no context for the manager's conversation");
    for (const file of ['/', '/app.js', '/faces.js', '/i18n.js', '/style.css', '/manifest.webmanifest', '/locales/pt-BR.json', '/icon-32.png']) {
      const r = await fetch(base + file);
      expect(r.ok, `${file} answered ${r.status}`);
    }
    // A project's page: its tabs (the prompt builder's screen moves into the last one) and the prompt shown by blocks.
    const html = await (await fetch(`${base}/`)).text();
    expect(['project-status', 'project-actions', 'project-more', 'project-needs', 'project-overview', 'project-crew', 'project-tasks', 'project-planning', 'project-context', 'project-builder', 'builder-body', 'builder-view', 'builder-edit']
      .every(id => html.includes(`id="${id}"`)), "the app's page lacks a part of the project's page or of the prompt builder");
    const unsigned = await fetch(`${base}/api/limits`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(unsigned.status === 403, `a command without the x-chiefmate header answered ${unsigned.status} instead of 403`);
    const machine = await (await fetch(`${base}/api/computer`)).json();
    expect(machine.memory?.total > 0 && Array.isArray(machine.projects), '/api/computer has no memory or projects');
    // Commands that must refuse without changing anything (the settings are the installation's own).
    const post = (route, body) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', 'x-chiefmate': '1' }, body: JSON.stringify(body) });
    expect((await post('/api/stop-project', { project: 'none' })).status === 400, 'stopping a project without a confirmed list was not refused');
    expect((await post('/api/reset-grants', { action: 'used', index: 9999 })).status === 400, 'marking a free reset that does not exist was not refused');
    // Updates are off in the smoke test: "update now" and "update check" answer so, and nothing is fetched or installed.
    expect(['pause', 'wait'].includes(state.update.mode) && state.update.installing === null, `/api/state has no update mode, or an update going on: ${JSON.stringify(state.update)}`);
    expect((await post('/api/update-now', {})).status === 400 && (await post('/api/update-check', {})).status === 400, 'an update was tried in the smoke test, where updates are off');
    expect(Array.isArray(state.teams) && state.teams.every(x => x.project && Array.isArray(x.members)), '/api/state has no crews by project');
    expect(Array.isArray(state.needs), "/api/state has no list of the owner's requests");
    expect((await post('/api/needs-you', { what: 'Sign in' })).status === 400, 'a request for the owner without a run was not refused');
    expect((await fetch(`${base}/api/run/none/context/1`)).status === 404, "a step's context of a run that does not exist did not answer 404");
    const outside = await fetch(`${base}/../package.json`);
    expect(!outside.ok || !(await outside.text()).includes('"name": "chiefmate"'), 'a file outside ui/ was served');
    // The conversation: what the manager is doing, the queue (edited and removed in place) and the interruption.
    // No message is sent for real: with the manager free, it would start an answer.
    const g = state.manager;
    expect('lastAction' in g && typeof g.interrupting === 'boolean' && 'since' in g, "/api/state has no last action or clock for the manager");
    expect(g.pending?.length === 1 && g.pending[0].id === 'smoke1', '/api/state does not show the messages waiting in the queue');
    expect((await post('/api/manager', { message: '  ' })).status === 400, 'an empty message to the manager was not refused');
    const edited = await post('/api/manager/edit', { id: 'smoke1', message: 'Changed' });
    expect(edited.ok && (await edited.json()).pending?.[0]?.text === 'Changed', 'a message in the queue was not edited');
    expect((await post('/api/manager/edit', { id: 'none', message: 'x' })).status === 404, 'editing a message that is not in the queue did not answer 404');
    const removed = await post('/api/manager/remove', { id: 'smoke1' });
    expect(removed.ok && (await removed.json()).pending?.length === 0, 'a message was not taken out of the queue');
    expect((await post('/api/manager/remove', { id: 'smoke1' })).status === 404, 'removing a message twice did not answer 404');
    // Live sessions: an unknown profile or session is refused, and nothing opens.
    expect((await post('/api/session', { profile: 'no-such-profile' })).status === 400, 'opening a session of an unknown profile was not refused');
    expect((await post('/api/session/end', { id: 'no-such-session' })).status === 400, 'ending a session that does not exist was not refused');
    // The planning board: imported from the old Markdown board, then changed through the API.
    const items = state.planning?.items ?? [];
    const imported = Object.fromEntries(items.map(i => [i.id, `${i.priority}/${i.status}`]));
    expect(imported[3] === 'high/in_progress' && imported[7] === 'low/waiting_owner' && imported[8] === 'medium/future', `the old Markdown board was not imported right: ${JSON.stringify(imported)}`);
    const added = await post('/api/planning', { action: 'add', project: 'Sample', title: 'Smoke item', priority: 'alta', status: 'a fazer' });
    const item = added.ok ? (await added.json()).item : null;
    expect(item?.id === 9 && item.priority === 'high' && item.status === 'todo', `an item was not added to the planning board: ${JSON.stringify(item)}`);
    const set = await post('/api/planning', { action: 'set', id: 9, status: 'waiting_owner', description: 'Notes' });
    expect(set.ok && (await set.json()).item?.status === 'waiting_owner', 'an item of the planning board was not changed');
    expect((await post('/api/planning', { action: 'set', id: 9, status: 'nonsense' })).status === 400, 'an unknown status was not refused');
    expect((await post('/api/planning', { action: 'set', id: 999, status: 'done' })).status === 400, 'changing an item that does not exist was not refused');
    expect((await post('/api/planning', { action: 'add', project: 'Sample', title: ' ' })).status === 400, 'an item without a title was not refused');
    expect((await post('/api/task', { project: 'none', agent: 'generalist', instruction: 'x', plan: 999 })).status === 400, 'a task linked to an item that does not exist was not refused');
    const archived = await post('/api/planning', { action: 'archive', id: 9 });
    expect(archived.ok && (await archived.json()).item?.archived, 'an item was not archived');
    // Proposals: proposed, refused when repeated, triaged by the manager, then the owner's decision (in a project
    // that is not in the settings, "do" is refused: its task could not be queued).
    const itemOf = async r => (r.ok ? (await r.json()).item : { error: (await r.json()).error });
    const proposed = await itemOf(await post('/api/planning', { action: 'propose', project: 'Sample', title: 'Smoke proposal', summary: 'A clear gain.', agent: 'someone', priority: 'low' }));
    expect(proposed?.status === 'proposed' && proposed.proposed_by === 'owner' && proposed.agent === 'someone' && proposed.description === 'A clear gain.', `a proposal was not recorded: ${JSON.stringify(proposed)}`);
    const p = proposed?.id;
    expect((await post('/api/planning', { action: 'propose', project: 'Sample', title: 'smoke  PROPOSAL' })).status === 400, 'a proposal repeating an open item was not refused');
    expect((await post('/api/planning', { action: 'triage', id: p, agent: 'someone' })).status === 400, 'a triage without a recommendation was not refused');
    const triaged = await itemOf(await post('/api/planning', { action: 'triage', id: p, recommend: 'fazer agora', priority: 'alta', note: 'Small and useful.', order: 1 }));
    expect(triaged?.status === 'triaged' && triaged.recommend === 'now' && triaged.priority === 'high' && triaged.rank === 1 && triaged.recommend_note === 'Small and useful.', `a proposal was not triaged: ${JSON.stringify(triaged)}`);
    expect((await post('/api/planning', { action: 'approve', id: p })).status === 400, 'an item of a project not in the settings was approved');
    const dropped = await itemOf(await post('/api/planning', { action: 'discard', id: p, reason: 'Not now.' }));
    expect(dropped?.status === 'discarded' && dropped.discard_reason === 'Not now.' && dropped.rank === null, `a proposal was not discarded with its reason: ${JSON.stringify(dropped)}`);
    const back = await itemOf(await post('/api/planning', { action: 'restore', id: p }));
    expect(back?.status === 'triaged', `a discarded proposal did not come back to the owner's decision: ${JSON.stringify(back)}`);
    const later = await itemOf(await post('/api/planning', { action: 'later', id: p }));
    expect(later?.status === 'future' && later.rank === null, `"later" did not leave the item for the future: ${JSON.stringify(later)}`);
    expect((await post('/api/planning', { action: 'reorder', ids: [999] })).status === 400, 'reordering an item that does not exist was not refused');
    expect(['proposed', 'triaged', 'approved', 'discarded'].every(s => state.planning.statuses.includes(s)), 'the board has no statuses for the proposals');
    // The agent's panel: the step's log read live, from where it stopped, and the direct talk refused off a step.
    const feed = await (await fetch(`${base}/api/run/smoke-feed/feed`)).json();
    expect(feed.step === 1 && feed.items?.length === 2 && feed.items[0].type === 'say' && feed.items[1].tool === 'Bash', `the agent's panel did not read the step's log: ${JSON.stringify(feed.items)}`);
    expect(feed.next === Buffer.byteLength(feedWhole) && !feed.live && !feed.talking, 'the panel read a line still being written, or took a finished run as going on');
    const again = await (await fetch(`${base}/api/run/smoke-feed/feed?step=1&from=${feed.next}`)).json();
    expect(again.items?.length === 0 && again.next === feed.next, 'reading the log again from where it stopped repeated what was already shown');
    expect((await fetch(`${base}/api/run/none/feed`)).status === 404, 'the panel of a run that does not exist did not answer 404');
    expect((await post('/api/run/talk', { run: 'smoke-feed', text: 'Hello' })).status === 400, 'a message to a run not going on was not refused');
    expect((await post('/api/run/talk', { run: 'smoke-feed', text: ' ' })).status === 400, 'an empty message to an agent was not refused');
    expect(state.crew.every(a => Array.isArray(a.runs) && 'waitingFor' in a), "the crew has no runs to open a panel on, or no \"waiting for\"");
    // A request for a team lead: refused for a project that does not exist, and with no request.
    expect(state.teams.every(x => 'lead' in x), '/api/state has no team lead (or null) for each project');
    expect((await post('/api/ask', { project: 'none', request: 'Do something' })).status === 400, 'a request for a project that does not exist was not refused');
    expect((await post('/api/ask', { project: 'none', request: 'x', plan: 999 })).status === 400, 'a request linked to an item that does not exist was not refused');
    // A project's page: refused for a project that does not exist; for the installation's first project, read only
    // (nothing opens: the actions are refused or asked for as a dry run).
    expect((await fetch(`${base}/api/project/no-such-project`)).status === 400, "the page of a project that does not exist did not answer 400");
    expect((await post('/api/project/open', { project: 'no-such-project', app: 'folder', dryRun: true })).status === 400, 'opening the folder of a project that does not exist was not refused');
    expect((await post('/api/project/dev', { project: 'no-such-project', action: 'start', dryRun: true })).status === 400, 'starting the environment of a project that does not exist was not refused');
    expect((await post('/api/project/dev', { project: 'no-such-project', action: 'other' })).status === 400, 'an unknown action on the development environment was not refused');
    expect((await post('/api/session', { profile: 'no-such-profile', dryRun: true })).status === 400, 'a dry run of an unknown session profile was not refused');
    // The app's prompt builder: the document (or none) and the copy's state; nothing opens (dry runs, or refused).
    const builderPage = await (await fetch(`${base}/api/prompt-builder`)).json();
    expect(builderPage.status && ['file', 'library', 'google'].includes(builderPage.status.origin) && 'document' in builderPage && 'last' in builderPage && Array.isArray(builderPage.defaults), `/api/prompt-builder is incomplete: ${JSON.stringify(builderPage).slice(0, 200)}`);
    expect((await fetch(`${base}/api/prompt-builder?project=no-such-project`)).status === 400, 'the prompt builder of a project that does not exist did not answer 400');
    expect((await post('/api/prompt-builder/session', { project: 'no-such-project', tool: 'claude', prompt: 'Hello', dryRun: true })).status === 400, "a session from the prompt builder for a project that does not exist was not refused");
    if (state.projects[0]) expect((await post('/api/prompt-builder/session', { project: state.projects[0].id, tool: 'claude', prompt: ' ', dryRun: true })).status === 400, 'a session from the prompt builder with an empty prompt was not refused');
    // A project's Context tab: everything its crew gets, in order and by source. A preview saves nothing, and saving
    // no change is refused (the installation's settings are never written here).
    if (state.projects[0]) {
      const id = state.projects[0].id;
      const ctx = await (await fetch(`${base}/api/project/${encodeURIComponent(id)}/context`)).json();
      expect(Array.isArray(ctx.members) && ctx.members.at(-1)?.kind === 'manager' && ctx.members.every(m => m.tokens.total === m.tokens.system + m.tokens.repository + m.tokens.prompt && m.system[0]?.key === 'agent' && m.prompt[0]?.key === 'header' && m.prompt.at(-1)?.key === 'rules') && Array.isArray(ctx.sessions) && Array.isArray(ctx.history), `/api/project/<id>/context is incomplete: ${JSON.stringify(ctx).slice(0, 300)}`);
      const preview = await (await post('/api/project/context/preview', { project: id, changes: {} })).json();
      expect(Array.isArray(preview.changed) && !preview.changed.length && preview.members?.length === ctx.members.length, `a preview with no change is wrong: ${JSON.stringify(preview).slice(0, 200)}`);
      expect((await post('/api/project/context/save', { project: id, changes: {} })).status === 400, 'saving no change to the context was not refused');
    }
    expect((await fetch(`${base}/api/project/no-such-project/context`)).status === 400, 'the context of a project that does not exist did not answer 400');
    expect(state.projects.every(p => ['claude', 'codex'].every(tool => state.sessions.profiles.some(x => x.project === p.id && x.tool === tool))), 'a project has no live session profile (its own or automatic) for each tool');
    const first = state.projects[0];
    if (first) {
      const page = await fetch(`${base}/api/project/${encodeURIComponent(first.id)}`);
      const info = page.ok ? await page.json() : {};
      expect(page.ok && info.id === first.id && Array.isArray(info.history) && 'clone' in info && 'branch' in info && 'dev' in info && typeof info.vscode === 'boolean', `the page of a project is incomplete: ${JSON.stringify(info).slice(0, 300)}`);
      expect(info.history?.every(r => r.project === first.id), "a project's page lists runs of another project");
    }
    const interrupt = await post('/api/manager/interrupt', {});
    expect(interrupt.ok && (await interrupt.json()).interrupted === false, 'interrupting a manager that is not answering did something');
  }
} catch (error) {
  failures.push(error.message);
} finally {
  child.kill();
}

// The queue of messages, in this process: a busy manager (made up, nothing runs) keeps them in order and is stopped.
try {
  const { chat, composeMessage, deliverPending, interruptManager, managerBusy, removePending, sendToManager } = await import(pathToFileURL(path.join(root, 'src', 'manager.mjs')).href);
  let stopped = null;
  Object.assign(chat, { responding: true, cancel: reason => (stopped = reason) });
  const first = sendToManager('First');
  const second = sendToManager('Second\nwith two lines');
  expect(first.queued && second.queued && first.position === 1 && second.position === 2, 'messages sent while the manager answers were not queued in order');
  expect(managerBusy() && !deliverPending(), 'the queue was delivered while the manager was still answering');
  expect(interruptManager() && chat.interrupting && stopped, 'the interruption did not stop the answer');
  const text = composeMessage('Owner', [first, second], '2026-01-02T10:00:00Z');
  expect(text.includes('interrupted your previous answer') && text.indexOf('First') < text.indexOf('Second') && (text.match(/\[sent /g) ?? []).length === 2, 'the queue was not put together in order, with the time of each message and the interruption');
  expect(composeMessage('Owner', [{ text: 'Hi', at: first.at, queued: false }]) === 'Message from Owner:\nHi', 'a message sent to a free manager changed its form');
  removePending(first.id);
  removePending(second.id);

  // The manager's news: events gathered and handed over as one system message, marked as not the owner's; into the
  // queue while the manager answers (still made up: nothing runs), joined to news already waiting; the settings pick
  // the events. Never delivered for real.
  const news = await import(pathToFileURL(path.join(root, 'src', 'news.mjs')).href);
  const { editPending } = await import(pathToFileURL(path.join(root, 'src', 'manager.mjs')).href);
  const picked = news.newsSettings({ manager_updates: ['run_failed', 'nonsense'] });
  expect(news.newsSettings({}).events.size === news.NEWS_EVENTS.length && !news.newsSettings({ manager_updates: false }).enabled && !news.newsSettings({ manager_updates: { enabled: false } }).enabled, '"manager_updates" does not default to every event, or false does not turn the news off');
  expect(picked.enabled && picked.events.size === 1 && picked.events.has('run_failed'), `a list in "manager_updates" did not pick its events: ${[...picked.events]}`);
  const only = { manager_updates: ['run_failed', 'pr_ready'] };
  expect(news.reportEvent('run_paused', 'Paused', { config: only }) === null, 'an event left out by the settings was kept');
  news.reportEvent('run_failed', 'Run a failed', { config: only });
  news.reportEvent('pr_ready', 'Run b has a pull request', { config: only });
  const item = await news.flushNews();
  expect(item?.from === 'chiefmate' && item.queued && item.events.map(e => e.kind).join() === 'run_failed,pr_ready', `the events were not handed over together, in the queue of a busy manager: ${JSON.stringify(item)}`);
  news.reportEvent('run_failed', 'Run c failed', { config: only });
  const joined = await news.flushNews();
  expect(joined?.id === item.id && joined.events.length === 3 && (await news.flushNews()) === null, 'news for a manager still busy was not joined to the news already in the queue');
  const told = composeMessage('Owner', [joined]);
  expect(told.startsWith('[System message from Chiefmate, not from Owner]') && told.includes('pr_ready: Run b has a pull request') && !told.includes('Message from Owner'), `the news is not marked as a system message, apart from the owner's: ${told}`);
  const both = composeMessage('Owner', [{ text: 'Hi', at: first.at, queued: false }, joined]);
  expect(both.startsWith('Message from Owner:\nHi') && both.includes("Answer Owner's message(s)"), "the news did not go along with the owner's message");
  let locked = false;
  try {
    editPending(joined.id, 'Changed');
  } catch {
    locked = true;
  }
  expect(locked, "Chiefmate's news could be edited as if the owner had written it");
  removePending(joined.id);
  const { watchEnded } = await import(pathToFileURL(path.join(root, 'src', 'sessions.mjs')).href);
  watchEnded([{ id: 's1', status: 'open' }, { id: 's2', status: 'open' }]);
  const ended = watchEnded([{ id: 's1', status: 'ended', name: 'X', tool: 'claude' }, { id: 's2', status: 'ended', endedBy: 'owner' }]);
  expect(ended.map(s => s.id).join() === 's1', 'a live session that ended was not noticed, or one ended by the owner was');
  const left = await news.flushNews(); // the installation's own settings decide whether that one was kept
  if (left) removePending(left.id);

  Object.assign(chat, { responding: false, interrupting: false, cancel: null });
  expect(!managerBusy(), 'the queue did not empty');
} catch (error) {
  failures.push(`conversation checks: ${error.message}`);
}

// The planning board follows the runs linked to it (in this process, with the same records; no run starts).
try {
  const { planItem, planningLine } = await import(pathToFileURL(path.join(root, 'src', 'planning.mjs')).href);
  const { saveRun } = await import(pathToFileURL(path.join(root, 'src', 'store.mjs')).href);
  const run = { id: 'smoke-run', status: 'queued', plan: 3, steps: [] };
  saveRun(run);
  expect(planItem(3).run === 'smoke-run' && planItem(3).status === 'queued', `queuing a run for an item did not link it: ${JSON.stringify(planItem(3))}`);
  saveRun(Object.assign(run, { status: 'running' }));
  expect(planItem(3).status === 'in_progress', 'the item did not follow its run going on');
  saveRun(Object.assign(run, { status: 'done', pullRequest: 'https://example.com/pull/1' }));
  expect(planItem(3).status === 'waiting_owner' && planItem(3).pr === 'https://example.com/pull/1', 'a run done with a pull request did not leave its item waiting for the owner');
  saveRun(Object.assign(run, { status: 'failed', pullRequest: null }));
  expect(planItem(3).status === 'todo', 'the item of a failed run did not go back to "todo"');
  const line = planningLine('Owner');
  expect(line.includes('#3 Sample: First thing') && line.includes('waiting for Owner: #7'), `the manager's summary of the board is wrong: ${line}`);
} catch (error) {
  failures.push(`planning checks: ${error.message}`);
}

// Proposals in this process: the author is the step's agent, the manager's summary lists them, and approved items
// become tasks one per project at a time, in the owner's order (runs recorded in the temporary folder; none starts).
try {
  process.env.CHIEFMATE_SMOKE = '1'; // the new proposals here never reach the manager
  const planning = await import(pathToFileURL(path.join(root, 'src', 'planning.mjs')).href);
  const { saveRun, readRun } = await import(pathToFileURL(path.join(root, 'src', 'store.mjs')).href);
  const { loadConfig, projectCrew } = await import(pathToFileURL(path.join(root, 'src', 'config.mjs')).href);
  saveRun({ id: 'smoke-proposer', kind: 'task', project: 'Sample', status: 'running', steps: [{ agent: 'designer', status: 'running' }], review: { agent: 'manager', status: 'pending' } });
  expect(planning.proposer({ run: 'smoke-proposer', step: '1' }).by === 'designer' && planning.proposer({ run: 'smoke-proposer', step: '2' }).by === 'manager', "a proposal's author is not the step's agent");
  expect(planning.proposer({ by: 'manager' }).by === 'manager' && planning.proposer({}).by === 'owner', 'a proposal made outside a run has the wrong author');
  const mine = planning.proposeItem({ project: 'Other', title: 'Proposed in a step', summary: 'One line.', by: 'designer', run: 'smoke-proposer' });
  expect(mine.proposed_by === 'designer' && mine.proposed_run === 'smoke-proposer', 'a proposal did not keep its author and run');
  expect(planning.planningLine('Owner').includes(`proposals waiting for your triage (plan triage, or plan discard): #${mine.id} Other: Proposed in a step (by designer`), `the manager's summary lacks the proposals: ${planning.planningLine('Owner')}`);
  // One approved task per project at a time: only with a project in this installation's settings (read only).
  const config = loadConfig();
  const projectId = Object.keys(config.projects ?? {})[0];
  const agent = projectId && Object.keys(projectCrew(config, projectId)).find(id => id !== 'manager' && id !== 'lead');
  if (agent) {
    const [a, b] = ['First approved', 'Second approved'].map(title => planning.proposeItem({ project: projectId, title: `Smoke ${title}`, agent, by: 'manager' }));
    planning.triageItem(a.id, { recommend: 'now' });
    planning.triageItem(b.id, { recommend: 'later', order: 1 }); // b first in the owner's order...
    planning.reorderItems([a.id, b.id]); // ...then dragged after a
    await planning.decideItem(b.id, 'approve');
    const first = planning.planItem(b.id);
    expect(first.status === 'queued' && first.run && readRun(first.run)?.plan === b.id && readRun(first.run)?.review, `an approved item did not become a task with the manager's review: ${JSON.stringify(first)}`);
    await planning.decideItem(a.id, 'approve');
    expect(planning.planItem(a.id).status === 'approved' && !planning.planItem(a.id).run, 'a second approved task of the same project did not wait its turn');
    saveRun({ ...readRun(first.run), status: 'done' });
    await planning.startApproved();
    expect(planning.planItem(b.id).status === 'done' && planning.planItem(a.id).status === 'queued', 'the next approved item did not start when the first one ended');
  }
} catch (error) {
  failures.push(`proposal checks: ${error.message}`);
}

// The direct talk with an agent at work, in this process: a made-up step going on (nothing real runs), then a
// stand-in for Claude Code (a small script) interrupted at a safe point and resumed with the owner's message.
try {
  const src = file => pathToFileURL(path.join(root, 'src', file)).href;
  const { live } = await import(src('runs.mjs'));
  const { pendingTalk, talkSection, talkSituation, talkTo, ownerTurn } = await import(src('talk.mjs'));
  const { pollRequest } = await import(src('needs.mjs'));
  const { runClaude } = await import(src('claude.mjs'));
  const run = { id: 'smoke-talk', title: 'Generalist: smoke', project: 'none', status: 'running', created: new Date().toISOString(), steps: [{ agent: 'generalist', status: 'running' }], requests: [] };
  let interrupted = 0;
  live.set(run.id, { run: run.id, memory: run, agent: 'generalist', step: 1, talking: true, heldUntil: 0, actions: [], process: { interrupt: () => interrupted++ } });
  const first = talkTo(run.id, 'Use the other file');
  expect(first.status === 'pending' && interrupted === 1 && pendingTalk(run, 1).length === 1, 'a message to an agent at work did not interrupt it, or was not kept to deliver');
  // The agent waits for the owner (needs-you --wait, polled just now): the message answers the request instead.
  run.requests.push({ id: 'r1', step: 1, agent: 'generalist', what: 'Which file?', wait: true, status: 'open', at: new Date().toISOString() });
  live.get(run.id).heldUntil = Date.now() + 20_000;
  const answer = talkTo(run.id, 'The second one');
  const polled = pollRequest(run.id, 'r1');
  expect(answer.via === 'request' && interrupted === 1 && polled.status === 'done' && polled.answer === 'The second one', "a message to an agent waiting for the owner did not answer its request");
  const section = talkSection(run, 1, id => id, { owner: 'Owner', language: 'en' });
  expect(section.includes('Owner') && section.includes('Use the other file') && section.includes('The second one'), `the step's report does not get the direct talk: ${section}`);
  expect(talkSituation([run], 'Owner').includes('Owner guided step 1 (generalist): "Use the other file"'), "the manager's situation does not get the direct talk");
  live.get(run.id).talking = false;
  let refused = false;
  try {
    talkTo(run.id, 'Between steps');
  } catch {
    refused = true;
  }
  expect(refused, 'a message was accepted while no step was at work');
  live.delete(run.id);

  // The stand-in: it starts an action, finishes it after a moment, then "works" for 30 seconds; resumed with a
  // message, it answers at once. The interruption must wait for the action and stop the rest.
  const fake = path.join(data, 'fake-claude.mjs');
  writeFileSync(fake, [
    "const args = process.argv.slice(2);",
    "const id = args[args.indexOf('--resume') + 1] && args.includes('--resume') ? args[args.indexOf('--resume') + 1] : args[args.indexOf('--session-id') + 1];",
    "let prompt = ''; process.stdin.on('data', d => (prompt += d)); process.stdin.on('end', () => {",
    "  const say = e => process.stdout.write(JSON.stringify(e) + '\\n');",
    "  say({ type: 'system', subtype: 'init', session_id: id, model: 'm' });",
    "  if (args.includes('--resume')) { say({ type: 'assistant', message: { content: [{ type: 'text', text: 'Understood.' }] } }); say({ type: 'result', subtype: 'success', result: 'Report after: ' + prompt.split('\\n')[3], session_id: id, num_turns: 1 }); return; }",
    "  say({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } });",
    "  setTimeout(() => say({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }), 700);",
    "  setTimeout(() => say({ type: 'result', subtype: 'success', result: 'too late', session_id: id }), 30000);",
    "});",
  ].join('\n'));
  process.env.CHIEFMATE_CLAUDE = fake;
  const log = path.join(data, 'fake.jsonl');
  const started = Date.now();
  let stoppedAt = null;
  const proc = runClaude({ dir: data, prompt: 'Work', model: 'm', session: { id: 'smoke-session' }, log, onEvent: e => e.type === 'action' && proc.interrupt() });
  const r = await proc.promise;
  stoppedAt = Date.now() - started;
  expect(proc.args.includes('--session-id') && !proc.args.includes('--no-session-persistence'), "a step's session is not kept, so it could not be resumed");
  expect(r.interrupted && !r.ok && !r.error && !r.canceled, `the interrupted step did not end as interrupted: ${JSON.stringify({ ...r, context: undefined })}`);
  expect(stoppedAt >= 600 && stoppedAt < 20_000, `the interruption did not wait for the action under way, or did not stop the agent (${stoppedAt} ms)`);
  const resumed = runClaude({ dir: data, prompt: ownerTurn([{ text: 'Use the other file', at: new Date().toISOString() }], { owner: 'Owner', language: 'en' }), model: 'm', session: { id: 'smoke-session', resume: true }, log });
  const back = await resumed.promise;
  expect(resumed.args[resumed.args.indexOf('--resume') + 1] === 'smoke-session', 'the step was not resumed in the same session');
  expect(back.ok && back.text === 'Report after: Use the other file', `the resumed session did not get the owner's message as its next turn: ${back.text ?? back.error}`);
  process.env.CHIEFMATE_CLAUDE = path.join(data, 'no-claude.exe');
} catch (error) {
  failures.push(`direct talk checks: ${error.message}`);
}

// Updating without waiting, in this process, with made-up hooks (no git, no restart, no real run or answer): the runs
// going on are asked to pause, the update waits for them and for the manager (interrupting it when asked), and when the
// new version does not go in, the paused work and the manager's queue go on.
try {
  const src = file => pathToFileURL(path.join(root, 'src', file)).href;
  const update = await import(src('update.mjs'));
  const { live, pauseAll, pauseLive, updatedTurn } = await import(src('runs.mjs'));
  const { queued } = await import(src('queue.mjs'));
  const { saveRun } = await import(src('store.mjs'));
  const { chat, deliverPending, removePending, sendToManager } = await import(src('manager.mjs'));
  expect(update.updateMode({}) === 'pause' && update.updateMode({ auto_update_mode: 'wait' }) === 'wait' && update.updateMode({ auto_update_mode: 'x' }) === 'pause', '"auto_update_mode" does not default to "pause", or "wait" is not kept');

  // A step at work is interrupted at a safe point, once; a run between steps is only marked.
  let interrupts = 0;
  live.set('smoke-pause-a', { run: 'smoke-pause-a', project: 'a', actions: [], process: { interrupt: () => interrupts++ } });
  live.set('smoke-pause-b', { run: 'smoke-pause-b', project: 'b', actions: [], process: null });
  const asked = pauseAll();
  expect(asked.join() === 'smoke-pause-a,smoke-pause-b' && interrupts === 1 && live.get('smoke-pause-b').pauseRequest && !pauseLive('smoke-pause-a') && interrupts === 1, `the runs going on were not asked to pause once each: ${asked}`);
  const turn = updatedTurn([{ text: 'Also fix the title', at: new Date().toISOString() }], { owner: 'Owner', language: 'en' });
  expect(turn.startsWith('Chiefmate was updated') && turn.includes('Continue from where you left off') && turn.includes('Also fix the title'), `a step resumed after the update is not told so, or loses the owner's message: ${turn}`);

  // The run paused for the update goes back to the front of the queue.
  saveRun({ id: 'smoke-q-old', project: 'a', status: 'queued', created: '2026-01-01T00:00:00Z', steps: [] });
  saveRun({ id: 'smoke-q-paused', project: 'b', status: 'queued', resumeFirst: true, created: '2026-01-02T00:00:00Z', steps: [] });
  const order = queued().map(r => r.id);
  expect(order.indexOf('smoke-q-paused') === 0 && order.includes('smoke-q-old'), `a run paused for the update does not resume first: ${order}`);
  saveRun({ id: 'smoke-q-old', project: 'a', status: 'canceled', created: '2026-01-01T00:00:00Z', steps: [] });
  saveRun({ id: 'smoke-q-paused', project: 'b', status: 'canceled', created: '2026-01-02T00:00:00Z', steps: [] });

  // The update itself: the crew pauses (two looks), then the manager's answer is interrupted, then the install fails.
  const calls = { interrupt: 0, resume: 0, apply: 0 };
  let busy = 2;
  let answering = true;
  const hooks = {
    pollMs: 10,
    pauseRuns: () => (busy > 1 ? ['smoke-pause-a'] : []),
    crewBusy: () => busy-- > 0,
    managerAnswering: () => answering,
    interruptManager: () => {
      calls.interrupt++;
      answering = false;
      return true;
    },
    resume: () => calls.resume++,
    apply: async job => {
      calls.apply++;
      // While the update is going on, a message to the manager waits in its queue, and nothing is delivered.
      const held = sendToManager('During the update');
      expect(job.stage === 'installing' && update.updating() && held.queued && !deliverPending() && !chat.responding, 'a message to the manager was delivered during the update');
      removePending(held.id);
      return false;
    },
  };
  const job = { since: new Date().toISOString(), by: 'owner', stage: 'pausing', paused: [], interruptManager: true };
  update.updateInfo.installing = job;
  const installed = await update.install(job, hooks);
  expect(!installed && calls.apply === 1 && calls.interrupt === 1 && calls.resume === 1 && job.paused.join() === 'smoke-pause-a', `the update did not pause the crew, interrupt the manager when asked and resume after a failed install: ${JSON.stringify({ installed, calls, job })}`);
  expect(update.updateInfo.installing === null && !update.updating(), 'a failed update kept holding the queue and the manager');

  // Without "interrupt", the update waits for the answer to end.
  answering = true;
  setTimeout(() => (answering = false), 50);
  const waited = { ...hooks, interruptManager: () => (calls.interrupt++, true), crewBusy: () => false, apply: async () => true };
  const job2 = { since: new Date().toISOString(), by: 'auto', stage: 'pausing', paused: [], interruptManager: false };
  update.updateInfo.installing = job2;
  expect((await update.install(job2, waited)) && calls.interrupt === 1 && !answering, "the update interrupted the manager without being asked, or did not wait for its answer");
  update.updateInfo.installing = null;
  live.delete('smoke-pause-a');
  live.delete('smoke-pause-b');
} catch (error) {
  failures.push(`update checks: ${error.message}`);
}

// Without the server: the crews by project, what a step may see, the command line and the prompt builder,
// with made-up settings, folders and documents (nothing personal).
try {
  const src = file => pathToFileURL(path.join(root, 'src', file)).href;
  const { projectCrew } = await import(src('config.mjs'));
  const { stepAccess, stepMcp } = await import(src('access.mjs'));
  const { claudeArgs } = await import(src('claude.mjs'));
  const { assemble, assembleBlocks, parseBlocks } = await import(src('prompts.mjs'));
  const { pickNext } = await import(src('queue.mjs'));
  const { planSession, sessionArgs, sessionIdOf } = await import(src('sessions.mjs'));

  // The queue: runs of different projects at once, up to the limit; one per project, in order; not before their time.
  const later = new Date(Date.now() + 3600_000).toISOString();
  const waiting = [
    { id: 'a1', project: 'a' }, { id: 'a2', project: 'a' }, { id: 'b1', project: 'b', notBefore: later }, { id: 'b2', project: 'b' },
    { id: 'c1', project: 'c' }, { id: 'd1', project: 'd' },
  ];
  expect(pickNext(waiting, [], 3).map(r => r.id).join() === 'a1,b2,c1', `the queue picked the wrong runs to go on at once: ${pickNext(waiting, [], 3).map(r => r.id).join()}`);
  expect(pickNext(waiting, ['a', 'c'], 5).map(r => r.id).join() === 'b2,d1', "the queue started a second run of a project that has one going on");
  expect(pickNext(waiting, [], 0).length === 0, 'the queue went past the limit of runs at once');

  const agents = {
    manager: { id: 'manager', name: 'Chiefmate', instructions: 'm' },
    generalist: { id: 'generalist', name: 'Generalist', instructions: 'g' },
    designer: { id: 'designer', name: 'Designer', instructions: 'd' },
  };
  const config = {
    projects: {
      alpha: { name: 'Alpha', docs: 'lib/DocsALPHA', crew: { builder: { agent: 'generalist', name: 'Builder', extra_instructions: 'Alpha only.' } }, mcp: ['browser'] },
      beta: { name: 'Beta' },
    },
    mcp_servers: { browser: { command: 'npx', args: ['some-mcp-server'] } },
  };
  const alpha = projectCrew(config, 'alpha', agents);
  expect(Object.keys(alpha).sort().join() === 'builder,manager', "a project's own crew is not just its members and the manager");
  expect(alpha.builder.base === 'generalist' && alpha.builder.instructions.includes('Alpha only.'), "a member of a project's crew lost its base agent or its instructions");
  expect(Object.keys(projectCrew(config, 'beta', agents)).length === 3, 'a project without a crew does not get the general crew');

  // The team leads: a member "lead" of the project's crew, based on the manager, that never edits; its plan (at most
  // three tasks, members of the crew only), its memory and what the manager sees.
  const leads = await import(src('leads.mjs'));
  const leadConfig = {
    owner: 'Owner',
    projects: {
      gamma: { name: 'Gamma', lead: { name: 'Gamma lead', extra_instructions: 'Gamma only.' }, crew: { generalist: {}, front: { agent: 'designer', name: 'Front' } } },
      delta: { name: 'Delta', lead: { agent: 'generalist' } },
    },
  };
  const gamma = projectCrew(leadConfig, 'gamma', { ...agents, manager: { ...agents.manager, tools: ['Bash', 'Read', 'Edit', 'Write'] } });
  const lead = gamma.lead;
  expect(lead?.base === 'manager' && lead.name === 'Gamma lead' && lead.instructions.includes('Gamma only.') && lead.instructions.includes('team lead of Gamma'), "a project's team lead lost its base agent, its name or its instructions");
  expect(!lead.tools.includes('Edit') && !lead.tools.includes('Write') && lead.disallowed.includes('Edit'), 'a team lead may edit the project');
  expect(projectCrew(leadConfig, 'delta', agents).lead?.base === 'generalist' && !projectCrew(config, 'alpha', agents).lead, 'a lead was based on the wrong agent, or a project without "lead" got one');
  const ask = { id: 'smoke-ask', kind: 'ask', project: 'gamma', title: 'Gamma lead: x', instruction: 'Improve the home page', steps: [leads.leadPlanStep('Improve the home page')], review: { agent: 'manager', status: 'pending' } };
  const memoryBlock = '~~~project-memory\n# Gamma\n- 2026-01-02: home page asked\n~~~';
  Object.assign(ask.steps[0], { status: 'done', report: `Plan below.\n\n~~~chiefmate-plan\n${JSON.stringify({ tasks: [
    { agent: 'front', task: 'Redo the header' }, { agent: 'nobody', task: 'x' }, { agent: 'Generalist', task: 'Fix the links' }, { agent: 'generalist', task: 'Test' }, { agent: 'front', task: 'One too many' },
  ], note: 'Two members' })}\n~~~\n\n${memoryBlock}` });
  const taken = leads.takeMemory(ask.steps[0].report);
  expect(taken.memory === '# Gamma\n- 2026-01-02: home page asked' && !taken.report.includes('project-memory') && taken.report.includes('chiefmate-plan'), 'the project memory was not taken out of the lead\'s report');
  leads.saveMemory('gamma', taken.memory);
  expect(leads.readMemory('gamma').startsWith('# Gamma') && leads.memoryInfo('gamma')?.lines === 2, 'the project memory was not saved where the lead reads it');
  const plan = leads.applyPlan(ask, ask.steps[0], gamma);
  expect(plan.tasks.map(x => x.agent).join() === 'front,generalist,generalist' && plan.dropped.length === 2, `the lead's plan was not kept to three tasks of the crew: ${JSON.stringify(plan)}`);
  expect(ask.steps.map(s => `${s.agent}${s.role ? `/${s.role}` : ''}`).join() === 'lead/plan,front,generalist,generalist,lead/review' && ask.steps[1].by === 'lead' && ask.lead.plan.note === 'Two members', `the plan's tasks did not become the run's steps: ${ask.steps.map(s => s.agent).join()}`);
  const prompt = leads.leadLines({ run: ask, step: ask.steps[0], agents: gamma, memory: leads.readMemory('gamma'), base: 'main' }).join('\n');
  expect(prompt.includes('~~~chiefmate-plan') && prompt.includes('`front` (Front') && !prompt.includes('`lead`') && prompt.includes('home page asked'), "the lead's planning prompt lacks the format, the crew or the memory");
  expect(leads.memberLines({ run: ask, step: ask.steps[1], lead, memory: 'Remember X' }).join('\n').includes('Task 1 of 3'), 'a planned task does not say which request it is part of');
  ask.lead.opinion = 'Approve with caveats.';
  expect(leads.finalReviewLines(ask, lead).join('\n').includes('Approve with caveats.'), "the manager's final review does not get the lead's opinion");
  ask.steps[0].status = 'running';
  expect(leads.leadSituation('gamma', lead, ask, null).includes('planning the request "Improve the home page"') && leads.leadSituation('gamma', lead, null, null).includes('off'), "the manager's line about the lead is wrong");
  const empty = { id: 'smoke-ask-2', kind: 'ask', project: 'gamma', steps: [{ ...leads.leadPlanStep('x'), status: 'done', report: '~~~chiefmate-plan\n{"tasks": [], "note": "Already done"}\n~~~' }], review: { agent: 'manager', status: 'pending' } };
  leads.applyPlan(empty, empty.steps[0], gamma);
  expect(empty.review.status === 'skipped' && empty.steps.length === 1 && empty.lead.plan.note === 'Already done', 'a plan with no task did not skip the rest of the run');
  // What a lead changes through the shell (a file, a commit) is dropped after its step: the working copy goes back.
  const { discardSince, headCommit } = await import(src('workspace.mjs'));
  const repo = mkdtempSync(path.join(os.tmpdir(), 'chiefmate-smoke-git-'));
  try {
    const g = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=smoke', '-c', 'user.email=smoke@example.com', ...a], { stdio: 'pipe' });
    g('init', '-q');
    writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    g('add', '-A');
    g('commit', '-qm', 'one');
    const before = await headCommit(repo);
    expect(!(await discardSince(repo, before)), 'a lead step that changed nothing was said to have changed files');
    writeFileSync(path.join(repo, 'a.txt'), 'two\n');
    g('commit', '-qam', 'two');
    writeFileSync(path.join(repo, 'new.txt'), 'x\n');
    expect(await discardSince(repo, before) && (await headCommit(repo)) === before && !existsSync(path.join(repo, 'new.txt')), "a lead's changes were not dropped");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }

  const mcp = stepMcp(config, config.projects.alpha, alpha.builder);
  expect(mcp.names.join() === 'browser' && mcp.tools.join() === 'mcp__browser', "the project's MCP server was not released");

  const temp = mkdtempSync(path.join(os.tmpdir(), 'chiefmate-smoke-'));
  try {
    const ws = path.join(temp, 'workspaces');
    for (const d of ['alpha', 'beta', '.library/lib/DocsALPHA', '.library/lib/DocsBETA', '.library/lib/Notes', '.library/other']) mkdirSync(path.join(ws, d), { recursive: true });
    const libraries = [{ id: 'lib', dir: path.join(ws, '.library', 'lib') }];
    const access = stepAccess({ config, projectId: 'alpha', project: config.projects.alpha, libraries, workspaces: ws, data: path.join(temp, 'data') });
    const denied = access.denied.join('\n');
    expect(access.addDirs.length === 1 && access.addDirs[0].endsWith('DocsALPHA'), 'a step got more than its own documentation folder');
    for (const name of ['beta', 'DocsBETA', 'Notes', 'other', 'data']) expect(denied.includes(`/${name}/**)`), `a step was not denied ${name}`);
    expect(!denied.includes('DocsALPHA') && !/\/alpha\/\*\*\)/.test(denied), "a step was denied its own folders");
    expect(/^Read\(\/\/[a-z]\//.test(access.denied[0]) || access.denied[0].startsWith('Read(///'), 'the permission rules do not use absolute paths');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }

  const args = claudeArgs({ model: 'm', attribution: false, mcpServers: mcp.servers, disallowed: ['Read(//x/**)'], tools: ['Bash'] });
  const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
  const userFolder = `${path.join(os.homedir(), '.claude').replaceAll('\\', '/')}/**`;
  expect(args[args.indexOf('--setting-sources') + 1] === 'project,local', 'the steps would load the user settings');
  expect(args.includes('--strict-mcp-config') && JSON.parse(args[args.indexOf('--mcp-config') + 1]).mcpServers.browser, 'the MCP servers do not come only from Chiefmate');
  expect(settings.claudeMdExcludes?.includes(userFolder), "the user's ~/.claude/CLAUDE.md is not excluded");

  const doc = [
    '# Environments', '// selection: one', '## Office', 'Work from {PLACE}.', 'PLACE = the office',
    '# Projects', '// selection: one', '## Sample project', '// tags: code', '// access: browser', '// CODE = SAMPLE',
    'Work on {CODE}. When you finish, push to GitHub.', 'Never push without review.',
    '# Modules', '// selection: several', '## Board', '// requires: Confirmation', 'Update the card.',
    '## Unused module', 'Nothing.',
    '# Automatic', '// selection: automatic', '## Code rules', '// tags: code', 'Keep the comments.',
    '## Browser access', '// tags: browser', 'Ask the owner to sign in.', '## Confirmation', '// include with: Other', 'Confirm first.',
    '## Book', '// tags: book', 'Nothing.',
  ].join('\n');
  const built = assemble(parseBlocks(doc), { blockName: 'Sample project', environment: 'Office', modules: ['Board'] });
  // "requires" only allows a block (it brings nothing): Board stays, and its unmet requirement is reported.
  expect(built.blocks.join() === 'Office,Sample project,Board,Code rules,Browser access', `the prompt builder chose the wrong blocks: ${built.blocks.join()}`);
  expect(built.missing.join() === 'requirement of "Board": Confirmation', `an unmet requirement was not reported: ${built.missing.join()}`);
  expect(built.text.includes('## Sample project') && built.text.includes('Work on SAMPLE.') && built.text.includes('Work from the office.'), "the prompt builder's variables or headings are wrong");
  expect(built.adaptations.length === 1 && built.text.includes('Never push without review.'), "the prompt builder's adaptation to the crew's rules is wrong");

  // The document's own format (in Portuguese, escaped as Google Docs exports it): a variable inside another one's value,
  // "incluir com" by tags (comma: all; bar: any; "sempre"; "acessos"), "requer", "rótulo" and the ready combinations.
  const docPt = [
    '# COMO USAR', '// seleção: ignorar', 'Help text.',
    '# AMBIENTES', '// seleção: uma  ', '// rótulo: Ambiente', '## Casa', '// tags: casa  ', '// REPO \\= {REPO\\_NOME}, in the Sample folder', 'At home.',
    '## Trabalho', '// tags: trabalho', 'At work.',
    '# ACESSO', '// seleção: automática', '## Browser', '// incluir com: acessos', '// ACESSOS \\= the services I name', 'Wait for my sign-in ({ACESSOS}).',
    '# PROJETOS', '// seleção: uma', '// rótulo: Projeto', '// DOCS \\= folder Docs{SIGLA}', '## Alpha', '// tags: código  ', '// SIGLA \\= ALPHA  ', '// REPO\\_NOME \\= alpha',
    'Read {DOCS}, then the repository ({REPO}). Also {PASTA\\_X}.',
    '# REGRAS', '// seleção: automática', '## Code rules', '// incluir com: código', 'Keep comments.', '## Library', '// incluir com: casa \\| trabalho', 'The library.',
    '## Both', '// incluir com: código, trabalho', 'Only with both.', '## Always', '// incluir com: sempre', 'Always.',
    '# MÓDULOS', '// seleção: várias', '## Start', '// requer: código', 'Start it.', '## Book reader', '// requer: livro', 'Read the book.', '## Board', '// acessos: Board, Mail', 'Update the card.',
    '# COMBINAÇÕES PRONTAS', '// seleção: combinações', '', 'Alpha at home \\= Alpha \\+ Casa \\+ Start', '', 'Alpha at work \\= Alpha \\+ Trabalho \\+ Board',
  ].join('\n');
  const sectionsPt = parseBlocks(docPt);
  const home = assembleBlocks(sectionsPt, ['Alpha', 'Casa', 'Start']);
  expect(home.blocks.join() === 'Casa,Alpha,Code rules,Library,Always,Start', `the automatic blocks did not come in by their tags: ${home.blocks.join()}`);
  expect(home.text.includes('Read folder DocsALPHA, then the repository (alpha, in the Sample folder).'), `a variable inside another one was not filled in: ${home.text}`);
  expect(home.text.includes('## Ambiente: Casa') && home.text.includes('## Projeto: Alpha') && home.unresolved.join() === 'PASTA_X', `the labels or the unfilled variables are wrong: ${home.unresolved.join()}`);
  const { combinations, composeChoice } = await import(src('prompts.mjs'));
  expect(combinations(sectionsPt).map(c => `${c.name}=${c.blocks.join('+')}`).join() === 'Alpha at home=Alpha+Casa+Start,Alpha at work=Alpha+Trabalho+Board', 'the ready combinations were not read');
  const work = composeChoice(sectionsPt, { chosen: ['Alpha', 'Trabalho', 'Board'], off: ['Always'] });
  expect(work.blocks.join() === 'Trabalho,Browser,Alpha,Code rules,Library,Both,Board' && work.off.join() === 'Always', `a choice with an automatic block turned off is wrong: ${work.blocks.join()}`);
  expect(work.text.includes('Wait for my sign-in (Board and Mail).') && work.unavailable.join() === 'Book reader', `the accesses or the blocks not allowed are wrong: ${work.unavailable.join()}`);

  // A live session: the blocks its profile names, by name in any section, with what they bring; nothing adapted.
  const session = assembleBlocks(parseBlocks(doc), ['Sample project', 'Office', 'Nowhere']);
  expect(session.blocks.join() === 'Office,Sample project,Code rules,Browser access', `a session got the wrong blocks: ${session.blocks.join()}`);
  expect(session.text.includes('Work on SAMPLE. When you finish, push to GitHub.') && !session.adaptations.length && session.missing.join() === 'block: Nowhere', "a session's blocks were adapted, or a missing block was not reported");
  const sessionTemp = mkdtempSync(path.join(os.tmpdir(), 'chiefmate-smoke-session-'));
  try {
    const builder = path.join(sessionTemp, 'builder.md');
    writeFileSync(builder, doc);
    const sessionConfig = {
      owner: 'Owner', language: 'en', projects: {}, prompt_builder: { file: builder },
      sessions: { review: { name: 'Review', tool: 'claude', cwd: sessionTemp, prompt_blocks: ['Sample project'], model: 'some-model' } },
    };
    const plan = planSession(sessionConfig, 'review');
    expect(plan.folder.dir === path.resolve(sessionTemp) && plan.prompt.text.includes('Work on SAMPLE.') && plan.prompt.text.startsWith('# Review'), "a session's folder or first message is wrong");
    const claude = sessionArgs({ tool: 'claude', cwd: sessionTemp, model: 'some-model' }, sessionConfig, 'Hello');
    expect(claude.at(-1) === 'Hello' && claude[claude.indexOf('--setting-sources') + 1] === 'project,local' && claude.includes('--strict-mcp-config'), "a Claude Code session would load the user's own configuration, or lose its first message");
    expect(JSON.parse(claude[claude.indexOf('--settings') + 1]).claudeMdExcludes?.includes(userFolder), "a Claude Code session would read the user's ~/.claude/CLAUDE.md");
    const codex = sessionArgs({ tool: 'codex', cwd: sessionTemp, model: null }, sessionConfig, 'Hello');
    expect(codex.join() === `-C,${sessionTemp},Hello`, `a Codex session's command line is wrong: ${codex.join(' ')}`);
    let refused = false;
    try {
      planSession({ ...sessionConfig, sessions: { x: { tool: 'other', cwd: sessionTemp } } }, 'x');
    } catch {
      refused = true;
    }
    expect(refused, 'a session with an unknown tool was not refused');
    // The app's prompt builder over a copy: the document, a choice put together and remembered (in the smoke's records).
    const builderDoc = path.join(sessionTemp, 'builder-pt.md');
    writeFileSync(builderDoc, docPt);
    const { builderPage, composeFromApp, lastChoice } = await import(src('prompts.mjs'));
    const appConfig = { ...sessionConfig, prompt_builder: { file: builderDoc }, projects: { alpha: { name: 'Alpha', prompt_block: 'Alpha', prompt_modules: ['Start'] } } };
    const page = builderPage(appConfig, 'alpha');
    expect(page.document.sections.map(s => s.name).join() === 'AMBIENTES,ACESSO,PROJETOS,REGRAS,MÓDULOS' && page.document.combinations.length === 2 && page.defaults.join() === 'Alpha,Start' && page.status.copied && !page.status.stale, `the prompt builder's page is wrong: ${JSON.stringify(page).slice(0, 300)}`);
    const fromApp = composeFromApp(appConfig, { project: 'alpha', chosen: ['Alpha', 'Casa'], off: ['Library'] });
    expect(fromApp.blocks.join() === 'Casa,Alpha,Code rules,Always' && lastChoice('alpha')?.off.join() === 'Library', `a choice in the app was not put together or remembered: ${fromApp.blocks.join()}`);
    expect(fromApp.details.find(d => d.name === 'Alpha')?.how === 'chosen' && fromApp.details.filter(d => fromApp.automatic.includes(d.name)).every(d => d.how !== 'chosen'), `the app's choice does not say how its automatic blocks came in: ${JSON.stringify(fromApp.details.map(d => [d.name, d.how]))}`);

    // The document in a library ("library_file"): read from the library's copy when it is there, else from "file"; a
    // path can't leave its library; "Reload" with an unknown library fails without touching anything; and the
    // document's last commit in a shallow copy is found by deepening it (a made-up repository, through file://).
    const { builderSettings, builderStatus } = await import(src('prompts.mjs'));
    const libConfig = { ...appConfig, library: {}, prompt_builder: { file: builderDoc, library_file: 'no-such-library/PROMPTS/PROMPTS_MONTADOR.md' } };
    const libSettings = builderSettings(libConfig);
    expect(libSettings.origin === 'library' && libSettings.library.path === 'PROMPTS/PROMPTS_MONTADOR.md' && libSettings.file === builderDoc && builderStatus(libConfig).source === 'file', `a library_file without the library's copy did not fall back to the file: ${JSON.stringify(libSettings)}`);
    expect(!builderSettings({ prompt_builder: { library_file: 'lib/../../secret.md' } }).library, 'a library_file leaving its library was accepted');
    expect(builderSettings({ prompt_builder: { file: builderDoc } }).origin === 'file' && builderSettings({ prompt_builder: { file: builderDoc, doc_id: 'x' } }).origin === 'google', "the prompt builder's origin is wrong without a library");
    const { syncPrompts } = await import(src('promptsync.mjs'));
    const libSync = await syncPrompts(libConfig);
    expect(libSync.ok === false && libSync.error.includes('no-such-library'), `reloading from an unknown library did not fail: ${JSON.stringify(libSync)}`);
    const { libraryFileCommit } = await import(src('workspace.mjs'));
    const git = (dir, ...args) => execFileSync('git', ['-c', 'user.name=Smoke', '-c', 'user.email=smoke@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, stdio: 'pipe' });
    const libOrigin = path.join(sessionTemp, 'library-origin');
    mkdirSync(path.join(libOrigin, 'PROMPTS'), { recursive: true });
    git(libOrigin, 'init', '-q', '-b', 'main');
    writeFileSync(path.join(libOrigin, 'PROMPTS', 'doc.md'), docPt);
    git(libOrigin, 'add', '.');
    git(libOrigin, 'commit', '-q', '-m', 'Add the document');
    for (const n of [1, 2]) {
      writeFileSync(path.join(libOrigin, `other-${n}.md`), 'x');
      git(libOrigin, 'add', '.');
      git(libOrigin, 'commit', '-q', '-m', `Other ${n}`);
    }
    const libCopy = path.join(sessionTemp, 'library-copy');
    git(sessionTemp, 'clone', '-q', '--depth', '1', pathToFileURL(libOrigin).href, libCopy);
    const docCommit = await libraryFileCommit(libCopy, path.join(libCopy, 'PROMPTS', 'doc.md'));
    expect(docCommit?.subject === 'Add the document' && !docCommit.approximate && !Number.isNaN(Date.parse(docCommit.date)), `the document's last commit in a shallow copy is wrong: ${JSON.stringify(docCommit)}`);
    expect(!existsSync(path.join(libCopy, '.git', 'FETCH_HEAD')), "deepening the library's history changed the date of its last update (FETCH_HEAD)");
    const written = planSession(sessionConfig, 'review', { prompt: '  My own prompt.  ' });
    expect(written.prompt.text === 'My own prompt.' && written.prompt.written, "a prompt written in the prompt builder is not a session's first message as it is");
    expect(sessionIdOf('"C:\\nodejs\\node.exe" "C:\\chiefmate\\src\\cli.mjs" session-run 2026-01-02-0900-review') === '2026-01-02-0900-review' && sessionIdOf('node src/cli.mjs server') === null, "a session's window process is not recognized");

    // A project's page: the automatic session profile (only for a tool the settings have no profile of), opened in
    // the owner's clone with the project's block and the environment; the folder, VS Code and the development
    // environment as dry runs. Nothing opens.
    const projects = await import(src('projects.mjs'));
    const { devIdOf } = await import(src('machine.mjs'));
    const { sessionProfiles } = await import(src('sessions.mjs'));
    const clone = path.join(sessionTemp, 'clone');
    mkdirSync(clone);
    const pageConfig = {
      ...sessionConfig, default_model: 'some-model', prompt_builder: { file: builder, environment: 'Office' },
      projects: { alpha: { name: 'Alpha', about: 'A sample.', local_clone: clone, prompt_block: 'Sample project', dev_start: 'npm run dev' }, beta: { name: 'Beta' } },
      sessions: { mine: { name: 'Mine', tool: 'codex', project: 'alpha', cwd: sessionTemp } },
    };
    const auto = sessionProfiles(pageConfig).filter(p => p.auto);
    expect(auto.map(p => p.id).join() === 'project-alpha-claude,project-beta-claude,project-beta-codex', `the automatic session profiles are wrong: ${auto.map(p => p.id).join()}`);
    expect(auto[0].prompt_blocks.join() === 'Sample project,Office' && auto[0].model === 'some-model' && !auto[1].prompt_blocks.length, "an automatic profile did not get the project's block and the environment");
    const { profileFor } = await import(src('sessions.mjs'));
    expect(profileFor(pageConfig, 'alpha', 'codex') === 'mine' && profileFor(pageConfig, 'alpha', 'claude') === 'project-alpha-claude', "the prompt builder's live session would not use the project's profile for the tool");
    const { writtenInstructions } = await import(src('prompts.mjs'));
    const sent = writtenInstructions('Work on it. Then push to GitHub.');
    expect(sent.adaptations.length === 1 && sent.text.startsWith('Work on it.'), "a prompt sent with a task was not adapted to the crew's rules");
    const opened = planSession(pageConfig, 'project-alpha-claude');
    expect(opened.folder.dir === path.resolve(clone) && opened.prompt.text.includes('Project: Alpha. A sample.') && opened.prompt.text.includes('Work on SAMPLE.') && opened.prompt.text.includes('Work from the office.'), `an automatic session did not open in the clone with the project's prompt: ${opened.prompt.text.slice(0, 300)}`);
    let noClone = false;
    try {
      planSession(pageConfig, 'project-beta-codex');
    } catch {
      noClone = true;
    }
    expect(noClone, "an automatic session of a project without the owner's clone was not refused");
    const folder = projects.openProjectApp('alpha', 'folder', { dryRun: true, config: pageConfig });
    expect(folder.dryRun && folder.dir === path.resolve(clone) && folder.args.join() === path.resolve(clone), `opening the project's folder would not open the clone: ${JSON.stringify(folder)}`);
    process.env.CHIEFMATE_VSCODE = path.join(sessionTemp, 'Code.exe');
    const code = projects.openProjectApp('alpha', 'vscode', { dryRun: true, config: pageConfig });
    expect(code.command === process.env.CHIEFMATE_VSCODE && code.args.join() === path.resolve(clone), `opening VS Code would not open the clone: ${JSON.stringify(code)}`);
    const dev = await projects.startDev('alpha', { dryRun: true, config: pageConfig });
    expect(dev.dryRun && dev.command === 'npm run dev' && dev.cwd === path.resolve(clone) && dev.window.join(' ') === 'dev-run alpha', `the development environment would not run "dev_start" in the clone: ${JSON.stringify(dev)}`);
    let noDev = false;
    try {
      projects.devPlan(pageConfig, 'beta');
    } catch {
      noDev = true;
    }
    expect(noDev, 'a project without "dev_start" was offered a development environment');
    expect(devIdOf('"C:\\nodejs\\node.exe" "C:\\chiefmate\\src\\cli.mjs" dev-run alpha') === 'alpha' && devIdOf('node src/cli.mjs session-run x') === null, "a development environment's window process is not recognized");
    const info = await projects.projectInfo('alpha', pageConfig, { dev: [{ project: 'alpha', pids: [42], ram: 1024 }] });
    expect(info.clone === path.resolve(clone) && info.dev?.status === 'running' && info.dev.ram === 1024 && info.vscode && info.deliver === 'pull_request', `the project's page facts are wrong: ${JSON.stringify(info)}`);

    // A project's Context tab, from made-up settings: each member's parts in order and by source, the blocks and how
    // each came in, an automatic block turned off for the project, what changed since the last recorded step, and the
    // changes previewed and saved (to a made-up place: no settings file is written) with their history.
    const { loadAgents } = await import(src('config.mjs'));
    expect(Object.values(loadAgents({ owner: 'Owner', crew: { writer: { extra_instructions: 'Extra.' } } })).every(a => a.instructions === a.instructionParts.map(p => p.text).join('')), "an agent's instruction parts are not its instructions");
    const ctx = await import(src('context.mjs'));
    const ctxConfig = {
      owner: 'Owner', language: 'en', default_model: 'some-model', prompt_builder: { file: builder, environment: 'Office' },
      crew: { designer: { extra_instructions: 'Installation note.' } },
      projects: { ctx: { name: 'Ctx', about: 'A sample.', main_branch: 'main', prompt_block: 'Sample project', prompt_modules: ['Board'], prompt_exclude: ['Browser access'], agent_notes: { designer: 'Mind the colors.' }, lead: { name: 'Ctx lead' }, crew: ['generalist', 'designer'] } },
    };
    const generalistSystem = ctx.projectContext(ctxConfig, 'ctx', { member: 'generalist', diffs: false, sent: true }).members[0].sent.system;
    const fence = '``````';
    mkdirSync(path.join(data, 'runs', 'smoke-ctx'), { recursive: true });
    writeFileSync(path.join(data, 'runs', 'smoke-ctx.json'), JSON.stringify({ id: 'smoke-ctx', kind: 'task', project: 'ctx', title: 'Ctx run', status: 'done', created: new Date().toISOString(), steps: [{ agent: 'generalist', status: 'done', started: new Date().toISOString() }] }));
    writeFileSync(path.join(data, 'runs', 'smoke-ctx', '01-generalist.context.md'), [
      '# Context received: generalist (step 1), run smoke-ctx', '', '- Model: `old-model`, time limit 60 min', '', '## Tools allowed', '- `Bash`', '',
      '## Prompt builder', '- Blocks: Office, Sample project, Board, Code rules, Browser access', '',
      "## System prompt (added to Claude Code's own)", `${fence}markdown`, generalistSystem, fence, '',
      '## Prompt', `${fence}markdown`, '# Ctx run', '', '## Your part', 'An old task.', '', '## Office', '', 'Work from the office.', '', '## Old section', 'Gone now.', fence, '',
    ].join('\n'));
    const context = ctx.projectContext(ctxConfig, 'ctx');
    const byId = Object.fromEntries(context.members.map(m => [m.id, m]));
    expect(context.members.map(m => m.id).join() === 'generalist,designer,lead,manager', `the context's members are wrong: ${context.members.map(m => m.id).join()}`);
    expect(byId.designer.system.map(p => p.key).join() === 'agent,installation' && byId.lead.system.map(p => p.key).join() === 'agent,lead-role' && byId.designer.prompt.some(p => p.key === 'agent-notes' && p.source === 'projects.ctx.agent_notes.designer'), "the context's parts or sources are wrong");
    const ctxBuilder = byId.generalist.prompt.find(p => p.key === 'builder');
    expect(ctxBuilder?.blocks.map(b => `${b.name}:${b.how}:${b.role ?? ''}`).join() === 'Office:chosen:environment,Sample project:chosen:project block,Board:chosen:module,Code rules:tags:' && ctxBuilder.off.join() === 'Browser access', `the context's blocks or how they came in are wrong: ${JSON.stringify(ctxBuilder?.blocks.map(b => [b.name, b.how, b.role]))}`);
    const changes = byId.generalist.diff?.changes ?? [];
    expect(byId.generalist.diff?.run === 'smoke-ctx' && changes.some(c => c.what === 'model' && c.before === 'old-model') && changes.some(c => c.what === 'section' && c.name === 'Old section' && c.status === 'removed')
      && changes.some(c => c.what === 'blocks' && c.removed.join() === 'Browser access') && !changes.some(c => c.what === 'system' || c.name === 'Your part' || c.name === 'Office') && byId.designer.diff === null,
    `what changed since the last run is wrong: ${JSON.stringify(changes.map(c => [c.what, c.name, c.status]))}`);
    expect(context.sessions.length === 2 && context.sessions.every(s => s.error), "the project's live sessions without the owner's clone did not say why");
    expect(ctx.contextText(context).includes('by a shared tag') && ctx.contextText(context, { full: false }).includes('# Context of Ctx'), 'the context as text is wrong');
    const applied = ctx.applyChanges(ctxConfig, 'ctx', { modules: ['Board', 'Unused module'], exclude: [], notes: 'N', extra: { generalist: 'G', lead: 'L', manager: 'M' }, agentNotes: { designer: '' } });
    const fields = applied.changed.map(c => c.field).join();
    expect(fields === 'projects.ctx.prompt_modules,projects.ctx.prompt_exclude,projects.ctx.notes,projects.ctx.agent_notes.designer,projects.ctx.crew.generalist.extra_instructions,projects.ctx.lead.extra_instructions,crew.manager.extra_instructions'
      && applied.config.projects.ctx.crew[0].extra_instructions === 'G' && applied.config.projects.ctx.lead.extra_instructions === 'L' && !applied.config.projects.ctx.agent_notes && !ctxConfig.projects.ctx.notes, `the context's changes were applied wrong: ${fields}`);
    let wrongBlock = false;
    try {
      ctx.applyChanges(ctxConfig, 'ctx', { modules: ['Board', 'Code rules'] });
    } catch {
      wrongBlock = true;
    }
    expect(wrongBlock, 'an automatic block was accepted as a module');
    const preview = ctx.previewChanges('ctx', { exclude: [] }, ctxConfig);
    expect(preview.changed.length === 1 && preview.members.find(m => m.id === 'generalist')?.added.includes('Ask the owner to sign in.'), "the preview of a change doesn't show what the crew would get");
    let saved = null;
    ctx.saveChanges('ctx', { notes: 'Hello' }, { config: ctxConfig, save: c => (saved = c) });
    expect(saved?.projects.ctx.notes === 'Hello' && ctx.readHistory('ctx')[0]?.changes[0]?.field === 'projects.ctx.notes', "a saved change was not recorded in the project's history");
  } finally {
    rmSync(sessionTemp, { recursive: true, force: true });
  }
} catch (error) {
  failures.push(`unit checks: ${error.message}`);
}

try {
  rmSync(data, { recursive: true, force: true, maxRetries: 5 });
} catch {
  // a temporary folder left behind is harmless
}

if (failures.length) {
  console.error(`Smoke test failed:\n${failures.map(f => `  - ${f}`).join('\n')}\n\nServer output:\n${output}`);
  process.exitCode = 1;
} else {
  console.log(`OK: a temporary Chiefmate answered on port ${port}.`);
}
