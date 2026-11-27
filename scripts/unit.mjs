// Unit tests with no dependency (node:test): the file viewer's checks of paths, its choice among a project's copies and
// its readers of tables; a copy behind its origin and the fast forward of a clone; the approval levels; the app's dictation;
// the emergency lockdown and its detection; each agent's effort; the redacted backup of the settings.
// Usage: npm test. Everything is made up, in a temporary folder removed at the end.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { browserState, findBrowsers, initials, isPlaywright, launchArgs, PALETTE, projectColor, shouldClose, themeManifest, windowName } from '../src/browsers.mjs';
import { readFeed } from '../src/claude.mjs';
import { backupConfig, loadAgents, projectCrew, redactConfig } from '../src/config.mjs';
import { effortChangeLine, effortHistory, effortSource, parseEffort, runEffortChanges, setEffort } from '../src/effort.mjs';
import { checkPath, kindOf, listFolder, newestCopy, opening, openOnComputer, projectPlaces, rawHeaders, rootsFor, runFiles, viewerRoots, viewFile } from '../src/files.mjs';
import { riskyCommand } from '../src/guard.mjs';
import { checkSignals, engage, isLocked, readLockdown, recordSignal, refuseWhileLocked, release, RULES, weigh, WINDOW_MINUTES } from '../src/lockdown.mjs';
import { startedAt } from '../src/machine.mjs';
import { parseCsv, readXlsx, zipEntries } from '../src/sheets.mjs';
import { askedTool, limitWaitCleared, stepTool } from '../src/runs.mjs';
import {
  agentTool, availableTools, chooseTool, codexEnvironment, codexEvents, codexGuard, codexStepArgs, correctionLine, GROK_DENY, grokEvents, grokStepArgs, parseTool,
  qualityRecords, qualitySummary, runTools, toolAvailable, toolEffort, toolModel,
} from '../src/tools.mjs';
import { parseLevel } from '../src/util.mjs';
import { behindOrigin, checkoutBranch, fastForward, projectLibraries, sameRepository } from '../src/workspace.mjs';
import { syntaxProblem } from './check.mjs';
import { SAMPLE_CSV, sampleXlsx, zip } from './fixtures.mjs';
import { compose, Dictation, nextState, recognizer, transcript } from '../ui/voice.js';
import './away-ui.test.mjs';

const windows = process.platform === 'win32';
const temp = mkdtempSync(path.join(os.tmpdir(), 'chiefmate-unit-'));
after(() => rmSync(temp, { recursive: true, force: true }));

// A project's working copy, its clone, a library, a folder outside every root and Chiefmate's own data folder.
const workspaces = path.join(temp, 'workspaces');
const work = path.join(workspaces, 'demo');
const clone = path.join(temp, 'clone');
const outside = path.join(temp, 'outside');
const data = path.join(clone, 'data');
const write = (file, text = 'x') => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};
for (const f of ['notes.txt', 'img/a.png', 'img/b.jpg', '.git/config', '.env', '.env.local', 'prod.env', 'keys/server.pem', 'id_rsa', 'id_ed25519.pub',
  'secrets/plan.txt', 'Segredos/x.txt', 'my-secret.json', 'node_modules/pkg/index.js']) write(path.join(work, f));
write(path.join(clone, 'readme.md'), '# Demo');
write(path.join(data, 'state.json'), '{}');
write(path.join(workspaces, '.library', 'docs', 'guide.md'), '# Guide');
write(path.join(outside, 'private.txt'), 'private');
// Links: a junction (no admin rights needed on Windows) or a symbolic link to a folder outside, one to Chiefmate's data
// and one to a folder inside the root.
const linkDir = (target, link) => symlinkSync(target, link, windows ? 'junction' : 'dir');
linkDir(outside, path.join(work, 'escape'));
linkDir(data, path.join(work, 'to-data'));
linkDir(path.join(work, 'img'), path.join(work, 'pictures'));
let fileLink = false;
try {
  symlinkSync(path.join(outside, 'private.txt'), path.join(work, 'link.txt'), 'file');
  fileLink = true;
} catch {
  // file links need extra rights on Windows: that case is skipped there
}

const config = { projects: { demo: { name: 'Demo', repository: 'https://example.com/demo.git', local_clone: clone } } };
const roots = viewerRoots(config, { workspaces });
const blocked = [data];
const check = p => checkPath(p, roots, { blocked });
const refused = (p, status = 403) => assert.throws(() => check(p), e => e.code === status, `${p} was not refused with ${status}`);

test('the roots are the working copy, the clone and the libraries', () => {
  assert.deepEqual(roots.map(r => r.kind), ['workspace', 'clone', 'library']);
});

test('a file inside a root is allowed, with its real path', () => {
  assert.equal(check(path.join(work, 'notes.txt')).root.kind, 'workspace');
  assert.equal(check(path.join(workspaces, '.library', 'docs', 'guide.md')).root.kind, 'library');
  assert.equal(check(path.join(clone, 'readme.md')).root.kind, 'clone');
});

test('".." and paths outside the roots are refused', () => {
  refused(path.join(work, '..', '..', 'outside', 'private.txt'));
  refused(`${work}${path.sep}..${path.sep}..${path.sep}outside${path.sep}private.txt`);
  refused(path.join(outside, 'private.txt'));
  refused(path.parse(temp).root);
  refused('notes.txt');
  refused('img/../notes.txt');
  refused('');
  refused('\\\\server\\share\\file.txt');
  refused('//server/share/file.txt');
  refused(`${path.join(work, 'notes.txt')}\0.png`);
});

test('links and junctions that lead outside, or to Chiefmate\'s data, are refused', () => {
  refused(path.join(work, 'escape', 'private.txt'));
  refused(path.join(work, 'to-data', 'state.json'));
  if (fileLink) refused(path.join(work, 'link.txt'));
  assert.ok(check(path.join(work, 'pictures', 'a.png')).real.endsWith(path.join('img', 'a.png')), 'a junction inside the root was refused');
});

test('protected names and places are refused, even inside a root', () => {
  for (const f of ['.git/config', '.env', '.env.local', 'prod.env', 'keys/server.pem', 'id_rsa', 'id_ed25519.pub', 'secrets/plan.txt', 'Segredos/x.txt', 'my-secret.json', 'node_modules/pkg/index.js']) {
    refused(path.join(work, f));
  }
  refused(path.join(data, 'state.json'));
  refused(path.join(work, 'nothing-here.txt'), 404);
});

test('on Windows: other letter cases, trailing dots and streams', { skip: !windows }, () => {
  assert.ok(check(path.join(work, 'NOTES.TXT')));
  assert.ok(check(work.toUpperCase() + '\\notes.txt'));
  refused(path.join(work, '.GIT', 'config'));
  refused(path.join(work, '.ENV'));
  refused(path.join(work, '.env.'));
  refused(path.join(work, '.env '));
  refused(path.join(clone, 'DATA', 'state.json'));
  refused(path.join(work, 'notes.txt:secret'));
  refused(path.join(work, 'notes.txt::$DATA'));
});

test("a folder's list leaves out what is protected or leads outside", () => {
  const names = listFolder(work, roots, { blocked }).entries.map(e => e.name);
  assert.deepEqual(names, ['img', 'keys', 'pictures', 'notes.txt']);
  assert.deepEqual(listFolder(path.join(work, 'keys'), roots, { blocked }).entries, []);
  const top = listFolder(clone, roots, { blocked });
  assert.deepEqual(top.entries.map(e => e.name), ['readme.md']);
  assert.equal(top.parent, null);
  assert.equal(listFolder(path.join(work, 'img'), roots, { blocked }).parent.toLowerCase(), check(work).real.toLowerCase());
});

// A new project delivered locally: its own folder (no remote) is its repository and your clone, and its crew's working
// copy lies inside Chiefmate's own clone, a root of another project.
test("a local delivery's Files tab opens your folder first, and the working copy is its own root", () => {
  const host = path.join(temp, 'host');
  const hostWs = path.join(host, 'workspaces');
  const folder = path.join(temp, 'Lessons');
  write(path.join(host, 'README.md'), '# Host');
  write(path.join(hostWs, 'lessons', 'draft.md'), '# Draft');
  write(path.join(folder, 'tasks.md'), '# Tasks');
  const local = {
    projects: {
      host: { name: 'Host', repository: 'https://example.com/host.git', local_clone: host },
      lessons: { name: 'Lessons', repository: folder, local_clone: folder, deliver: 'local', main_branch: 'main' },
    },
  };
  const roots = viewerRoots(local, { workspaces: hostWs });
  const own = checkPath(path.join(hostWs, 'lessons', 'draft.md'), roots, { blocked: [] }).root;
  assert.deepEqual([own.kind, own.project], ['workspace', 'lessons']);
  assert.equal(listFolder(path.join(hostWs, 'lessons'), roots, { blocked: [] }).parent, null);
  assert.equal(checkPath(path.join(host, 'README.md'), roots, { blocked: [] }).root.project, 'host');
  // A root nested in a protected folder of another root never opens it.
  const pkg = path.join(host, 'node_modules', 'pkg');
  write(path.join(pkg, 'index.js'));
  const nested = viewerRoots({ ...local, viewer: { extra_roots: [pkg] } }, { workspaces: hostWs });
  assert.equal(nested.at(-1).kind, 'extra');
  assert.throws(() => checkPath(path.join(pkg, 'index.js'), nested, { blocked: [] }), e => e.code === 403);
  const first = rootsFor(local, 'lessons', { workspaces: hostWs })[0];
  assert.deepEqual([first.kind, first.path.toLowerCase()], ['clone', realpathSync.native(folder).toLowerCase()]);
  // Delivered as a pull request, the crew's working copy stays first.
  const pr = { projects: { ...local.projects, lessons: { ...local.projects.lessons, deliver: 'pull_request' } } };
  assert.equal(rootsFor(pr, 'lessons', { workspaces: hostWs })[0].kind, 'workspace');
});

