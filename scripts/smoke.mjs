// Starts a temporary Chiefmate on a spare port (only the app and the API: no queue, no schedule, no updates)
// and checks that everything answers. Usage: npm run smoke
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
writeFileSync(path.join(data, 'manager', 'pending.json'), JSON.stringify([{ id: 'smoke1', text: 'Waiting', at: new Date().toISOString(), queued: true }]));
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
    for (const key of ['now', 'version', 'language', 'ai', 'update', 'projects', 'missions', 'crew', 'teams', 'needs', 'prompts', 'focus', 'running', 'current', 'parallel', 'sessions', 'queue', 'history', 'usage', 'manager', 'computer', 'plan', 'alerts']) {
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
    const unsigned = await fetch(`${base}/api/limits`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(unsigned.status === 403, `a command without the x-chiefmate header answered ${unsigned.status} instead of 403`);
    const machine = await (await fetch(`${base}/api/computer`)).json();
    expect(machine.memory?.total > 0 && Array.isArray(machine.projects), '/api/computer has no memory or projects');
    // Commands that must refuse without changing anything (the settings are the installation's own).
    const post = (route, body) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', 'x-chiefmate': '1' }, body: JSON.stringify(body) });
    expect((await post('/api/stop-project', { project: 'none' })).status === 400, 'stopping a project without a confirmed list was not refused');
    expect((await post('/api/reset-grants', { action: 'used', index: 9999 })).status === 400, 'marking a free reset that does not exist was not refused');
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
  Object.assign(chat, { responding: false, interrupting: false, cancel: null });
  expect(!managerBusy(), 'the queue did not empty');
} catch (error) {
  failures.push(`conversation checks: ${error.message}`);
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
  expect(built.blocks.join() === 'Office,Sample project,Board,Code rules,Browser access,Confirmation', `the prompt builder chose the wrong blocks: ${built.blocks.join()}`);
  expect(built.text.includes('## Sample project') && built.text.includes('Work on SAMPLE.') && built.text.includes('Work from the office.'), "the prompt builder's variables or headings are wrong");
  expect(built.adaptations.length === 1 && built.text.includes('Never push without review.'), "the prompt builder's adaptation to the crew's rules is wrong");

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
    expect(sessionIdOf('"C:\\nodejs\\node.exe" "C:\\chiefmate\\src\\cli.mjs" session-run 2026-01-02-0900-review') === '2026-01-02-0900-review' && sessionIdOf('node src/cli.mjs server') === null, "a session's window process is not recognized");
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
