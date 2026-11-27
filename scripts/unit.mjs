// Unit tests with no dependency (node:test): the file viewer's checks of paths, its choice among a project's copies and
// its readers of tables; a copy behind its origin and the fast forward of a clone; the approval levels; the app's dictation;
// the band of what a live session asks; the emergency lockdown and its detection; the warning before Claude Code's
// sign-in expires; each agent's effort; the redacted backup of the settings; the usage resets' countdowns.
// Usage: npm test. Everything is made up, in a temporary folder removed at the end.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { browserState, findBrowsers, initials, isPlaywright, launchArgs, PALETTE, projectColor, shouldClose, themeManifest, windowName } from '../src/browsers.mjs';
import { describeDoing, LOGIN_RENEW, loginDue, loginLine, loginRead, loginWarning, parseLoginStatus, readFeed } from '../src/claude.mjs';
import { loginText } from '../src/plan.mjs';
import { backupConfig, loadAgents, projectCrew, redactConfig } from '../src/config.mjs';
import { effortChangeLine, effortHistory, effortSource, parseEffort, runEffortChanges, setEffort } from '../src/effort.mjs';
import { checkPath, kindOf, listFolder, newestCopy, opening, openOnComputer, projectPlaces, rawHeaders, rootsFor, runFiles, viewerRoots, viewFile } from '../src/files.mjs';
import { guardHooks, plainPush, publishing, riskyCommand } from '../src/guard.mjs';
import { checkSignals, engage, isLocked, ownerKeyFile, protectedFolders, readLockdown, recordSignal, refuseWhileLocked, release, RULES, weigh, WINDOW_MINUTES } from '../src/lockdown.mjs';
import { startedAt } from '../src/machine.mjs';
import { parseCsv, readXlsx, zipEntries } from '../src/sheets.mjs';
import { copyHolders, pickNext } from '../src/queue.mjs';
import { askedTool, copyHolder, endLine, holdsCopy, limitWaitCleared, stepTool } from '../src/runs.mjs';
import { addSpeech, askedBy, SPEECH_KEEP, SPEECH_MAX, SPEECH_SHOWN, speechLine, speechNow, speechRule, speechView } from '../src/speech.mjs';
import {
  agentTool, availableTools, chooseTool, codexEnvironment, codexEvents, codexGuard, codexStepArgs, correctionLine, GROK_DENY, grokEvents, grokStepArgs, parseTool,
  qualityRecords, qualitySummary, runTools, toolAvailable, toolEffort, toolModel,
} from '../src/tools.mjs';
import { parseLevel } from '../src/util.mjs';
import { behindOrigin, checkoutBranch, fastForward, freshenBranch, projectLibraries, restoreShelf, sameRepository, shelfRef, shelveWork } from '../src/workspace.mjs';
import { syntaxProblem } from './check.mjs';
import { SAMPLE_CSV, sampleXlsx, zip } from './fixtures.mjs';
import { countdown, resetLabel, spare, SPARE_MIN_FREE, SPARE_WITHIN_MS, timeLeft } from '../ui/countdown.js';
import { compose, Dictation, nextState, recognizer, transcript } from '../ui/voice.js';
import './away-ui.test.mjs';
import { AFAR_VERSION, offered, ONLY_ON_PC } from '../ui/afar.js';
import { asksHtml, asksLayout, GROUP_FROM, keepFolds, newFolds, toggleFold } from '../ui/asks.js';
import { devLog, startDev } from '../src/projects.mjs';
import { connectionOwner, fromAfar, fromServe, isTailscaleService, ownAddresses, ownerOnly, remoteRefusal, tailnetSource } from '../src/server.mjs';
import { forAgent, isOwner, openAppWindow, OWNER_HEADER, ownerHeaders, ownerKey, pairingCode, redeemCode } from '../src/owner.mjs';

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
    // The table of ui/afar.js itself, seen from the computer or from the phone.
    $: selector => nodes[selector.slice(1)], offered: action => offered(action, here ? 'localhost' : 'pc.tailnet.ts.net'), toast: text => toasts.push(text), baseName: p => p.split(/[\\/]/).pop(),
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

// ---------- A paused run's working copy: its work put aside, the copy kept, the branch up to date ----------

/** A text file as LF, whatever core.autocrlf did to it. */
const lf = file => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

/** origin with a main branch, and the crew's copy of it on the run's branch "run-a". */
function pausedCopy() {
  const top = mkdtempSync(path.join(temp, 'paused-'));
  const origin = path.join(top, 'origin');
  const dir = path.join(top, 'copy');
  mkdirSync(origin);
  gitIn(origin, 'init', '-q', '-b', 'main');
  write(path.join(origin, 'app.md'), 'App\n');
  gitIn(origin, 'add', '-A');
  gitIn(origin, 'commit', '-qm', 'start');
  gitIn(top, 'clone', '-q', origin, dir);
  gitIn(dir, 'checkout', '-q', '-b', 'run-a');
  // A stash is a commit: Chiefmate's own git calls need an identity.
  gitIn(dir, 'config', 'user.name', 'Test');
  gitIn(dir, 'config', 'user.email', 'test@example.com');
  /** A pull request merged on origin's main meanwhile. */
  const merged = (name, text) => {
    write(path.join(origin, name), text);
    gitIn(origin, 'add', '-A');
    gitIn(origin, 'commit', '-qm', `merged ${name}`);
  };
  return { dir, origin, merged, git: (...args) => gitIn(dir, ...args) };
}

test('a paused run keeps its work: another run preparing the copy loses nothing, and it comes back on the current main', async () => {
  const { dir, merged, git } = pausedCopy();
  // Run A's step paused with a new file and a changed one, not committed.
  write(path.join(dir, 'new.md'), 'New\n');
  write(path.join(dir, 'app.md'), 'App by A\n');
  const commit = await shelveWork(dir, 'run-a');
  assert.match(commit, /^[0-9a-f]{40}$/);
  assert.equal(git('status', '--porcelain'), '');
  assert.equal(git('rev-parse', shelfRef('run-a')), commit);
  assert.match(git('stash', 'list'), /chiefmate: paused run run-a/);
  // Run B of the same project prepares the copy as prepareWorkspace does, and leaves work of its own in the stash list.
  git('checkout', '-q', '-f', 'main');
  git('reset', '--hard', '-q', 'origin/main');
  git('clean', '-fdq');
  write(path.join(dir, 'b.md'), 'B\n');
  git('stash', 'push', '-q', '--include-untracked', '-m', 'other');
  // Seven pull requests merged while A waited.
  for (let n = 1; n <= 7; n++) merged(`pr${n}.md`, `PR ${n}\n`);
  await checkoutBranch(dir, 'run-a');
  const fresh = await freshenBranch(dir, 'main');
  assert.equal(fresh.behind, 7);
  assert.equal(git('rev-parse', 'HEAD'), git('rev-parse', 'origin/main'));
  assert.equal(git('branch', '--show-current'), 'run-a');
  await restoreShelf(dir, 'run-a', commit);
  assert.equal(lf(path.join(dir, 'new.md')), 'New\n');
  assert.equal(lf(path.join(dir, 'app.md')), 'App by A\n');
  assert.ok(existsSync(path.join(dir, 'pr7.md')));
  // Its stash and ref are gone; the other stash stays.
  assert.equal(git('stash', 'list').split('\n').length, 1);
  assert.match(git('stash', 'list'), /other/);
  assert.throws(() => git('rev-parse', '--verify', '-q', shelfRef('run-a')));
  assert.equal(await shelveWork(dir, 'run-a').then(() => shelveWork(dir, 'run-a')), null);
});