// A made-up user folder: a document in Documents, a script, a protected name, Chiefmate's data inside it and a junction
// to the folder outside it.
const home = path.join(temp, 'home');
const homeData = path.join(home, 'chiefmate', 'data');
const report = path.join(home, 'Documents', 'atlas-anexos', 'guia-visual', 'comparacao.html');
for (const f of [report, path.join(home, 'Documents', 'run.bat'), path.join(home, '.ssh', 'config'), path.join(homeData, 'state.json')]) write(f);
linkDir(outside, path.join(home, 'Documents', 'escape'));
const atHome = (p, more = {}) => openOnComputer(p, { home, blocked: [homeData], dryRun: true, ...more });
const refusedAtHome = (p, status = 403) => assert.throws(() => atHome(p), e => e.code === status, `${p} was not refused with ${status}`);

test('opening on the computer: absolute or from the user folder, with / or \\', () => {
  for (const p of [report, report.replaceAll('\\', '/'), 'Documents\\atlas-anexos\\guia-visual\\comparacao.html', 'Documents/atlas-anexos/guia-visual/comparacao.html',
    '~\\Documents\\atlas-anexos\\guia-visual\\comparacao.html', '~/Documents/atlas-anexos/guia-visual/comparacao.html', '%USERPROFILE%\\Documents\\atlas-anexos\\guia-visual\\comparacao.html',
    `\`${report}\``, `${report}:12`]) {
    assert.equal(atHome(p).path, realpathSync.native(report), `${p} did not lead to the file`);
  }
  assert.equal(atHome(report).how, 'app');
  assert.equal(atHome('Documents').how, 'folder');
  // A script is never run: only shown in its folder.
  assert.equal(atHome('Documents/run.bat').how, 'reveal');
  // Without "dryRun", started once with the file, and nothing really opens in the test.
  const started = [];
  openOnComputer(report, { home, blocked: [homeData], start: how => started.push(how) });
  assert.equal(started.length, 1);
  assert.ok(started[0].args.join(' ').includes(path.basename(report)));
});

test('opening on the computer: how each platform opens or shows a file', () => {
  assert.deepEqual(opening('C:\\Users\\a\\x,y.html', false, 'win32'), { how: 'app', command: 'explorer.exe', args: ['"C:\\Users\\a\\x,y.html"'], verbatim: true });
  assert.deepEqual(opening('C:\\Users\\a\\run.ps1', false, 'win32').args, ['/select,"C:\\Users\\a\\run.ps1"']);
  assert.deepEqual(opening('/home/a/run.sh', false, 'darwin'), { how: 'reveal', command: 'open', args: ['-R', '/home/a/run.sh'] });
  assert.deepEqual(opening('/home/a/run.sh', false, 'linux').args, ['/home/a']);
  for (const name of ['a.exe', 'a.cmd', 'a.vbs', 'a.lnk', 'a.js', 'a.xlsm', 'a.docm', 'a.hta', 'noextension']) assert.equal(opening(name, false, 'win32').how, 'reveal', name);
});

test('opening on the computer: a missing file says the path tried', () => {
  const tried = path.join(home, 'Documents', 'atlas-anexos', 'nada.html');
  assert.throws(() => atHome('Documents\\atlas-anexos\\nada.html'), e => e.code === 404 && e.tried === tried && e.message.includes(tried));
});

test("opening on the computer: never outside the user folder nor Chiefmate's protected places", () => {
  refusedAtHome(path.join(outside, 'private.txt'));
  refusedAtHome('..\\outside\\private.txt');
  refusedAtHome('../outside/private.txt');
  refusedAtHome('Documents/escape/private.txt');
  refusedAtHome(path.parse(temp).root);
  refusedAtHome('\\\\server\\share\\file.txt');
  refusedAtHome('//server/share/file.txt');
  refusedAtHome('');
  refusedAtHome(`${report}\0.png`);
  refusedAtHome(path.join(homeData, 'state.json'));
  refusedAtHome('chiefmate/data');
  refusedAtHome('.ssh/config');
  if (windows) {
    refusedAtHome(`${report}:secret`);
    refusedAtHome('CHIEFMATE\\DATA\\state.json');
  }
  assert.equal(atHome(path.join(outside, 'private.txt'), { home: outside }).how, 'app', 'the made-up user folder itself was refused');
});

// The app's side: the paths in a text and the click that can't open in the viewer (ui/app.js, run on its own).
const appJs = readFileSync(new URL('../ui/app.js', import.meta.url), 'utf8');
const between = (from, to) => appJs.slice(appJs.indexOf(from), appJs.indexOf(to));
const linkOf = html => [...html.matchAll(/data-file="([^"]*)"/g)].map(m => m[1].replaceAll('&#39;', "'"));

test('app: a path in a text becomes a link, from the user folder too, with / or \\', () => {
  const inline = runInNewContext(`${between('// ---------- Text and formats', '/** Simple markdown')} inline;`, {});
  assert.deepEqual(linkOf(inline('Abra Documents\\atlas-anexos\\guia-visual\\comparacao.html.')), ['Documents\\atlas-anexos\\guia-visual\\comparacao.html']);
  assert.deepEqual(linkOf(inline('Veja ~/Documents/atlas-anexos/guia-visual/comparação.html, por favor')), ['~/Documents/atlas-anexos/guia-visual/comparação.html']);
  assert.deepEqual(linkOf(inline('Em C:/Users/luan/Documents/a.md e C:\\Users\\luan\\b.pdf.')), ['C:/Users/luan/Documents/a.md', 'C:\\Users\\luan\\b.pdf']);
  assert.deepEqual(linkOf(inline('`C:\\Users\\luan\\Área de Trabalho\\relatório.html`')), ['C:\\Users\\luan\\Área de Trabalho\\relatório.html']);
  assert.deepEqual(linkOf(inline('Sem caminho aqui: 1/2 e https://example.com/a.html')), []);
});

function openUi({ here = true, answer }) {
  const nodes = Object.fromEntries(['path-dialog', 'path-dialog-title', 'path-dialog-text', 'path-dialog-path'].map(id => [id, { open: false, showModal() { this.open = true; } }]));
  const sent = [];
  const toasts = [];
  const open = runInNewContext(`${between('async function openOnComputer', "$('#path-dialog-copy')")} openOnComputer;`, {
    $: selector => nodes[selector.slice(1)], onThisComputer: () => here, toast: text => toasts.push(text), baseName: p => p.split(/[\\/]/).pop(),
    t: (text, values = {}) => text.replace(/\{(\w+)\}/g, (m, k) => values[k]),
    api: async (route, body) => {
      sent.push({ route, body });
      const r = answer(body);
      if (r.status) throw Object.assign(new Error(r.error), r);
      return r;
    },
  });
  return { open, nodes, sent, toasts };
}

