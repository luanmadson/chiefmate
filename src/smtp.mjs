// A small SMTP client (node:net and node:tls, no dependency) for the owner's e-mail notice when the emergency lockdown
// needs them and Telegram fails or isn't set up (src/escalation.mjs). Implicit TLS (port 465), STARTTLS (587) or, only
// to this computer (a relay of the owner's, the tests), plain. The certificate is always checked.
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';

export const SECURITY = ['starttls', 'tls', 'none'];
const LOCAL = new Set(['localhost', '127.0.0.1', '::1']);
export const isLocalHost = host => LOCAL.has(String(host ?? '').toLowerCase());
// One address, with nothing that could open a new header or command.
export const validAddress = a => /^[^\s<>@,;:"]+@[^\s<>@,;:"]+\.[^\s<>@,;:"]+$/.test(String(a ?? ''));

const b64 = s => Buffer.from(String(s), 'utf8').toString('base64');
const header = s => `=?UTF-8?B?${b64(String(s).replace(/[\r\n]+/g, ' '))}?=`;

/** The message itself: plain text in UTF-8, base64 (no line can start with a dot). */
export function message({ from, to, subject, text, date = new Date() }) {
  const domain = String(from).split('@')[1] || 'localhost';
  const body = b64(String(text).replace(/\r?\n/g, '\r\n')).replace(/.{1,76}/g, '$&\r\n');
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${header(subject)}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${randomBytes(12).toString('hex')}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    body,
  ].join('\r\n');
}

/** The server's replies, one at a time (a reply may span lines: "250-..." then "250 ..."). */
function replies(socket) {
  let buffer = '';
  let lines = [];
  const ready = [];
  const waiting = [];
  let failure = null;
  const give = reply => (waiting.length ? waiting.shift().resolve(reply) : ready.push(reply));
  const onData = chunk => {
    buffer += chunk.toString('utf8');
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).replace(/\r$/, '');
      buffer = buffer.slice(i + 1);
      lines.push(line);
      if (!/^\d{3}-/.test(line)) {
        give({ code: Number(line.slice(0, 3)) || 0, text: lines.join('\n') });
        lines = [];
      }
    }
  };
  const onEnd = error => {
    failure ??= error ?? new Error('the connection closed');
    while (waiting.length) waiting.shift().reject(failure);
  };
  const onClose = () => onEnd();
  socket.on('data', onData);
  socket.on('error', onEnd);
  socket.on('close', onClose);
  return {
    next: () => (ready.length ? Promise.resolve(ready.shift()) : failure ? Promise.reject(failure) : new Promise((resolve, reject) => waiting.push({ resolve, reject }))),
    // Before STARTTLS: the plain socket is handed over to TLS.
    detach: () => {
      socket.off('data', onData);
      socket.off('error', onEnd);
      socket.off('close', onClose);
    },
  };
}

function connect({ host, port, security }) {
  return new Promise((resolve, reject) => {
    const options = { host, port, servername: net.isIP(host) ? undefined : host };
    const socket = security === 'tls' ? tls.connect(options) : net.connect(options);
    socket.once(security === 'tls' ? 'secureConnect' : 'connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

/**
 * Sends one e-mail: { host, port, security ('starttls', 'tls' or 'none'), user, pass, from, to, subject, text }.
 * Throws with the server's answer when it refuses. "none" only to this computer: a login never goes out in clear.
 */
export async function sendMail({ host, port, security = 'starttls', user = '', pass = '', from, to, subject, text, timeoutMs = 20_000 }) {
  if (!SECURITY.includes(security)) throw new Error(`Unknown SMTP security "${security}".`);
  if (security === 'none' && !isLocalHost(host)) throw new Error('SMTP without TLS goes only to this computer.');
  if (!validAddress(from) || !validAddress(to)) throw new Error('The sender and the recipient must be plain e-mail addresses.');
  let socket = await connect({ host, port: Number(port) || (security === 'tls' ? 465 : 587), security });
  const timer = setTimeout(() => socket.destroy(new Error('the SMTP server took too long')), timeoutMs);
  let talk = replies(socket);
  const expect = async (codes, line) => {
    if (line !== undefined) socket.write(`${line}\r\n`);
    const reply = await talk.next();
    if (!codes.includes(reply.code)) {
      // The login is never repeated in an error.
      const said = /^AUTH\b/i.test(line ?? '') || line === b64(user) || line === b64(pass) ? 'AUTH' : (line ?? '(greeting)');
      throw new Error(`SMTP ${said.split(' ')[0]}: ${reply.text.slice(0, 300)}`);
    }
    return reply;
  };
  try {
    await expect([220]);
    let hello = await expect([250], 'EHLO chiefmate.localhost');
    if (security === 'starttls') {
      if (!/\bSTARTTLS\b/i.test(hello.text)) throw new Error('The SMTP server does not offer STARTTLS.');
      await expect([220], 'STARTTLS');
      talk.detach();
      socket = await new Promise((resolve, reject) => {
        const secure = tls.connect({ socket, servername: net.isIP(host) ? undefined : host }, () => resolve(secure));
        secure.once('error', reject);
      });
      talk = replies(socket);
      hello = await expect([250], 'EHLO chiefmate.localhost');
    }
    if (user) {
      if (/AUTH[ =][^\n]*\bPLAIN\b/i.test(hello.text)) await expect([235], `AUTH PLAIN ${Buffer.from(`\0${user}\0${pass}`, 'utf8').toString('base64')}`);
      else {
        await expect([334], 'AUTH LOGIN');
        await expect([334], b64(user));
        await expect([235], b64(pass));
      }
    }
    await expect([250], `MAIL FROM:<${from}>`);
    await expect([250, 251], `RCPT TO:<${to}>`);
    await expect([354], 'DATA');
    await expect([250], `${message({ from, to, subject, text })}\r\n.`);
    socket.write('QUIT\r\n');
  } finally {
    clearTimeout(timer);
    socket.end();
  }
}
