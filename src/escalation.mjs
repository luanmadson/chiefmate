// Calling the owner outside the app when the emergency lockdown needs them: their own Telegram bot, read by polling
// (getUpdates: no port open to the internet) and talking only to the private chats they linked, and an e-mail as the
// fallback when Telegram fails or isn't set up (src/smtp.mjs). Only an escalation reaches them (wantsOwner): an alarm the
// emergency watch kept locked or couldn't review (src/sentinel.mjs), or one an agent or the manager engaged; a false
// alarm the watch released stays in the app, and a lockdown the owner engaged is theirs already.
// On Telegram the message has three buttons. Release asks for the owner's PIN (kept only as a salted scrypt hash): the
// buttons carry a single-use code per incident that expires in CODE_MINUTES, and MAX_TRIES wrong PINs block the release
// by Telegram until the owner sets the PIN again on the computer. Keep stopped is recorded and does nothing else.
// Details sends the whole report. The e-mail only warns: the actions stay on Telegram and in the app.
// The secrets (the bot's token, the linked chats, the PIN's hash, the SMTP login) are in data/secrets/escalation.json,
// out of git and a protected folder for the agents (src/lockdown.mjs); the rest (the calls made, the update offset, the
// wrong PINs) in data/security/escalation.json. Nothing here is reachable through the remote access.
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { chmodSync } from 'node:fs';
import path from 'node:path';
import { formatDateTime, t } from './i18n.mjs';
import { readLockdown, release, saveEscalation, SECURITY_DIR } from './lockdown.mjs';
import { reasonText } from './sentinel.mjs';
import { isLocalHost, SECURITY, sendMail, validAddress } from './smtp.mjs';
import { clip, DATA, readJson, writeJson } from './util.mjs';

export const SECRETS_DIR = path.join(DATA, 'secrets');
export const CODE_MINUTES = 30;
export const MAX_TRIES = 3;
const PIN_WAIT_MINUTES = 5;
const LINK_MINUTES = 15;
const POLL_SECONDS = 25;
const KEEP_INCIDENTS = 20;
const SCRYPT = { N: 16384, r: 8, p: 1 };
const API = 'https://api.telegram.org';

// What the server's start gives (src/cli.mjs): telling the owner and the manager ({ kind, title, text, news }).
const hooks = { tell: () => {} };
export const setEscalationHooks = h => Object.assign(hooks, h);

/** The surroundings, made up by the tests: { secretsDir, dir, fetch, mail, lockHooks, tell }. */
const io = (o = {}) => ({ fetch: (...a) => fetch(...a), mail: sendMail, tell: hooks.tell, ...o });

// ---------- Where it is kept ----------

const secretsFile = o => path.join(o.secretsDir ?? SECRETS_DIR, 'escalation.json');
const stateFile = o => path.join(o.dir ?? SECURITY_DIR, 'escalation.json');
export const readSecrets = (o = {}) => readJson(secretsFile(o), {});
const readState = o => readJson(stateFile(o), {});
const saveState = (state, o) => writeJson(stateFile(o), state);
function saveSecrets(secrets, o) {
  const file = secretsFile(o);
  writeJson(file, secrets);
  try {
    chmodSync(file, 0o600); // only its owner, where the system honors it
  } catch {
    // Windows keeps the folder's permissions
  }
}

const sha = s => createHash('sha256').update(String(s)).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const iso = ms => new Date(ms).toISOString();

// ---------- The PIN ----------

/** A PIN the owner may choose: 6 to 12 digits, not one digit repeated nor a plain run (123456, 987654). */
export function pinProblem(pin) {
  const s = String(pin ?? '');
  if (!/^\d{6,12}$/.test(s)) return t('The PIN must have 6 to 12 digits.');
  const steps = new Set([...s].slice(1).map((d, i) => (Number(d) - Number(s[i]) + 10) % 10));
  if (steps.size === 1 && [0, 1, 9].includes([...steps][0])) return t('That PIN is too easy to guess.');
  return null;
}