test('app: on the computer the file opens there; on the phone, its path to copy and where it opens', async () => {
  const pc = openUi({ answer: () => ({ path: report, how: 'app' }) });
  await pc.open('Documents\\atlas-anexos\\guia-visual\\comparacao.html');
  assert.deepEqual(JSON.parse(JSON.stringify(pc.sent)), [{ route: '/api/files/open', body: { path: 'Documents\\atlas-anexos\\guia-visual\\comparacao.html', dryRun: false } }]);
  assert.equal(pc.toasts[0], 'Opened on the computer: comparacao.html');
  assert.equal(pc.nodes['path-dialog'].open, false);
  const phone = openUi({ here: false, answer: () => ({ path: report, how: 'app', dryRun: true }) });
  await phone.open('Documents/atlas-anexos/guia-visual/comparacao.html');
  assert.equal(phone.sent[0].body.dryRun, true, 'the phone asked to open the file on the computer');
  assert.ok(phone.nodes['path-dialog'].open, 'the phone was left without the path');
  assert.equal(phone.nodes['path-dialog-path'].textContent, report);
  assert.match(phone.nodes['path-dialog-text'].textContent, /opens on the computer/);
  // The copy button is in the page, in the same dialog.
  assert.match(readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8'), /id="path-dialog"[\s\S]*id="path-dialog-path"[\s\S]*id="path-dialog-copy"/);
});

test('app: a file found nowhere shows the path tried', async () => {
  const tried = path.join(home, 'Documents', 'nada.html');
  const ui = openUi({ answer: () => ({ status: 404, error: `File not found: ${tried}.`, data: { tried } }) });
  await ui.open('Documents\\nada.html', Object.assign(new Error('File not found: Documents/nada.html. Looked in: your clone (C:\\x).'), { status: 404 }));
  assert.equal(ui.nodes['path-dialog-title'].textContent, 'File not found');
  assert.equal(ui.nodes['path-dialog-path'].textContent, tried);
  assert.match(ui.nodes['path-dialog-text'].textContent, /Looked in: your clone[\s\S]*File not found: .*nada\.html/);
});

test('kinds and headers: nothing runs in the app', () => {
  assert.deepEqual(['a.PNG', 'b.pdf', 'c.md', 'd.xlsx', 'e.csv', 'f.json', 'LICENSE', 'g.exe'].map(kindOf), ['image', 'pdf', 'markdown', 'table', 'table', 'text', 'text', 'other']);
  assert.equal(rawHeaders('a.png')['content-type'], 'image/png');
  assert.match(rawHeaders('a.png')['content-security-policy'], /sandbox/);
  assert.equal(rawHeaders('a.png')['cache-control'], 'no-store');
  assert.equal(rawHeaders('a.png')['x-content-type-options'], 'nosniff');
  assert.equal(rawHeaders('logo.svg', { dest: 'image' })['content-type'], 'image/svg+xml');
  assert.match(rawHeaders('logo.svg', { dest: 'document' })['content-disposition'], /^attachment/);
  assert.match(rawHeaders('page.html')['content-disposition'], /^attachment/);
  assert.equal(rawHeaders('page.html')['content-type'], 'application/octet-stream');
  assert.equal(rawHeaders('notes.md')['content-type'], 'text/plain; charset=utf-8');
  assert.equal(rawHeaders('doc.pdf', { head: Buffer.from('%PDF-1.7') })['content-type'], 'application/pdf');
  assert.match(rawHeaders('fake.pdf', { head: Buffer.from('<html>') })['content-disposition'], /^attachment/);
});

test('XLSX: sheets, shared and inline strings, numbers, dates and booleans', () => {
  const book = readXlsx(sampleXlsx());
  assert.deepEqual(book.sheets, ['Sales', 'Notes & more']);
  assert.deepEqual(book.rows, [
    ['Product', 'Unit price', 'Date', '', 'Paid'],
    ['Tea & biscuits\r', '12.5', '2026-03-01', '', 'TRUE'],
    [],
    ['formula <text>'],
  ]);
  assert.equal(book.truncated, false);
  assert.equal(book.total, 4);
  const notes = readXlsx(sampleXlsx(), { sheet: 1 });
  assert.equal(notes.sheet, 1);
  assert.deepEqual(notes.rows, [['Only note']]);
});

test('XLSX: the preview stops at its row limit, with a warning', () => {
  const book = readXlsx(sampleXlsx({ extraRows: 50 }), { maxRows: 10 });
  assert.equal(book.rows.length, 10);
  assert.equal(book.truncated, true);
  assert.ok(book.total >= 54);
});

test('XLSX: a damaged file, a zip without a workbook and a part too large are refused', () => {
  assert.throws(() => readXlsx(Buffer.from('not a zip at all')), /not a valid XLSX/);
  assert.throws(() => readXlsx(zip({ 'readme.txt': 'hello' })), /not a valid XLSX/);
  const bomb = zip({ 'xl/workbook.xml': Buffer.alloc(2 * 1024 ** 2, 32) });
  assert.equal(zipEntries(bomb).get('xl/workbook.xml').usize, 2 * 1024 ** 2);
  assert.throws(() => readXlsx(bomb, { maxPart: 1024 ** 2 }), /too large/);
});

test('CSV: the delimiter, quotes, line breaks inside quotes and the row limit', () => {
  const table = parseCsv(SAMPLE_CSV);
  assert.deepEqual(table.rows, [['name', 'city', 'note'], ['Ana', 'Porto Alegre', 'said "hi"\nand left'], ['Beto', 'Recife', '']]);
  assert.deepEqual(parseCsv('a,b\n1,2').rows, [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsv('a\tb\n1\t2', { delimiter: '\t' }).rows, [['a', 'b'], ['1', '2']]);
  const long = parseCsv(Array.from({ length: 30 }, (_, i) => `${i},x`).join('\n'), { maxRows: 5 });
  assert.equal(long.rows.length, 5);
  assert.equal(long.total, 30);
  assert.equal(long.truncated, true);
});

test("a run's files: what its branch created or changed, never a protected one", async () => {
  const repo = path.join(temp, 'repo');
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, windowsHide: true, encoding: 'utf8' }).trim();
  write(path.join(repo, 'old.txt'), 'old');
  write(path.join(repo, 'gone.md'), 'gone');
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'base');
  const baseCommit = git('rev-parse', 'HEAD');
  git('checkout', '-qb', 'run-branch');
  write(path.join(repo, 'designs', 'one.png'), 'png');
  write(path.join(repo, 'old.txt'), 'new text');
  write(path.join(repo, '.env.production'), 'TOKEN=x');
  rmSync(path.join(repo, 'gone.md'));
  git('add', '-A');
  git('commit', '-qm', 'work');
  git('checkout', '-q', 'main');
  const runConfig = { projects: { demo: { name: 'Demo', local_clone: repo, main_branch: 'main' } } };
  const run = { id: 'unit-run', project: 'demo', branch: 'run-branch', baseCommit };
  const list = await runFiles(run, runConfig);
  assert.deepEqual(list.files.map(f => `${f.status} ${f.file} ${f.kind}`), ['A designs/one.png image', 'D gone.md markdown', 'M old.txt text']);
  assert.equal(list.files[0].size, 3);
  // Read from the branch, even with another branch checked out; only the files the run lists.
  const readRun = id => (id === run.id ? run : null);
  const text = await viewFile('text', { run: run.id, file: 'old.txt' }, { config: runConfig, readRun });
  assert.equal(text.text, 'new text');
  const found = await viewFile('info', { run: run.id, path: 'designs/one.png' }, { config: runConfig, readRun });
  assert.deepEqual(found.ref, { run: run.id, file: 'designs/one.png' });
  for (const file of ['.env.production', 'gone.md', '../old.txt', 'C:/x.txt']) {
    await assert.rejects(viewFile('raw', { run: run.id, file }, { config: runConfig, readRun }), e => e.code === 403 || e.code === 404, `${file} was read`);
  }
});

// ---------- Dictation (ui/voice.js), with a made-up recognizer and field ----------

const said = (text, isFinal) => Object.assign([{ transcript: text }], { isFinal });
class FakeRecognition {
  static last = null;
  constructor() {
    FakeRecognition.last = this;
  }
  start() {}
  stop() {
    this.onend();
  }
  abort() {
    this.onerror({ error: 'aborted' });
    this.onend();
  }
}
function fakeField(value, start = value.length, end = start) {
  const field = {
    value, selectionStart: start, selectionEnd: end, inputs: 0,
    setSelectionRange(a, b) { Object.assign(this, { selectionStart: a, selectionEnd: b }); },
    dispatchEvent() { this.inputs++; },
  };
  field.ownerDocument = { activeElement: field };
  return field;
}

test('dictation: the recognizer only in a secure context', () => {
  class R {}
  assert.equal(recognizer({ isSecureContext: true, webkitSpeechRecognition: R }), R);
  assert.equal(recognizer({ isSecureContext: true, SpeechRecognition: R }), R);
  assert.equal(recognizer({ isSecureContext: false, SpeechRecognition: R }), null);
  assert.equal(recognizer({ isSecureContext: true }), null); // Firefox
});

test('dictation: the words go where the caret is, spaced from the text around', () => {
  assert.deepEqual(compose({ value: '', start: 0, end: 0 }, ' hello  world '), { value: 'hello world', caret: 11 });
  assert.deepEqual(compose({ value: 'Hi there', start: 2, end: 2 }, 'you'), { value: 'Hi you there', caret: 6 });
  assert.deepEqual(compose({ value: 'Hi ', start: 3, end: 3 }, 'you'), { value: 'Hi you', caret: 6 });
  assert.deepEqual(compose({ value: 'Hi.', start: 2, end: 2 }, 'you'), { value: 'Hi you.', caret: 6 });
  assert.deepEqual(compose({ value: 'Hi', start: 2, end: 2 }, ', you'), { value: 'Hi, you', caret: 7 });
  assert.deepEqual(compose({ value: 'Hi old friend', start: 3, end: 6 }, 'new'), { value: 'Hi new friend', caret: 6 }); // the selection replaced
  assert.deepEqual(compose({ value: 'Hi old', start: 3, end: 6 }, '  '), { value: 'Hi old', caret: 6 }); // nothing heard: unchanged
  assert.deepEqual(transcript([said('one', true), said(' two', true), said('thr', false)]), { final: 'one two', interim: 'thr' });
  assert.deepEqual(transcript([said('one', true), said('two', false)], 1), { final: '', interim: 'two' });
});

test('dictation: its states', () => {
  assert.equal(nextState('idle', 'toggle'), 'starting');
  assert.equal(nextState('starting', 'start'), 'listening');
  assert.equal(nextState('listening', 'toggle'), 'stopping');
  assert.equal(nextState('starting', 'toggle'), 'stopping');
  assert.equal(nextState('stopping', 'start'), 'stopping');
  assert.equal(nextState('stopping', 'end'), 'idle');
  assert.equal(nextState('listening', 'end'), 'idle'); // the browser stopped by itself
});

test('dictation: words shown as heard, the final ones kept, the typed text untouched', () => {
  const field = fakeField('Note: buy', 5); // the caret after "Note:"
  const states = [];
  const d = new Dictation({ Recognition: FakeRecognition, field, lang: 'pt-BR', onState: s => states.push(s) });
  d.start();
  const rec = FakeRecognition.last;
  assert.equal(rec.lang, 'pt-BR');
  assert.equal(rec.interimResults, true);
  rec.onstart();
  assert.ok(d.listening);
  rec.onresult({ results: [said('milk', false)] });
  assert.equal(field.value, 'Note: milk buy');
  rec.onresult({ results: [said('milk and', true), said('bre', false)] });
  assert.equal(field.value, 'Note: milk and bre buy');
  d.stop(); // the words not yet final go
  assert.equal(field.value, 'Note: milk and buy');
  assert.equal(field.selectionStart, 'Note: milk and'.length);
  assert.deepEqual(states, ['starting', 'listening', 'stopping', 'idle']);
  assert.ok(field.inputs > 0);
});

test('dictation: after a send, nothing comes back; aborted, nothing more is written', () => {
  const field = fakeField('');
  const d = new Dictation({ Recognition: FakeRecognition, field, lang: 'en-US' });
  d.start();
  const rec = FakeRecognition.last;
  rec.onstart();
  rec.onresult({ results: [said('first message', true)] });
  assert.equal(field.value, 'first message');
  Object.assign(field, { value: '', selectionStart: 0, selectionEnd: 0 }); // sent by Enter
  rec.onresult({ results: [said('first message', true), said('second', true)] });
  assert.equal(field.value, ''); // the results before the send are left out
  rec.onresult({ results: [said('first message', true), said('second', true), said('next', false)] });
  assert.equal(field.value, 'next');
  d.abort();
  assert.equal(field.value, 'next');
  assert.equal(d.state, 'idle');
});

