// Starts a temporary Chiefmate on a spare port (only the app and the API: no queue, no schedule, no updates)
// and checks that everything answers. Usage: npm run smoke
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SAMPLE_CSV, SAMPLE_PNG, sampleXlsx } from './fixtures.mjs';

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
// The remote access through Tailscale Serve, made up: a second listener, with a tailnet name and a login of its own.
const remote = { enabled: true, host: 'pc.smoke-tailnet.ts.net', logins: ['owner@example.com'], port: port + 1 };
// The file viewer's extra folder, made up: an image, a CSV, a workbook, and files it must never open.
const files = mkdtempSync(path.join(os.tmpdir(), 'chiefmate-smoke-files-'));
mkdirSync(path.join(files, 'designs'));
writeFileSync(path.join(files, 'designs', 'proposal-1.png'), SAMPLE_PNG);
writeFileSync(path.join(files, 'designs', 'proposal-2.png'), SAMPLE_PNG);
writeFileSync(path.join(files, 'sales.csv'), SAMPLE_CSV);
writeFileSync(path.join(files, 'budget.xlsx'), sampleXlsx());
writeFileSync(path.join(files, 'page.html'), '<script>alert(1)</script>');
writeFileSync(path.join(files, '.env'), 'TOKEN=made-up');
const child = spawn(process.execPath, [path.join(root, 'src', 'cli.mjs'), 'server'], {
  cwd: root,
  env: { ...process.env, CHIEFMATE_PORT: String(port), CHIEFMATE_SMOKE: '1', CHIEFMATE_REMOTE_ACCESS: JSON.stringify(remote), CHIEFMATE_VIEWER: JSON.stringify({ extra_roots: [files] }) },
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
    // The app's refresh: compressed, and an unchanged state (apart from "now") answers 304 with no body. (node:http,
    // as fetch hides the compression.)
    const { get } = await import('node:http');
    const read = headers => new Promise((resolve, reject) => {
      get({ host: '127.0.0.1', port, path: '/api/state', headers: { host: `localhost:${port}`, ...headers } }, r => {
        let size = 0;
        r.on('data', d => (size += d.length));
        r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, size }));
      }).on('error', reject);
    });
    const packed = await read({ 'accept-encoding': 'gzip' });
    expect(packed.status === 200 && packed.headers['content-encoding'] === 'gzip' && packed.size > 0, '/api/state is not compressed with gzip');
    let unchanged = false;
    for (let i = 0; i < 5 && packed.headers.etag && !unchanged; i++) {
      if (i) await new Promise(r => setTimeout(r, 200));
      const again = await read({ 'if-none-match': packed.headers.etag });
      unchanged = again.status === 304 && again.size === 0;
    }
    expect(unchanged, '/api/state has no tag, or an unchanged state did not answer 304');
    for (const key of ['now', 'version', 'language', 'ai', 'update', 'projects', 'missions', 'crew', 'teams', 'needs', 'prompts', 'focus', 'running', 'current', 'parallel', 'sessions', 'queue', 'history', 'usage', 'manager', 'computer', 'plan', 'planning', 'alerts', 'attention', 'decisions']) {
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
    // Phones (the 600 px blocks of ui/style.css): 15 px text, no type under 11 px, the sections' descriptions folded,
    // and the band at the top kept for what needs the owner (no info notices there).
    const styles = await (await fetch(`${base}/style.css`)).text();
    const phoneCss = [];
    for (let at = styles.indexOf('@media (max-width: 600px)'); at >= 0; at = styles.indexOf('@media (max-width: 600px)', at + 1)) {
      let depth = 0, end = styles.indexOf('{', at);
      const start = end;
      for (; end < styles.length; end++) if (styles[end] === '{') depth++; else if (styles[end] === '}' && --depth === 0) break;
      phoneCss.push(styles.slice(start + 1, end));
    }
    const phone = phoneCss.join('\n');
    const tiny = [...phone.matchAll(/font-size: ([\d.]+)px/g)].filter(m => Number(m[1]) < 11 && Number(m[1]) > 0).map(m => m[0]);
    expect(/(^|\n)\s*body \{ font-size: 15px; \}/.test(phone) && !tiny.length, `the phone layout's type is off (15 px text, nothing under 11 px): ${tiny.join(', ')}`);
    expect(/\.view-header p[^{]*\{ display: none; \}/.test(phone), "the phone layout shows the sections' descriptions");
    const appJs = await (await fetch(`${base}/app.js`)).text();
    expect(/phone && i\.level === 'info'/.test(appJs.slice(appJs.indexOf('function drawAlerts'), appJs.indexOf('function drawNavAttention'))), "a phone's band also shows the info notices");
    // Each decision card shows its approval level; those of level 1 fold apart and don't count in the menu's mark.
    const navCode = appJs.slice(appJs.indexOf('function navSections'), appJs.indexOf('function drawNavAttention'));
    expect(/approvalBadge\(c\)/.test(appJs) && /managerSettles\(c\)/.test(navCode) && /fold\('manager'/.test(appJs) && /\.decision-approval\[data-approval="3"\]/.test(styles),
      'the decision cards lack their approval level, or the level 1 cards still count as needing the owner');
    // A project's page: its tabs (the prompt builder's screen moves into the last one) and the prompt shown by blocks.
    const html = await (await fetch(`${base}/`)).text();
    // The decisions in a tab of their own, and the focus mode: the conversation alone, nothing over it or beside it;
    // an urgent tab pulses, and stands still (lit) with reduced motion.
    expect(['view-decisions', 'decisions', 'focus-mode', 'focus-bar'].every(id => html.includes(`id="${id}"`)) && html.includes('href="#decisions"')
      && !/id="chat"[^]*?<\/section>/.exec(html)?.[0].includes('id="decisions"'), 'the app lacks the Decisions tab or the focus mode, or the decisions are still in the conversation');
    expect(/html\.chat-focus \.titlebar, html\.chat-focus \.nav, html\.chat-focus \.alerts, html\.chat-focus \.statusbar/.test(styles)
      && /prefers-reduced-motion: reduce\) \{ \.nav a\[data-level="urgent"\][^}]*animation: none/.test(styles), 'the focus mode leaves a bar or band on screen, or an urgent tab pulses with reduced motion');
    expect(['project-status', 'project-actions', 'project-more', 'project-needs', 'project-overview', 'project-crew', 'project-tasks', 'project-planning', 'project-context', 'project-builder', 'builder-body', 'builder-view', 'builder-edit']
      .every(id => html.includes(`id="${id}"`)), "the app's page lacks a part of the project's page or of the prompt builder");
    const unsigned = await fetch(`${base}/api/limits`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(unsigned.status === 403, `a command without the x-chiefmate header answered ${unsigned.status} instead of 403`);
    const machine = await (await fetch(`${base}/api/computer`)).json();
    expect(machine.memory?.total > 0 && Array.isArray(machine.projects), '/api/computer has no memory or projects');
    // Commands that must refuse without changing anything (the settings are the installation's own).
    const post = (route, body) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', 'x-chiefmate': '1' }, body: JSON.stringify(body) });
    // Attention: the board's item waiting for the owner (#7) is an important notice; marked as seen, it fades.
    const proposal = state.attention.items.find(i => i.id.startsWith('plan:7:'));
    expect(proposal?.level === 'important' && proposal.kind === 'proposal' && !proposal.seen && state.attention.counts.important >= 1 && state.attention.top,
      `the board's item waiting for the owner is not an important notice: ${JSON.stringify(state.attention)}`);
    if (proposal) {
      expect((await post('/api/attention/seen', { ids: [proposal.id] })).ok, 'marking a notice as seen failed');
      const after = (await (await fetch(`${base}/api/state`)).json()).attention;
      const faded = after.items.find(i => i.id === proposal.id);
      expect(faded?.seen && after.counts.important === state.attention.counts.important - 1, 'a notice marked as seen did not fade');
      const archived = await (await fetch(`${base}/api/attention/archived`)).json();
      expect(typeof after.archived === 'number' && Array.isArray(archived.items) && archived.items.length === after.archived, `the archive's count or list is missing: ${JSON.stringify([after.archived, archived])}`);
    }
    // Away mode from the app's button: on, in /api/state, then off (the smoke test's server tells no manager).
    const awayOn = await (await post('/api/away', { on: true })).json();
    const awayState = (await (await fetch(`${base}/api/state`)).json()).away;
    const awayOff = await (await post('/api/away', { on: false })).json();
    expect(awayOn.away?.since && awayState?.since === awayOn.away.since && awayOff.away === null && state.away === null, `the away mode's button did not turn it on and off: ${JSON.stringify({ awayOn, awayState, awayOff })}`);
    expect(html.includes('id="away"'), "the app's title bar has no away mode button");
    // The autopilot's panel in the Usage section: its state, and limits refused before anything is saved.
    const ap = state.autopilot;
    expect(ap && typeof ap.enabled === 'boolean' && ap.stop_at_5h_window > 0 && ap.week_pace > 0 && Array.isArray(ap.queued) && Array.isArray(ap.wakes) && (ap.enabled || ap.blocked?.reason === 'off'),
      `/api/state has no autopilot's state: ${JSON.stringify(ap)}`);
    expect(html.includes('id="autopilot"') && html.includes('id="autopilot-form"'), "the Usage section has no autopilot's panel");
    expect((await post('/api/autopilot', { quiet_hours: 'soon' })).status === 400 && (await post('/api/autopilot', { week_pace: 'much' })).status === 400, "the autopilot's invalid limits were not refused");
    expect((await post('/api/stop-project', { project: 'none' })).status === 400, 'stopping a project without a confirmed list was not refused');
    expect((await post('/api/reset-grants', { action: 'used', index: 9999 })).status === 400, 'marking a free reset that does not exist was not refused');
    // Updates are off in the smoke test: "update now" and "update check" answer so, and nothing is fetched or installed.
    expect(['pause', 'wait'].includes(state.update.mode) && state.update.installing === null, `/api/state has no update mode, or an update going on: ${JSON.stringify(state.update)}`);
    expect((await post('/api/update-now', {})).status === 400 && (await post('/api/update-check', {})).status === 400, 'an update was tried in the smoke test, where updates are off');
    expect(Array.isArray(state.teams) && state.teams.every(x => x.project && Array.isArray(x.members)), '/api/state has no crews by project');
    expect(Array.isArray(state.needs), "/api/state has no list of the owner's requests");
    expect((await post('/api/needs-you', { what: 'Sign in' })).status === 400, 'a request for the owner without a run was not refused');
    // A merge needs a finished run with a pull request or a branch in the owner's clone.
    expect((await post('/api/merge', { run: 'smoke-feed', preview: true })).status === 400 && (await post('/api/merge', { run: 'no-such-run' })).status === 400, 'a merge of a run with nothing to merge was not refused');
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
    expect((await post('/api/session/say', { id: 'no-such-session', text: 'Hello' })).status === 400, 'a message to a session that does not exist was not refused');
    expect((await fetch(`${base}/api/session/no-such-session`)).status >= 400, 'the conversation of a session that does not exist was given');
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
    const deciding = (await (await fetch(`${base}/api/state`)).json()).attention.items.find(i => i.id === `decide:${p}`);
    expect(deciding?.level === 'important' && deciding.kind === 'decision' && deciding.view === 'planning', `a triaged proposal is not an important notice: ${JSON.stringify(deciding)}`);
    expect((await post('/api/planning', { action: 'approve', id: p })).status === 400, 'an item of a project not in the settings was approved');
    const dropped = await itemOf(await post('/api/planning', { action: 'discard', id: p, reason: 'Not now.' }));
    expect(dropped?.status === 'discarded' && dropped.discard_reason === 'Not now.' && dropped.rank === null, `a proposal was not discarded with its reason: ${JSON.stringify(dropped)}`);
    const back = await itemOf(await post('/api/planning', { action: 'restore', id: p }));
    expect(back?.status === 'triaged', `a discarded proposal did not come back to the owner's decision: ${JSON.stringify(back)}`);
    const later = await itemOf(await post('/api/planning', { action: 'later', id: p }));
    expect(later?.status === 'future' && later.rank === null, `"later" did not leave the item for the future: ${JSON.stringify(later)}`);
    expect((await post('/api/planning', { action: 'reorder', ids: [999] })).status === 400, 'reordering an item that does not exist was not refused');
    expect(['proposed', 'triaged', 'approved', 'discarded'].every(s => state.planning.statuses.includes(s)), 'the board has no statuses for the proposals');
    // The project radar: ideas added with scores and sources, ordered by potential, and the owner's decisions ("I want
    // this" puts a proposal on the planning board, under "radar", for the manager).
    expect(Array.isArray(state.radar?.ideas) && state.radar.statuses?.join() === 'new,studying,chosen,discarded,project', '/api/state has no project radar');
    const ideaOf = async r => (r.ok ? (await r.json()).idea : { error: (await r.json()).error });
    const idea = {
      action: 'add', title: 'Smoke idea', summary: 'One sentence.', potential: 3, effort: 2, risk: 4, problem: 'A problem.', market: 'Large.',
      competitors: ['Rival https://example.com/rival', 'No site'], sources: ['A study https://example.com/study'], series: '2024:40,2025:55',
    };
    const smokeIdea = await ideaOf(await post('/api/radar', idea));
    expect(smokeIdea?.id === 1 && smokeIdea.status === 'new' && smokeIdea.scores.potential === 3 && smokeIdea.sources[0]?.url === 'https://example.com/study'
      && smokeIdea.fundamentals.competitors.length === 2 && smokeIdea.fundamentals.competitors[1].url === '' && smokeIdea.series.at(-1)?.value === 55, `a radar idea was not added: ${JSON.stringify(smokeIdea)}`);
    expect((await post('/api/radar', { ...idea, title: 'smoke  IDEA' })).status === 400, 'a radar idea repeating a title was not refused');
    expect((await post('/api/radar', { ...idea, title: 'No source', sources: [] })).status === 400, 'a radar idea without a source was not refused');
    expect((await post('/api/radar', { ...idea, title: 'Bad link', sources: ['Click javascript:alert(1)'] })).status === 400, 'a source without an http(s) link was not refused');
    expect((await post('/api/radar', { ...idea, title: 'Bad competitor', competitors: [{ name: 'X', url: 'javascript:alert(1)' }] })).status === 400, 'a competitor with a script link was not refused');
    expect((await post('/api/radar', { ...idea, title: 'Bad score', potential: 6 })).status === 400, 'a score above 5 was not refused');
    const second = await ideaOf(await post('/api/radar', { ...idea, title: 'Smoke better idea', potential: 5 }));
    const ideas = (await (await fetch(`${base}/api/state`)).json()).radar.ideas;
    expect(ideas.map(i => i.id).join() === `${second.id},1`, `the radar is not ordered by potential: ${ideas.map(i => i.id)}`);
    const chosen = await ideaOf(await post('/api/radar', { action: 'choose', id: second.id }));
    const chosenItem = (await (await fetch(`${base}/api/state`)).json()).planning.items.find(i => i.id === chosen?.plan);
    expect(chosen?.status === 'chosen' && chosenItem?.project === 'radar' && chosenItem.status === 'proposed' && chosenItem.description.includes(`radar idea #${second.id}`), `"I want this" did not put the idea on the planning board: ${JSON.stringify({ chosen, chosenItem })}`);
    expect((await post('/api/radar', { action: 'choose', id: second.id })).status === 400, 'an idea was chosen twice');
    await post('/api/planning', { action: 'discard', id: chosen?.plan, reason: 'Smoke.' }); // out of the proposals checked below
    const inStudy = await ideaOf(await post('/api/radar', { action: 'later', id: 1 }));
    expect(inStudy?.status === 'studying', `"Later" did not leave the idea in study: ${JSON.stringify(inStudy)}`);
    const discarded = await ideaOf(await post('/api/radar', { action: 'discard', id: 1, reason: 'Too crowded.' }));
    expect(discarded?.status === 'discarded' && discarded.discard_reason === 'Too crowded.', `an idea was not discarded: ${JSON.stringify(discarded)}`);
    const restored = await ideaOf(await post('/api/radar', { action: 'restore', id: 1 }));
    expect(restored?.status === 'new' && !restored.discard_reason, `a discarded idea did not come back: ${JSON.stringify(restored)}`);
    const became = await ideaOf(await post('/api/radar', { action: 'set', id: second.id, status: 'virou projeto', project: 'sample' }));
    expect(became?.status === 'project' && became.project === 'sample', `an idea was not marked as a project: ${JSON.stringify(became)}`);
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
    // The remote access: the headers Tailscale Serve would send, made up (fetch can't set Host, so node:http).
    const http = await import('node:http');
    const ask = (p, route, headers, body) => new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port: p, path: route, method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json', ...headers } : headers }, res => {
        let text = '';
        res.on('data', d => (text += d));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
      });
      r.on('error', reject);
      r.end(body ? JSON.stringify(body) : undefined);
    });
    const tailnet = { host: remote.host, 'tailscale-user-login': 'Owner@example.com' };
    const command = { ...tailnet, origin: `https://${remote.host}`, 'x-chiefmate': '1' };
    const page = await ask(remote.port, '/', tailnet);
    expect(page.status === 200 && page.headers['x-content-type-options'] === 'nosniff' && /frame-ancestors 'none'/.test(page.headers['content-security-policy'] ?? ''),
      `the app through the remote access answered ${page.status}, or without its safety headers`);
    expect((await ask(remote.port, '/api/state', { host: remote.host })).status === 403, 'the remote access answered without a Tailscale login');
    expect((await ask(remote.port, '/api/state', { ...tailnet, 'tailscale-user-login': 'someone@example.com' })).status === 403, 'the remote access answered a login not allowed');
    expect((await ask(remote.port, '/api/state', { ...tailnet, host: `127.0.0.1:${remote.port}` })).status === 403, 'the remote access answered an address other than the tailnet name');
    expect((await ask(remote.port, '/api/manager/interrupt', command, {})).status === 200, 'a command through the remote access, with the tailnet name and an allowed login, was refused');
    expect((await ask(remote.port, '/api/manager/interrupt', { ...command, origin: 'https://evil.example' }, {})).status === 403, 'a command from another website through the remote access was not refused');
    const { origin: _origin, ...noOrigin } = command;
    expect((await ask(remote.port, '/api/manager/interrupt', noOrigin, {})).status === 403, 'a command without Origin through the remote access was not refused');
    const opens = await ask(remote.port, '/api/project/open', command, { project: 'none', app: 'folder' });
    expect(opens.status === 403 && JSON.parse(opens.text).error?.includes('computer'), `opening a window on the computer from another device was not refused: ${opens.status}`);
    expect((await ask(remote.port, '/api/project/open', command, { project: 'none', app: 'folder', dryRun: true })).status !== 403, 'a dry run of opening a folder was refused through the remote access');
    expect((await ask(port, '/api/state', tailnet)).status === 403, "the app's own port answered the tailnet name");

    // The file viewer: an image, a CSV and a workbook open, read only, with the safety headers; what is outside its
    // folders, protected or asked by another site is refused; the remote access asks for its login here too.
    const fileUrl = (what, p, extra = '') => `/api/files/${what}?path=${encodeURIComponent(p)}${extra}`;
    const image = await fetch(`${base}${fileUrl('raw', path.join(files, 'designs', 'proposal-1.png'))}`);
    const imageBytes = Buffer.from(await image.arrayBuffer());
    expect(image.status === 200 && image.headers.get('content-type') === 'image/png' && imageBytes.equals(SAMPLE_PNG)
      && image.headers.get('x-content-type-options') === 'nosniff' && image.headers.get('cache-control') === 'no-store'
      && /sandbox/.test(image.headers.get('content-security-policy') ?? '') && image.headers.get('cross-origin-resource-policy') === 'same-origin',
    `the viewer did not send the image with its safety headers: ${image.status} ${[...image.headers].join('; ')}`);
    const imageInfo = await (await fetch(`${base}${fileUrl('info', path.join(files, 'designs', 'proposal-2.png'))}`)).json();
    expect(imageInfo.kind === 'image' && imageInfo.size === SAMPLE_PNG.length && imageInfo.gallery?.length === 2, `an image's facts or its gallery are wrong: ${JSON.stringify(imageInfo)}`);
    const csv = await (await fetch(`${base}${fileUrl('table', path.join(files, 'sales.csv'))}`)).json();
    expect(csv.rows?.length === 3 && csv.rows[1][1] === 'Porto Alegre' && csv.truncated === false, `the CSV did not open as a table: ${JSON.stringify(csv).slice(0, 300)}`);
    const book = await (await fetch(`${base}${fileUrl('table', path.join(files, 'budget.xlsx'))}`)).json();
    expect(book.sheets?.join('|') === 'Sales|Notes & more' && book.rows?.[1]?.[2] === '2026-03-01', `the workbook did not open as a table: ${JSON.stringify(book).slice(0, 300)}`);
    const sheet2 = await (await fetch(`${base}${fileUrl('table', path.join(files, 'budget.xlsx'), '&sheet=1')}`)).json();
    expect(sheet2.sheet === 1 && sheet2.rows?.[0]?.[0] === 'Only note', "the workbook's second sheet did not open");
    const listed = await (await fetch(`${base}${fileUrl('list', files)}`)).json();
    expect(listed.entries?.map(e => e.name).join('|') === 'designs|budget.xlsx|page.html|sales.csv', `the folder's list is wrong, or shows a protected file: ${JSON.stringify(listed.entries?.map(e => e.name))}`);
    const htmlFile = await fetch(`${base}${fileUrl('raw', path.join(files, 'page.html'))}`);
    expect(/^attachment/.test(htmlFile.headers.get('content-disposition') ?? '') && htmlFile.headers.get('content-type') === 'application/octet-stream', 'an HTML file was not sent as a download');
    expect((await fetch(`${base}${fileUrl('raw', path.join(files, '.env'))}`)).status === 403, 'the viewer opened a .env file');
    expect((await fetch(`${base}${fileUrl('raw', path.join(files, '..', path.basename(data), 'state.json'))}`)).status === 403, 'the viewer opened a file outside its folders');
    expect((await fetch(`${base}${fileUrl('raw', path.join(root, 'package.json'))}`)).status === 403, "the viewer opened a file outside its folders (Chiefmate's own)");
    expect((await ask(port, fileUrl('raw', path.join(files, 'sales.csv')), { host: `localhost:${port}`, 'sec-fetch-site': 'cross-site' })).status === 403, 'the viewer answered another site');
    expect((await ask(port, fileUrl('raw', path.join(files, 'sales.csv')), { host: `localhost:${port}`, 'sec-fetch-site': 'same-site' })).status === 403, 'the viewer answered another port of this computer');
    expect((await ask(remote.port, fileUrl('info', path.join(files, 'sales.csv')), { host: remote.host })).status === 403, 'the viewer answered the remote access without a Tailscale login');
    expect((await ask(remote.port, fileUrl('info', path.join(files, 'sales.csv')), tailnet)).status === 200, 'the viewer refused the remote access with an allowed login');
    expect((await fetch(`${base}/api/files/run/smoke-feed`)).ok, "a run's files did not answer");
    expect((await fetch(`${base}/api/files/run/..%2Fsmoke-feed`)).status === 404, "a run's files answered a made-up id");

    // The watchdog: its news for the manager (never delivered here), a look that changes nothing, and the rescue
    // actions refused inside a step.
    expect((await post('/api/watchdog', { text: 'smoke' })).status === 200, "the watchdog's news was refused");
    const cli = (args, env = {}) => execFileSync(process.execPath, [path.join(root, 'src', 'cli.mjs'), ...args], { env: { ...process.env, CHIEFMATE_PORT: String(port), ...env }, stdio: 'pipe', windowsHide: true, encoding: 'utf8' });
    // The manager's question with buttons (ask-owner): a card with one button per option; the answer closes it (the
    // news never reaches a manager here; CHIEFMATE_RUN emptied, as when the crew runs this). A step asks with needs-you.
    const askedOut = cli(['ask-owner', 'Ship it?', '--context', 'Two lines of why.', '--options', 'Yes|No|Wait', '--recommend', 'wait', '--level', '2'], { CHIEFMATE_RUN: '' });
    const cardsNow = async () => (await (await fetch(`${base}/api/state`)).json()).decisions ?? [];
    const questionCard = (await cardsNow()).find(c => c.kind === 'question' && c.title === 'Ship it?');
    expect(askedOut.includes('Question #') && questionCard?.options?.join('|') === 'Yes|No|Wait' && questionCard.recommend === 'Wait' && questionCard.what === 'Two lines of why.' && questionCard.approval === 2,
      `the manager's question is not a card with its options: ${askedOut} ${JSON.stringify(questionCard)}`);
    expect((await post('/api/decide', { card: questionCard?.id, action: 'answer', option: 'Maybe' })).status !== 200, 'an answer that is not one of the options was accepted');
    expect((await post('/api/decide', { card: questionCard?.id, action: 'answer', option: 'no' })).ok && !(await cardsNow()).some(c => c.id === questionCard?.id),
      'answering a question from its card failed, or the card stayed');
    // The manager's approval level for a run (cli.mjs level, through the running Chiefmate): kept in the run's record.
    const runLevel = () => JSON.parse(readFileSync(path.join(data, 'runs', 'smoke-feed.json'), 'utf8')).level;
    const leveled = cli(['level', 'smoke-feed', '1']);
    expect(/Level 1/.test(leveled) && runLevel() === 1, `the run's approval level was not set: ${leveled}`);
    expect((await post('/api/level', { run: 'smoke-feed', level: '7' })).status !== 200, 'an unknown approval level was accepted');
    cli(['level', 'smoke-feed', 'none']);
    expect(runLevel() === null, "the run's approval level was not cleared");
    let askRefused = false;
    try {
      cli(['ask-owner', 'From a step?'], { CHIEFMATE_RUN: 'x' });
    } catch {
      askRefused = true;
    }
    expect(askRefused, 'a step of a run asked the owner with ask-owner');
    const look = JSON.parse(cli(['watch', '--dry-run', '--json']));
    expect(look.health === true && Array.isArray(look.problems) && !look.rescue && !look.problems.some(p => p.id === 'server_down'), `the watchdog's look is wrong: ${JSON.stringify(look)}`);
    expect(!existsSync(path.join(data, 'watch', 'state.json')), "the watchdog's dry run saved its state");
    let rescueRefused = false;
    try {
      cli(['rescue', 'restart', '--dry-run'], { CHIEFMATE_RUN: 'x' });
    } catch (error) {
      rescueRefused = /rescuer's and the owner's/.test(String(error.stderr));
    }
    expect(rescueRefused, 'a rescue action ran inside a step');

    // The radar from the command line: added (through the running Chiefmate), listed, and the owner's decisions
    // refused inside a step.
    const cliAdded = cli(['radar', 'add', 'Smoke CLI idea', '--summary', 'From the command line.', '--potential', '4', '--effort', '3', '--risk', '2',
      '--source', 'Report https://example.com/report', '--source', 'Survey https://example.com/survey', '--competitor', 'Rival https://example.com/r'], { CHIEFMATE_RUN: 'x' });
    expect(/^Added #3 /.test(cliAdded) && /Smoke CLI idea/.test(cli(['radar', 'list'])), `the radar command did not add or list an idea: ${cliAdded}`);
    expect(/Sources: Report https:\/\/example.com\/report; Survey/.test(cli(['radar', 'show', '3'])), "the radar command does not show an idea's sources");
    let decisionRefused = false;
    try {
      cli(['radar', 'choose', '3'], { CHIEFMATE_RUN: 'x' });
    } catch (error) {
      decisionRefused = /only adds and updates/.test(String(error.stderr));
    }
    expect(decisionRefused, "a step of a run made the owner's decision on a radar idea");
  }
} catch (error) {
  failures.push(error.message);
} finally {
  child.kill();
}

