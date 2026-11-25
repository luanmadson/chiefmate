// Dictation in the message fields, through the browser's speech recognition (Web Speech API), with no dependency.
// The words go where the caret is, those still being heard shown as they come; nothing is sent by itself.
// Nothing here touches the page when imported, so the unit tests load it in Node.

/** How long a silence stops the dictation. */
export const SILENCE_MS = 5000;

/** The browser's recognizer, or null without one (Firefox) or outside a secure context (https, localhost). */
export function recognizer(win = globalThis) {
  if (!win?.isSecureContext) return null;
  return win.SpeechRecognition ?? win.webkitSpeechRecognition ?? null;
}

/**
 * A dictation's states: idle → starting (asked) → listening (the browser hears) → stopping → idle.
 * Events: toggle (the button or Ctrl+M), start and end (the recognizer's).
 */
export function nextState(state, event) {
  if (event === 'end') return 'idle';
  if (event === 'start') return state === 'starting' ? 'listening' : state;
  if (event === 'toggle') return state === 'idle' ? 'starting' : 'stopping';
  return state;
}

const tidy = s => s.replace(/\s+/g, ' ').trim();

/** What was heard from result `from` on: the final words and those still being heard. */
export function transcript(results, from = 0) {
  const final = [];
  const interim = [];
  for (let i = from; i < results.length; i++) (results[i].isFinal ? final : interim).push(results[i][0]?.transcript ?? '');
  return { final: tidy(final.join(' ')), interim: tidy(interim.join(' ')) };
}

/**
 * The field's text with the words heard in place of its selection (base: { value, start, end }), and the caret after
 * them. A space goes between the words and the text around them, unless that text has one or is punctuation.
 */
export function compose(base, heard) {
  const words = tidy(heard);
  if (!words) return { value: base.value, caret: base.end };
  const before = base.value.slice(0, base.start);
  const after = base.value.slice(base.end);
  const open = before && !/\s$/.test(before) && !/^[.,;:!?)]/.test(words) ? ' ' : '';
  const close = after && !/^[\s.,;:!?)]/.test(after) ? ' ' : '';
  return { value: before + open + words + close + after, caret: before.length + open.length + words.length };
}

/** One dictation into one field. onState(state) follows its states; onError(code) gets the recognizer's errors. */
export class Dictation {
  constructor({ Recognition, field, lang, continuous = true, silenceMs = SILENCE_MS, onState = () => {}, onError = () => {} }) {
    Object.assign(this, { Recognition, field, lang, continuous, silenceMs, onState, onError });
    this.state = 'idle';
    this.rec = null;
  }

  get listening() {
    return this.state === 'starting' || this.state === 'listening';
  }

  start() {
    if (this.state !== 'idle') return;
    this.rebase(0);
    this.final = '';
    this.aborted = false;
    const rec = new this.Recognition();
    Object.assign(rec, { lang: this.lang, interimResults: true, continuous: this.continuous, maxAlternatives: 1 });
    rec.onstart = () => {
      this.set('start');
      this.quietLater();
    };
    rec.onresult = event => this.hear(event.results);
    rec.onerror = event => event.error !== 'aborted' && this.onError(event.error);
    rec.onend = () => this.finish();
    this.rec = rec;
    this.set('toggle');
    try {
      rec.start();
    } catch {
      this.onError('start');
      this.finish();
    }
  }

  /** Stops listening: the final words stay, those not yet final go. */
  stop() {
    if (!this.rec || this.state === 'stopping') return;
    this.set('toggle');
    this.rec.stop();
  }

  /** Stops at once, writing nothing more (the message was sent, or the page changed). */
  abort() {
    if (!this.rec) return;
    this.aborted = true;
    if (this.state !== 'stopping') this.set('toggle');
    this.rec.abort();
  }

  set(event) {
    this.state = nextState(this.state, event);
    this.onState(this.state);
  }

  quietLater() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.stop(), this.silenceMs);
  }

  /** From now on, the words go where the field's caret is, and the results before `skip` are left out. */
  rebase(skip) {
    const f = this.field;
    this.base = { value: f.value, start: f.selectionStart ?? f.value.length, end: f.selectionEnd ?? f.value.length };
    this.written = f.value;
    this.skip = skip;
  }

  hear(results) {
    if (this.aborted) return;
    this.quietLater();
    // Typed in, or sent, meanwhile: what is heard next goes where the caret is now
    if (this.field.value !== this.written) this.rebase(results.length);
    const { final, interim } = transcript(results, this.skip);
    this.final = final;
    this.put(`${final} ${interim}`, false);
  }

  put(heard, done) {
    const f = this.field;
    const next = compose(this.base, heard);
    if (next.value === f.value && !done) return;
    f.value = next.value;
    this.written = next.value;
    if (done || f.ownerDocument?.activeElement === f) f.setSelectionRange(next.caret, next.caret);
    f.dispatchEvent(new Event('input', { bubbles: true }));
  }

  finish() {
    clearTimeout(this.timer);
    if (!this.aborted && this.field.value === this.written) this.put(this.final, true);
    this.rec = null;
    this.set('end');
  }
}