/** The PIN's salted hash: { salt, hash, n }. The PIN itself is never kept. */
export function hashPin(pin, salt = randomBytes(16)) {
  const hash = scryptSync(String(pin), salt, 32, SCRYPT);
  return { salt: salt.toString('base64'), hash: hash.toString('base64'), n: SCRYPT.N };
}

export function pinMatches(pin, stored) {
  if (!stored?.salt || !stored?.hash) return false;
  const want = Buffer.from(stored.hash, 'base64');
  const got = scryptSync(String(pin ?? ''), Buffer.from(stored.salt, 'base64'), want.length, { ...SCRYPT, N: stored.n ?? SCRYPT.N });
  return got.length === want.length && timingSafeEqual(got, want);
}

// ---------- Telegram ----------

/** One call to the Bot API. The token never shows in an error. */
async function telegram(method, params, o, token = readSecrets(o).telegram?.token) {
  if (!token) throw new Error(t('Telegram is not set up.'));
  let answer;
  try {
    const r = await o.fetch(`${API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params ?? {}),
      signal: AbortSignal.timeout(((params?.timeout ?? 0) + 15) * 1000),
    });
    answer = await r.json().catch(() => ({ ok: false, description: `HTTP ${r.status}` }));
  } catch (error) {
    throw new Error(t('Telegram could not be reached: {error}', { error: clip(String(error?.message ?? error).replaceAll(token, '[token]'), 200) }));
  }
  if (!answer?.ok) throw new Error(t('Telegram refused it: {error}', { error: clip(String(answer?.description ?? 'unknown error').replaceAll(token, '[token]'), 200) }));
  return answer.result;
}

// Plain text (no parse mode: nothing to escape); Telegram takes up to 4096 characters.
const say = (chat, text, o, extra = {}) => telegram('sendMessage', { chat_id: chat, text: text.length > 4000 ? `${text.slice(0, 3999)}…` : text, disable_web_page_preview: true, ...extra }, o);

const buttons = code => ({
  inline_keyboard: [
    [{ text: t('Release'), callback_data: `r:${code}` }, { text: t('Keep stopped'), callback_data: `k:${code}` }],
    [{ text: t('Details'), callback_data: `d:${code}` }],
  ],
});

// ---------- What the owner reads ----------

const VERDICTS = () => ({ false_alarm: t('false alarm'), real: t('real'), uncertain: t('uncertain') });
const who = x => (x.agent ? `${t(x.agent.name)}${x.agent.title ? ` (${t(x.agent.title)})` : ''}` : x.who ?? t('unknown'));

/** The people and commands behind the alarm: the watch's report, or the evidence when there is none. */
function involvedOf(lock) {
  const list = lock.sentinel?.incident?.involved;
  if (list?.length) return list;
  return (lock.evidence ?? []).map(e => ({ who: e.who ?? null, run: e.run ?? null, command: e.command ?? e.detail ?? '', cwd: e.cwd ?? null, refused: e.refused, step: e.step ? Number(e.step) : null }));
}

function analystsLine(lock) {
  const verdicts = lock.sentinel?.verdicts ?? [];
  if (!verdicts.length) return t('Analysts: not consulted.');
  return t('Analysts: {list}', { list: verdicts.map((v, i) => `${'AB'[i]} ${VERDICTS()[v.verdict] ?? v.verdict} ${Math.round((v.confidence ?? 0) * 100)}%`).join(' · ') });
}

function whyLine(lock) {
  const s = lock.sentinel;
  if (s?.status === 'off') return t('Why it waits for you: the emergency watch is off.');
  if (s?.decision?.reasons?.length) return t('Why it waits for you: {why}', { why: s.decision.reasons.map(reasonText).join('; ') });
  if (lock.by === 'manager') return t('Why it waits for you: the manager engaged it.');
  if (lock.by === 'step') return t('Why it waits for you: an agent at work engaged it.');
  return t('Why it waits for you: {why}', { why: lock.reason ?? '' });
}

/** The short message of an escalation, in the owner's language: who, what, whether it ran, the analysts and why. */
export function alarmText(lock, { expires = null, email = false, pin = true } = {}) {
  const people = involvedOf(lock);
  const x = people[0];
  const lines = [t('Chiefmate: emergency lockdown, it needs you'), t('Since {time}: {reason}', { time: formatDateTime(lock.since), reason: lock.reason ?? '' })];
  if (x) {
    lines.push([t('Agent: {name}', { name: who(x) }), x.projectName && t('project: {name}', { name: x.projectName })].filter(Boolean).join(' · '));
    if (x.task) lines.push(t('Task: {title}', { title: `${x.task}${x.step ? ` (${t('step {n} of {total}', { n: x.step, total: x.steps ?? '?' })})` : ''}` }));
    lines.push(`${x.refused === false ? t('Command (it ran):') : t('Command (refused by the guard):')} ${clip(x.command, 300)}`);
    if (people.length > 1) lines.push(t('And {count} more.', { count: people.length - 1 }));
  }
  lines.push(analystsLine(lock), whyLine(lock));
  if (email) lines.push('', t('This e-mail only warns you: act on Telegram, or in the app on the computer where Chiefmate runs.'));
  else if (expires && pin) lines.push('', t('Release here with your PIN until {time}, or in the app on the computer.', { time: formatDateTime(expires) }));
  else if (expires) lines.push('', t('No PIN is set: release it in the app on the computer.'));
  return lines.join('\n');
}

const yesNo = v => (v === null || v === undefined ? t("couldn't check") : v ? t('yes') : t('no'));

/** The whole report, for Details: every agent and command, the checks, each analyst and why. */
export function detailsText(lock) {
  const lines = [t('Since {time}: {reason}', { time: formatDateTime(lock.since), reason: lock.reason ?? '' })];
  for (const x of involvedOf(lock)) {
    lines.push('', `${who(x)}${x.projectName ? ` · ${t('project: {name}', { name: x.projectName })}` : ''}${x.task ? ` · ${t('task: {title}', { title: x.task })}` : ''}${x.step ? ` · ${t('step {n} of {total}', { n: x.step, total: x.steps ?? '?' })}` : ''}`);
    lines.push(`${x.refused === false ? t('Command (it ran):') : t('Command (refused by the guard):')} ${clip(x.command, 600)}`);
    if (x.cwd) lines.push(t('in {folder}', { folder: x.cwd }));
  }
  const c = lock.sentinel?.checks;
  if (c) {
    const changes = c.protected === null || c.protected === undefined ? t("couldn't check") : c.protected.length ? c.protected.map(p => `${p.path} (${p.what})`).join('; ') : t('none');
    const out = c.outbound === null || c.outbound === undefined ? t("couldn't check") : c.outbound.length ? c.outbound.map(p => p.command).join('; ') : t('none');
    lines.push('', `${t('Refused or harmless')}: ${yesNo(c.refused || c.harmless)}`, `${t('Changes in protected places')}: ${clip(changes, 400)}`, `${t('Sent out')}: ${clip(out, 400)}`, `${t('Second alarm in 24 h')}: ${yesNo(c.repeat)}`, `${t('Involves the manager')}: ${yesNo(c.manager)}`);
  }
  const verdicts = lock.sentinel?.verdicts ?? [];
  if (verdicts.length) {
    lines.push('');
    verdicts.forEach((v, i) => lines.push(`${t('Analyst {letter}', { letter: 'AB'[i] })}: ${VERDICTS()[v.verdict] ?? v.verdict}, ${t('confidence {n}%', { n: Math.round((v.confidence ?? 0) * 100) })}${v.reason ? `. ${v.reason}` : ''}`));
  }
  lines.push('', whyLine(lock));
  const stopped = Object.entries(lock.stopped ?? {}).filter(([, n]) => typeof n === 'number' && n > 0).map(([k, n]) => `${k} ${n}`).join(', ');
  if (stopped) lines.push(t('Stopped: {list}', { list: stopped }));
  return lines.join('\n');
}

// ---------- The escalation ----------

/** Whether the alarm going on waits for the owner, who doesn't know of it yet: then the escalation calls them. */
export function wantsOwner(lock) {
  if (lock?.active !== true) return false;
  if (lock.by === 'auto' && lock.from === 'detection') return ['escalated', 'off'].includes(lock.sentinel?.status);
  return ['manager', 'step'].includes(lock.by);
}

const telegramReady = s => !!(s.telegram?.token && s.telegram.chats?.length);
const emailReady = s => !!(s.email?.host && s.email.to && s.email.from);

/**
 * Calls the owner about the alarm going on, once per alarm: Telegram first, to every linked chat, with its buttons and a
 * new single-use code; the e-mail when Telegram fails or isn't set up. Kept in the alarm's state (saveEscalation) and
 * in data/security/escalation.json. Returns the call, or null when there is nothing to call about.
 */
export async function escalate(lock = null, options = {}) {
  const o = io(options);
  lock ??= readLockdown(o.dir);
  if (!wantsOwner(lock)) return null;
  const state = readState(o);
  if (state.incidents?.[lock.since]) return state.incidents[lock.since];
  const secrets = readSecrets(o);
  const now = Date.now();
  const code = randomBytes(12).toString('base64url');
  const call = { at: iso(now), expires: iso(now + CODE_MINUTES * 60_000), code: sha(code), used: null, messages: [], decisions: [], channels: [], errors: [] };
  // Written before sending: a second call for the same alarm (a restart meanwhile) never sends twice.
  const kept = Object.entries({ ...state.incidents, [lock.since]: call }).sort(([, a], [, b]) => Date.parse(a.at) - Date.parse(b.at)).slice(-KEEP_INCIDENTS);
  saveState({ ...state, incidents: Object.fromEntries(kept) }, o);
  if (telegramReady(secrets)) {
    for (const chat of secrets.telegram.chats) {
      try {
        const m = await say(chat, alarmText(lock, { expires: call.expires, pin: !!secrets.pin?.hash }), o, { reply_markup: buttons(code) });
        call.messages.push({ chat, id: m.message_id });
      } catch (error) {
        call.errors.push({ channel: 'telegram', error: clip(error.message, 300) });
      }
    }
    if (call.messages.length) call.channels.push('telegram');
  }
  if (!call.channels.length && emailReady(secrets)) {
    try {
      await o.mail({ ...secrets.email, subject: t('Chiefmate: emergency lockdown, it needs you'), text: alarmText(lock, { email: true }) });
      call.channels.push('email');
    } catch (error) {
      call.errors.push({ channel: 'email', error: clip(error.message, 300) });
    }
  }
  updateCall(lock.since, () => call, o);
  saveEscalation(lock.since, { at: call.at, channels: call.channels, errors: call.errors, decisions: [] }, o.dir);
  if (!call.channels.length && (secrets.telegram?.token || secrets.email?.host)) {
    const errors = call.errors.map(e => `${e.channel}: ${e.error}`).join('; ') || t('no chat linked');
    try {
      o.tell({
        kind: 'lockdown', title: t('Could not reach you outside the app'),
        text: t('The emergency lockdown needs you, but Telegram and the e-mail failed: {errors}', { errors }),
        news: `The emergency lockdown since ${lock.since} needs the owner, but calling them outside the app failed (${errors}). Tell them in one line, if they talk to you.`,
      });
    } catch {
      // telling never gets in the way
    }
  }
  return call;
}

function updateCall(since, change, o) {
  const state = readState(o);
  const call = state.incidents?.[since];
  if (!call) return null;
  const next = change({ ...call });
  saveState({ ...state, incidents: { ...state.incidents, [since]: next } }, o);
  return next;
}

/** The owner's choice on Telegram, in the call and in the alarm's record. */
function recordDecision(since, action, o) {
  const entry = { at: new Date().toISOString(), action, from: 'telegram' };
  const call = updateCall(since, c => ({ ...c, decisions: [...(c.decisions ?? []), entry].slice(-20) }), o);
  if (call) saveEscalation(since, { decisions: call.decisions }, o.dir);
}

const findCall = (state, code) => Object.entries(state.incidents ?? {}).find(([, c]) => c.code === sha(code)) ?? null;

// ---------- The owner's answers ----------

/** One update from Telegram. Anyone but a linked private chat is ignored, with no answer. */
export async function handleUpdate(update, options = {}) {
  const o = io(options);
  const chats = readSecrets(o).telegram?.chats ?? [];
  const q = update.callback_query;
  if (q) {
    const chat = q.message?.chat;
    if (chat?.type !== 'private' || q.from?.id !== chat.id || !chats.includes(chat.id)) return;
    await telegram('answerCallbackQuery', { callback_query_id: q.id }, o).catch(() => null);
    const [action, code] = String(q.data ?? '').split(':');
    return onButton(action, code ?? '', chat.id, o);
  }
  const m = update.message;
  if (m?.chat?.type !== 'private' || m.from?.id !== m.chat.id) return;
  const text = String(m.text ?? '').trim();
  const start = text.match(/^\/start(?:@\w+)?\s+([\w-]{1,64})$/);
  if (start) return linkChat(start[1], m.chat.id, o);
  if (!chats.includes(m.chat.id)) return;
  const state = readState(o);
  if (state.awaiting?.chat === m.chat.id) return pinGiven(text, m, o);
  // A PIN sent late, out of turn: it leaves the chat too.
  if (/^\d{4,12}$/.test(text)) await telegram('deleteMessage', { chat_id: m.chat.id, message_id: m.message_id }, o).catch(() => null);
  await say(m.chat.id, t('Chiefmate writes here only when an emergency lockdown needs you.'), o);
}

async function onButton(action, code, chat, o) {
  const state = readState(o);
  const found = findCall(state, code);
  if (!found) return say(chat, t('This button is no longer valid.'), o);
  const [since, call] = found;
  const lock = readLockdown(o.dir);
  if (lock.active !== true || lock.since !== since) return say(chat, t('This alarm is over: nothing to do.'), o);
  if (action === 'd') return say(chat, detailsText(lock), o);
  if (action === 'k') {
    recordDecision(since, 'keep', o);
    return say(chat, t('Recorded: everything stays stopped. Release it in the app on the computer when you decide.'), o);
  }
  if (action !== 'r') return null;
  if (state.pin?.blocked) return say(chat, t('Release by Telegram is blocked after {count} wrong PINs. Release it in the app on the computer; set the PIN again there to use Telegram again.', { count: MAX_TRIES }), o);
  if (!readSecrets(o).pin?.hash) return say(chat, t('No PIN is set: release it in the app on the computer.'), o);
  if (call.used) return say(chat, t('This release code was already used.'), o);
  const expires = Date.parse(call.expires);
  if (Date.now() > expires) return say(chat, t('The release code expired after {minutes} minutes: release it in the app on the computer.', { minutes: CODE_MINUTES }), o);
  saveState({ ...state, awaiting: { chat, since, until: iso(Math.min(expires, Date.now() + PIN_WAIT_MINUTES * 60_000)) } }, o);
  return say(chat, t('Send your PIN in your next message: it is deleted from the chat right after. You have {minutes} minutes.', { minutes: PIN_WAIT_MINUTES }), o, { reply_markup: { force_reply: true, input_field_placeholder: 'PIN' } });
}

async function pinGiven(text, m, o) {
  // The PIN never stays in the chat.
  await telegram('deleteMessage', { chat_id: m.chat.id, message_id: m.message_id }, o).catch(() => null);
  const state = readState(o);
  const { since, until } = state.awaiting;
  const call = state.incidents?.[since];
  const lock = readLockdown(o.dir);
  const done = reply => {
    saveState({ ...readState(o), awaiting: null }, o);
    return say(m.chat.id, reply, o);
  };
  if (Date.now() > Date.parse(until)) return done(t('Too late: tap Release again.'));
  if (lock.active !== true || lock.since !== since) return done(t('This alarm is over: nothing to do.'));
  if (!call || call.used || Date.now() > Date.parse(call.expires) || state.pin?.blocked) return done(t('This release code is no longer valid: release it in the app on the computer.'));
  if (pinMatches(text, readSecrets(o).pin)) {
    updateCall(since, c => ({ ...c, used: new Date().toISOString() }), o);
    saveState({ ...readState(o), awaiting: null, pin: { tries: 0 } }, o);
    // Recorded before the release, so the alarm's record keeps it.
    recordDecision(since, 'release', o);
    release({ by: 'owner', from: 'telegram' }, { dir: o.dir, ...(o.lockHooks ? { h: o.lockHooks } : {}) });
    await say(m.chat.id, t('Released. The queue goes on; the runs the lockdown stopped stay canceled until you resume them.'), o);
    return tidy(o);
  }
  const tries = (state.pin?.tries ?? 0) + 1;
  if (tries < MAX_TRIES) {
    saveState({ ...state, pin: { tries } }, o);
    return say(m.chat.id, t('Wrong PIN. {left} attempt(s) left.', { left: MAX_TRIES - tries }), o, { reply_markup: { force_reply: true, input_field_placeholder: 'PIN' } });
  }
  saveState({ ...state, awaiting: null, pin: { tries, blocked: new Date().toISOString() } }, o);
  recordDecision(since, 'pin_blocked', o);
  try {
    o.tell({
      kind: 'lockdown', title: t('Release by Telegram blocked'),
      text: t('{count} wrong PINs on Telegram: its release is blocked. Release the lockdown here; set the PIN again to use Telegram again.', { count: MAX_TRIES }),
      news: `${MAX_TRIES} wrong PINs were sent on the owner's Telegram chat to release the emergency lockdown since ${since}; the release by Telegram is blocked until the owner sets the PIN again on the computer. Tell them in one line.`,
    });
  } catch {
    // telling never gets in the way
  }
  return say(m.chat.id, t('Release by Telegram is blocked after {count} wrong PINs. Release it in the app on the computer; set the PIN again there to use Telegram again.', { count: MAX_TRIES }), o);
}

