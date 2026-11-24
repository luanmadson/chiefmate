// Starts a temporary Chiefmate on a spare port (only the app and the API: no queue, no schedule, no updates)
// and checks that everything answers. Usage: npm run smoke
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 47000 + Math.floor(Math.random() * 900);
const base = `http://localhost:${port}`;
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
    for (const key of ['version', 'language', 'ai', 'update', 'projects', 'missions', 'crew', 'focus', 'queue', 'history', 'usage', 'manager']) {
      expect(key in state, `/api/state has no "${key}"`);
    }
    expect(state.crew?.some(a => a.id === 'manager'), 'the crew has no manager');
    for (const file of ['/', '/app.js', '/faces.js', '/i18n.js', '/style.css', '/manifest.webmanifest', '/locales/pt-BR.json', '/icon-32.png']) {
      const r = await fetch(base + file);
      expect(r.ok, `${file} answered ${r.status}`);
    }
    const unsigned = await fetch(`${base}/api/limits`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(unsigned.status === 403, `a command without the x-chiefmate header answered ${unsigned.status} instead of 403`);
    const outside = await fetch(`${base}/../package.json`);
    expect(!outside.ok || !(await outside.text()).includes('"name": "chiefmate"'), 'a file outside ui/ was served');
  }
} catch (error) {
  failures.push(error.message);
} finally {
  child.kill();
}

if (failures.length) {
  console.error(`Smoke test failed:\n${failures.map(f => `  - ${f}`).join('\n')}\n\nServer output:\n${output}`);
  process.exitCode = 1;
} else {
  console.log(`OK: a temporary Chiefmate answered on port ${port}.`);
}