test('dictation: a silence stops it', async () => {
  const field = fakeField('');
  const d = new Dictation({ Recognition: FakeRecognition, field, lang: 'en-US', silenceMs: 20 });
  d.start();
  FakeRecognition.last.onstart();
  FakeRecognition.last.onresult({ results: [said('hello', true)] });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(d.state, 'idle');
  assert.equal(field.value, 'hello');
});

test('approval levels: 1, 2 or 3, cleared with none, anything else refused', () => {
  assert.deepEqual([1, '2', ' 3 ', 'level 2', 'nível 3'].map(parseLevel), [1, 2, 3, 2, 3]);
  assert.deepEqual(['', 'none', '?', null, undefined].map(parseLevel), [null, null, null, null, null]);
  for (const bad of ['0', '4', 'high', '1.5']) assert.throws(() => parseLevel(bad), /Unknown level/);
});

// A project's copies made up with git: its origin, your clone (left behind), a library that copies the same repository
// and another clone that moves the origin forward.
const gitIn = (dir, ...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, windowsHide: true, encoding: 'utf8', stdio: 'pipe' }).trim();
const copies = path.join(temp, 'copies');
const origin = path.join(copies, 'origin.git');
const seed = path.join(copies, 'seed');
const behindClone = path.join(copies, 'clone');
const copiesWs = path.join(copies, 'workspaces');
const library = path.join(copiesWs, '.library', 'demo-lib');
mkdirSync(copies, { recursive: true });
gitIn(copies, 'init', '-q', '--bare', '-b', 'main', origin);
gitIn(copies, 'clone', '-q', origin, seed);
gitIn(seed, 'checkout', '-q', '-b', 'main');
write(path.join(seed, 'doc.md'), '# Doc');
gitIn(seed, 'add', '-A');
gitIn(seed, 'commit', '-qm', 'first');
gitIn(seed, 'push', '-q', 'origin', 'main');
gitIn(copies, 'clone', '-q', origin, behindClone);
gitIn(copies, 'clone', '-q', origin, library);
// The origin moves on: your clone doesn't have "merged.md" yet.
write(path.join(seed, 'merged.md'), '# Merged');
gitIn(seed, 'add', '-A');
gitIn(seed, 'commit', '-qm', 'merged');
gitIn(seed, 'push', '-q', 'origin', 'main');
const copiesConfig = {
  projects: { demo2: { name: 'Demo 2', repository: `${origin}${path.sep}`, local_clone: behindClone, main_branch: 'main' } },
  library: { 'demo-lib': { name: 'Demo library', repository: origin.toUpperCase(), main_branch: 'main' }, other: { repository: 'https://example.com/other.git' } },
};

test("a project's reference library is the one that copies its repository", () => {
  assert.ok(sameRepository('https://example.com/Demo.git', 'https://example.com/demo/') && !sameRepository('', ''));
  assert.deepEqual(projectLibraries(copiesConfig, 'demo2'), windows ? ['demo-lib'] : []);
});

test('a relative path opens from the newest copy of the project, and says which', () => {
  const config = { ...copiesConfig, library: { 'demo-lib': { name: 'Demo library', repository: origin } } };
  const roots = viewerRoots(config, { workspaces: copiesWs });
  const places = projectPlaces(config, 'demo2', roots, { workspaces: copiesWs });
  assert.deepEqual(places.map(p => p.kind), ['clone', 'library']);
  const old = new Date(Date.now() - 3_600_000);
  utimesSync(path.join(behindClone, 'doc.md'), old, old);
  let found = newestCopy('doc.md', places, roots, []);
  assert.equal(found.from.kind, 'library');
  assert.equal(found.copies, 2);
  utimesSync(path.join(behindClone, 'doc.md'), new Date(), new Date());
  found = newestCopy('doc.md', places, roots, []);
  assert.equal(found.from.kind, 'clone');
  assert.equal(newestCopy('missing.md', places, roots, []), null);
});

test('a file in no copy: where it was looked for, and the copy behind its origin', async () => {
  assert.deepEqual(await behindOrigin(behindClone, 'main'), { branch: 'main', behind: -1 });
  gitIn(behindClone, 'fetch', '-q', 'origin');
  assert.deepEqual(await behindOrigin(behindClone), { branch: 'main', behind: 1 });
  const config = { projects: { demo2: copiesConfig.projects.demo2 } };
  await assert.rejects(viewFile('info', { path: 'merged.md', project: 'demo2' }, { config, readRun: () => null }),
    e => e.code === 404 && e.message.includes(behindClone) && e.message.includes('origin/main'), 'the refusal does not say where nor that the clone is behind');
});

test("your clone moves forward only by a fast forward, with nothing of yours in the way", async () => {
  gitIn(behindClone, 'fetch', '-q', 'origin', 'main');
  write(path.join(behindClone, 'doc.md'), '# Changed by you');
  assert.match(await fastForward(behindClone, 'FETCH_HEAD', 'main'), /\S/);
  assert.ok(!existsSync(path.join(behindClone, 'merged.md')));
  gitIn(behindClone, 'checkout', '-q', '--', 'doc.md');
  assert.match(await fastForward(behindClone, 'FETCH_HEAD', 'other'), /\S/);
  assert.equal(await fastForward(behindClone, 'FETCH_HEAD', 'main'), null);
  assert.ok(existsSync(path.join(behindClone, 'merged.md')));
  assert.deepEqual(await behindOrigin(behindClone, 'main'), { branch: 'main', behind: 0 });
});

function conflictingRun() {
  const dir = mkdtempSync(path.join(temp, 'git-recovery-'));
  const git = (...args) => gitIn(dir, ...args);
  const file = path.join(dir, 'doc.md');
  const commit = (name, contents) => {
    write(name, contents);
    git('add', '--', name);
    git('commit', '-qm', contents.trim());
  };
  git('init', '-q', '-b', 'main');
  commit(file, 'Base\n');
  git('branch', 'run');
  git('branch', 'side');
  commit(file, 'Main\n');
  commit(path.join(dir, 'extra.md'), 'Extra\n');
  // A commit a sequence can still have to pick after its conflict.
  git('checkout', '-q', 'side');
  commit(path.join(dir, 'side.md'), 'Side\n');
  git('checkout', '-q', 'run');
  commit(file, 'Run\n');
  return { dir, git };
}

for (const { operation, args, marker, sequence } of [
  { operation: 'merge', args: ['main'], marker: 'MERGE_HEAD' },
  { operation: 'cherry-pick', args: ['main~'], marker: 'CHERRY_PICK_HEAD' },
  { operation: 'revert', args: ['--no-edit', 'main~'], marker: 'REVERT_HEAD' },
  { operation: 'rebase', args: ['--merge', 'main'], marker: 'rebase-merge' },
  { operation: 'rebase', args: ['--apply', 'main'], marker: 'rebase-apply' },
  { operation: 'cherry-pick', args: ['main', 'main~'], marker: 'CHERRY_PICK_HEAD', sequence: true },
  { operation: 'revert', args: ['--no-edit', 'main', 'main~'], marker: 'REVERT_HEAD', sequence: true },
  { operation: 'cherry-pick', args: ['main', 'main~', 'side'], marker: 'CHERRY_PICK_HEAD', sequence: true },
  { operation: 'revert', args: ['--no-edit', 'main', 'main~', 'side'], marker: 'REVERT_HEAD', sequence: true },
]) {
  test(`resuming aborts git ${operation} ${args.join(' ')} and keeps the run's commits`, async () => {
    const { dir, git } = conflictingRun();
    if (operation === 'revert' && sequence) git('cherry-pick', 'main');
    const before = git('rev-parse', 'run');
    assert.throws(() => git(operation, ...args));
    const state = path.join(dir, '.git', marker);
    assert.ok(existsSync(state));
    const interrupted = git('rev-parse', 'run');
    assert.equal(sequence ? git('rev-parse', 'run~') : interrupted, before);
    const recovered = [];
    await checkoutBranch(dir, 'run', name => recovered.push(name));
    assert.deepEqual(recovered, [operation]);
    assert.equal(git('branch', '--show-current'), 'run');
    assert.equal(git('rev-parse', 'HEAD'), interrupted);
    assert.equal(git('status', '--porcelain'), '');
    assert.equal(existsSync(state), false);
    assert.equal(existsSync(path.join(dir, '.git', 'sequencer')), false);
  });
}

test('a failed Git abort leaves the branch and conflict in place and tells the owner how to resume', async () => {
  const { dir, git } = conflictingRun();
  const before = git('rev-parse', 'run');
  assert.throws(() => git('merge', 'main'));
  write(path.join(dir, '.git', 'index.lock'));
  await assert.rejects(checkoutBranch(dir, 'run', () => assert.fail('The abort failed')), error => {
    assert.ok(error.message.includes(dir));
    assert.match(error.message, /git status/);
    assert.match(error.message, /git merge --abort/);
    return true;
  });
  assert.equal(git('rev-parse', 'run'), before);
  assert.ok(existsSync(path.join(dir, '.git', 'MERGE_HEAD')));
});

test('the step feed shows a recovery action written after an interrupted log line', () => {
  const log = path.join(temp, 'git-recovery.jsonl');
  write(log, '{"type":\n{"type":"chiefmate_action","text":"The unfinished Git merge was aborted before resuming: the commits are kept."}\n');
  assert.deepEqual(readFeed(log, temp).items, [{ type: 'action', text: 'The unfinished Git merge was aborted before resuming: the commits are kept.' }]);
});