/** "/start <code>" from the link the owner opened: that private chat gets the calls from now on. */
async function linkChat(code, chat, o) {
  const state = readState(o);
  const l = state.linking;
  if (!l || Date.now() > Date.parse(l.until) || l.code !== sha(code)) return;
  const secrets = readSecrets(o);
  const chats = [...new Set([...(secrets.telegram?.chats ?? []), chat])];
  saveSecrets({ ...secrets, telegram: { ...secrets.telegram, chats } }, o);
  saveState({ ...state, linking: null }, o);
  await say(chat, t('Linked: this chat gets the calls of the emergency lockdown when it needs you. Nothing else is written here.'), o);
}

/** Takes the buttons off the messages of alarms that are over (released anywhere). */
async function tidy(o) {
  const state = readState(o);
  const lock = readLockdown(o.dir);
  for (const [since, call] of Object.entries(state.incidents ?? {})) {
    if (call.tidied || !call.messages?.length || (lock.active === true && lock.since === since)) continue;
    for (const m of call.messages) await telegram('editMessageReplyMarkup', { chat_id: m.chat, message_id: m.id, reply_markup: { inline_keyboard: [] } }, o).catch(() => null);
    updateCall(since, c => ({ ...c, tidied: new Date().toISOString() }), o);
  }
}

