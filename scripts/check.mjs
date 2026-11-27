// Checks the code before a commit: the syntax of every script, and that every text the app shows has a translation.
// Usage: npm run check
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * What is wrong with a script's syntax (a line to print), or null: "node --check" on it, with Node's own message going
 * straight to this console. No pipe: Codex's sandbox on Windows refuses the pipes Node.js would create for the output
 * (EPERM), not the process itself. When Node.js can't be started at all, the line says why, with the error's code.
 */
export function syntaxProblem(file, run = spawnSync) {
  const r = run(process.execPath, ['--check', path.join(root, file)], { stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true });
  if (r.error) return `Couldn't check ${file}: ${r.error.code ?? 'error'}, ${r.error.message}`;
  if (r.status !== 0) return `Syntax error in ${file} (${r.signal ?? `exit code ${r.status}`}): Node's message is above.`;
  return null;
}

// Only when run as a script (npm run check), not when the tests import syntaxProblem. Real paths on both sides, as
// Node.js resolves its entry point: a folder reached through a junction or symlink would otherwise skip the whole check
// and still exit 0.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();

function main() {
  const scripts = dir => readdirSync(path.join(root, dir)).filter(f => /\.m?js$/.test(f)).map(f => path.join(dir, f));
  const code = [...scripts('src'), ...scripts('ui'), ...scripts('scripts')];
  let failed = false;

  const problems = code.map(file => syntaxProblem(file)).filter(Boolean);
  if (problems.length) {
    failed = true;
    console.error(problems.join('\n'));
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

  if (failed) {
    process.exitCode = 1;
    console.error(`Check failed${problems.length ? `: ${problems.length} of ${code.length} scripts not checked or with a syntax error` : ''}.`);
  } else console.log(`OK: ${code.length} scripts, ${texts.size} texts, all translated.`);
}