test('a run waiting for a usage limit goes back to the queue once the limit is raised above the usage or taken out', () => {
  const resets = new Date(Date.now() + 3_600_000).toISOString();
  const usage = { five_hour: { used: 0.11, resets }, seven_day: { used: 0.2, resets } };
  const run = { status: 'waiting', notBefore: resets, limitWait: { window: 'five_hour', ceiling: 0.05 } };
  const cleared = (window, week = 0.9) => limitWaitCleared(run, { pause_at_5h_window: window, pause_at_plan_week: week }, usage);
  assert.equal(cleared(0.05), false);
  assert.equal(cleared(0.11), false);
  assert.equal(cleared(0.7, 0.1), false);
  assert.equal(cleared(0.7), true);
  assert.equal(cleared(undefined), true);
  assert.equal(limitWaitCleared({ status: 'waiting', note: 'Your account reached its limit in the middle of a step' }, {}, usage), false);
});

// ---------- The crew's tools (src/tools.mjs): which one a member runs on, until when, and how each is started ----------

test('a member runs on Claude Code unless it asks for Codex or Grok, and the manager and leads always do', () => {
  const config = { tools: { grok: { available_until: '2026-12-17' } } };
  const day = new Date(2026, 11, 1);
  assert.equal(agentTool(config, { id: 'generalist' }, day).tool, 'claude');
  assert.deepEqual(agentTool(config, { id: 'generalist', tool: 'codex' }, day), { tool: 'codex', asked: 'codex', until: null, reason: null });
  assert.deepEqual(agentTool(config, { id: 'writer', tool: 'Grok' }, day), { tool: 'grok', asked: 'grok', until: '2026-12-17', reason: null });
  assert.equal(agentTool(config, { id: 'manager', tool: 'codex' }, day).reason, 'lead');
  assert.equal(agentTool(config, { id: 'lead', lead: true, tool: 'grok' }, day).reason, 'lead');
  assert.deepEqual(agentTool(config, { id: 'x', tool: 'gemini' }, day), { tool: 'claude', asked: 'gemini', until: null, reason: 'unknown' });
  assert.equal(agentTool({ tools: { codex: { enabled: false } } }, { id: 'x', tool: 'codex' }, day).reason, 'off');
  assert.equal(stepTool(config, { id: 'generalist', tool: 'codex' }, true).tool, 'claude', 'the final review left Claude Code');
});

test("a tool's last day: still there on it, gone the day after, by itself", () => {
  const config = { tools: { grok: { available_until: '2026-12-17' }, codex: { available_until: 'soon' } } };
  assert.ok(toolAvailable(config, 'grok', new Date(2026, 11, 17, 23, 59)));
  assert.ok(!toolAvailable(config, 'grok', new Date(2026, 11, 18, 0, 1)));
  assert.deepEqual(availableTools(config, new Date(2026, 11, 18)), ['claude', 'codex'], 'an unreadable date must not take the tool away');
  assert.deepEqual(agentTool(config, { id: 'writer', tool: 'grok' }, new Date(2026, 11, 18)), { tool: 'claude', asked: 'grok', until: '2026-12-17', reason: 'expired' });
  assert.ok(toolAvailable({}, 'claude') && !toolAvailable({}, 'other'));
});

test("a tool's model: the member's own, never a Claude model on Codex or Grok", () => {
  assert.equal(toolModel('codex', 'claude-opus-5-5'), null);
  assert.equal(toolModel('grok', 'Opus'), null);
  assert.equal(toolModel('codex', 'gpt-6.1'), 'gpt-6.1');
  assert.equal(toolModel('claude', 'claude-opus-5-5'), 'claude-opus-5-5');
});

test("a task's tool: over the member's, never for the leads, the final review or a sensitive project", () => {
  const config = { tools: { grok: { available_until: '2026-12-17' } } };
  const day = new Date(2026, 11, 1);
  assert.equal(parseTool(' Codex '), 'codex');
  assert.equal(parseTool(''), null);
  assert.throws(() => parseTool('gemini'), /Unknown tool/);
  assert.deepEqual(chooseTool(config, { id: 'generalist' }, { asked: 'codex', date: day }), { tool: 'codex', asked: 'codex', until: null, reason: null, task: true });
  assert.equal(chooseTool(config, { id: 'writer', tool: 'grok' }, { asked: 'claude', date: day }).tool, 'claude', "the task's choice wins over the member's");
  assert.deepEqual(chooseTool(config, { id: 'writer', tool: 'grok' }, { date: day }), { tool: 'grok', asked: 'grok', until: '2026-12-17', reason: null, task: false });
  assert.equal(chooseTool(config, { id: 'lead', lead: true }, { asked: 'codex', date: day }).reason, 'lead');
  assert.equal(chooseTool(config, { id: 'generalist' }, { asked: 'grok', date: new Date(2026, 11, 18) }).reason, 'expired');
  const sensitive = chooseTool(config, { id: 'generalist', tool: 'codex' }, { asked: 'grok', project: { sensitive: true }, date: day });
  assert.deepEqual([sensitive.tool, sensitive.asked, sensitive.reason], ['claude', 'grok', 'sensitive']);
  assert.equal(chooseTool(config, { id: 'lead', lead: true }, { asked: 'codex', project: { sensitive: true }, date: day }).reason, 'lead', 'a lead is not "sensitive"');
  assert.equal(stepTool(config, { id: 'generalist' }, true, { asked: 'codex' }).tool, 'claude', 'the final review left Claude Code');
  // The step's own tool (a mission's step), else the run's.
  assert.equal(askedTool({ tool: 'grok' }, { toolAsked: 'codex' }), 'codex');
  assert.equal(askedTool({ tool: 'grok' }, {}), 'grok');
  assert.equal(askedTool({}, {}), null);
});

test("a run's tools, for the cards: the ones its crew ran on, or will run on", () => {
  assert.deepEqual(runTools({ kind: 'task', tool: 'codex', steps: [{ agent: 'generalist', status: 'pending' }] }), ['codex']);
  assert.deepEqual(runTools({ kind: 'task', tool: 'codex', steps: [{ agent: 'generalist', status: 'done', tool: 'claude' }] }), [], 'it fell back to Claude Code');
  assert.deepEqual(runTools({ kind: 'mission', steps: [{ agent: 'writer', status: 'pending', toolAsked: 'grok' }, { agent: 'generalist', status: 'done', tool: 'codex' }, { agent: 'manager', status: 'done', tool: 'claude' }] }), ['grok', 'codex']);
  assert.deepEqual(runTools({ kind: 'ask', tool: 'grok', steps: [{ agent: 'lead', role: 'plan', status: 'pending' }] }), ['grok'], 'a request not planned yet');
  assert.deepEqual(runTools({ kind: 'task', steps: [{ agent: 'generalist', status: 'pending' }] }), []);
});

test("the tools' quality: one record per step on Codex or Grok, and the summary by tool", () => {
  assert.equal(correctionLine('## Verdict\n**Corrections:** fixed a missing import\nApprove.'), 'fixed a missing import');
  assert.equal(correctionLine('No such line'), null);
  const run = id => ({
    id, project: 'demo', kind: 'task', title: 'Fix the conflict', tool: 'codex', status: 'done', checks: [{ command: 'npm test', ok: true }],
    steps: [{ agent: 'generalist', status: 'done', tool: 'codex', durationMs: 4 * 60000 }],
    review: { agent: 'manager', status: 'done', tool: 'claude', report: 'Corrections: none' },
  });
  const clean = qualityRecords(run('a'));
  assert.equal(clean.length, 1);
  assert.deepEqual([clean[0].tool, clean[0].kind, clean[0].chosen, clean[0].checks, clean[0].corrected, clean[0].note], ['codex', 'task', 'task', true, false, '']);
  const fixed = qualityRecords(run('b'), ['Chiefmate: manager review']);
  assert.deepEqual([fixed[0].corrected, fixed[0].note], [true, 'Chiefmate: manager review']);
  const said = qualityRecords({ ...run('c'), review: { status: 'done', report: 'Corrections: the test was wrong' } });
  assert.deepEqual([said[0].corrected, said[0].note], [true, 'the test was wrong']);
  const failed = qualityRecords({ ...run('d'), status: 'failed', checks: [], review: { status: 'pending' }, steps: [{ agent: 'writer', status: 'failed', tool: 'grok', durationMs: 60000 }] });
  assert.deepEqual([failed[0].tool, failed[0].checks, failed[0].corrected, failed[0].chosen], ['grok', null, null, 'task']);
  assert.deepEqual(qualityRecords({ ...run('e'), steps: [{ agent: 'generalist', status: 'done', tool: 'claude' }] }), [], 'no step on Codex or Grok, no record');
  const summary = qualitySummary([...clean, ...fixed, ...said, ...failed]);
  const codex = summary.find(x => x.tool === 'codex');
  assert.deepEqual([codex.count, codex.clean, codex.corrected, codex.failed, codex.meanMs], [3, 1, 2, 0, 4 * 60000]);
  assert.deepEqual(codex.kinds.map(k => [k.kind, k.count]), [['task', 3]]);
  const grok = summary.find(x => x.tool === 'grok');
  assert.deepEqual([grok.count, grok.clean, grok.failed], [1, 0, 1]);
  assert.ok(!summary.some(x => x.tool === 'claude'));
});