/** Reads Telegram's updates once (long polling) and handles them. Returns how many came. */
export async function pollOnce(options = {}, { timeout = POLL_SECONDS } = {}) {
  const o = io(options);
  if (!readSecrets(o).telegram?.token) return 0;
  const updates = await telegram('getUpdates', { offset: readState(o).offset ?? 0, timeout, allowed_updates: ['message', 'callback_query'] }, o);
  for (const u of updates) {
    // The offset first: an update that fails is never handled twice.
    saveState({ ...readState(o), offset: u.update_id + 1 }, o);
    try {
      await handleUpdate(u, o);
    } catch (error) {
      console.error('Escalation:', error.message);
    }
  }
  return updates.length;
}

/** Whether Telegram needs reading now: a chat being linked, or an alarm with messages sent still going on. */
function listening(o) {
  if (!readSecrets(o).telegram?.token) return false;
  const state = readState(o);
  if (state.linking && Date.now() < Date.parse(state.linking.until)) return true;
  const lock = readLockdown(o.dir);
  return lock.active === true && !!state.incidents?.[lock.since]?.messages?.length;
}

/**
 * The server's loop: an escalation as soon as the alarm waits for the owner, Telegram read only while it matters (no
 * request at all otherwise), and the buttons of alarms that are over taken off.
 */