test("a branch with commits of its own, or a copy with changes, isn't moved; work that doesn't fit keeps its stash", async () => {
  const { dir, merged, git } = pausedCopy();
  write(path.join(dir, 'own.md'), 'Own\n');
  git('add', '-A');
  git('commit', '-qm', 'own');
  merged('pr1.md', 'PR 1\n');
  const head = git('rev-parse', 'HEAD');
  assert.equal(await freshenBranch(dir, 'main'), null);
  assert.equal(git('rev-parse', 'HEAD'), head);

  const second = pausedCopy();
  second.merged('pr1.md', 'PR 1\n');
  write(path.join(second.dir, 'dirty.md'), 'Dirty\n');
  const start = second.git('rev-parse', 'HEAD');
  assert.equal(await freshenBranch(second.dir, 'main'), null);
  assert.equal(second.git('rev-parse', 'HEAD'), start);

  // The work changes a file main changed too: it doesn't apply there, the copy is left clean and the stash kept.
  const third = pausedCopy();
  write(path.join(third.dir, 'app.md'), 'App by A\n');
  const commit = await shelveWork(third.dir, 'run-a');
  third.merged('app.md', 'App on main\n');
  const fresh = await freshenBranch(third.dir, 'main');
  await assert.rejects(restoreShelf(third.dir, 'run-a', commit), /stash apply/);
  assert.equal(third.git('status', '--porcelain'), '');
  assert.equal(third.git('rev-parse', shelfRef('run-a')), commit);
  // Back on the branch where it was, it applies; over changes already in the copy, it applies and cleans nothing.
  third.git('reset', '--hard', '-q', fresh.from);
  write(path.join(third.dir, 'mine.md'), 'Mine\n');
  await assert.rejects(restoreShelf(third.dir, 'run-a', commit), /changes not committed/);
  assert.equal(lf(path.join(third.dir, 'mine.md')), 'Mine\n');
  assert.equal(third.git('rev-parse', shelfRef('run-a')), commit);
  rmSync(path.join(third.dir, 'mine.md'));
  await restoreShelf(third.dir, 'run-a', commit);
  assert.equal(lf(path.join(third.dir, 'app.md')), 'App by A\n');
});

test('a run paused in the middle of its work keeps the copy: no other run of the project starts until it resumes', () => {
  const at = '2026-11-26T12:00:00.000Z';
  const runA = { id: 'a', project: 'demo', created: at, status: 'paused', prepared: true, resumeFirst: true };
  const runB = { id: 'b', project: 'demo', created: at, status: 'queued' };
  const runC = { id: 'c', project: 'other', created: at, status: 'queued' };
  assert.equal(holdsCopy(runA), true);
  assert.equal(holdsCopy({ ...runA, resumeFirst: false }), false);
  assert.equal(holdsCopy({ ...runA, resumeFirst: false, shelf: { commit: 'x' } }), true);
  assert.equal(holdsCopy({ ...runA, prepared: false }), false);
  assert.equal(holdsCopy({ ...runA, status: 'done' }), false);
  assert.equal(copyHolder(runB, [runA, runB, runC])?.id, 'a');
  assert.equal(copyHolder(runC, [runA, runB, runC]), null);
  // Paused (held for the owner): B waits, the other project's run goes on.
  const holders = copyHolders([runA, runB, runC]);
  assert.deepEqual(pickNext([runB, runC], [], 3, Date.now(), holders).map(r => r.id), ['c']);
  // Back in the queue (first, as resumeFirst puts it): A starts, never B beside it.
  const back = { ...runA, status: 'queued' };
  assert.deepEqual(pickNext([back, runB, runC], [], 3, Date.now(), copyHolders([back, runB, runC])).map(r => r.id), ['a', 'c']);
  // Waiting for a time ahead: nothing of the project starts.
  const later = { ...runA, status: 'waiting', notBefore: new Date(Date.now() + 3_600_000).toISOString() };
  assert.deepEqual(pickNext([later, runB], [], 3, Date.now(), copyHolders([later, runB])).map(r => r.id), []);
  // Once it resumed and ended, B goes.
  assert.deepEqual(pickNext([runB], [], 3, Date.now(), copyHolders([{ ...runA, status: 'done' }, runB])).map(r => r.id), ['b']);
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
    'curl -X POST https://api.github.com/repos/a/b/pulls', 'gh gist create f --public', 'gh release create v1', 'gh workflow run ci', 'gh secret set T']) assert.ok(caught(c), `not refused: ${c}`);
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

// ---------- What a live session asks (ui/asks.js): the compact band, its group and its folds ----------

const askUi = {
  t: (text, values = {}) => text.replace(/\{(\w+)\}/g, (_, k) => values[k]),
  esc: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
  facts: a => `<p class="facts-of-${a.id}">${a.what}</p>`,
};
const ask = (id, summary) => ({ id, kind: 'permission', what: `run ${id}`, ...(summary ? { explain: { summary } } : {}) });
const toggles = html => [...html.matchAll(/data-ask-fold="([^"]+)" aria-expanded="(true|false)"/g)].map(m => [m[1], m[2] === 'true']);