test('Codex: its sandbox, no own configuration, never asking, and the guard as its hook', () => {
  const args = codexStepArgs({ dir: 'C:\\work\\demo', model: 'claude-opus-5-5', effort: 'high', session: { id: 'x' }, guardLog: 'C:\\data\\01-generalist.guard.jsonl' });
  const value = flag => args[args.indexOf(flag) + 1];
  assert.equal(args[0], 'exec');
  assert.ok(args.includes('--ignore-user-config') && args.includes('--json') && args.at(-1) === '-');
  assert.ok(args.includes('sandbox_mode="workspace-write"') && args.includes('approval_policy="never"'));
  assert.ok(!args.some(a => /danger-full-access|bypass-approvals-and-sandbox/.test(a)), 'the sandbox was turned off');
  assert.equal(value('-C'), 'C:\\work\\demo');
  assert.ok(!args.includes('-m'), 'a Claude model went to Codex');
  assert.ok(args.includes('model_reasoning_effort="high"'));
  const hook = args.find(a => a.startsWith('hooks.PreToolUse='));
  assert.ok(hook && hook.includes('matcher="Bash"') && hook.includes('guard.mjs') && hook.includes('01-generalist.guard.jsonl'), `no guard hook: ${hook}`);
  assert.ok(args.includes('--dangerously-bypass-hook-trust'), "the guard's hook would not run without trust");
  const resumed = codexStepArgs({ dir: 'C:\\work\\demo', session: { id: 'thread-1', resume: true }, guardLog: 'g' });
  assert.deepEqual(resumed.slice(0, 2), ['exec', 'resume']);
  assert.equal(resumed.at(-2), 'thread-1');
  assert.ok(resumed.some(a => a.startsWith('hooks.PreToolUse=')), 'the guard left the resumed session');
});

