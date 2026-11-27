import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const readUi = file => readFileSync(new URL(`../ui/${file}`, import.meta.url), 'utf8');
const app = readUi('app.js');
const html = readUi('index.html');
const pt = JSON.parse(readUi('locales/pt-BR.json'));

// Run the app's own handlers against just the title bar controls, with a stand-in for the server.
function awayUi({ enabled = true, mode = 'normal', week_pace = 1 } = {}) {
  const nodes = Object.fromEntries(['away', 'away-since', 'away-notice', 'away-pace-label', 'away-pace', 'away-custom-pace'].map(id => [id, {}]));
  const listeners = {};
  for (const id of ['away', 'away-pace']) {
    nodes[id].addEventListener = (type, callback) => (listeners[type] = callback);
  }
  nodes.away.setAttribute = (key, value) => (nodes.away[key] = value);
  const state = { away: null, autopilot: { enabled, mode, week_pace } };
  const calls = [];
  const toasts = [];
  const location = { hash: '#operations' };
  let fail = false;
  const draw = runInNewContext(`
    ${app.slice(app.indexOf('// ---------- Away mode'), app.indexOf('// ---------- Emergency lockdown'))}
    ${app.slice(app.indexOf('const AUTOPILOT_MODES'), app.indexOf('/** Who changed the autopilot'))}
    drawAway;
  `, {
    $: selector => nodes[selector.slice(1)], state, online: true, location,
    clockTime: () => '21:26', percent: value => `${Math.round(value * 100)}%`,
    t: (key, values = {}) => (pt[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => values[name]),
    toast: message => toasts.push(message),
    refresh: () => draw(),
    api: async (route, body) => {
      calls.push([route, { ...body }]);
      if (route === '/api/away') state.away = body.on ? { since: '2026-11-26T21:26:00-03:00', held: 0 } : null;
      else if (fail) throw Error('Could not save');
      else state.autopilot.mode = body.mode;
    },
  });
  draw();
  return {
    nodes, state, calls, toasts, location, draw,
    toggle: listeners.click,
    choose: value => {
      nodes['away-pace'].value = value;
      return listeners.change({ target: nodes['away-pace'] });
    },
    failNextSave: () => (fail = true),
  };
}

test('away mode uses the general absence wording in Brazilian Portuguese', async () => {
  assert.match(html, /id="away"[^>]*><span data-t="Away mode">/);
  assert.equal(pt['Away mode'], 'Não estou aqui');
  assert.doesNotMatch(Object.values(pt).join('\n'), /soneca/i);
  const { nodes, toggle, toasts, calls, location } = awayUi();
  assert.equal(nodes['away-notice'].hidden, true);
  assert.match(nodes.away.title, /^Vai se ausentar\?/);
  await toggle();
  assert.equal(nodes.away['aria-pressed'], 'true');
  assert.equal(nodes['away-since'].textContent, 'Desde 21:26');
  assert.match(nodes.away.title, /^Ausente desde 21:26\..*resumo/);
  assert.match(toasts.at(-1), /^Ausência ativada\./);
  assert.equal(nodes['away-notice'].hidden, false);
  await toggle();
  assert.equal(nodes.away['aria-pressed'], 'false');
  assert.equal(nodes['away-notice'].hidden, true);
  assert.equal(location.hash, '#manager');
  assert.match(toasts.at(-1), /resumo da ausência/);
  assert.deepEqual(calls, [['/api/away', { on: true }], ['/api/away', { on: false }]]);
});

test('the away notice shows the configured pace and saves a change in place', async () => {
  assert.match(html, /<label id="away-pace-label" for="away-pace"><\/label>\s*<select id="away-pace">/);
  const { nodes, state, toggle, choose, calls, toasts, location, draw, failNextSave } = awayUi({ enabled: false, mode: 'custom', week_pace: 1.2 });
  const select = nodes['away-pace'];
  await toggle();
  assert.equal(nodes['away-pace-label'].textContent, 'Ritmo (desligado)');
  assert.equal(select.value, 'custom');
  assert.equal(nodes['away-custom-pace'].textContent, 'Meta de 120%');
  for (const [mode, label, localized] of [['save', 'Save usage', 'Economizar'], ['all', 'Spend all', 'Gastar tudo'], ['normal', 'Normal', 'Normal']]) {
    assert.ok(html.includes(`<option value="${mode}" data-t="${label}">`));
    await choose(mode);
    assert.deepEqual(calls.at(-1), ['/api/autopilot', { mode }]);
    assert.equal(select.value, mode);
    assert.equal(toasts.at(-1), `Modo de gasto: ${localized}.`);
  }
  assert.equal(nodes['away-custom-pace'].hidden, true);
  assert.equal(state.autopilot.enabled, false);
  assert.equal(location.hash, '#operations');
  state.autopilot.enabled = true;
  state.autopilot.mode = 'save';
  draw();
  assert.equal(nodes['away-pace-label'].textContent, 'Ritmo do piloto');
  assert.equal(select.value, 'save');
  failNextSave();
  await choose('all');
  assert.equal(select.value, 'save');
  assert.equal(toasts.at(-1), 'Could not save');
});