export function startEscalation(options = {}) {
  const o = io(options);
  let on = true;
  let failures = 0;
  (async () => {
    while (on) {
      try {
        if (wantsOwner(readLockdown(o.dir))) await escalate(null, o);
        await tidy(o);
        if (listening(o)) await pollOnce(o);
        else await sleep(5000);
        failures = 0;
      } catch (error) {
        if (!failures++) console.error('Escalation:', error.message);
        await sleep(Math.min(60_000, 5000 * failures));
      }
    }
  })();
  return () => {
    on = false;
  };
}

// ---------- Setting it up (the app and the command line, on this computer only) ----------

/** What the app and the command line show: never the token, the PIN's hash or the SMTP password. */
export function escalationView(options = {}) {
  const o = io(options);
  const s = readSecrets(o);
  const state = readState(o);
  const linking = state.linking && Date.now() < Date.parse(state.linking.until) ? state.linking.until : null;
  const last = Object.entries(state.incidents ?? {}).at(-1);
  return {
    telegram: s.telegram?.token ? { bot: s.telegram.bot?.username ?? null, chats: s.telegram.chats?.length ?? 0, linking } : null,
    pin: { set: !!s.pin?.hash, blocked: state.pin?.blocked ?? null, tries: state.pin?.tries ?? 0 },
    email: s.email?.host ? { host: s.email.host, port: s.email.port, security: s.email.security, from: s.email.from, to: s.email.to, user: s.email.user || '' } : null,
    ready: telegramReady(s) || emailReady(s),
    last: last ? { since: last[0], at: last[1].at, channels: last[1].channels ?? [], errors: last[1].errors ?? [], decisions: last[1].decisions ?? [] } : null,
  };
}