test("Codex's guard hook: words quoted for PowerShell (or sh), as TOML", () => {
  const value = codexGuard("C:\\Run's data\\g.jsonl");
  const command = JSON.parse(value.match(/command=("(?:[^"\\]|\\.)*")/)[1]);
  if (windows) assert.ok(command.startsWith("& '") && command.includes("Run''s data"), command);
  else assert.ok(command.includes("Run'\\''s data"), command);
});

test('Grok: deny rules for every publication, its own session, no Claude or Cursor configuration', () => {
  const args = grokStepArgs({ dir: '/w', model: 'grok-4.7', effort: 'deep', session: { id: 'u1' }, promptFile: '/p.md' });
  const denied = args.flatMap((a, i) => (a === '--deny' ? [args[i + 1]] : []));
  assert.deepEqual(denied, GROK_DENY);
  assert.ok(args.includes('--always-approve') && args.includes('--no-memory') && args[args.indexOf('--output-format') + 1] === 'streaming-json');
  assert.equal(args[args.indexOf('-s') + 1], 'u1');
  assert.equal(args[args.indexOf('-m') + 1], 'grok-4.7');
  assert.ok(!args.includes('--effort'), 'an effort Grok does not know was passed');
  assert.equal(grokStepArgs({ dir: '/w', session: { id: 'u1', resume: true }, promptFile: '/p.md' }).at(-1), 'u1');
  // Each rule is a glob over the whole line: these must be caught, the ordinary commands must not.
  const glob = rule => new RegExp(`^${rule.slice(5, -1).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
  const caught = command => GROK_DENY.some(rule => glob(rule).test(command));
  for (const c of ['git push', 'git -C x push origin main', 'bash -c "git push"', 'git remote set-url origin x', 'gh pr create', 'gh repo delete x', 'gh api -X POST repos/a/b/pulls',
    'curl -X POST https://api.github.com/repos/a/b/pulls']) assert.ok(caught(c), `not refused: ${c}`);
  for (const c of ['git status', 'git commit -m "Fix"', 'npm test', 'node src/cli.mjs plan list', 'git log --oneline']) assert.ok(!caught(c), `refused: ${c}`);
});

test("Codex's PATH leaves out Windows' app aliases, which its sandbox can't start", { skip: !windows }, () => {
  const key = Object.keys(process.env).find(k => k.toLowerCase() === 'path');
  const saved = process.env[key];
  process.env[key] = ['C:\\Windows\\System32', 'C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps', 'C:\\Tools'].join(';');
  try {
    const env = codexEnvironment({ CHIEFMATE_RUN: 'r' });
    assert.equal(env[key], 'C:\\Windows\\System32;C:\\Tools');
    assert.equal(env.CHIEFMATE_RUN, 'r');
  } finally {
    process.env[key] = saved;
  }
});

test("Codex's and Grok's events become the step's text and actions", () => {
  assert.deepEqual(codexEvents({ type: 'thread.started', thread_id: 't1' }), [{ kind: 'start', session: 't1' }]);
  const call = codexEvents({ type: 'item.started', item: { id: 'i1', type: 'command_execution', command: '"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command \'npm test\'' } });
  assert.deepEqual(call, [{ kind: 'call', id: 'i1', tool: 'Bash', input: { command: 'npm test' } }]);
  assert.equal(codexEvents({ type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'x', exit_code: 1, aggregated_output: 'boom' } })[0].failed, true);
  assert.deepEqual(codexEvents({ type: 'item.completed', item: { type: 'error', message: '`--dangerously-bypass-hook-trust` is enabled.' } }), []);
  assert.equal(codexEvents({ type: 'turn.completed', usage: { input_tokens: 5, cached_input_tokens: 2, output_tokens: 1 } }).at(-1).kind, 'end');
  const grokCall = grokEvents({ type: 'tool_call', toolCallId: 'c1', toolName: 'run_terminal_command', rawInput: { command: 'git status' } });
  assert.equal(grokCall[0].tool, 'Bash');
  assert.equal(grokCall[0].input.command, 'git status');
  const denied = grokEvents({ type: 'tool_call_update', toolCallId: 'c2', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'Tool was not executed: Denied by permission policy: deny rule on bash matching "*git *push*"' } }] });
  assert.ok(denied[0].denied && denied[0].failed);
  const end = grokEvents({ type: 'end', stopReason: 'end_turn', sessionId: 's1', usage: { input_tokens: 3, output_tokens: 2 }, num_turns: 4 });
  assert.deepEqual(end.map(e => e.kind), ['start', 'usage', 'end']);
  assert.equal(grokEvents({ type: 'end', stopReason: 'max_tokens' }).at(-1).kind, 'fail');
});

test("The crew's browsers: a color and initials per project, the window's name and the theme", () => {
  const config = { projects: { one: { name: 'Atlas Público' }, two: { name: 'Chiefmate', color: '#123ABC' }, three: { name: 'x', color: 'blue' } } };
  assert.equal(projectColor(config, 'one'), PALETTE[0]);
  assert.equal(projectColor(config, 'two'), '#123abc');
  assert.equal(projectColor(config, 'three'), PALETTE[2]); // an invalid color falls back to the palette
  assert.equal(projectColor(config, 'gone'), '#6b7280');
  assert.deepEqual([initials('Atlas Público'), initials('Chiefmate'), initials('riffdex'), initials('')], ['AP', 'CH', 'RI', '?']);
  assert.equal(windowName('Chiefmate', 'Navegadores "da equipe"\n identificados por projeto e com uma tarefa bem longa'), 'Chiefmate · Navegadores da equipe identificados por projeto…');
  assert.equal(windowName('Chiefmate', ''), 'Chiefmate');
  assert.deepEqual(themeManifest({ name: 'X', color: '#3b6ea5' }).theme.colors.frame, [59, 110, 165]);
  assert.deepEqual(
    [['npx', '@playwright/mcp@latest'], ['mcp-server-playwright'], ['node', 'C:/x/node_modules/.bin/mcp-server-playwright'], ['npx', '@executeautomation/playwright-mcp-server']]
      .map(([command, ...args]) => isPlaywright({ command, args })),
    [true, true, true, false], // only Microsoft's server reads Chiefmate's --config
  );
  assert.deepEqual(launchArgs({ name: 'A · b', theme: 'T', owner: 'run:1' }), ['--window-name=A · b', '--disable-extensions-except=T', '--load-extension=T', '--chiefmate-browser=run:1']);
});

test("The crew's browsers: closed when the task is over and left nothing open for the owner", () => {
  assert.equal(shouldClose({ known: true, running: false, request: false }), true);
  assert.equal(shouldClose({ known: true, running: true, request: false }), false);
  assert.equal(shouldClose({ known: true, running: false, request: true }), false); // a sign-in under way
  assert.equal(shouldClose({ known: false, running: false, request: false }), false); // never a browser it can't place
  assert.deepEqual(
    [{ known: true, running: true }, { known: true, request: true }, { known: true }, { known: false }].map(browserState),
    ['running', 'kept', 'done', 'unknown'],
  );
});

test("The crew's browsers among the processes: the main process of each, its project, task and state", () => {
  const config = { projects: { demo: { name: 'Demo' } } };
  const dir = String.raw`C:\chiefmate\data\browsers\demo\profile`;
  const list = [
    { pid: 10, name: 'chrome.exe', cmd: `chrome.exe --user-data-dir=${dir} "--window-name=Demo · Task" --chiefmate-browser=run:r1 about:blank`, started: '2026-01-01T10:00:00.000Z' },
    { pid: 11, name: 'chrome.exe', cmd: `chrome.exe --type=renderer --user-data-dir=${dir}` },
    { pid: 12, name: 'msedge.exe', cmd: String.raw`msedge.exe --user-data-dir=C:\Users\u\AppData\Local\ms-playwright\mcp-msedge-abc about:blank` },
    { pid: 13, name: 'chrome.exe', cmd: String.raw`chrome.exe --user-data-dir=C:\Users\u\Chrome` },
    { pid: 14, name: 'chrome.exe', cmd: `chrome.exe "--user-data-dir=${dir}" --chiefmate-browser=session:s1` },
    { pid: 15, name: 'bash.exe', cmd: 'bash -c "grep -- --chiefmate-browser=run:r1 notes.txt"' }, // only mentions the mark
  ];
  const states = { 'run:r1': { known: true, running: false, request: false, title: 'Run one' }, 'session:s1': { known: true, running: true, request: false, title: 'Live' } };
  const found = findBrowsers(config, list, { launches: { 'run:r1': { project: 'demo', task: 'Task' } }, state: owner => states[owner] });
  assert.deepEqual(found.map(b => b.pid), [10, 12, 14]);
  assert.deepEqual(found.map(b => [b.id, b.task, b.state, b.close]), [['demo', 'Task', 'done', true], [null, null, 'unknown', false], ['demo', 'Live', 'running', false]]);
  assert.equal(found[0].initials, 'DE');
  assert.equal(found[0].since, '2026-01-01T10:00:00.000Z');
});

test("A process's start, as Windows PowerShell writes it", () => {
  assert.equal(startedAt('/Date(1795645561244)/'), new Date(1795645561244).toISOString());
  assert.equal(startedAt({ value: '/Date(0)/' }), new Date(0).toISOString());
  assert.equal(startedAt(null), null);
  assert.equal(startedAt('nonsense'), null);
});

// ---------- The emergency lockdown (src/lockdown.mjs): made-up signals and made-up actions, nothing stopped for real ----------

const lockDir = () => mkdtempSync(path.join(temp, 'lockdown-'));
/** Made-up hooks: they count what the lockdown asks for, and stop or open nothing. */
function fakeHooks() {
  const calls = { stopAll: 0, resume: 0, told: [] };
  return { calls, h: { stopAll: async () => (calls.stopAll++, { runs: 2, manager: 1, sessions: 0, browsers: 1 }), resume: () => calls.resume++, tell: x => calls.told.push(x.kind) } };
}

test('The lockdown: the owner engages it, everything is refused, and only the owner on this computer releases it', async () => {
  const dir = lockDir();
  const { calls, h } = fakeHooks();
  assert.equal(isLocked(dir), false);
  assert.doesNotThrow(() => refuseWhileLocked('merge', dir));
  const state = await engage({ reason: 'Something odd', by: 'owner', from: 'app' }, { dir, h });
  assert.equal(state.active, true);
  assert.equal(state.reason, 'Something odd');
  assert.deepEqual(state.stopped, { runs: 2, manager: 1, sessions: 0, browsers: 1 });
  assert.equal(calls.stopAll, 1);
  assert.deepEqual(calls.told, ['lockdown']);
  assert.equal(isLocked(dir), true);
  assert.throws(() => refuseWhileLocked('merge', dir), /lockdown|emergência/i);
  // Engaged again: what started meanwhile stops too, and the owner is not told twice.
  await engage({ reason: 'Again', evidence: [{ at: new Date().toISOString(), kind: 'mass_delete', detail: 'x' }] }, { dir, h });
  const again = readLockdown(dir);
  assert.equal(again.reason, 'Something odd');
  assert.equal(again.stopped.runs, 4);
  assert.equal(again.evidence.length, 1);
  assert.deepEqual(calls.told, ['lockdown']);
  // Never through the remote access, never by anyone else.
  assert.throws(() => release({ by: 'owner', from: 'remote' }, { dir, h }), /remote|remoto/i);
  assert.throws(() => release({ by: 'manager', from: 'app' }, { dir, h }));
  assert.equal(isLocked(dir), true);
  const released = release({ by: 'owner', from: 'app' }, { dir, h });
  assert.equal(released.active, false);
  assert.equal(released.history.at(-1).reason, 'Something odd');
  assert.equal(calls.resume, 1);
  assert.doesNotThrow(() => refuseWhileLocked('merge', dir));
  assert.throws(() => release({ by: 'owner', from: 'app' }, { dir, h }));
});

test('The lockdown: the detection warns first and locks only for what is grave', async () => {
  const at = Date.parse('2026-11-26T03:00:00Z');
  const s = (kind, minutes = 1) => ({ at: new Date(at - minutes * 60_000).toISOString(), kind, detail: kind, who: 'step' });
  // Pure: counts within the window, warn and lock thresholds, nothing from before the last release.
  assert.deepEqual(weigh([s('publish_refused'), s('publish_refused')], {}, at), { lock: null, warnings: [] });
  assert.deepEqual(weigh([1, 2, 3].map(() => s('publish_refused')), {}, at).warnings.map(w => w.kind), ['publish_refused']);
  assert.equal(weigh(Array.from({ length: RULES.publish_refused.lock }, () => s('publish_refused')), {}, at).lock.kind, 'publish_refused');
  assert.equal(weigh([s('publish_refused', WINDOW_MINUTES + 1), s('publish_refused'), s('publish_refused')], {}, at).warnings.length, 0);
  assert.equal(weigh([s('protected_access')], {}, at).lock.kind, 'protected_access');
  assert.equal(weigh([s('protected_access', 5)], { history: [{ until: new Date(at - 60_000).toISOString() }] }, at).lock, null);
  assert.equal(weigh([1, 2, 3].map(() => s('publish_refused')), { warned: { publish_refused: new Date(at - 60_000).toISOString() } }, at).warnings.length, 0);
  assert.equal(weigh([s('mass_delete')], {}, at).warnings[0].kind, 'mass_delete');
  assert.equal(weigh([s('unknown_origin')], {}, at).warnings.length, 0);

  // Warned once, then locked when an agent reaches into a protected folder; released, the old signal locks no more.
  const dir = lockDir();
  const { calls, h } = fakeHooks();
  for (let i = 0; i < 3; i++) recordSignal('publish_refused', 'cli.mjs merge', { who: 'step', dir });
  let r = await checkSignals({ dir, h });
  assert.deepEqual([r.locked, r.warnings.length, isLocked(dir)], [false, 1, false]);
  assert.equal(readLockdown(dir).warnings.length, 1);
  r = await checkSignals({ dir, h });
  assert.equal(r.warnings.length, 0); // not warned twice in the window
  recordSignal('protected_access', 'cat <profile>', { who: 'step', dir });
  r = await checkSignals({ dir, h });
  assert.equal(r.locked, true);
  const state = readLockdown(dir);
  assert.deepEqual([state.active, state.by, state.from, state.evidence[0].kind], [true, 'auto', 'detection', 'protected_access']);
  assert.equal(calls.stopAll, 1);
  assert.deepEqual(calls.told, ['security_warning', 'lockdown']);
  release({ by: 'owner', from: 'cli' }, { dir, h });
  r = await checkSignals({ dir, h, at: Date.now() + 1000 });
  assert.equal(r.locked, false);
  assert.equal(isLocked(dir), false);
  assert.equal(recordSignal('no_such_kind', 'x', { dir }), null);
});

test("The lockdown's detection in a shell command: protected folders and deletions, never a folder's name in a text", () => {
  const home = path.join(temp, 'home');
  const cwd = path.join(home, 'Documents', 'GitHub', 'app', 'workspaces', 'demo');
  const root = path.join(home, 'Documents', 'GitHub', 'app');
  const profile = path.join(root, 'data', 'browser-profile');
  const tmp = path.join(temp, 'tmp');
  const kinds = command => riskyCommand(command, { cwd, protect: [profile], home, root, temp: tmp }).map(f => f.kind);
  // A protected folder, however it is reached.
  assert.deepEqual(kinds(`cat "${path.join(profile, 'a', 'b.txt')}"`), ['protected_access']);
  assert.deepEqual(kinds('ls ../../data/browser-profile'), ['protected_access']);
  assert.deepEqual(kinds(`bash -c "dir ${profile}"`), ['protected_access']);
  // Its name in a search or a message is not a path to it.
  assert.deepEqual(kinds('grep -rn "data/browser-profile" src'), []);
  assert.deepEqual(kinds('git commit -m "Never read data/browser-profile"'), []);
  // Deletions: inside the agent's own folder, nothing; outside it, a warning; a whole drive, home, a folder above,
  // Chiefmate or a protected one, grave.
  assert.deepEqual(kinds('rm -rf node_modules dist'), []);
  assert.deepEqual(kinds('rm notes.txt ../other.txt'), []);
  assert.deepEqual(kinds(`rm -rf '${path.join(tmp, 'scratch')}' /tmp/build "$TMPDIR/x"`), []);
  assert.deepEqual(kinds(`rm -rf '${path.join(home, 'Documents', 'GitHub', 'other')}'`), ['mass_delete']);
  assert.deepEqual(kinds('rm -rf *'), ['mass_delete']);
  assert.deepEqual(kinds('rm -rf ..'), ['wide_delete']);
  assert.deepEqual(kinds('rm -rf ~'), ['wide_delete']);
  assert.deepEqual(kinds('rm -rf ~/Documents'), ['wide_delete']);
  assert.deepEqual(kinds(`Remove-Item -Recurse -Force "${root}"`), ['wide_delete']);
  assert.deepEqual(kinds(`rd /s /q '${path.parse(cwd).root}'`), ['wide_delete']);
  assert.deepEqual(kinds(`rm -rf '${path.join(root, 'data')}'`), ['wide_delete']);
  assert.deepEqual(kinds(`Remove-Item -Force "${root}"`), []); // not recursive
  assert.deepEqual(kinds('cd x && rm -fr ../../..'), ['wide_delete']);
  // Git Bash's drive paths on Windows (/c/Users/...).
  if (process.platform === 'win32') {
    const bash = p => p.replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`).replace(/\\/g, '/');
    assert.deepEqual(kinds(`rm -rf ${bash(path.join(home, 'Documents'))}`), ['wide_delete']);
    assert.deepEqual(kinds(`rm -rf ${bash(path.join(tmp, 'scratch'))}`), []);
  }
});