test('Asks band: one ask is one line, its details folded until opened and folded again', () => {
  const one = [ask('a1', 'Delete the build folder')];
  let folds = newFolds('s1');
  let html = asksHtml(one, folds, askUi);
  assert.equal(asksLayout(one, folds).grouped, false);
  assert.match(html, /Needs you/);
  assert.match(html, /Delete the build folder/);
  assert.match(html, /data-live-allow="a1"/);
  assert.match(html, /data-live-refuse="a1"/);
  assert.deepEqual(toggles(html), [['a1', false]]);
  assert.doesNotMatch(html, /facts-of-a1/);
  folds = toggleFold(folds, 'a1');
  html = asksHtml(one, folds, askUi);
  assert.deepEqual(toggles(html), [['a1', true]]);
  assert.match(html, /<div class="ask-details" id="ask-a1"><p class="facts-of-a1">/);
  folds = toggleFold(folds, 'a1');
  assert.deepEqual(toggles(asksHtml(one, folds, askUi)), [['a1', false]]);
  assert.equal(asksHtml([], folds, askUi), '');
});

test('Asks band: from two asks, one line with their number, unfolded into the lines and folded back', () => {
  const two = [ask('a1', 'Delete the build folder'), ask('a2')];
  let folds = newFolds('s1');
  let html = asksHtml(two, folds, askUi);
  assert.equal(GROUP_FROM, 2);
  assert.deepEqual(asksLayout(two, folds), { grouped: true, expanded: false, count: 2, rows: [] });
  assert.match(html, /2 permissions asked/);
  assert.deepEqual(toggles(html), [['band', false]]);
  assert.doesNotMatch(html, /data-live-allow/);
  folds = toggleFold(folds, 'band');
  html = asksHtml(two, folds, askUi);
  assert.deepEqual(toggles(html), [['band', true], ['a1', false], ['a2', false]]);
  assert.match(html, /The agent asks to: run a2/);
  assert.equal((html.match(/data-live-allow=/g) ?? []).length, 2);
  assert.equal((html.match(/Needs you/g) ?? []).length, 1, 'the label shows once, on the group line');
  folds = toggleFold(folds, 'a2');
  assert.deepEqual(toggles(asksHtml(two, folds, askUi)), [['band', true], ['a1', false], ['a2', true]]);
  folds = toggleFold(folds, 'band');
  html = asksHtml(two, folds, askUi);
  assert.deepEqual(toggles(html), [['band', false]]);
  assert.doesNotMatch(html, /facts-of-a2/);
});