/** The bot's token, from BotFather: checked with Telegram (getMe) before it is kept. Another bot unlinks the chats. */
export async function setToken(token, options = {}) {
  const o = io(options);
  const value = String(token ?? '').trim();
  if (!/^\d{5,}:[\w-]{30,}$/.test(value)) throw new Error(t('That is not a bot token: it looks like 123456789:AAE..., as BotFather gives it.'));
  const me = await telegram('getMe', {}, o, value);
  // A bot with a webhook can't be polled.
  await telegram('deleteWebhook', { drop_pending_updates: true }, o, value).catch(() => null);
  const secrets = readSecrets(o);
  const same = secrets.telegram?.bot?.id === me.id;
  saveSecrets({ ...secrets, telegram: { token: value, bot: { id: me.id, username: me.username ?? null }, chats: same ? secrets.telegram.chats ?? [] : [] } }, o);
  saveState({ ...readState(o), offset: 0, linking: null }, o);
  return escalationView(o);
}

/** A link to the bot with a code good for LINK_MINUTES: opening it and pressing Start (/start <code>) links that chat. */
export function startLinking(options = {}) {
  const o = io(options);
  const bot = readSecrets(o).telegram?.bot?.username;
  if (!bot) throw new Error(t('Telegram is not set up.'));
  const code = randomBytes(9).toString('base64url');
  const until = iso(Date.now() + LINK_MINUTES * 60_000);
  saveState({ ...readState(o), linking: { code: sha(code), until } }, o);
  return { link: `https://t.me/${bot}?start=${code}`, command: `/start ${code}`, bot, until };
}