// The watchdog's checks, in this process with made-up states: no AI, nothing stopped, nothing told.
try {
  const watch = await import(pathToFileURL(path.join(root, 'src', 'watch.mjs')).href);
  const at = Date.parse('2026-01-05T12:00:00Z');
  const ago = minutes => new Date(at - minutes * 60_000).toISOString();
  const memory = { free: 8, total: 16 };
  const healthy = { running: [], queue: [], parallel: { max: 3 }, update: { waiting: 0, installing: null, mode: 'pause' }, sessions: { open: [] }, computer: { chiefmate: { ram: 1 } } };
  const ids = problems => problems.map(p => `${p.id}:${p.level}`).join(',');
  expect(watch.findProblems({ health: true, state: healthy, memory, at }).length === 0, 'the watchdog found a problem in a healthy Chiefmate');
  expect(ids(watch.findProblems({ health: false, state: null, memory, at })) === 'server_down:stuck', 'the watchdog missed a Chiefmate that does not answer');
  const stuckQueue = { ...healthy, queue: [{ id: 'q1', title: 'Q', project: 'p', status: 'queued' }, { id: 'q2', title: 'W', project: 'p2', status: 'waiting' }] };
  expect(ids(watch.findProblems({ health: true, state: stuckQueue, memory, at })) === 'queue_stuck:pending', 'a queue seen stuck once was not left pending');
  expect(ids(watch.findProblems({ health: true, state: stuckQueue, memory, seen: { queue_stuck: ago(20) }, at })) === 'queue_stuck:stuck', 'a queue stuck for 20 minutes was missed');
  expect(watch.findProblems({ health: true, state: { ...stuckQueue, update: { ...healthy.update, installing: { since: ago(5) } } }, memory, seen: { queue_stuck: ago(20) }, at }).length === 0, 'a queue held by an update was taken as stuck');
  const silent = { ...healthy, running: [{ id: 'r1', title: 'R', project: 'p', stepStarted: ago(90), actions: [{ at: ago(70) }] }] };
  expect(ids(watch.findProblems({ health: true, state: silent, memory, at })) === 'run_silent:r1:stuck', 'a run silent for 70 minutes was missed');
  expect(watch.findProblems({ health: true, state: { ...silent, running: [{ ...silent.running[0], needsYou: 1 }] }, memory, at }).length === 0, 'a run waiting for the owner was taken as silent');
  expect(ids(watch.findProblems({ health: true, state: { ...healthy, update: { ...healthy.update, installing: { since: ago(80), stage: 'pausing' } } }, memory, at })) === 'update_stuck:stuck', 'an update installing for 80 minutes was missed');
  const waiting = { ...healthy, update: { ...healthy.update, waiting: 2, blocked: 'changes' } };
  expect(ids(watch.findProblems({ health: true, state: waiting, memory, seen: { update_waiting: ago(150) }, at })) === 'update_waiting:warn', 'a blocked update waiting for hours was not a warning');
  expect(watch.findProblems({ health: true, state: { ...waiting, update: { waiting: 2, mode: 'wait' }, running: [{ id: 'r', project: 'p', actions: [{ at: ago(1) }] }] }, memory, seen: { update_waiting: ago(150) }, at }).length === 0, 'an update waiting for the crew in "wait" mode was taken as a problem');
  expect(ids(watch.findProblems({ health: true, state: healthy, memory: { free: 1, total: 16 }, at })) === 'memory_low:warn', 'low memory was missed');
  // Orphans: only the crew's kinds of process, alive for long, whose parent is gone or took a newer process's id.
  const list = [
    { pid: 1, parent: 0, name: 'explorer.exe', cmd: '', created: ago(600) },
    { pid: 10, parent: 99, name: 'git.exe', cmd: 'git fetch', created: ago(40) },
    { pid: 11, parent: 99, name: 'git.exe', cmd: 'git fetch', created: ago(5) },
    { pid: 12, parent: 1, name: 'git.exe', cmd: 'git status', created: ago(40) },
    { pid: 13, parent: 99, name: 'claude.exe', cmd: 'claude', created: ago(40) },
    { pid: 14, parent: 99, name: 'claude.exe', cmd: 'claude -p --output-format stream-json', created: ago(40) },
    { pid: 15, parent: 16, name: 'codex.exe', cmd: 'codex exec --json', created: ago(40) },
    { pid: 16, parent: 1, name: 'cmd.exe', cmd: 'cmd', created: ago(10) },
    { pid: 17, parent: 99, name: 'node.exe', cmd: 'node src/cli.mjs server', created: ago(40) },
    { pid: 18, parent: 99, name: 'git.exe', cmd: 'git fsmonitor--daemon run --detach', created: ago(40) },
  ];
  expect(watch.orphansIn(list, at).map(p => p.pid).join(',') === '10,14,15', `the orphans are wrong: ${watch.orphansIn(list, at).map(p => p.pid)}`);
  const prompt = watch.rescuePrompt({ problems: [{ level: 'stuck', text: 'Something stuck.' }] }, { owner: 'Owner', language: 'pt-BR' });
  expect(/rescue restart/.test(prompt) && /stop-orphans/.test(prompt) && /rescue resume/.test(prompt) && /Never change a file/.test(prompt) && /Brazilian Portuguese/.test(prompt), "the rescuer's instructions lack its closed list or rules");
  const defaults = watch.watchSettings({ default_model: 'm' });
  expect(defaults.rescuer && defaults.model === 'm' && defaults.maxMinutes === 15 && defaults.everyMinutes === 60, `the watchdog's defaults are wrong: ${JSON.stringify(defaults)}`);
} catch (error) {
  failures.push(`watchdog checks: ${error.message}`);
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
  // Away mode: the manager is told whatever "manager_updates" says; while away, the events that only inform wait and
  // the others still go; back, the held ones go with "back", for the summary. Still into the busy manager's queue.
  const { readPending } = await import(pathToFileURL(path.join(root, 'src', 'store.mjs')).href);
  const settle = () => new Promise(resolve => setTimeout(resolve, 100));
  const away = { owner: 'Owner', manager_updates: ['run_failed', 'needs_you'] };
  const gone = news.setAway(true, away);
  await settle();
  const leaving = readPending().find(m => m.from === 'chiefmate');
  expect(gone?.since && gone.held === 0 && leaving?.events.map(e => e.kind).join() === 'away' && composeMessage('Owner', [leaving]).includes('For the away event'), `turning away mode on did not tell the manager: ${JSON.stringify(leaving)}`);
  removePending(leaving.id);
  news.reportEvent('run_failed', 'Run d failed', { config: away });
  news.reportEvent('needs_you', 'Run e needs Owner', { config: away });
  const urgent = await news.flushNews();
  expect(news.awayInfo()?.held === 1 && urgent?.events.map(e => e.kind).join() === 'needs_you' && composeMessage('Owner', [urgent]).includes('Owner is away'), `while away, an event that only informs was not held, or one that needs the owner was: ${JSON.stringify(urgent)}`);
  removePending(urgent.id);
  news.setAway(false, away);
  await settle();
  const summary = readPending().find(m => m.from === 'chiefmate');
  expect(!news.awayInfo() && summary?.events.map(e => e.kind).join() === 'run_failed,back' && composeMessage('Owner', [summary]).includes('summary of the time away'), `back from away mode, the held events did not go with "back": ${JSON.stringify(summary)}`);
  removePending(summary.id);
  // An owner's merge that fails on a conflict (a local branch, in a made-up clone): the manager is told at once, without
  // waiting for the minute, with git's output and the board item; the error says so. The manager's own failure is not news.
  const { mergeRun } = await import(pathToFileURL(path.join(root, 'src', 'merge.mjs')).href);
  const { saveRun: keepRun } = await import(pathToFileURL(path.join(root, 'src', 'store.mjs')).href);
  const clone = mkdtempSync(path.join(os.tmpdir(), 'chiefmate-smoke-merge-'));
  try {
    const g = (...a) => execFileSync('git', ['-C', clone, '-c', 'user.name=smoke', '-c', 'user.email=smoke@example.com', ...a], { stdio: 'pipe' });
    g('init', '-q', '-b', 'main');
    writeFileSync(path.join(clone, 'a.txt'), 'one\n');
    g('add', '-A');
    g('commit', '-qm', 'one');
    g('checkout', '-qb', 'cm/conflict');
    writeFileSync(path.join(clone, 'a.txt'), 'branch\n');
    g('commit', '-qam', 'branch');
    g('checkout', '-q', 'main');
    writeFileSync(path.join(clone, 'a.txt'), 'main\n');
    g('commit', '-qam', 'main');
    const mergeConfig = { owner: 'Owner', projects: { mp: { local_clone: clone, main_branch: 'main' } } };
    keepRun({ id: 'smoke-merge-fail', project: 'mp', title: 'Conflicting work', status: 'done', branch: 'cm/conflict', delivered: clone, plan: 7 });
    const failed = await mergeRun('smoke-merge-fail', { by: 'owner' }, mergeConfig).then(() => null, error => error);
    await settle();
    const told = readPending().find(m => m.from === 'chiefmate');
    const event = told?.events.find(e => e.kind === 'merge_failed');
    expect(failed?.conflict && failed.message.includes('The manager was told') && event?.text.includes('a conflict with main') && event.text.includes('#7') && event.text.includes('cm/conflict')
      && composeMessage('Owner', [told]).includes('For the merge_failed events'), `a failed merge of the owner's did not reach the manager at once: ${failed?.message} ${JSON.stringify(told)}`);
    if (told) removePending(told.id);
    const own = await mergeRun('smoke-merge-fail', { by: 'manager' }, mergeConfig).then(() => null, error => error);
    await settle();
    expect(own && !own.message.includes('The manager was told') && !readPending().some(m => m.from === 'chiefmate'), "the manager's own failed merge was told to it as news");
  } finally {
    rmSync(clone, { recursive: true, force: true });
  }
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
  saveRun(Object.assign(run, { merged: { at: new Date().toISOString(), by: 'owner', how: 'pr' } }));
  expect(planItem(3).status === 'done', 'the item of a merged run did not become done');
  saveRun(Object.assign(run, { status: 'failed', pullRequest: null, merged: null }));
  expect(planItem(3).status === 'todo', 'the item of a failed run did not go back to "todo"');
  const line = planningLine('Owner');
  expect(line.includes('#3 Sample: First thing') && line.includes('waiting for Owner: #7'), `the manager's summary of the board is wrong: ${line}`);
} catch (error) {
  failures.push(`planning checks: ${error.message}`);
}