test("Asks band: the folds don't change in place, and what was answered is forgotten", () => {
  const folds = newFolds('s1');
  const opened = toggleFold(toggleFold(folds, 'a1'), 'a2');
  assert.deepEqual(folds, { session: 's1', band: false, open: [] });
  assert.deepEqual(opened.open, ['a1', 'a2']);
  assert.deepEqual(keepFolds(opened, [ask('a2')]).open, ['a2']);
  const group = toggleFold(folds, 'band');
  assert.equal(keepFolds(group, [ask('a1')]).band, true, 'the group stays open while asks remain');
  assert.equal(keepFolds(group, []).band, false, 'once all are answered, the next ones come folded');
  assert.match(asksHtml([ask('<x>', 'a "quoted" <b>')], folds, askUi), /data-ask-fold="&lt;x>"[^]*a &quot;quoted&quot; &lt;b>/);
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

test("A push's folder is the command's own (a cd before it, git -C), so its card names the right repository", () => {
  const dirOf = command => publishing(command)[0]?.dir ?? null;
  const other = path.join(temp, 'acervo');
  assert.equal(path.resolve(dirOf(`cd "${other}" && git push origin main`)), other);
  assert.equal(path.resolve(temp, dirOf('cd sub && git -C inner push origin x')), path.join(temp, 'sub', 'inner'));
  assert.equal(dirOf('git push origin x'), null);
  if (process.platform === 'win32') assert.equal(path.resolve(dirOf('cd /c/Users/x && git push origin y')), path.resolve('C:/Users/x'));
  // The same push however it is written, the same folder; never the main branch, never forced.
  const target = plainPush('git push origin feature', temp);
  assert.deepEqual(plainPush('git push -u origin feature 2>&1', temp), target);
  assert.deepEqual(plainPush(`cd "${temp}" && git push --set-upstream origin feature >/dev/null 2>&1`, os.tmpdir()), target);
  assert.equal(plainPush('git push -u origin main 2>&1', temp).refused, 'main');
  assert.equal(plainPush('git push --force-with-lease origin feature 2>&1', temp).refused, 'forced');
});

test("gh's gists, releases, workflows and secrets publish, each under its own rule; what only looks does not", () => {
  const rules = command => publishing(command).map(f => f.rule);
  for (const [command, rule] of [
    ['gh gist create notes.md --public', 'Bash(gh gist:*)'], ['gh gist create notes.md', 'Bash(gh gist:*)'], ['gh gist edit 123', 'Bash(gh gist:*)'],
    ['gh release create v1.0 --notes x', 'Bash(gh release:*)'], ['gh -R a/b release upload v1 f.zip', 'Bash(gh release:*)'],
    ['gh workflow run ci.yml', 'Bash(gh workflow:*)'], ['gh workflow enable ci', 'Bash(gh workflow:*)'],
    ['gh secret set TOKEN -b x', 'Bash(gh secret:*)'], ['gh secret delete TOKEN', 'Bash(gh secret:*)'],
    ['bash -c "gh release create v2"', 'Bash(gh release:*)'], ['cd x && gh workflow run deploy', 'Bash(gh workflow:*)'],
  ]) assert.deepEqual(rules(command), [rule], command);
  for (const command of ['gh gist view 1', 'gh gist list', 'gh release view v1', 'gh release list', 'gh release download v1', 'gh workflow list', 'gh workflow view ci', 'gh secret list']) {
    assert.deepEqual(rules(command), [], command);
  }
  // Allowed on its card, the rule goes to the hook like the others.
  const hook = guardHooks({ log: 'g', allowed: ['Bash(gh release:*)', 'Bash(rm:*)'] }).PreToolUse[0].hooks[0].command;
  assert.ok(hook.includes('--allow "Bash(gh release:*)"') && !hook.includes('rm:'), hook);
});

test("A heredoc's text written into a file by a command that does nothing else is data; any other is looked at as before", () => {
  const rules = command => publishing(command).map(f => f.rule);
  // Only written: a test script that quotes gh and git, in any of the usual forms, with commands that run nothing.
  for (const command of [
    "cat > .tmp/guard-test.mjs <<'EOF'\nassert.deepEqual(publishing('gh pr view 3'), []);\n// don't: gh pr create\ngh repo delete x\ngit push origin main\nEOF",
    "mkdir -p .tmp && cat <<'EOF' > .tmp/t.sh\ngh pr merge 3\nEOF\nchmod +x .tmp/t.sh && ls -l .tmp",
    'cat <<EOF >> notes.txt\ngit push\nEOF',
    "tee -a log.txt <<'EOF'\ngh release create v1\nEOF",
    "tee f.txt > /dev/null <<'EOF'\ngh release create v1\nEOF",
    "cat > a.txt <<'A' && cat > b.txt <<\"B\"\ngit push\nA\ngh pr create\nB",
    "cat > t.txt <<-'EOF'\n\tgit push\n\tEOF",
  ]) assert.deepEqual(rules(command), [], command);
  // Run, expanded, piped, named again or another way, or not really a heredoc: still refused. Anything but an INERT
  // program may run the file (a glob, a variable, xargs, a hook, a test runner), and bash reads "${x:-"<<EOF "}",
  // $[1 << 2] and an escaped "cat()" otherwise than a heredoc.
  for (const command of [
    "cat <<'EOF' > t.sh\ngit push\nEOF\nnpm test",
    "cat > t.sh <<'EOF'\ngit push\nEOF\nbash *.sh",
    "cat > t.sh <<'EOF'\ngit push\nEOF\nbash<t.sh",
    "cat > t <<'EOF'\ngit push\nEOF\nf=t; bash $f",
    "cat > t.sh <<'EOF'\ngit push\nEOF\nbash {t,}.sh",
    "cat > t.sh <<'EOF'\ngit push\nEOF\nls | xargs bash",
    "cat > t.sh <<'EOF'\ngit push\nEOF\nbash \"\\\"\"; bash t.sh",
    "cat > .git/hooks/pre-commit <<'EOF'\ngit push\nEOF\ngit commit -m x",
    "cat > cat <<'EOF'\ngit push\nEOF\nchmod +x cat && ./cat",
    "PATH=. cat > f <<'EOF'\ngit push\nEOF",
    'cat > f.txt "${x:-"<<EOF "}"\ngit push\nEOF',
    'cat > f.txt $[ 1 << 2 ]\ngit push\n2',
    "cat\\\n() { bash; }; cat > f.txt <<'EOF'\ngit push\nEOF",
    "eval cat\\(\\)\\{ bash\\;\\}; cat > f.txt <<'EOF'\ngit push\nEOF",
    "bash -c \"cat > t.sh <<'EOF'\ngit push\nEOF\" && bash t.sh",
    "bash <<'EOF'\ngit push\nEOF",
    "cat <<'EOF' | bash\ngit push\nEOF",
    "cat > t.sh <<'EOF'\ngit push\nEOF\nbash t.sh",
    "cat > t.sh <<'EOF'\ngit push\nEOF\nchmod +x t.sh && ./t.sh",
    'cat > t.txt <<EOF\n$(git push)\nEOF',
    'cat > t.txt <<EOF\n`git push`\nEOF',
    "cat > >(bash) <<'EOF'\ngit push\nEOF",
    "tee /dev/stdout <<'EOF' | sh\ngit push\nEOF",
    "mkfifo p; bash < p & cat > p <<'EOF'\ngit push\nEOF",
    "cat() { bash -s; }; cat > f <<'EOF'\ngit push\nEOF",
    "{bash,-s} cat > f <<'EOF'\ngit push\nEOF",
    "$(echo bash -s) cat > f <<'EOF'\ngit push\nEOF",
    "bash -s &> cat > f <<'EOF'\ngit push\nEOF",
    "# cat > f <<'EOF'\ngit push\nEOF",
    "echo 'cat > f <<EOF'\ngit push\nEOF",
    "echo ${#y} 'a\ncat > f <<'EOF'\n'\ngit push\nEOF",
    "cat > f <<'EOF'\ngit push",
    "cat > f <<$'EOF'\ngit push\nEOF",
    "cat > f <<'EOF'\nnotes\nEOF\ngit push origin x",
  ]) assert.deepEqual(rules(command), ['Bash(git push:*)'], command);
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

  // full_backup_dir: the full copy also off this computer, on its own too, but never inside git nor in backup_dir.
  const cloud = path.join(temp, 'backup', 'cloud');
  backupConfig({ ...config, full_backup_dir: cloud }, { fullDir });
  assert.equal(JSON.parse(readFileSync(path.join(cloud, 'chiefmate.json'), 'utf8')).projects.demo.notes, config.projects.demo.notes);
  const alone = { owner: 'y', full_backup_dir: path.join(temp, 'backup', 'alone') };
  backupConfig(alone, { fullDir: other });
  for (const dir of [alone.full_backup_dir, other]) assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'chiefmate.json'), 'utf8')), alone);
  const repo = path.join(temp, 'backup', 'git');
  mkdirSync(path.join(repo, '.git'), { recursive: true });
  const logged = console.error;
  const said = [];
  console.error = (...words) => said.push(words.join(' '));
  try {
    backupConfig({ owner: 'z', full_backup_dir: path.join(repo, 'private') }, { fullDir: path.join(temp, 'backup', 'z') });
    backupConfig({ ...config, full_backup_dir: config.backup_dir }, { fullDir });
    // the same folder spelled in other letters, on Windows
    if (windows) backupConfig({ ...config, full_backup_dir: `${config.backup_dir.toUpperCase()}\\` }, { fullDir });
    // a value that is not a path neither breaks the save nor Chiefmate's start
    backupConfig({ owner: 'w', full_backup_dir: true }, { fullDir: path.join(temp, 'backup', 'w') });
  } finally {
    console.error = logged;
  }
  assert.ok(!existsSync(path.join(repo, 'private')), 'no full copy inside a git repository');
  assert.equal(JSON.parse(readFileSync(path.join(config.backup_dir, 'chiefmate.json'), 'utf8')).projects.demo.notes, '[removed from this copy]', 'backup_dir keeps the redacted copy');
  assert.deepEqual(said.map(line => line.match(/full_backup_dir (.+?)(?: \(|, so )/)?.[1] ?? line),['is inside a git repository', 'is the same folder as backup_dir', ...(windows ? ['is the same folder as backup_dir'] : []), 'is not a folder path'], 'the log says why');
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

test('speech bubbles: the lines kept, who asked, the line shown now and its state', () => {
  const at = minutes => new Date(Date.parse('2026-11-27T10:00:00Z') + minutes * 60_000).toISOString();
  const run = { id: 'r', kind: 'task', origin: 'manager', title: 'Redo pull request #81 without conflicts', steps: [{ agent: 'generalist', status: 'running' }] };
  // One line: spaces collapsed, at most SPEECH_MAX characters; nothing for an empty text.
  assert.equal(speechLine('  Fixing\n the   tests '), 'Fixing the tests');
  assert.ok(speechLine('x'.repeat(400)).length <= SPEECH_MAX);
  assert.equal(addSpeech(run, { step: 1, agent: 'generalist', text: '   ' }), null);
  // Who asked: the manager for a task it queued; the lead for a task it planned; nobody for a mission or a review.
  assert.deepEqual(askedBy(run, run.steps[0]), { by: 'manager', text: run.title });
  assert.deepEqual(askedBy({ ...run, origin: 'app' }, run.steps[0]), { by: 'owner', text: run.title });
  assert.equal(askedBy({ ...run, kind: 'mission' }, run.steps[0]), null);
  assert.deepEqual(askedBy(run, { agent: 'designer', by: 'lead', part: 'Adjust the Decisions screen' }), { by: 'lead', text: 'Adjust the Decisions screen' });
  assert.equal(askedBy(run, { agent: 'manager', review: true }), null);
  const asked = addSpeech(run, { step: 1, agent: 'generalist', ...askedBy(run, run.steps[0]), at: at(0) });
  assert.equal(asked.by, 'manager');

  // Fresh: the bubble shows who asked; ten minutes later with nothing said, a line from what the agent is doing, marked automatic.
  const live = { step: 1, agent: 'generalist', doing: 'running the tests', held: false, lastAt: at(1), since: at(0) };
  assert.deepEqual([speechNow(run, live, Date.parse(at(2)), 'en').by, speechNow(run, live, Date.parse(at(2)), 'en').auto], ['manager', false]);
  const later = speechNow(run, { ...live, lastAt: at(11) }, Date.parse(at(12)), 'en');
  assert.deepEqual([later.text, later.auto, later.state], ["I'm running the tests.", true, 'working']);
  // The agent's own line; another within a minute takes its place, the same one only refreshes its time.
  addSpeech(run, { step: 1, agent: 'generalist', text: 'Just finishing the tests', at: at(12) });
  addSpeech(run, { step: 1, agent: 'generalist', text: 'Just finishing the tests; one failed and I am fixing it', at: at(12.5) });
  addSpeech(run, { step: 1, agent: 'generalist', text: 'Just finishing the tests; one failed and I am fixing it', at: at(13) });
  assert.deepEqual(run.speech.map(x => x.by), ['manager', 'agent']);
  assert.equal(run.speech[1].at, at(13));
  const said = speechNow(run, { ...live, lastAt: at(13) }, Date.parse(at(14)), 'en');
  assert.deepEqual([said.text, said.by, said.auto], ['Just finishing the tests; one failed and I am fixing it', 'agent', false]);
  addSpeech(run, { step: 1, agent: 'generalist', text: 'Tests pass now', at: at(15) });
  assert.equal(run.speech.length, 3, 'a line more than a minute later is a new line');

  // Calling the owner: the request's line stays while the step waits for them, and is passed over once it goes on.
  addSpeech(run, { step: 1, agent: 'generalist', by: 'auto', state: 'calling', text: 'I need you: sign in to the site', at: at(16) });
  const calling = speechNow(run, { ...live, held: true, lastAt: at(16) }, Date.parse(at(40)), 'en');
  assert.deepEqual([calling.state, calling.text, calling.auto], ['calling', 'I need you: sign in to the site', true]);
  const goingOn = speechNow(run, { ...live, doing: 'changing app.js', lastAt: at(41) }, Date.parse(at(41.5)), 'en');
  assert.deepEqual([goingOn.state, goingOn.text], ['working', "I'm changing app.js."]);
  // Held with no call of its own (a request from before): the line from what it is doing, still calling.
  const heldAuto = speechNow({ speech: [] }, { ...live, doing: 'waiting for you', held: true }, Date.parse(at(42)), 'en');
  assert.deepEqual([heldAuto.state, heldAuto.text], ['calling', "I'm waiting for you."]);
  // No action for twenty minutes: stuck.
  assert.equal(speechNow(run, { ...live, lastAt: at(41) }, Date.parse(at(62)), 'en').state, 'stuck');

  // The step's end: done with the sentence of its summary, stopped with its error, waiting for the plan's limit.
  assert.equal(endLine({ status: 'done', outcome: { change: 'The Decisions screen is clearer.' } }).state, 'done');
  assert.match(endLine({ status: 'done', outcome: { change: 'The Decisions screen is clearer.' } }).text, /The Decisions screen is clearer\./);
  assert.deepEqual([endLine({ status: 'failed', error: 'time limit' }).state, /time limit/.test(endLine({ status: 'failed', error: 'time limit' }).text)], ['stuck', true]);
  assert.equal(endLine({ status: 'pending' }, at(300)).state, 'waiting');

  // Kept: at most SPEECH_KEEP lines; the app gets the last SPEECH_SHOWN, and the line now only for a run going on.
  for (let i = 0; i < SPEECH_KEEP + 20; i++) addSpeech(run, { step: 2, agent: 'designer', by: 'auto', text: `Line ${i}`, at: at(100 + i) });
  assert.equal(run.speech.length, SPEECH_KEEP);
  assert.equal(speechView(run).lines.length, SPEECH_SHOWN);
  assert.equal(speechView(run).now, null);
  assert.equal(speechView({}).lines.length, 0);
  // The rule the crew reads, and a line said through it that is not the agent's doing.
  assert.match(speechRule('node cli.mjs', 'Brazilian Portuguese', 'Sam'), /node cli\.mjs say "<one short line>"`, in Brazilian Portuguese/);
  assert.equal(describeDoing('Bash', { command: 'node "C:/x/src/cli.mjs" say "Adjusting the screen"' }), null);
  assert.equal(describeDoing('Bash', { command: 'node C:/x/src/cli.mjs say "Adjusting the screen"' }), null);
  assert.notEqual(describeDoing('Bash', { command: 'npm test' }), null);
});

// ---------- From another device (the remote access) ----------

test('from afar, what opens on the computer is refused and not offered, and the rest has a version that works', () => {
  for (const [action, { route, body }] of Object.entries(ONLY_ON_PC)) {
    assert.equal(fromAfar(route, { project: 'demo', ...body }).refused, true, `${action} is offered from afar but the server refuses it`);
    assert.equal(offered(action, 'pc.tailnet.ts.net'), false, `${action} is offered from afar`);
    assert.equal(offered(action, 'localhost'), true, `${action} is not offered on the computer`);
  }
  for (const [action, { route, body, becomes }] of Object.entries(AFAR_VERSION)) {
    const afar = fromAfar(route, { project: 'demo', ...body });
    assert.ok(!afar.refused, `${action} is refused from afar`);
    assert.deepEqual(afar.body, { project: 'demo', ...becomes }, `${action} does not become its version from afar`);
    assert.equal(offered(action, 'pc.tailnet.ts.net'), true, `${action} is not offered from afar`);
  }
  // What doesn't open anything goes on as it is.
  assert.deepEqual(fromAfar('/api/browser', { action: 'close', pid: 1 }), { body: { action: 'close', pid: 1 }, refused: false });
  assert.deepEqual(fromAfar('/api/project/dev', { action: 'stop' }).body, { action: 'stop' });
  assert.deepEqual(fromAfar('/api/task', { x: 1 }), { body: { x: 1 } });
});

test("the remote access takes only Tailscale Serve's connections, from another device of the tailnet", () => {
  const remote = { host: 'pc.tailnet.ts.net', logins: ['owner@example.com'], port: 4748 };
  const request = from => ({ method: 'GET', headers: { host: remote.host, 'tailscale-user-login': 'owner@example.com', ...(from === undefined ? {} : { 'x-forwarded-for': from }) } });
  // The phone, by its tailnet address (IPv4 or IPv6), goes on.
  assert.equal(tailnetSource('100.101.102.103', ['127.0.0.1']), '');
  assert.equal(tailnetSource('fd7a:115c:a1e0::1234', []), '');
  // This computer's own node calling its tailnet name carries the owner's login too: refused.
  assert.equal(tailnetSource('100.94.1.2', ['127.0.0.1', '100.94.1.2']), 'from this computer');
  // No address, one outside the tailnet, or a list of them: not what Serve sends.
  for (const from of [undefined, '', '127.0.0.1', '192.168.0.5', '100.128.0.1', '100.101.102.103, 100.1.2.3']) {
    assert.equal(tailnetSource(from, []), 'not through the tailnet', `${from} was taken as a tailnet device`);
  }
  assert.equal(remoteRefusal(request(undefined), remote), 'not through the tailnet');
  assert.equal(remoteRefusal(request('127.0.0.1'), remote), 'not through the tailnet');
  assert.ok(ownAddresses().includes('127.0.0.1'), "this computer's addresses were not read");
  const ownNode = ownAddresses().find(a => tailnetSource(a, []) === '');
  if (ownNode) assert.equal(remoteRefusal(request(ownNode), remote), 'from this computer');
  assert.equal(remoteRefusal(request('100.101.102.103'), remote), '');

  // Who opened the connection, read from netstat: the client's side of it, never the listener's.
  const netstat = [
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    127.0.0.1:4748         0.0.0.0:0              LISTENING       9768',
    '  TCP    127.0.0.1:4748         127.0.0.1:63518        ESTABLISHED     9768',
    '  TCP    127.0.0.1:63518        127.0.0.1:4748         ESTABELECIDA    8376',
    '  TCP    127.0.0.1:63520        127.0.0.1:4747         ESTABLISHED     5555',
  ].join('\r\n');
  assert.equal(connectionOwner(netstat, 63518, 4748), 8376);
  assert.equal(connectionOwner(netstat, 63520, 4748), 0);
  assert.equal(connectionOwner('', 63518, 4748), 0);
  // Tailscale's service runs in session 0, where a user's programs can't; one named like it elsewhere is refused.
  assert.equal(isTailscaleService('"tailscaled.exe","8376","Services","0","67,904 K"'), true);
  assert.equal(isTailscaleService('"tailscaled.exe","9000","Console","1","10,000 K"'), false);
  assert.equal(isTailscaleService('"svchost.exe","1200","Services","0","9,000 K"'), false);
  assert.equal(isTailscaleService('INFO: No tasks are running which match the specified criteria.'), false);
});

test('a program of this computer sending Serve\'s headers to the remote listener is refused', { skip: process.platform !== 'win32' }, async () => {
  const http = await import('node:http');
  let stand = {};
  const server = http.createServer((req, res) => fromServe(req.socket, stand).then(ok => res.end(String(ok))));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const ask = () => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: server.address().port, agent: false }, res => {
    let text = '';
    res.on('data', d => (text += d)).on('end', () => resolve(text));
  }).on('error', reject));
  try {
    // This test's own process is not Tailscale's service.
    assert.equal(await ask(), 'false');
    // The lookup finds the process that opened the connection: this one, when it stands in for Serve.
    stand = { servePid: process.pid };
    assert.equal(await ask(), 'true');
    stand = { servePid: process.pid + 1 };
    assert.equal(await ask(), 'false');
  } finally {
    server.close();
  }
});

// ---------- The owner's local key ----------

test("the owner's key is made once, kept in its file and checked exactly", () => {
  const dir = path.join(temp, 'owner-security');
  const key = ownerKey(dir);
  assert.match(key, /^[\w-]{40,}$/);
  assert.equal(readFileSync(ownerKeyFile(dir), 'utf8').trim(), key);
  assert.equal(ownerKey(dir), key, 'the key changed on a second reading');
  assert.equal(isOwner({ [OWNER_HEADER]: key }, dir), true);
  for (const wrong of [undefined, '', key.slice(1), `${key}x`, key.toUpperCase()]) assert.equal(isOwner({ [OWNER_HEADER]: wrong }, dir), false, `${wrong} was taken for the key`);
});

test("only the owner's terminal sends the key: an agent's command never does", () => {
  const dir = path.join(temp, 'owner-security');
  assert.deepEqual(ownerHeaders({}, dir), { [OWNER_HEADER]: ownerKey(dir) });
  for (const name of ['CHIEFMATE_RUN', 'CHIEFMATE_MANAGER', 'CHIEFMATE_SESSION', 'CHIEFMATE_RESCUER']) {
    assert.equal(forAgent({ [name]: '1' }), true, `${name} is not an agent`);
    assert.deepEqual(ownerHeaders({ [name]: '1' }, dir), {}, `the key goes with ${name}`);
  }
});

test("the owner's key is a protected place: an agent's command that reaches it is refused", () => {
  const data = path.join(temp, 'owner-data');
  const file = ownerKeyFile(path.join(data, 'security'));
  const protect = protectedFolders({}, data);
  assert.ok(protect.includes(file), "the key's file is not protected");
  for (const command of [`type "${file}"`, `node -e "console.log(require('fs').readFileSync('${file.replaceAll('\\', '/')}', 'utf8'))"`]) {
    assert.ok(riskyCommand(command, { cwd: temp, protect, home: temp, temp }).some(f => f.kind === 'protected_access'), `reading the key was not caught: ${command}`);
  }
});

test('a pairing code gives the key once, and only within its time', () => {
  const dir = path.join(temp, 'owner-security');
  const at = Date.now();
  const code = pairingCode(at);
  assert.equal(redeemCode(code, { at, dir }), ownerKey(dir));
  assert.equal(redeemCode(code, { at, dir }), null, 'a code was used twice');
  assert.equal(redeemCode(pairingCode(at), { at: at + 3 * 60_000, dir }), null, 'an expired code was taken');
  for (const wrong of ['made-up', undefined, '']) assert.equal(redeemCode(wrong, { at, dir }), null);
  assert.deepEqual(openAppWindow({ port: 1, dryRun: true }), { opened: false, dryRun: true }, 'a test opened a window');
});

test('without the key, a command may do only what an agent may, never as the owner', () => {
  const owners = [
    ['/api/lockdown', { action: 'release', confirm: true }], ['/api/lockdown', { action: 'engage', by: 'owner' }],
    ['/api/decide', { card: 'x', action: 'approve' }], ['/api/merge', { run: 'r' }], ['/api/merge', { run: 'r', by: 'owner' }],
    ['/api/close-pr', { run: 'r', replacedBy: 'n' }], ['/api/manager', { message: 'hi' }], ['/api/manager/edit', { id: '1' }],
    ['/api/manager/interrupt', {}], ['/api/needs-you/done', { run: 'r', id: '1', by: 'owner' }], ['/api/needs-you/done', { by: 'check', answer: 'yes' }],
    ['/api/defect/close', { id: 1 }], ['/api/session/say', { id: 's', text: 'x' }], ['/api/steer', { by: 'cli' }], ['/api/power', { action: 'standby' }],
    ['/api/planning', { action: 'approve', id: 1 }], ['/api/planning', { action: 'set', id: 1, status: 'approved' }], ['/api/radar', { action: 'choose', id: 1 }],
    ['/api/radar', { action: 'choose', id: 1, by: 'crew' }], ['/api/radar', { action: 'set', id: 1, status: 'virou projeto', by: 'crew' }], ['/api/radar', { action: 'set', id: 1 }],
    ['/api/update-now', { interruptManager: true }], ['/api/usage-reader', { enabled: true }], ['/api/files/open', { path: 'x' }], ['/api/effort', {}],
    ['/api/autopilot', {}], ['/api/away', { on: true }], ['/api/attention/seen', { ids: [] }], ['/api/run/talk', {}], ['/api/new-conversation', {}],
    ['/api/session/permission', {}], ['/api/work-now', {}], ['/api/voice-input', {}], ['/api/no-such-route', {}],
    ['/api/planning', { action: 'triage', id: 1, recommend: 'now' }], ['/api/planning', { action: 'reorder', ids: [1] }], ['/api/planning', { action: 'restore', id: 1 }],
    ['/api/planning', { action: 'add', project: 'p', title: 't', status: 'triaged' }], ['/api/planning', { action: 'triage', id: 1, by: 'owner' }],
    ['/api/say', { text: 'x' }], ['/api/say', { run: '', text: 'x' }],
  ];
  for (const [route, body] of owners) assert.equal(ownerOnly(route, body), true, `${route} ${JSON.stringify(body)} goes without the key`);
  // What the command line sends for an agent (a step, a live session, the manager, the watchdog and its rescuer).
  const agents = [
    ['/api/needs-you', { run: 'r', what: 'x' }], ['/api/needs-you/poll', { run: 'r', id: '1' }], ['/api/needs-you/done', { run: 'r', id: '1', by: 'check' }],
    ['/api/defect', { text: 'x', from: { run: 'r' } }], ['/api/defect/close', { id: 1, by: 'manager' }], ['/api/manager', { message: 'x', from: { session: 's' } }],
    ['/api/request', { id: 'x', action: 'approve' }], ['/api/ask-owner', { question: 'x' }], ['/api/task', {}], ['/api/ask', {}], ['/api/mission', {}],
    ['/api/level', {}], ['/api/cancel', {}], ['/api/resume', {}], ['/api/planning', { action: 'propose', project: 'p', title: 't', run: 'r' }],
    ['/api/planning', { action: 'approve', id: 1, by: 'manager' }], ['/api/radar', { action: 'add', by: 'crew' }], ['/api/session', { profile: 'x' }],
    ['/api/radar', { action: 'set', id: 1, summary: 'x', by: 'crew' }], ['/api/radar', { action: 'set', id: 1, status: 'project', project: 'p', by: 'manager' }],
    ['/api/session/end', { id: 's' }], ['/api/session/say', { id: 's', text: 'x', by: 'manager' }], ['/api/steer', { by: 'manager' }],
    ['/api/merge', { run: 'r', preview: true }], ['/api/merge', { run: 'r', by: 'manager' }], ['/api/close-pr', { run: 'r', by: 'manager' }],
    ['/api/lockdown', { action: 'engage', by: 'step' }], ['/api/limits', {}], ['/api/stop-project', { project: 'p', pids: [1] }], ['/api/project/dev', {}],
    ['/api/prompts-sync', {}], ['/api/update-check', {}], ['/api/update-now', {}], ['/api/usage-reader', { read: true }], ['/api/watchdog', { text: 'x' }],
    ['/api/owner/window', {}], ['/api/owner/pair', { code: 'x' }],
    // The manager's triage and the board's order, and a step's line for its speech bubble.
    ['/api/planning', { action: 'triage', id: 1, recommend: 'now', by: 'manager' }], ['/api/planning', { action: 'reorder', ids: [1], by: 'manager' }],
    ['/api/planning', { action: 'restore', id: 1, by: 'manager' }], ['/api/planning', { action: 'set', id: 1, status: 'triaged', by: 'manager' }],
    ['/api/planning', { action: 'add', project: 'p', title: 't', status: 'approved', by: 'manager' }], ['/api/planning', { action: 'set', id: 1, status: 'done' }],
    ['/api/say', { run: 'r', step: 1, text: 'x' }],
  ];
  for (const [route, body] of agents) assert.equal(ownerOnly(route, body), false, `${route} ${JSON.stringify(body)} needs the key`);
  // The app sends the key in the server's header.
  assert.ok(readFileSync(path.join(import.meta.dirname, '..', 'ui', 'app.js'), 'utf8').includes(`'${OWNER_HEADER}': owner`), "the app doesn't send the owner's key");
});

test('the development environment started from afar runs in the background', async () => {
  const dev = { projects: { demo: { name: 'Demo', local_clone: clone, dev_start: 'npm run dev' } } };
  const plan = await startDev('demo', { dryRun: true, background: true, config: dev });
  assert.equal(plan.background, true);
  assert.equal(plan.window, undefined, 'a window would open');
  assert.deepEqual(plan.run, ['dev-run', 'demo', '--background']);
  assert.equal(plan.log, devLog('demo'));
  assert.ok(plan.log.endsWith(path.join('projects', 'demo', 'dev.log')));
  assert.deepEqual((await startDev('demo', { dryRun: true, config: dev })).window, ['dev-run', 'demo'], 'on the computer, it no longer opens in a window');
});

// ---------- The usage resets' countdowns and the spare notice (ui/countdown.js), on a fixed clock ----------

test('the status bar counts down to each usage reset and flags a spare 5-hour window', () => {
  const now = Date.parse('2026-11-26T21:00:00Z');
  const at = minutes => new Date(now + minutes * 60_000).toISOString();
  // Rounded up to the minute: never "0 min" before the reset.
  assert.deepEqual(timeLeft(at(174), now), { days: 0, hours: 2, minutes: 54, total: 174 });
  assert.equal(timeLeft(at(0.2), now).total, 1);
  assert.equal(timeLeft(at(0), now), null);
  assert.equal(timeLeft(null, now), null);
  assert.deepEqual([at(45), at(60), at(174), at(24 * 60), at(2 * 1440 + 14 * 60 + 30)].map(iso => countdown(iso, now)), ['45 min', '1h00', '2h54', '1d0h', '2d14h']);

  // Within a day the time left; beyond it the day and hour; past, the reading is old; unknown, nothing.
  assert.equal(resetLabel(at(174), now), 'renews in 2h54');
  const week = resetLabel(at(2 * 1440 + 14 * 60), now, { locale: 'pt-BR' });
  assert.match(week, /^renews \S+ \d{2}:\d{2}$/);
  assert.ok(!week.includes('.'), "the weekday keeps no abbreviation's period");
  assert.equal(resetLabel(at(-5), now), 'renewed');
  assert.equal(resetLabel(undefined, now), '');
  assert.equal(resetLabel('nonsense', now), '');
  const pt = { 'renews in {left}': 'renova em {left}', '{hours}h{minutes}': '{hours}h{minutes}' };
  const translate = (text, values) => (pt[text] ?? text).replace(/\{(\w+)\}/g, (m, k) => values[k]);
  assert.equal(resetLabel(at(174), now, { t: translate }), 'renova em 2h54');

  // The spare notice: under an hour left and over 30% unused, both needed.
  assert.deepEqual(spare({ used: 0.59, resets: at(48) }, now), { free: 0.41, left: '48 min' });
  assert.equal(spare({ used: 0.59, resets: at(61) }, now), null, 'more than an hour left');
  assert.ok(spare({ used: 0.59, resets: at(SPARE_WITHIN_MS / 60_000) }, now), 'exactly an hour left still counts');
  assert.equal(spare({ used: 1 - SPARE_MIN_FREE, resets: at(30) }, now), null, 'only 30% unused');
  assert.equal(spare({ used: 0.2, resets: at(-1) }, now), null, 'already reset: the reading is old');
  assert.equal(spare({ used: 0.2 }, now), null, 'reset unknown');
  assert.equal(spare(undefined, now), null, 'not measured');
});

// ---------- The warning before Claude Code's sign-in expires ----------

test("Claude Code's sign-in: only its expiry is read, warned 3 days before its earliest end and strongly from the day before", () => {
  const status = { loggedIn: true, email: 'someone@example.com', orgName: 'Org', loginExpiresAt: '2026-12-04T23:08:36.905Z' };
  assert.equal(parseLoginStatus(JSON.stringify(status)), '2026-12-04T23:08:36.905Z');
  assert.equal(parseLoginStatus(JSON.stringify({ loggedIn: false })), null);
  assert.equal(parseLoginStatus('not json'), null);

  // Claude Code says a sign-in ends between 3 days before its expiry and the expiry: the warning counts from the earliest.
  const expires = '2026-12-04T23:08:36.905Z';
  const at = days => Date.parse(expires) - days * 86400_000;
  const info = { expires, checked: new Date(at(10)).toISOString() };
  assert.equal(loginWarning(info, at(6.5)), null, 'warned more than 3 days before the earliest end');
  assert.equal(loginWarning({ expires: null }, at(1)), null, 'warned with no expiry known');
  assert.equal(loginWarning(info, at(5)).step, '3d');
  assert.equal(loginWarning(info, at(3.5)).step, '1d');
  assert.equal(loginWarning(info, at(1)).step, '1d', 'the warning eased once the sign-in may already have ended');
  assert.equal(loginWarning(info, at(-0.1)).step, 'expired');

  // A read that fails, or finds the sign-in gone, keeps the expiry known; a sign-in with no expiry (an API key) clears it.
  const failed = Object.assign(new Error('Command failed'), { code: 1 });
  assert.deepEqual(loginRead(info, failed, '', 'now'), { expires, checked: 'now', error: 'Command failed' });
  assert.equal(loginRead(info, failed, JSON.stringify({ loggedIn: false, loginExpiresAt: null }), 'now').expires, expires);
  assert.equal(loginRead(info, null, JSON.stringify({ loggedIn: true, loginExpiresAt: null }), 'now').expires, null);
  assert.deepEqual(loginRead(info, null, JSON.stringify({ ...status, loginExpiresAt: '2027-01-04T10:00:00.000Z' }), 'now'), { expires: '2027-01-04T10:00:00.000Z', checked: 'now', error: null });

  // Asked again at the start, after a failed read, once a day, and hourly within the warning (so a renewal shows soon).
  assert.equal(loginDue({ checked: null }), true);
  const checkedAt = (since, days) => ({ expires, checked: new Date(at(days) - since).toISOString() });
  assert.equal(loginDue({ ...checkedAt(10 * 60_000, 10), error: 'timed out' }, at(10)), true, 'a failed read waited a day');
  assert.equal(loginDue(checkedAt(2 * 3600_000, 10), at(10)), false);
  assert.equal(loginDue(checkedAt(24 * 3600_000, 10), at(10)), true);
  assert.equal(loginDue(checkedAt(2 * 3600_000, 2), at(2)), true);
  assert.equal(loginDue(checkedAt(59 * 60_000, 5), at(5)), true, 'the hourly timer, a moment early, skipped an hour');
  assert.equal(loginDue(checkedAt(10 * 60_000, 2), at(2)), false);

  // The owner's warning and the manager's line carry the command to renew it, and nothing of the account.
  const strong = loginText(loginWarning(info, at(3.5)));
  assert.ok(strong.title && strong.text.includes(LOGIN_RENEW) && !strong.text.includes('example.com'));
  assert.notEqual(loginText(loginWarning(info, at(5))).title, strong.title, 'the day before the earliest end reads as the others');
  assert.equal(loginText(null), null);
  assert.equal(loginLine('the owner', info, at(7)), null);
  assert.ok(loginLine('the owner', info, at(5)).includes(LOGIN_RENEW));
  assert.ok(loginLine('the owner', info, at(0.5)).endsWith('remind them now.'));
});