test('effort: each level from its place, the project only, the history and the run report', () => {
  const config = {
    owner: 'Someone', crew: { writer: { effort: 'medium' } },
    projects: { demo: { name: 'Demo', effort: { generalist: 'low', manager: 'xhigh' } }, own: { name: 'Own', crew: { editor: { agent: 'writer', effort: 'high' } }, lead: { name: 'Lead' } } },
  };
  const agents = loadAgents(config);
  assert.equal(agents.writer.effort, 'medium');
  assert.equal(effortSource(config, null, agents.writer), 'installation');
  assert.equal(effortSource(config, null, agents.generalist), 'agent');
  const demo = projectCrew(config, 'demo', agents);
  assert.equal(demo.generalist.effort, 'low');
  assert.equal(demo.manager.effort, 'xhigh', "the manager's reviews of the project's runs");
  assert.equal(effortSource(config, 'demo', demo.generalist), 'project');
  assert.equal(projectCrew(config, 'own', agents).editor.effort, 'high');
  assert.equal(effortSource(config, 'own', projectCrew(config, 'own', agents).editor), 'member');
  assert.equal(agents.generalist.effort, loadAgents({ owner: 'x' }).generalist.effort, 'a project never changes the general crew');
  assert.equal(parseEffort('MAX'), 'max');
  assert.equal(parseEffort('padrão'), 'default');
  assert.equal(parseEffort('huge'), null);

  const file = path.join(temp, 'effort-history.jsonl');
  let saved = null;
  const save = c => { saved = c; };
  const one = setEffort({ member: 'generalist', level: 'max', project: 'demo', config, save, file, by: 'manager' });
  assert.deepEqual([one.from, one.to, one.changed, one.by], ['low', 'max', true, 'manager']);
  assert.equal(saved.projects.demo.effort.generalist, 'max');
  assert.equal(config.projects.demo.effort.generalist, 'low', 'the settings given are not changed in place');
  const same = setEffort({ member: 'writer', level: 'medium', config, save: () => assert.fail('saved with no change'), file });
  assert.equal(same.changed, false);
  const back = setEffort({ member: 'writer', level: 'default', config, save, file });
  assert.equal(back.to, loadAgents({ owner: 'x' }).writer.effort ?? null, "back to the agent's own");
  assert.equal(saved.crew.writer, undefined, 'an empty crew setting is removed');
  const chat = setEffort({ member: 'manager', level: 'low', chat: true, config, save, file });
  assert.equal(saved.crew.manager.chat_effort, 'low');
  assert.ok(chat.changed);
  assert.throws(() => setEffort({ member: 'writer', level: 'low', chat: true, config, save, file }), /conversation/);
  assert.throws(() => setEffort({ member: 'nobody', level: 'low', config, save, file }), /Unknown agent/);
  assert.throws(() => setEffort({ member: 'writer', level: 'huge', config, save, file }), /Unknown effort/);
  assert.throws(() => setEffort({ member: 'writer', level: 'low', project: 'nope', config, save, file }), /Unknown project/);

  const all = effortHistory({ file });
  assert.equal(all.length, 3);
  assert.equal(effortHistory({ project: 'own', file }).length, 2, "another project's change is not this project's");
  assert.equal(runEffortChanges({ project: 'demo', started: '2000-01-01T00:00:00Z' }, file).length, 3);
  assert.equal(runEffortChanges({ project: 'demo', started: '2000-01-01T00:00:00Z', ended: '2000-01-02T00:00:00Z' }, file).length, 0);
  assert.match(effortChangeLine(one), /manager: generalist in demo, low → max$/);

  // A step records the level its tool was given: Codex has no max and runs at its own default.
  assert.deepEqual([toolEffort('claude', 'max'), toolEffort('claude', undefined), toolEffort('codex', 'max'), toolEffort('codex', 'xhigh'), toolEffort('grok', 'max')], ['max', null, null, 'xhigh', 'max']);
});

test("the settings' backup: a redacted copy in backup_dir, the full one only on this computer", () => {
  const config = {
    owner: 'Someone', port: 4747, default_model: 'claude-opus-5-5',
    backup_dir: path.join(temp, 'backup', 'repo'),
    projects: {
      demo: {
        name: 'Demo', repository: 'https://github.com/someone/demo.git', main_branch: 'main', checks: ['npm test'], sensitive: true,
        about: 'Family budget kept by Jane Roe', notes: 'Pays R$ 1.234,56 a month; write to jane.roe@example.com',
        agent_notes: { writer: 'Call Jane at (51) 99876-5432' },
        crew: { editor: { agent: 'writer', name: 'Editor', extra_instructions: 'Jane Roe owes 300 reais' } },
        lead: { name: 'Lead', extra_instructions: 'Private' },
      },
    },
    missions: { weekly: { name: 'Weekly', project: 'demo', description: 'Text', steps: [{ agent: 'writer', part: 'Text' }], review: { agent: 'manager', part: 'Text' }, schedule: { days: ['mon'], time: '09:00' } } },
    crew: { manager: { max_minutes: 60, extra_instructions: 'Private' } },
    library: { acervo: { name: 'Acervo', repository: 'git@github.com:someone/acervo.git', about: 'Private' } },
    mcp_servers: {
      api: { command: 'npx', args: ['tool@1.2.3', '--access-token', 'sbp_0123456789abcdef0123', '--api-key=sk_live_0123456789abcdef'], env: { SERVICE_KEY: 'abc123' }, headers: { 'X-Any': 'xyz' } },
      web: { type: 'http', url: 'https://me:pa55word@mcp.example.net/mcp?api_key=s3cr3t&lang=en' },
    },
    remote_access: { enabled: true, logins: ['owner@example.com'], api_token: 'tk-9f8e', pin: 4321 },
    prompt_builder: { doc_id: '1AbCdEfGh', environment: 'Home' },
    plan_resets: [{ kind: 'full', expires: '2026-12-10T19:00:00-03:00', used: false, note: 'Free reset' }],
    sessions: { live: { name: 'Live', tool: 'claude', setup: 'Budget of US$ 300; CPF 123.456.789-09; write to ana@example.com' } },
  };
  const before = JSON.stringify(config);
  const red = redactConfig(config);
  assert.equal(JSON.stringify(config), before, 'the settings given are not changed');
  const text = JSON.stringify(red);
  for (const word of ['Jane', 'example.com', '1.234,56', '99876', '300', 'abc123', 'xyz', 'tk-9f8e', '4321', '1AbCdEfGh', '123.456.789', 'Private', 'Free reset', 'sbp_0123', 'sk_live', 'pa55word', 's3cr3t']) {
    assert.ok(!text.includes(word), `${word} left in the redacted copy`);
  }
  const demo = red.projects.demo;
  assert.deepEqual([demo.about, demo.notes, demo.agent_notes, demo.crew.editor.extra_instructions], ['[removed from this copy]', '[removed from this copy]', { writer: '[removed from this copy]' }, '[removed from this copy]']);
  assert.deepEqual([demo.name, demo.repository, demo.main_branch, demo.checks, demo.sensitive, demo.crew.editor.agent], ['Demo', 'https://github.com/someone/demo.git', 'main', ['npm test'], true, 'writer'], 'the structure stays');
  assert.deepEqual(red.missions.weekly.schedule, { days: ['mon'], time: '09:00' });
  assert.equal(red.missions.weekly.steps[0].agent, 'writer');
  assert.deepEqual([red.mcp_servers.api.command, red.mcp_servers.api.env.SERVICE_KEY, red.mcp_servers.api.headers['X-Any']], ['npx', '[secret]', '[secret]']);
  // A secret after a flag or in an address goes; a pinned package and a git remote over SSH are not e-mails.
  assert.deepEqual(red.mcp_servers.api.args, ['tool@1.2.3', '--access-token', '[secret]', '--api-key=[secret]']);
  assert.equal(red.mcp_servers.web.url, 'https://[secret]@mcp.example.net/mcp?api_key=[secret]&lang=en');
  assert.equal(red.library.acervo.repository, 'git@github.com:someone/acervo.git');
  assert.deepEqual([red.remote_access.logins, red.remote_access.api_token, red.remote_access.pin, red.prompt_builder.doc_id], [['[login]'], '[secret]', '[secret]', '[id]']);
  assert.equal(red.plan_resets[0].expires, '2026-12-10T19:00:00-03:00', 'dates are not amounts or phones');
  assert.equal(red.sessions.live.setup, 'Budget of [amount]; CPF [document]; write to [email]');
  assert.deepEqual([red.owner, red.port, red.backup_dir], ['Someone', 4747, config.backup_dir]);
  assert.match(red.backup_note, /Redacted copy/);

  const fullDir = path.join(temp, 'backup', 'local');
  backupConfig(config, { fullDir });
  assert.deepEqual(JSON.parse(readFileSync(path.join(config.backup_dir, 'chiefmate.json'), 'utf8')), red);
  assert.deepEqual(JSON.parse(readFileSync(path.join(fullDir, 'chiefmate.json'), 'utf8')), config, 'the full copy, on this computer');
  const other = path.join(temp, 'backup', 'none');
  backupConfig({ owner: 'x' }, { fullDir: other });
  assert.ok(!existsSync(other), 'no backup without backup_dir');
});

test('npm run check says why a script was not checked, with no pipe a sandbox could refuse', () => {
  const calls = [];
  const fake = result => (command, args, options) => (calls.push(options), result);
  const denied = Object.assign(new Error('spawnSync C:\\Program Files\\nodejs\\node.exe EPERM'), { code: 'EPERM' });
  assert.equal(syntaxProblem('src/a.mjs', fake({ error: denied, status: null, stderr: undefined })),
    "Couldn't check src/a.mjs: EPERM, spawnSync C:\\Program Files\\nodejs\\node.exe EPERM");
  assert.match(syntaxProblem('src/b.mjs', fake({ status: 1, signal: null })), /^Syntax error in src\/b\.mjs \(exit code 1\)/);
  assert.equal(syntaxProblem('src/c.mjs', fake({ status: 0 })), null);
  // An stdio left out (whole or in part) is a pipe too.
  const stdio = o => typeof o?.stdio === 'string' ? [o.stdio, o.stdio, o.stdio] : [0, 1, 2].map(i => o?.stdio?.[i]);
  assert.ok(calls.length === 3 && calls.every(o => stdio(o).every(s => s != null && s !== 'pipe' && s !== 'overlapped')), 'node --check got a pipe');
  assert.equal(syntaxProblem(path.join('scripts', 'fixtures.mjs')), null, 'a real script failed the check');
});