// The manager's line about the radar (the ideas the server checks above added, in the same records).
try {
  const { radarLine } = await import(pathToFileURL(path.join(root, 'src', 'radar.mjs')).href);
  const line = radarLine('Owner');
  expect(/^Project radar \(node src\/cli.mjs radar\): 2 new idea\(s\) waiting for Owner: #3 Smoke CLI idea \(potential 4/.test(line), `the manager's line about the radar is wrong: ${line}`);
} catch (error) {
  failures.push(`radar checks: ${error.message}`);
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

// The autopilot, in this process with made-up settings and usage: its limits, the empty queue that wakes the manager
// once, the approval it refuses and the daily report (the news never reaches the manager here; nothing starts).
try {
  process.env.CHIEFMATE_SMOKE = '1';
  const autopilot = await import(pathToFileURL(path.join(root, 'src', 'autopilot.mjs')).href);
  const planning = await import(pathToFileURL(path.join(root, 'src', 'planning.mjs')).href);
  const { readState, saveState } = await import(pathToFileURL(path.join(root, 'src', 'store.mjs')).href);
  const { newsMessage } = await import(pathToFileURL(path.join(root, 'src', 'manager.mjs')).href);
  const defaults = autopilot.autopilotSettings({});
  expect(!defaults.enabled && defaults.week_pace === 0.95 && defaults.stop_at_5h_window === 0.85 && !defaults.quiet_hours && defaults.daily_report === '08:00', `the autopilot's defaults are wrong: ${JSON.stringify(defaults)}`);
  const quiet = autopilot.parseQuietHours('23:00-07:00');
  const at = (h, m = 0) => new Date(2026, 0, 5, h, m);
  expect(autopilot.inQuietHours(quiet, at(23, 30)) && autopilot.inQuietHours(quiet, at(6, 59)) && !autopilot.inQuietHours(quiet, at(7)) && !autopilot.parseQuietHours('soon'), 'the quiet hours across midnight are wrong');
  const on = autopilot.autopilotSettings({ autopilot: { enabled: true, quiet_hours: '23:00-07:00' } });
  const later = h => new Date(Date.now() + h * 3600_000).toISOString();
  const week = (used, daysLeft) => ({ seven_day: { used, resets: later(daysLeft * 24) } });
  expect(autopilot.blockReason(defaults, {})?.includes('off') && autopilot.blockReason(on, {}, at(2))?.includes('quiet hours'), 'the autopilot acted while off or in quiet hours');
  expect(autopilot.blockReason(on, { five_hour: { used: 0.9, resets: later(2) } }, at(12))?.includes('5-hour'), 'the autopilot acted above the 5-hour limit');
  expect(autopilot.blockReason(on, week(0.6, 3.5), at(12))?.includes('pace') && autopilot.blockReason(on, week(0.4, 3.5), at(12)) === null, "the week's pace is not respected");
  expect(autopilot.blockInfo(on, { five_hour: { used: 0.9, resets: later(2) } }, at(12))?.reason === 'window' && autopilot.blockInfo(on, {}, at(2))?.quiet === '23:00-07:00', "the autopilot's reason to wait, for the app, is wrong");
  // The app's switch and limits, validated only (dryRun: the settings are the installation's own).
  const changed = autopilot.changeAutopilot({ enabled: true, week_pace: '0.8', stop_at_5h_window: 2, quiet_hours: '22:00-06:30', daily_report: 'off' }, { config: { autopilot: { enabled: false } }, dryRun: true });
  expect(changed.enabled === true && changed.week_pace === 0.8 && changed.stop_at_5h_window === 1 && changed.quiet_hours === '22:00-06:30' && changed.daily_report === false, `the autopilot's settings from the app are wrong: ${JSON.stringify(changed)}`);
  const invalid = body => { try { autopilot.changeAutopilot(body, { config: {}, dryRun: true }); return false; } catch { return true; } };
  expect(invalid({ quiet_hours: '7-8' }) && invalid({ daily_report: '25:00' }) && invalid({ week_pace: '' }), "the autopilot's invalid settings were accepted");
  const config = { owner: 'Owner', projects: { Auto: {} }, autopilot: { enabled: true, daily_report: false } };
  const item = planning.proposeItem({ project: 'Auto', title: 'Smoke autopilot item', agent: 'someone', by: 'manager' });
  planning.triageItem(item.id, { recommend: 'now' });
  const idle = await autopilot.checkAutopilot({ config, usage: {}, runs: [] });
  expect(idle.woke.join() === 'Auto', `an empty queue with an item triaged "now" did not wake the manager: ${JSON.stringify(idle)}`);
  expect((await autopilot.checkAutopilot({ config, usage: {}, runs: [] })).woke.length === 0, 'the same empty queue woke the manager twice');
  expect(!autopilot.idleProjects(config, [{ id: 'r', project: 'Auto', status: 'queued' }]).has('Auto'), 'a project with a run queued counted as idle');
  const refused = async (cfg, usage) => autopilot.autopilotApprove(item.id, { config: cfg, usage }).then(() => false, () => true);
  expect(await refused({ ...config, autopilot: { enabled: false } }, {}) && await refused(config, { five_hour: { used: 0.95, resets: later(1) } }), 'the autopilot approved while off or above its limits');
  expect(newsMessage('Owner', [{ kind: 'idle', text: 'Empty', at: new Date().toISOString() }]).includes('plan approve <n> --autopilot'), 'the idle news does not tell the manager how to queue the next item');
  const state = readState();
  state.autopilot = { ...state.autopilot, log: [{ at: new Date().toISOString(), item: item.id, project: 'Auto', title: 'Smoke autopilot item', agent: 'someone' }] };
  saveState(state);
  const daily = { ...config, autopilot: { enabled: true, daily_report: '00:00' } };
  const report = (await autopilot.checkAutopilot({ config: daily, usage: {}, runs: [{ id: 'r', project: 'Auto', status: 'running' }] })).report;
  expect(report?.text?.includes(`#${item.id} Auto: "Smoke autopilot item"`), `the daily report does not list what the autopilot queued: ${JSON.stringify(report)}`);
  expect((await autopilot.checkAutopilot({ config: daily, usage: {}, runs: [{ id: 'r', project: 'Auto', status: 'running' }] })).report === null, 'the daily report went twice in a day');
  const today = autopilot.autopilotStatus(daily, {});
  expect(today.queued.some(e => e.item === item.id && e.status === planning.planItem(item.id).status) && today.wakes.some(w => w.project === 'Auto') && today.blocked === null, `the app does not get what the autopilot did today: ${JSON.stringify(today)}`);
} catch (error) {
  failures.push(`autopilot checks: ${error.message}`);
}

// The direct talk with an agent at work, in this process: a made-up step going on (nothing real runs), then a
// stand-in for Claude Code (a small script) interrupted at a safe point and resumed with the owner's message.
try {
  const src = file => pathToFileURL(path.join(root, 'src', file)).href;
  const { live } = await import(src('runs.mjs'));
  const { pendingTalk, talkSection, talkSituation, talkTo, ownerTurn } = await import(src('talk.mjs'));
  const { askOwner, finishRequest, pollRequest } = await import(src('needs.mjs'));
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
  // A question from the step: one button per option, the recommended one among them; it always waits, and the
  // option clicked is the answer the waiting command hands over.
  const asked = await askOwner({ run: run.id, step: 1, what: 'Resend or SES?', options: 'Resend|SES', recommend: 'resend', why: 'Simpler to set up.' });
  expect(asked.wait && asked.options.join() === 'Resend,SES' && asked.recommend === 'Resend' && asked.why === 'Simpler to set up.', `a question was not recorded with its options and recommendation: ${JSON.stringify(asked)}`);
  let outside = false;
  try {
    finishRequest(run.id, asked.id, 'owner', 'Mailgun');
  } catch {
    outside = true;
  }
  finishRequest(run.id, asked.id, 'owner', 'ses');
  const chosen = pollRequest(run.id, asked.id);
  expect(outside && chosen.status === 'done' && chosen.answer === 'SES', `the option clicked did not answer the question, or an answer outside the options was taken: ${JSON.stringify(chosen)}`);
  let single = false;
  try {
    await askOwner({ run: run.id, step: 1, what: 'Only one?', options: 'Yes' });
  } catch {
    single = true;
  }
  expect(single, 'a question with a single option was accepted');
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
  // A run preparing its working copy (a download, say) has it stopped at once.
  live.set('smoke-pause-b', { run: 'smoke-pause-b', project: 'b', actions: [], process: null, preparing: new AbortController() });
  const asked = pauseAll();
  expect(asked.join() === 'smoke-pause-a,smoke-pause-b' && interrupts === 1 && live.get('smoke-pause-b').pauseRequest && !pauseLive('smoke-pause-a') && interrupts === 1, `the runs going on were not asked to pause once each: ${asked}`);
  expect(live.get('smoke-pause-b').preparing.signal.aborted, 'a pause for an update did not stop the preparation of a working copy');
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
  let waitingShown = '';
  const hooks = {
    pollMs: 10,
    pauseRuns: () => (busy > 1 ? ['smoke-pause-a'] : []),
    // What the app shows while pausing: the runs the update waits for, with what they are doing.
    crewWaiting: () => [{ run: 'smoke-pause-a', title: 'Run A', project: 'a', doing: 'preparing the working copy' }],
    crewBusy: () => {
      waitingShown ||= (update.updateInfo.installing?.waitingFor ?? []).map(w => `${w.title}: ${w.doing}`).join();
      return busy-- > 0;
    },
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
  expect(waitingShown === 'Run A: preparing the working copy' && job.waitingFor.length === 0, `the update did not say which runs it waits for while pausing, or kept them after: ${waitingShown}`);

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

// A command stopped by its time limit or by a pause ends with every process it started (on Windows, git's download
// helper outlived git and held its output open); a working copy is made borrowing your own clone's objects, and a
// preparation stopped, or a lock left by a git cut off, leaves nothing in the way of the next one.
{
  const src = file => pathToFileURL(path.join(root, 'src', file)).href;
  const { prepareWorkspace, run } = await import(src('workspace.mjs'));
  const { WORKSPACES } = await import(src('util.mjs'));
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const alive = pid => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const tree = "const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'inherit' }); console.log('grandchild ' + c.pid); setTimeout(() => {}, 60000);";
  for (const how of ['timeout', 'aborted']) {
    let grandchild = 0;
    try {
      const controller = new AbortController();
      if (how === 'aborted') setTimeout(() => controller.abort(), 1500);
      const started = Date.now();
      const r = await run(process.execPath, ['-e', tree], root, { maxMinutes: how === 'timeout' ? 0.025 : 5, signal: controller.signal });
      grandchild = Number(r.output.match(/grandchild (\d+)/)?.[1]) || 0;
      expect(r.stopped === how && r.code !== 0, `a command was not reported as stopped (${how}): ${JSON.stringify(r)}`);
      await pause(500);
      // The whole tree is ended on Windows only (taskkill /T); elsewhere the command itself.
      if (process.platform === 'win32') expect(grandchild && !alive(grandchild) && Date.now() - started < 8000, `a command stopped (${how}) left a process it started running`);
    } catch (error) {
      failures.push(`stopping a command (${how}): ${error.message}`);
    } finally {
      if (grandchild && alive(grandchild)) process.kill(grandchild);
    }
  }

  const temp = mkdtempSync(path.join(os.tmpdir(), 'chiefmate-smoke-clone-'));
  const hadWorkspaces = existsSync(WORKSPACES);
  const id = `smoke-${process.pid}`;
  const copy = path.join(WORKSPACES, id);
  try {
    const origin = path.join(temp, 'origin');
    const mine = path.join(temp, 'mine');
    const g = (dir, ...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=smoke', '-c', 'user.email=smoke@example.com', ...a], { stdio: 'pipe' });
    mkdirSync(origin);
    g(origin, 'init', '-q', '-b', 'main');
    writeFileSync(path.join(origin, 'a.txt'), 'one\n');
    g(origin, 'add', '-A');
    g(origin, 'commit', '-qm', 'one');
    execFileSync('git', ['clone', '-q', origin, mine], { stdio: 'pipe' });
    const project = { repository: origin, local_clone: mine };
    const stopped = new AbortController();
    stopped.abort();
    const refused = await prepareWorkspace(id, project, 'main', () => {}, { signal: stopped.signal }).then(() => null, error => error);
    expect(refused?.name === 'AbortError' && !existsSync(copy) && !existsSync(`${copy}.partial`), `a preparation stopped by a pause did not stop, or left a copy behind: ${refused?.message}`);
    const dir = await prepareWorkspace(id, project, 'main');
    const alternates = readFileSync(path.join(dir, '.git', 'objects', 'info', 'alternates'), 'utf8').trim().replaceAll('\\', '/').toLowerCase();
    expect(alternates.endsWith(`${path.basename(temp)}/mine/.git/objects`.toLowerCase()) && existsSync(path.join(dir, 'a.txt')), `the first copy of a project did not borrow the objects of your own clone: ${alternates}`);
    writeFileSync(path.join(dir, '.git', 'index.lock'), '');
    await prepareWorkspace(id, project, 'main');
    expect(!existsSync(path.join(dir, '.git', 'index.lock')), 'a lock left by a git cut off was not cleared');
  } catch (error) {
    failures.push(`preparing a working copy: ${error.message}`);
  } finally {
    rmSync(copy, { recursive: true, force: true });
    rmSync(`${copy}.partial`, { recursive: true, force: true });
    if (!hadWorkspaces) rmSync(WORKSPACES, { recursive: true, force: true });
    rmSync(temp, { recursive: true, force: true });
  }
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

  // The guard of the crew and the manager: a publication written any way is refused and noted; nothing else is.
  const { crewGuard } = await import(src('runs.mjs'));
  const guardDir = mkdtempSync(path.join(os.tmpdir(), 'chiefmate-guard-'));
  try {
    const guardLog = path.join(guardDir, 'guard.jsonl');
    const guarded = JSON.parse(claudeArgs({ model: 'm', hooks: crewGuard(guardLog) }).find((a, i, all) => all[i - 1] === '--settings'));
    const hook = guarded.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command ?? '';
    const refuses = command => /"permissionDecision":"deny"/.test(execFileSync(hook, { shell: true, encoding: 'utf8', input: JSON.stringify({ tool_name: 'Bash', tool_use_id: 't', tool_input: { command } }) }));
    const publish = ['git -C . push origin main', 'gh api repos/a/b/pulls -f title=T -f head=h', 'cd x && git push', 'bash -c "gh pr create --fill"', 'git -c a=b remote add up u'];
    const wrong = [...publish.filter(c => !refuses(c)), ...['git status', 'gh api repos/a/b/pulls', 'git commit -m "no git push here"'].filter(refuses)];
    const noted = readFileSync(guardLog, 'utf8').trim().split('\n').length;
    expect(hook.includes('guard.mjs') && !hook.includes('--allow') && !wrong.length && noted === publish.length,
      `the guard of the crew and the manager misjudged what publishes: ${JSON.stringify({ hook, wrong, noted })}`);
  } finally {
    rmSync(guardDir, { recursive: true, force: true });
  }

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

// Titles, summaries and final summaries (src/digest.mjs): the fallbacks, the parsing of a report, "doing now", and
// the quick model's call made through a stand-in for Claude Code (nothing real starts).
try {
  const src = file => pathToFileURL(path.join(root, 'src', file)).href;
  const digest = await import(src('digest.mjs'));
  const { claudeArgs, describeDoing } = await import(src('claude.mjs'));
  const { t } = await import(src('i18n.mjs'));
  const long = "Before anything else: 'git fetch origin' and merge origin/main into the current branch, solving the conflicts there are. Then run the tests.";
  const title = digest.shortTitle(long);
  expect(title.length <= digest.TITLE_MAX && title.startsWith('Before anything else') && title.endsWith('…'), `the fallback title is wrong: ${title}`);
  expect(digest.shortTitle('# Fix the login\n\nMore here.') === 'Fix the login', 'the fallback title kept markdown or more than the first sentence');
  expect(digest.shortSummary('One. Two is here. Three.') === 'One. Two is here.', 'the fallback summary is not the first sentences');

  const outcome = { done: ['Added short titles', 'Folded the reports'], change: 'Each run says what it does in one line.', needs: null };
  for (const lang of ['en', 'pt-BR']) {
    const report = `# Report\n\n${digest.outcomeMarkdown(outcome, lang)}\n\n### ${digest.outcomeLabels(lang).full}\nThe details.`;
    const parsed = digest.parseOutcome(report, [lang]);
    expect(JSON.stringify(parsed.outcome) === JSON.stringify(outcome) && parsed.rest === 'The details.', `the final summary at the top of a report (${lang}) was not read: ${JSON.stringify(parsed)}`);
  }
  const needs = digest.parseOutcome('### What was done\n- A\n### What changes for you\nB.\n### Needs you?\nYes: sign in to X.\n\nThe rest.');
  expect(needs.outcome?.needs === 'sign in to X.' && needs.rest === 'The rest.', `"Needs you?" was read wrong: ${JSON.stringify(needs)}`);
  expect(digest.parseOutcome('Just a report.').outcome === null, 'a report without a final summary got one');
  expect(digest.mergeOutcomes([{ outcome: { done: ['a', 'b'], change: 'x', needs: null } }, { outcome: { done: ['c', 'd'], change: 'y', needs: 'z' } }])?.done.join() === 'a,b,c'
    && digest.mergeOutcomes([{}]) === null, "the steps' summaries were not put together");
  expect(describeDoing('Bash', { command: 'npm run smoke' }) === t('running the tests') && describeDoing('Read', { file_path: 'C:/x/src/runs.mjs' }) === t('reading the code ({file})', { file: 'runs.mjs' }),
    '"doing now" is wrong for a test command or a file read');
  const quickArgs = claudeArgs({ model: 'haiku', noTools: true });
  expect(quickArgs.at(-2) === '--tools' && quickArgs.at(-1) === '', 'the quick call does not turn every tool off');
  expect(await digest.askQuick('Hello', { quick_model: false }) === null, 'the quick call ran with "quick_model" off');

  // A stand-in answers the quick call: the run gets its title and summary, and keeps what was given.
  const fake = path.join(data, 'fake-quick.mjs');
  writeFileSync(fake, [
    "process.stdin.resume(); process.stdin.on('end', () => {",
    "  const tools = process.argv.indexOf('--tools');",
    "  const text = tools > 0 && process.argv[tools + 1] === '' ? JSON.stringify({ title: 'Builder: highlight the blocks', summary: 'Shows the blocks. So the owner sees them.' }) : 'tools were on';",
    "  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text, num_turns: 1 }));",
    '});',
  ].join('\n'));
  process.env.CHIEFMATE_CLAUDE = fake;
  const { describeLater } = await import(src('runs.mjs'));
  const { readRun, saveRun } = await import(src('store.mjs'));
  saveRun({ id: 'brief-test', kind: 'task', project: 'none', title: 'Old: the start of the instruction', instruction: 'Highlight the blocks of the builder.', status: 'done', steps: [] });
  saveRun({ id: 'brief-given', kind: 'task', project: 'none', title: 'Given', summary: 'Given too.', briefBy: { title: 'given', summary: 'given' }, instruction: 'x', status: 'done', steps: [] });
  await describeLater('brief-test');
  const described = readRun('brief-test');
  expect(described.title === 'Builder: highlight the blocks' && described.summary === 'Shows the blocks. So the owner sees them.' && described.briefBy?.title === 'model',
    `an older run did not get its title and summary from the quick model: ${JSON.stringify([described.title, described.summary])}`);
  expect(describeLater('brief-given') === null && readRun('brief-given').title === 'Given', 'a title and summary given by the manager were generated again');
  process.env.CHIEFMATE_CLAUDE = path.join(data, 'no-claude.exe');
} catch (error) {
  failures.push(`titles and summaries: ${error.message}`);
}

// The attention levels, in this process with made-up records (nothing is notified): what is urgent, important and
// info, the seen marks (an info notice goes away), and the urgent Windows notification that stays until seen.
try {
  const src = file => pathToFileURL(path.join(root, 'src', file)).href;
  const { attentionArchive, attentionItems, attentionSummary, checkPullRequests, markSeen, pullRequestTargets } = await import(src('attention.mjs'));
  const { toastXml } = await import(src('notify.mjs'));
  // gh and git stand-ins; a check done now also keeps the background check (real gh) away for its 5 minutes.
  const checked = [];
  const ask = {
    pr: async url => (checked.push(url), url.endsWith('/1') ? 'merged' : url.endsWith('/2') ? 'closed' : 'open'),
    branch: async r => (checked.push(r.branch), r.branch === 'cm/merged'),
  };
  await checkPullRequests([], {}, ask);
  const at = new Date(Date.now() - 3600_000).toISOString();
  const later = new Date(Date.now() + 2 * 3600_000).toISOString();
  const runs = [
    { id: 'a-failed', project: 'p', title: 'Broke', status: 'failed', created: at, ended: at, result: 'tests failed' },
    { id: 'a-pr', project: 'p', title: 'With a PR', status: 'done', created: at, ended: at, pullRequest: 'https://github.com/o/r/pull/1' },
    { id: 'a-done', project: 'p', title: 'Plain task', status: 'done', created: at, ended: at },
    { id: 'a-old', project: 'p', title: 'Old', status: 'failed', created: '2020-01-01T00:00:00Z', ended: '2020-01-01T00:00:00Z' },
  ];
  const input = {
    config: { plan_resets: [{ kind: 'full', expires: later, used: false }] }, runs,
    needs: [{ id: 'r1', run: 'a-run', title: 'Task', what: 'Sign in', at, project: 'p' }, { id: 'r2', kind: 'permission', session: 's1', title: 'Pair', what: 'git push', at, project: 'p' }],
    usage: { five_hour: { used: 0.95, resets: later }, seven_day: { used: 0.75, resets: later } },
    machine: { memory: { free: 1, total: 10 }, projects: [] },
    items: [{ id: 3, title: 'Approve', status: 'waiting_owner', pr: 'https://github.com/o/r/pull/2', project: 'p' }],
    update: { waiting: 1, blocked: 'changes' },
  };
  const list = attentionItems(input);
  const level = id => list.find(i => i.id.startsWith(id))?.level;
  expect(level('needs:') === 'urgent' && level('failed:a-failed') === 'urgent' && level('usage:five_hour') === 'urgent' && level('memory:') === 'urgent' && level('reset:') === 'urgent',
    `an urgent notice is missing or not urgent: ${JSON.stringify(list.map(i => [i.id, i.level]))}`);
  expect(level('usage:seven_day') === 'important' && level('plan:3:') === 'important' && level('pr:a-pr') === 'important' && level('update:') === 'important',
    `an important notice is missing or not important: ${JSON.stringify(list.map(i => [i.id, i.level]))}`);
  expect(level('done:a-done') === 'info' && !list.some(i => i.id === 'failed:a-old') && list[0].level === 'urgent' && list.at(-1).level === 'info', 'the info notices or the order of the levels are wrong');
  expect(attentionSummary(list).top === 'urgent' && !list.find(i => i.kind === 'needs').seenable, "the summary is not urgent, or a step's request can be marked as seen");
  const asked = list.find(i => i.id === 'needs:s1:r2');
  expect(asked?.level === 'urgent' && asked.request.kind === 'permission' && asked.request.session === 's1', "a live session's permission asked is not an urgent notice with its Allow");
  markSeen(['done:a-done', 'failed:a-failed']);
  const again = attentionItems(input);
  expect(!again.some(i => i.id === 'done:a-done') && again.find(i => i.id === 'failed:a-failed')?.seen, 'a seen info notice did not go away, or a seen urgent one did not fade');
  expect(attentionItems({ ...input, runs: [...runs, { id: 'a-redo', project: 'p', title: 'Broke', status: 'running', created: new Date().toISOString() }] }).every(i => i.id !== 'failed:a-failed'), 'a failed run redone still asks for attention');

  // The archive: a pull request merged or closed on GitHub, a branch merged in the owner's clone, a board item done,
  // an info notice seen or a day old, and a cause that ended (and came back). Nothing is lost.
  const why = id => attentionArchive().find(i => i.id.startsWith(id))?.reason;
  expect(why('done:a-done') === 'seen', `a seen info notice did not go to the archive: ${JSON.stringify(attentionArchive())}`);
  const local = { id: 'a-local', project: 'p', title: 'Local', status: 'done', created: at, ended: at, branch: 'cm/merged', delivered: 'C:/clone' };
  const more = {
    ...input, runs: [...runs, local],
    items: [...input.items, { id: 4, title: 'Local branch', status: 'waiting_owner', project: 'p', run: 'a-local' }, { id: 5, title: 'Still waiting', status: 'waiting_owner', project: 'p' }],
  };
  const before = attentionItems(more);
  expect(['pr:a-pr', 'plan:3:', 'plan:4:', 'plan:5:', 'done:a-local'].every(id => before.some(i => i.id.startsWith(id))), `a notice to archive later is missing: ${JSON.stringify(before.map(i => i.id))}`);
  const targets = pullRequestTargets(before, more.runs, more.items);
  await checkPullRequests(targets, {}, ask);
  const askedOnce = checked.length;
  await checkPullRequests(targets, {}, ask);
  expect(askedOnce >= 3 && checked.length === askedOnce, `the pull requests were asked again within 5 minutes, or not at all: ${JSON.stringify(checked)}`);
  const settled = attentionItems(more);
  expect(!settled.some(i => /^(pr:a-pr|plan:3:|plan:4:)/.test(i.id)) && why('pr:a-pr') === 'merged' && why('plan:3:') === 'closed' && why('plan:4:') === 'branch',
    `a merged or closed pull request, or a merged branch, is still waiting for the owner: ${JSON.stringify(attentionArchive())}`);
  expect(settled.some(i => i.id.startsWith('plan:5:')), 'a board item still waiting for the owner left the list');
  const twoDays = new Date(Date.now() - 2 * 86400_000).toISOString();
  attentionItems({
    ...more, machine: { memory: { free: 9, total: 10 }, projects: [] },
    items: more.items.map(i => (i.id === 5 ? { ...i, status: 'done' } : i)), runs: more.runs.map(r => (r.id === 'a-local' ? { ...r, ended: twoDays } : r)),
  });
  expect(why('plan:5:') === 'resolved' && why('memory:low') === 'resolved' && why('done:a-local') === 'expired',
    `a board item done, a cause ended or a day-old info notice did not go to the archive: ${JSON.stringify(attentionArchive().map(i => [i.id, i.reason]))}`);
  const back = attentionItems(more);
  expect(back.some(i => i.id === 'memory:low') && !why('memory:low') && !back.some(i => i.id === 'done:a-local'), 'a cause back did not return to the list, or an expired info notice came back');
  expect(attentionArchive().every(i => i.archived && i.title), 'an archived notice lost what it said');
  // Merged outside Chiefmate (a pull request on GitHub, a branch in the owner's clone): the run is merged, its item done.
  const { readRun, saveRun } = await import(src('store.mjs'));
  const { addItem, planItem, triageItem } = await import(src('planning.mjs'));
  const onGitHub = addItem({ project: 'p', title: 'Merged on GitHub' });
  const inClone = addItem({ project: 'p', title: 'Merged in the clone' });
  saveRun({ id: 'o-pr', project: 'p', title: 'Merged on GitHub', status: 'done', created: at, ended: at, pullRequest: 'https://github.com/o/r/pull/1', plan: onGitHub.id });
  saveRun({ id: 'o-local', project: 'p', title: 'Merged in the clone', status: 'done', created: at, ended: at, branch: 'cm/merged', delivered: 'C:/clone', plan: inClone.id });
  expect(planItem(onGitHub.id).status === 'waiting_owner' && planItem(inClone.id).status === 'waiting_owner', 'a board item with work to merge is not waiting for the owner');
  attentionItems({ config: {}, runs: [readRun('o-pr'), readRun('o-local')], items: [planItem(onGitHub.id), planItem(inClone.id)] });
  expect(readRun('o-pr').merged?.by === 'outside' && readRun('o-pr').merged.how === 'pr' && readRun('o-local').merged?.how === 'local',
    `work merged outside Chiefmate did not mark its run as merged: ${JSON.stringify([readRun('o-pr').merged, readRun('o-local').merged])}`);
  expect(planItem(onGitHub.id).status === 'done' && planItem(inClone.id).status === 'done', 'a board item whose work was merged outside Chiefmate still waits for the owner');
  // Closed on GitHub without a merge: the run is discarded, its item back to the owner's decision (to do, without an agent).
  const closedTriaged = addItem({ project: 'p', title: 'Closed on GitHub', agent: 'generalist' });
  triageItem(closedTriaged.id, { recommend: 'now' });
  const closedPlain = addItem({ project: 'p', title: 'Closed, no agent' });
  saveRun({ id: 'c-pr', project: 'p', title: 'Closed on GitHub', status: 'done', created: at, ended: at, pullRequest: 'https://github.com/o/r/pull/2', plan: closedTriaged.id });
  saveRun({ id: 'c-pr2', project: 'p', title: 'Closed, no agent', status: 'done', created: at, ended: at, pullRequest: 'https://github.com/o/r/pull/2', plan: closedPlain.id });
  attentionItems({ config: {}, runs: [readRun('c-pr'), readRun('c-pr2')], items: [planItem(closedTriaged.id), planItem(closedPlain.id)] });
  expect(readRun('c-pr').discarded?.by === 'outside' && readRun('c-pr').discarded.how === 'pr' && !readRun('c-pr').merged,
    `a pull request closed on GitHub did not mark its run as discarded: ${JSON.stringify(readRun('c-pr'))}`);
  expect(planItem(closedTriaged.id).status === 'triaged' && planItem(closedTriaged.id).rank != null && planItem(closedTriaged.id).recommend === 'later' && planItem(closedPlain.id).status === 'todo',
    `a board item whose pull request was closed without a merge did not go back to the owner's decision: ${JSON.stringify([planItem(closedTriaged.id), planItem(closedPlain.id)])}`);
  const urgent = toastXml('Needs you', 'Sign in', 'chiefmate:operations', { urgent: true });
  expect(urgent.includes('scenario="reminder"') && urgent.includes('activationType="system"') && !toastXml('Done', 'x').includes('scenario'), 'an urgent Windows notification does not stay until seen');
} catch (error) {
  failures.push(`attention levels: ${error.message}`);
}

// The owner's decision cards, in this process with made-up records (no gh, no git, nothing told to the manager): what
// each card says, the project beside the number, a project someone else reviews (no Approve), "not now", the answers
// to the manager's questions and the discards.
try {
  process.env.CHIEFMATE_SMOKE = '1';
  const src = file => pathToFileURL(path.join(root, 'src', file)).href;
  const { addQuestion, decide, decisionCards, openQuestions, verdictRecommendation } = await import(src('decisions.mjs'));
  const { attentionItems } = await import(src('attention.mjs'));
  const { readRun, saveRun } = await import(src('store.mjs'));
  const { planItems, proposeItem, triageItem } = await import(src('planning.mjs'));
  const { t } = await import(src('i18n.mjs'));
  // The recommendation is read after its label in the manager's verdict, not from its first line ("What I fixed: ...").
  const advice = verdictRecommendation(['**What I fixed:** a conflict.', '**Risks:** low.', '**Recommendation:** approve with caveats: check the phone.'].join('\n\n'));
  const inline = verdictRecommendation('What I fixed: nothing. Risks: none. Recommendation: do not approve, the tests fail.');
  expect(advice.short === t('Approve with caveats') && advice.text.startsWith('Approve with caveats: check') && inline.short === t('Do not approve'),
    `the recommendation was not read from the verdict: ${JSON.stringify([advice, inline])}`);
  const config = { projects: { 'zz-p': { name: 'Proj', local_clone: path.join(data, 'no-clone') }, 'zz-q': { name: 'Shared', merge_by_owner: false } } };
  const at = new Date(Date.now() - 3600_000).toISOString();
  const made = [
    { id: 'd-pr', project: 'zz-p', title: 'Better cards', summary: 'Cards with buttons.', status: 'done', created: at, ended: at, pullRequest: 'https://github.com/o/r/pull/34', checks: [{ ok: true }, { ok: false }], outcome: { done: ['Cards'], change: 'You decide with one click.', needs: 'No' }, level: 1 },
    { id: 'd-shared', project: 'zz-q', title: 'Shared fix', status: 'done', created: at, ended: at, pullRequest: 'https://github.com/o/s/pull/9' },
    { id: 'd-local', project: 'zz-p', title: 'Local work', status: 'done', created: at, ended: at, branch: 'cm/local', delivered: path.join(data, 'no-clone') },
  ];
  for (const r of made) saveRun(r);
  const runs = () => made.map(r => readRun(r.id));
  const bad = [{ question: '' }, { question: 'Q', options: 'Only one' }, { question: 'Q', options: 'A|B', recommend: 'C' }, { question: 'Q', options: 'A|B|C|D|E|F|G' }, { question: 'Q', options: 'A|B', project: 'nope' }];
  expect(bad.every(b => {
    try {
      addQuestion(b, config);
      return false;
    } catch {
      return true;
    }
  }), 'a question without text, with one option or too many, a recommendation outside them or an unknown project was accepted');
  const q = addQuestion({ question: 'Publish now?', context: 'It goes live.', options: 'Sim|Não|Esperar', recommend: 'esperar', project: 'zz-p', level: '2' }, config);
  expect(q.recommend === 'Esperar' && addQuestion({ question: 'Plain?' }, config).options.length === 2, 'a question lost its recommendation, or one without options has no Yes and No');
  const item = proposeItem({ project: 'zz-p', title: 'Decision card check', summary: 'First line.\nMore detail.', agent: 'designer', by: 'smoke' });
  expect((() => {
    try {
      triageItem(item.id, { recommend: 'now', level: '5' });
      return false;
    } catch {
      return true;
    }
  })(), 'a triage with an unknown approval level was accepted');
  triageItem(item.id, { recommend: 'now', note: 'Quick win', risk: 'Touches the menu', level: 3 });
  const cardsFor = () => {
    const items = planItems();
    const questions = openQuestions();
    return decisionCards({ config, attention: attentionItems({ config, runs: runs(), items, questions }), items, questions });
  };
  const cards = cardsFor();
  const card = id => cards.find(c => c.id === id);
  const pr = card('pr:d-pr');
  expect(pr?.label === t('PR #{number} of {project}', { number: 34, project: 'Proj' }) && pr.approve && pr.what === 'Cards with buttons.' && pr.change.includes('You decide with one click.')
    && pr.risk.includes(t('{count} check(s) failed: look at them before approving.', { count: 1 })) && !pr.thirdParty, `a pull request's card is wrong: ${JSON.stringify(pr)}`);
  const shared = card('pr:d-shared');
  expect(shared?.thirdParty && !shared.approve && shared.level === 'info' && !shared.change, `a pull request someone else reviews is not a card without Approve: ${JSON.stringify(shared)}`);
  let refused = false;
  try {
    await decide({ card: shared.id, action: 'approve' }, cards);
  } catch {
    refused = true;
  }
  expect(refused, 'a pull request someone else reviews was merged from its card');
  refused = false;
  try {
    await decide({ card: shared.id, action: 'discard' }, cards);
  } catch {
    refused = true;
  }
  expect(refused, 'a pull request someone else reviews was closed from its card');
  const local = card('pr:d-local');
  expect(local?.label === t('Branch {branch} of {project}', { branch: 'cm/local', project: 'Proj' }) && local.approve && !cards.some(c => c.id === 'done:d-local'), `a branch delivered locally is not a card: ${JSON.stringify(local)}`);
  const asked = card(`question:${q.id}`);
  expect(asked?.options.join('|') === 'Sim|Não|Esperar' && asked.recommend === 'Esperar' && asked.what === 'It goes live.', `a question's card is wrong: ${JSON.stringify(asked)}`);
  const proposal = card(`decide:${item.id}`);
  expect(proposal?.risk === 'Touches the menu' && proposal.recommend.includes('Quick win') && proposal.what === 'First line.' && proposal.detail.includes('More detail.')
    && proposal.label === t('Item #{number} of {project}', { number: item.id, project: 'Proj' }), `a proposal's card is wrong: ${JSON.stringify(proposal)}`);
  // The approval level the manager gave each one: on the run, the question and the board's item; none, "?" in the app.
  expect(pr.approval === 1 && asked.approval === 2 && proposal.approval === 3 && local.approval === null && shared.approval === null,
    `the cards' approval levels are wrong: ${JSON.stringify(cards.map(c => [c.id, c.approval]))}`);
  // "Not now" fades the card to the end; it stays pending.
  expect((await decide({ card: 'pr:d-pr', action: 'later' }, cards)).done === 'later', '"not now" failed');
  const faded = cardsFor();
  expect(faded.find(c => c.id === 'pr:d-pr')?.seen && faded.at(-1).seen, 'a card left for later did not fade to the end');
  // An answer (once), a discarded branch and a discarded proposal leave the cards.
  expect((await decide({ card: asked.id, action: 'answer', option: 'esperar' }, cards)).answer === 'Esperar', 'the answer to a question was not recorded');
  let twice = false;
  try {
    await decide({ card: asked.id, action: 'answer', option: 'Sim' }, cards);
  } catch {
    twice = true;
  }
  expect(twice, 'a question was answered twice');
  expect((await decide({ card: local.id, action: 'discard' }, cards)).done === 'discarded' && readRun('d-local').discarded?.by === 'owner', 'a local branch was not discarded from its card');
  await decide({ card: proposal.id, action: 'discard' }, cards);
  const left = cardsFor().map(c => c.id);
  expect(!left.includes(local.id) && !left.includes(asked.id) && !left.includes(proposal.id) && left.includes('pr:d-pr'), `a decided card is still pending: ${JSON.stringify(left)}`);
  expect(planItems().find(i => i.id === item.id)?.status === 'discarded', 'a proposal discarded from its card is not discarded on the board');
} catch (error) {
  failures.push(`decision cards: ${error.message}`);
}

// Live sessions in the app, in this process, with stand-ins for Claude Code and Codex (no real tool, no window): the
// first message is the first turn; the text and the actions go to the history as they happen; a message sent while
// the agent works waits in the queue and goes next, in the same session; a refused push becomes a request that the
// owner allows; an interrupted or ended session carries on in the same conversation; Codex resumes its thread.
try {
  const sessions = await import(pathToFileURL(path.join(root, 'src', 'sessions.mjs')).href);
  const liveDir = mkdtempSync(path.join(os.tmpdir(), 'chiefmate-smoke-live-'));
  const calls = path.join(liveDir, 'calls.jsonl');
  const fakeClaude = path.join(liveDir, 'fake-claude.mjs');
  writeFileSync(fakeClaude, [
    "import { appendFileSync } from 'node:fs';",
    "import { execSync } from 'node:child_process';",
    "const args = process.argv.slice(2);",
    "const id = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : args[args.indexOf('--session-id') + 1];",
    "let prompt = ''; process.stdin.on('data', d => (prompt += d)); process.stdin.on('end', () => {",
    `  appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ tool: 'claude', args, prompt }) + '\\n');`,
    "  if (prompt.includes('already there') && args.includes('--session-id')) { process.stderr.write('Error: Session ID ' + id + ' is already in use.'); process.exit(1); }",
    "  const say = e => process.stdout.write(JSON.stringify(e) + '\\n');",
    "  say({ type: 'system', subtype: 'init', session_id: id, model: 'm' });",
    "  say({ type: 'assistant', message: { content: [{ type: 'text', text: (args.includes('--resume') ? 'Again: ' : 'First: ') + prompt.split('\\n')[0] }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'git status' } }] } });",
    "  say({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } });",
    "  const denials = prompt.includes('push it') ? [{ tool_name: 'Bash', tool_use_id: 't2', tool_input: { command: 'git push origin main' } }] : [];",
    // As Claude Code does: the guard's hook runs before a command, through the shell, with the call on standard input.
    "  if (prompt.includes('through the API')) {",
    "    const hook = JSON.parse(args[args.indexOf('--settings') + 1]).hooks.PreToolUse[0].hooks[0].command;",
    "    const run = command => execSync(hook, { input: JSON.stringify({ tool_name: 'Bash', tool_use_id: 't3', tool_input: { command } }), encoding: 'utf8' });",
    `    appendFileSync(${JSON.stringify(path.join(liveDir, 'guard.txt'))},JSON.stringify([run('cd x && gh api repos/a/b/pulls -f title=T -f head=h'), run('git -C sub push origin main'), run('git status')]));`,
    "  }",
    "  setTimeout(() => say({ type: 'result', subtype: 'success', result: 'done', session_id: id, num_turns: 1, permission_denials: denials }), prompt.includes('take long') ? 20000 : 300);",
    "});",
  ].join('\n'));
  const fakeCodex = path.join(liveDir, 'fake-codex.mjs');
  writeFileSync(fakeCodex, [
    "import { appendFileSync } from 'node:fs';",
    "const args = process.argv.slice(2);",
    "if (args[0] === 'login') process.exit(0);",
    "const thread = args.includes('resume') ? args[args.length - 2] : 'thread-1';",
    "let prompt = ''; process.stdin.on('data', d => (prompt += d)); process.stdin.on('end', () => {",
    `  appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ tool: 'codex', args, prompt }) + '\\n');`,
    "  const say = e => process.stdout.write(JSON.stringify(e) + '\\n');",
    "  say({ type: 'thread.started', thread_id: thread });",
    "  say({ type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'pwsh.exe -Command \"npm test\"', status: 'in_progress' } });",
    "  say({ type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'pwsh.exe -Command \"npm test\"', aggregated_output: 'blocked', exit_code: 1, status: 'failed' } });",
    "  say({ type: 'item.completed', item: { id: 'i2', type: 'file_change', changes: [{ path: 'a.txt', kind: 'add' }], status: 'completed' } });",
    "  say({ type: 'item.completed', item: { id: 'i3', type: 'agent_message', text: 'Codex: ' + prompt.split('\\n')[0] } });",
    "  say({ type: 'turn.completed', usage: {} });",
    "});",
  ].join('\n'));
  Object.assign(process.env, { CHIEFMATE_CLAUDE: fakeClaude, CHIEFMATE_CODEX: fakeCodex });
  const liveConfig = {
    owner: 'Owner', language: 'en', default_model: 'm', projects: {}, mcp_servers: { pw: { command: 'npx', args: ['pw'] }, other: { command: 'x' } },
    sessions: { pair: { name: 'Pair', tool: 'claude', cwd: liveDir, model: 'm', mcp: ['pw'] }, cx: { name: 'Cx', tool: 'codex', cwd: liveDir } },
  };
  const idle = async id => {
    for (let i = 0; i < 150 && (sessions.turnOf(id) || (sessions.readSession(id)?.queue ?? []).length); i++) await new Promise(r => setTimeout(r, 100));
  };
  const called = () => readFileSync(calls, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const kinds = id => sessions.sessionHistory(id).items.map(e => e.kind).join();
  try {
    const s = await sessions.openSession('pair', { config: liveConfig, prompt: 'Start here' });
    expect(s.mode === 'app' && s.status === 'open' && !s.window, `a live session did not open in the app: ${JSON.stringify(s).slice(0, 200)}`);
    const queued = sessions.sayToSession(s.id, 'Second message');
    expect(queued.queued && queued.position === 1, "a message sent while the agent works did not wait in the session's queue");
    await idle(s.id);
    const [first, second] = called();
    const sid = first.args[first.args.indexOf('--session-id') + 1];
    expect(first.prompt === 'Start here' && second?.args[second.args.indexOf('--resume') + 1] === sid && second.prompt.includes('Second message'), 'the second turn did not resume the same Claude Code session with the queued message');
    expect(first.args[first.args.indexOf('--setting-sources') + 1] === 'project,local' && first.args.includes('--strict-mcp-config') && first.args.includes('Bash') && first.args.includes('Bash(git push:*)'), "a session in the app would load the user's own configuration, lack the terminal, or push without asking");
    expect(kinds(s.id) === 'owner,say,action,owner,say,action', `the history of a session in the app is wrong: ${kinds(s.id)}`);
    const { items, next } = sessions.sessionHistory(s.id);
    expect(items[0].first && items[1].text === 'First: Start here' && items[2].text.includes('git status') && sessions.sessionHistory(s.id, next).items.length === 0, "the session's history does not keep the first message, the text and the actions in order");

    sessions.sayToSession(s.id, 'Now push it');
    await idle(s.id);
    const ask = sessions.readSession(s.id).requests.find(r => r.kind === 'permission' && r.status === 'open');
    expect(ask?.rule === 'Bash(git push:*)' && sessions.sessionRequests().some(r => r.id === ask.id && r.session === s.id), 'a refused push did not become a request for the owner');
    const plain = ask.explain ?? {};
    expect(plain.summary === 'Send the commits of branch main to origin' && plain.risk === 'high' && plain.change.includes('main branch') && plain.undo && plain.command === 'git push origin main',
      `a push to the main branch is not explained in plain words (what, what changes, undo, high risk, the command): ${JSON.stringify(plain)}`);
    const noMachine = { sessions: [], supported: false };
    expect(sessions.sessionsState(liveConfig, noMachine).open.find(x => x.id === s.id)?.phase === 'permission', 'a session waiting for a permission is not shown as such');
    sessions.answerPermission(s.id, ask.id, true);
    await idle(s.id);
    const allowed = called().at(-1);
    expect(allowed.prompt.includes('allowed this') && !allowed.args.includes('Bash(git push:*)'), 'the permission given did not reach the agent, or the push is still refused');

    // The guard: a publication written any other way is refused too, and becomes a request; what was allowed goes.
    const { publishing } = await import(pathToFileURL(path.join(root, 'src', 'guard.mjs')).href);
    const rules = c => publishing(c).map(f => f.rule.slice(5, -3)).join();
    const guarded = {
      'git -C ../x push': 'git push', 'cd x && git --no-pager -c a=b push origin HEAD': 'git push', 'bash -c "git push"': 'git push', 'FOO=1 git.exe push': 'git push',
      'gh api repos/a/b/pulls -f title=T': 'gh api', 'gh api -X POST repos/a/b/pulls': 'gh api', 'curl -X POST https://api.github.com/repos/a/b/pulls -d @pr.json': 'gh api',
      'git -C x remote set-url origin u': 'git remote', 'gh pr create --fill': 'gh pr',
      'git status && git log': '', 'git commit -m "explain git push"': '', 'gh api repos/a/b/pulls': '', 'curl https://api.github.com/repos/a/b': '',
    };
    const misread = Object.entries(guarded).filter(([c, r]) => rules(c) !== r);
    expect(!misread.length, `the guard misreads what a command publishes: ${misread.map(([c]) => `${c} -> ${rules(c) || '(nothing)'}`).join('; ')}`);
    sessions.sayToSession(s.id, 'Open it through the API');
    await idle(s.id);
    const hooked = JSON.parse(called().at(-1).args[called().at(-1).args.indexOf('--settings') + 1]).hooks?.PreToolUse?.[0]?.hooks?.[0]?.command ?? '';
    const [api, sideways, plainGit] = JSON.parse(readFileSync(path.join(liveDir, 'guard.txt'), 'utf8'));
    expect(hooked.includes('guard.mjs') && hooked.includes('--allow "Bash(git push:*)"') && JSON.parse(api).hookSpecificOutput?.permissionDecision === 'deny' && sideways === '' && plainGit === '',
      `the guard did not refuse a pull request opened through the API, or refused what was allowed or harmless: ${JSON.stringify([hooked, api, sideways, plainGit])}`);
    const viaApi = sessions.readSession(s.id).requests.find(r => r.kind === 'permission' && r.status === 'open' && r.rule === 'Bash(gh api:*)');
    expect(viaApi?.explain?.summary === "Open a pull request on a/b through GitHub's API" && viaApi.explain.command.startsWith('cd x && gh api'), `what the guard refused did not become a request explained in plain words: ${JSON.stringify(viaApi)}`);
    sessions.answerPermission(s.id, viaApi.id, false);

    sessions.sayToSession(s.id, 'Please take long');
    for (let i = 0; i < 50 && !sessions.turnOf(s.id)?.last; i++) await new Promise(r => setTimeout(r, 100));
    expect(sessions.interruptSession(s.id), 'a turn going on could not be interrupted');
    await idle(s.id);
    sessions.sayToSession(s.id, 'Go on');
    await idle(s.id);
    expect(called().at(-1).prompt.includes('interrupted your previous turn') && sessions.readSession(s.id).status === 'open', 'after an interruption, the next message did not tell the agent');
    const line = sessions.sessionsLine(liveConfig, noMachine);
    expect(line.includes(`[${s.id}]`) && line.includes('session log') && line.includes('Last said'), `the manager's line about the sessions is incomplete: ${line}`);

    // An update pauses the turn at a safe point; it carries on by itself, in the same session (here at once: no update runs).
    sessions.sayToSession(s.id, 'Please take long again');
    for (let i = 0; i < 50 && !sessions.turnOf(s.id)?.last; i++) await new Promise(r => setTimeout(r, 100));
    expect(sessions.pauseSessionTurns().includes(s.id) && sessions.sessionTurnsGoingOn(), 'a turn going on was not asked to pause for an update');
    await idle(s.id);
    await idle(s.id);
    const carried = called().at(-1);
    expect(carried.prompt.includes('to install an update') && carried.args.includes('--resume') && !sessions.readSession(s.id).paused, `a turn paused for an update did not carry on by itself: ${carried.prompt.slice(0, 120)}`);

    // The manager writes only at the owner's request, and the agent and the history say so.
    sessions.sayToSession(s.id, 'Hello from the manager', { by: 'manager' });
    await idle(s.id);
    expect(called().at(-1).prompt.includes("written by Chiefmate's manager") && sessions.sessionHistory(s.id).items.some(e => e.kind === 'owner' && e.by === 'manager'), "a message written by the manager doesn't say so");
    let blocked = '';
    try {
      execFileSync(process.execPath, [path.join(root, 'src', 'cli.mjs'), 'session', 'say', s.id, 'hi'], { env: { ...process.env, CHIEFMATE_MANAGER: '1' }, stdio: 'pipe', windowsHide: true });
    } catch (error) {
      blocked = String(error.stderr);
    }
    expect(blocked.includes('--owner-asked'), 'the manager could write to a live session without the owner asking');

    // Claude Code already has the session that Chiefmate would start anew (a turn cut off by a restart): it is resumed.
    const record = path.join(data, 'sessions', `${s.id}.json`);
    writeFileSync(record, JSON.stringify({ ...JSON.parse(readFileSync(record, 'utf8')), turns: 0 }));
    sessions.sayToSession(s.id, 'Is it already there?');
    await idle(s.id);
    const [inUse, retried] = called().slice(-2);
    expect(inUse.args.includes('--session-id') && retried.args.includes('--resume') && retried.prompt.includes('already there') && sessions.readSession(s.id).lastTurn?.ok, '"Session ID ... is already in use" was not resumed');

    // The external tools released to the profile and to the project, and no other.
    const both = sessions.sessionMcp({ ...liveConfig, projects: { p: { mcp: ['other'] } } }, { profile: 'pair', project: 'p' });
    const windowArgs = sessions.sessionArgs({ tool: 'claude', profile: 'pair', cwd: liveDir }, liveConfig, null);
    const servers = Object.keys(JSON.parse(windowArgs[windowArgs.indexOf('--mcp-config') + 1]).mcpServers);
    expect(both.names.join() === 'other,pw' && both.tools.includes('mcp__pw') && servers.join() === 'pw', `a live session's external tools are wrong: ${both.names} / ${servers}`);

    await sessions.endSession(s.id);
    expect(sessions.readSession(s.id).status === 'ended', 'a session in the app did not end');
    sessions.sayToSession(s.id, 'Back again');
    await idle(s.id);
    expect(sessions.readSession(s.id).status === 'open' && called().at(-1).args.includes('--resume'), 'a message to an ended session did not resume it in the same conversation');
    expect((await sessions.openSession('pair', { config: liveConfig })).id === s.id, 'a profile opened a second session in the app while one was open');
    await sessions.endSession(s.id);

    const c = await sessions.openSession('cx', { config: liveConfig, prompt: 'Hi codex' });
    await idle(c.id);
    sessions.sayToSession(c.id, 'And then');
    await idle(c.id);
    const [cx1, cx2] = called().filter(x => x.tool === 'codex');
    expect(cx1.args.slice(0, 2).join() === 'exec,--json' && cx1.args.includes('-C') && cx2?.args.slice(0, 3).join() === 'exec,resume,--json' && cx2.args.includes('thread-1'), `Codex was not resumed in its thread: ${JSON.stringify(cx2?.args)}`);
    const said = sessions.sessionHistory(c.id).items;
    expect(said.some(e => e.kind === 'say' && e.text === 'Codex: Hi codex') && said.some(e => e.kind === 'action' && e.failed && e.text.includes('npm test')) && said.some(e => e.kind === 'action' && e.text.includes('a.txt')), "Codex's text and actions did not reach the history");
    expect(sessions.sessionView(c.id).session.turns === 2, "a Codex session's view is wrong");
    await sessions.endSession(c.id);
  } finally {
    process.env.CHIEFMATE_CLAUDE = path.join(data, 'no-claude.exe');
    delete process.env.CHIEFMATE_CODEX;
    rmSync(liveDir, { recursive: true, force: true, maxRetries: 5 });
  }
} catch (error) {
  failures.push(`live session checks: ${error.message}`);
}

// The remote access's settings: off by default, and off when incomplete (no tailnet name, no login, the app's own port).
try {
  const { remoteSettings } = await import(pathToFileURL(path.join(root, 'src', 'server.mjs')).href);
  const quiet = console.error;
  console.error = () => {};
  try {
    expect(remoteSettings(undefined, 4747) === null && remoteSettings({ enabled: false, host: 'pc.t.ts.net', logins: ['a@b.c'] }, 4747) === null, 'the remote access is on by default');
    expect([{ host: 'localhost', logins: ['a@b.c'] }, { host: 'pc.t.ts.net', logins: [] }, { host: 'pc.t.ts.net', logins: ['a@b.c'], port: 4747 }]
      .every(x => remoteSettings({ enabled: true, ...x }, 4747) === null), 'incomplete remote access settings were accepted');
    const on = remoteSettings({ enabled: true, host: 'https://PC.t.ts.net/', logins: 'A@b.c' }, 4747);
    expect(on?.host === 'pc.t.ts.net' && on.logins[0] === 'a@b.c' && on.port === 4748, `the remote access settings were read wrong: ${JSON.stringify(on)}`);
  } finally {
    console.error = quiet;
  }
} catch (error) {
  failures.push(`remote access checks: ${error.message}`);
}

// Merging with the owner's authorization (src/merge.mjs), in this process: a branch delivered locally goes into a
// made-up clone's base branch (a git repository in the temporary folder; nothing goes to GitHub), only once, and the
// command refuses to run inside a step.
try {
  const { mergeRun, previewMerge, refreshCopies } = await import(pathToFileURL(path.join(root, 'src', 'merge.mjs')).href);
  const { readRun } = await import(pathToFileURL(path.join(root, 'src', 'store.mjs')).href);
  const clone = path.join(data, 'merge-clone');
  mkdirSync(clone);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=smoke', '-c', 'user.email=smoke@example.com', ...args], { cwd: clone, encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  writeFileSync(path.join(clone, 'a.txt'), 'a\n');
  git('add', '.');
  git('commit', '-q', '-m', 'start');
  git('checkout', '-q', '-b', 'chiefmate/smoke');
  writeFileSync(path.join(clone, 'b.txt'), 'b\n');
  git('add', '.');
  git('commit', '-q', '-m', 'the run');
  git('checkout', '-q', 'main');
  writeFileSync(path.join(data, 'runs', 'smoke-merge.json'), JSON.stringify({
    id: 'smoke-merge', kind: 'task', project: 'local-sample', title: 'Local merge', status: 'done', created: new Date().toISOString(),
    branch: 'chiefmate/smoke', delivered: clone, steps: [],
  }));
  const config = { projects: { 'local-sample': { local_clone: clone, main_branch: 'main', deliver: 'local' } } };
  const preview = await previewMerge('smoke-merge', config);
  expect(preview.kind === 'local' && preview.base === 'main' && preview.branch === 'chiefmate/smoke', `the merge preview is wrong: ${JSON.stringify(preview)}`);
  expect(!existsSync(path.join(clone, 'b.txt')), 'the merge preview changed the clone');
  await mergeRun('smoke-merge', { by: 'manager' }, config);
  expect(existsSync(path.join(clone, 'b.txt')) && git('branch', '--show-current').trim() === 'main', "the run's branch was not merged into the clone's base branch");
  expect(readRun('smoke-merge').merged?.by === 'manager', 'the merge was not recorded in the run');
  expect(await mergeRun('smoke-merge', {}, config).then(() => false, e => /already/.test(e.message)), 'a run was merged twice');
  let refused = false;
  try {
    execFileSync(process.execPath, [path.join(root, 'src', 'cli.mjs'), 'merge', 'smoke-merge', '--yes'], { env: { ...process.env, CHIEFMATE_RUN: 'x', CHIEFMATE_MANAGER: '' }, stdio: 'pipe', windowsHide: true });
  } catch (error) {
    refused = /never merges/.test(String(error.stderr));
  }
  expect(refused, 'the merge command ran inside a step');
  // After a pull request's merge: the project's library is updated (a made-up update here) and the owner's clone moves
  // forward by a fast forward only; with a change of the owner's in the way, it is left alone and the owner is told.
  const origin = path.join(data, 'refresh-origin.git');
  const ownerClone = path.join(data, 'refresh-clone');
  const pusher = path.join(data, 'refresh-pusher');
  const ws = path.join(data, 'refresh-ws');
  mkdirSync(path.join(ws, '.library', 'refresh-lib', '.git'), { recursive: true });
  git('init', '-q', '--bare', '-b', 'main', origin);
  git('clone', '-q', origin, pusher);
  const inPusher = (...args) => execFileSync('git', ['-c', 'user.name=smoke', '-c', 'user.email=smoke@example.com', ...args], { cwd: pusher, encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
  inPusher('checkout', '-q', '-b', 'main');
  writeFileSync(path.join(pusher, 'a.txt'), 'a\n');
  inPusher('add', '.');
  inPusher('commit', '-q', '-m', 'start');
  inPusher('push', '-q', 'origin', 'main');
  git('clone', '-q', origin, ownerClone);
  const refreshConfig = { projects: { refresh: { repository: origin, local_clone: ownerClone, main_branch: 'main' } }, library: { 'refresh-lib': { name: 'Refresh library', repository: `${origin}/` } } };
  const pushMerged = file => {
    writeFileSync(path.join(pusher, file), 'merged\n');
    inPusher('add', '.');
    inPusher('commit', '-q', '-m', `merged ${file}`);
    inPusher('push', '-q', 'origin', 'main');
  };
  const updated = [];
  const fakeLibrary = async id => updated.push(id);
  pushMerged('merged.txt');
  const done = await refreshCopies({ id: 'r1', project: 'refresh', base: 'main' }, { kind: 'pr' }, refreshConfig, { library: fakeLibrary, workspaces: ws });
  expect(updated.join() === 'refresh-lib' && done.done.length === 2 && !done.skipped.length && existsSync(path.join(ownerClone, 'merged.txt')),
    `the library or the owner's clone was not brought up to date after a merge: ${JSON.stringify(done)}`);
  pushMerged('second.txt');
  writeFileSync(path.join(ownerClone, 'a.txt'), 'a change of the owner\n');
  const held = await refreshCopies({ id: 'r2', project: 'refresh', base: 'main' }, { kind: 'pr' }, refreshConfig, { library: fakeLibrary, workspaces: ws });
  expect(held.skipped.length === 1 && held.skipped[0].includes(ownerClone) && !existsSync(path.join(ownerClone, 'second.txt'))
    && readFileSync(path.join(ownerClone, 'a.txt'), 'utf8') === 'a change of the owner\n', `the owner's clone was touched with a change of theirs in it: ${JSON.stringify(held)}`);
} catch (error) {
  failures.push(`merge checks: ${error.message}`);
}

// No trace of Chiefmate (src/workspace.mjs), with made-up repositories in the temporary folder: a neutral branch name
// that never overwrites one of the clone's, the traces found in the run's work, and the clone's branch moved forward
// without switching branches.
try {
  const ws = await import(pathToFileURL(path.join(root, 'src', 'workspace.mjs')).href);
  const owner = path.join(data, 'nt-clone');
  const copy = path.join(data, 'nt-copy');
  const git = (dir, ...args) => execFileSync('git', ['-c', 'user.name=smoke', '-c', 'user.email=smoke@example.com', ...args], { cwd: dir, encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
  mkdirSync(owner);
  git(owner, 'init', '-q', '-b', 'feature/x');
  writeFileSync(path.join(owner, 'a.txt'), 'a\n');
  git(owner, 'add', '.');
  git(owner, 'commit', '-q', '-m', 'start');
  git(owner, 'branch', 'wip/fix-the-report');
  git(data, 'clone', '-q', owner, copy);
  const local = { deliver: 'local', local_clone: owner };
  expect(ws.noTrace(local) && !ws.noTrace({ ...local, no_trace: false }) && !ws.noTrace({}) && ws.noTrace({ no_trace: true }), 'no_trace is not on by default with local delivery only');
  expect(ws.runBranch({}, 'id1', 'Fix') === 'chiefmate/id1' && ws.runBranch(local, 'id1', 'Fix the report!') === 'wip/fix-the-report'
    && ws.runBranch({ ...local, deliver_branch: 'work' }, 'id1', 'Fix') === 'work/fix' && ws.runBranch({ ...local, deliver_branch: 'current' }, 'id1', 'Fix') === 'wip/fix',
  'the run branch names are wrong');
  const branch = await ws.freeBranch(owner, 'wip/fix-the-report');
  expect(branch === 'wip/fix-the-report-2', `a branch of the clone would be reused: ${branch}`);
  git(copy, 'checkout', '-q', '-b', branch);
  writeFileSync(path.join(copy, 'b.txt'), 'b\n');
  git(copy, 'add', '.');
  git(copy, 'commit', '-q', '-m', 'Add b');
  expect((await ws.traces(copy, 'feature/x')).length === 0, 'clean work was taken for a trace of Chiefmate');
  // Someone else's commits from main, merged in during the run, are not the run's traces.
  git(owner, 'checkout', '-q', '-b', 'main');
  writeFileSync(path.join(owner, 'chiefmate.md'), 'notes\n');
  writeFileSync(path.join(owner, 'c.txt'), 'Built with Chiefmate\n');
  git(owner, 'add', '.');
  git(owner, '-c', 'user.name=Regis', 'commit', '-q', '-m', 'Add notes', '-m', 'Co-Authored-By: Claude <noreply@anthropic.com>');
  git(owner, 'checkout', '-q', 'feature/x');
  git(copy, 'fetch', '-q', 'origin');
  git(copy, 'merge', '-q', '--no-edit', 'origin/main');
  const merged = await ws.traces(copy, 'feature/x');
  expect(merged.length === 0, `commits merged in from main were taken for the run's traces: ${JSON.stringify(merged)}`);
  writeFileSync(path.join(copy, 'chiefmate_tmp.py'), 'x = 1\n');
  writeFileSync(path.join(copy, 'b.txt'), 'b\n# made by Chiefmate\n');
  git(copy, 'add', '.');
  git(copy, 'commit', '-q', '-m', 'Chiefmate: generalist (fix)');
  const found = await ws.traces(copy, 'feature/x');
  expect(found.length === 3 && found.some(x => /chiefmate_tmp\.py/.test(x)) && found.some(x => /b\.txt/.test(x)), `the traces were not all found: ${JSON.stringify(found)}`);
  git(copy, 'reset', '-q', '--hard', 'HEAD~1');
  await ws.deliverToClone(copy, branch, owner);
  writeFileSync(path.join(owner, 'a.txt'), 'changed\n');
  expect(/changes/.test(await ws.advanceClone(owner, branch, 'feature/x')) && !existsSync(path.join(owner, 'b.txt')), 'a clone with changes not committed was moved forward');
  git(owner, 'checkout', '-q', '--', 'a.txt');
  expect((await ws.advanceClone(owner, branch, 'feature/x')) === null && existsSync(path.join(owner, 'b.txt'))
    && git(owner, 'branch', '--show-current').trim() === 'feature/x' && !git(owner, 'branch', '--list', branch).trim(),
  "the clone's branch was not moved forward in place, or the run's branch was left behind");
} catch (error) {
  failures.push(`no trace checks: ${error.message}`);
}

try {
  rmSync(data, { recursive: true, force: true, maxRetries: 5 });
  rmSync(files, { recursive: true, force: true, maxRetries: 5 });
} catch {
  // a temporary folder left behind is harmless
}

if (failures.length) {
  console.error(`Smoke test failed:\n${failures.map(f => `  - ${f}`).join('\n')}\n\nServer output:\n${output}`);
  process.exitCode = 1;
} else {
  console.log(`OK: a temporary Chiefmate answered on port ${port}.`);
}
