// Unit tests with no dependency (node:test): the file viewer's checks of paths and its readers of tables.
// Usage: npm test. Everything is made up, in a temporary folder removed at the end.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { checkPath, kindOf, listFolder, rawHeaders, runFiles, viewerRoots, viewFile } from '../src/files.mjs';
import { parseCsv, readXlsx, zipEntries } from '../src/sheets.mjs';
import { SAMPLE_CSV, sampleXlsx, zip } from './fixtures.mjs';

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