/** The owner's PIN: only its salted hash is kept. Setting it again lifts the block after wrong PINs. */
export function setPin(pin, options = {}) {
  const o = io(options);
  const problem = pinProblem(pin);
  if (problem) throw new Error(problem);
  saveSecrets({ ...readSecrets(o), pin: { ...hashPin(pin), set: new Date().toISOString() } }, o);
  saveState({ ...readState(o), pin: { tries: 0 } }, o);
  return escalationView(o);
}

/** The e-mail fallback: { host, port, security, user, pass, from, to }. An empty password keeps the one already kept. */
export function setEmail(e, options = {}) {
  const o = io(options);
  const host = String(e?.host ?? '').trim().toLowerCase();
  const security = SECURITY.includes(e?.security) ? e.security : 'starttls';
  const port = Number(e?.port) || (security === 'tls' ? 465 : 587);
  const from = String(e?.from ?? '').trim();
  const to = String(e?.to ?? '').trim();
  const user = String(e?.user ?? '').trim();
  if (!/^[a-z0-9.-]+$|^::1$/.test(host)) throw new Error(t('Write the SMTP server, such as smtp.example.com.'));
  if (!(port > 0 && port < 65536)) throw new Error(t('The SMTP port must be a number such as 587 or 465.'));
  if (security === 'none' && !isLocalHost(host)) throw new Error(t('SMTP without TLS goes only to this computer.'));
  if (!validAddress(from) || !validAddress(to)) throw new Error(t('The sender and the recipient must be plain e-mail addresses.'));
  const secrets = readSecrets(o);
  const old = secrets.email ?? {};
  const pass = String(e?.pass ?? '') || (old.host === host && old.user === user ? old.pass ?? '' : '');
  saveSecrets({ ...secrets, email: { host, port, security, user, pass, from, to } }, o);
  return escalationView(o);
}

