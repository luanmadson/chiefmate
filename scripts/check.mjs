// Checks the code before a commit: the syntax of every script, and that every text the app shows has a translation.
// Usage: npm run check
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scripts = dir => readdirSync(path.join(root, dir)).filter(f => /\.m?js$/.test(f)).map(f => path.join(dir, f));
const code = [...scripts('src'), ...scripts('ui'), ...scripts('scripts')];
let failed = false;

for (const file of code) {
  const r = spawnSync(process.execPath, ['--check', path.join(root, file)], { encoding: 'utf8' });
  if (r.status !== 0) {
    failed = true;
    console.error(`Syntax error in ${file}:\n${r.stderr}`);
  }
}

// The texts to translate: every t('...') and t("...") in the code, every data-t* in the page,
// and the crew's names, titles and roles.
const texts = new Set();
const unescape = s => s.replace(/\\(['"\\])/g, '$1');
for (const file of code.filter(f => !f.startsWith('scripts'))) {
  const source = readFileSync(path.join(root, file), 'utf8');
  for (const m of source.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)) texts.add(unescape(m[1]));
  for (const m of source.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g)) texts.add(unescape(m[1]));
}
const decode = s => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const page = readFileSync(path.join(root, 'ui', 'index.html'), 'utf8');
for (const m of page.matchAll(/data-t(?:-placeholder|-title|-label)?="([^"]*)"/g)) texts.add(decode(m[1]));
for (const file of readdirSync(path.join(root, 'agents')).filter(f => f.endsWith('.md'))) {
  const header = readFileSync(path.join(root, 'agents', file), 'utf8').split(/\r?\n---\r?\n/)[0];
  for (const m of header.matchAll(/^(?:name|title|role):\s*(.+)$/gm)) texts.add(m[1].trim().replace(/^["']|["']$/g, ''));
}

const placeholders = s => (s.match(/\{\w+\}/g) ?? []).sort().join(' ');
for (const file of readdirSync(path.join(root, 'ui', 'locales')).filter(f => f.endsWith('.json'))) {
  const dictionary = JSON.parse(readFileSync(path.join(root, 'ui', 'locales', file), 'utf8'));
  const missing = [...texts].filter(k => !(k in dictionary));
  const unused = Object.keys(dictionary).filter(k => !texts.has(k));
  const mismatched = [...texts].filter(k => k in dictionary && placeholders(k) !== placeholders(dictionary[k]));
  if (missing.length) {
    failed = true;
    console.error(`${file}: ${missing.length} text(s) without a translation:\n${missing.map(k => `  ${JSON.stringify(k)}`).join('\n')}`);
  }
  if (mismatched.length) {
    failed = true;
    console.error(`${file}: the {placeholders} differ in:\n${mismatched.map(k => `  ${JSON.stringify(k)}`).join('\n')}`);
  }
  if (unused.length) console.warn(`${file}: ${unused.length} translation(s) no longer used:\n${unused.map(k => `  ${JSON.stringify(k)}`).join('\n')}`);
}

if (failed) process.exitCode = 1;
else console.log(`OK: ${code.length} scripts, ${texts.size} texts, all translated.`);