/** A test, so the owner sees it arrive: to every linked chat, or by e-mail. Returns where it went. */
export async function sendTest(channel, options = {}) {
  const o = io(options);
  const s = readSecrets(o);
  const text = t('Chiefmate test: this is where the emergency lockdown calls you when it needs you. Nothing to do.');
  if (channel === 'email') {
    if (!emailReady(s)) throw new Error(t('The e-mail is not set up.'));
    await o.mail({ ...s.email, subject: t('Chiefmate: test'), text });
    return { email: s.email.to };
  }
  if (!telegramReady(s)) throw new Error(t('Telegram is not set up, or no chat is linked yet.'));
  for (const chat of s.telegram.chats) await say(chat, text, o);
  return { telegram: s.telegram.chats.length };
}

/** Forgets a channel: "telegram" (the token and the chats) or "email". */
export function removeChannel(channel, options = {}) {
  const o = io(options);
  if (!['telegram', 'email'].includes(channel)) throw new Error(t('Unknown channel.'));
  const { [channel]: gone, ...rest } = readSecrets(o);
  saveSecrets(rest, o);
  if (channel === 'telegram') saveState({ ...readState(o), offset: 0, linking: null, awaiting: null }, o);
  return escalationView(o);
}

/** The app's and the command line's setup actions (POST /api/escalation, on this computer only). */
export async function changeEscalation(body, options = {}) {
  const action = String(body?.action ?? '');
  if (action === 'status') return { escalation: escalationView(options) };
  if (action === 'token') return { escalation: await setToken(body.token, options) };
  if (action === 'link') return { link: startLinking(options), escalation: escalationView(options) };
  if (action === 'pin') return { escalation: setPin(body.pin, options) };
  if (action === 'email') return { escalation: setEmail(body, options) };
  if (action === 'test') return { sent: await sendTest(body.channel === 'email' ? 'email' : 'telegram', options), escalation: escalationView(options) };
  if (action === 'remove') return { escalation: removeChannel(String(body.channel ?? ''), options) };
  throw new Error(t('Unknown action.'));
}
