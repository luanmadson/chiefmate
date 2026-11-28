// Calling the owner when a step of the crew needs them (src/needs.mjs). ui/app.js draws the call bar at the top of
// every page; this module holds what decides it and what reaches the owner out of sight: the browser's notification,
// the window's title blinking and an optional sound. Each browser keeps its own choices: the sound is off until the
// owner turns it on, and the notification needs the browser's permission, asked on a click. Nothing here reads the
// state or the page by itself: ui/app.js passes what it needs; scripts/unit.mjs tests it.

/** The owner's choices in this browser (localStorage). */
export const SOUND_KEY = 'chiefmate.call-sound';
export const NOTIFY_KEY = 'chiefmate.call-notify';

/** The open calls of the crew's steps, without the ones left for later: those that hold their step first, oldest first. */
export const callsOf = needs => (needs ?? [])
  .filter(n => n.run && !n.deferred)
  .sort((a, b) => Number(!!b.waiting) - Number(!!a.waiting) || String(a.at).localeCompare(String(b.at)));

/** The bar: the first call in full and how many more, or every call once opened. */
export const callsLayout = (calls, open) => ({ count: calls.length, shown: open ? calls : calls.slice(0, 1), more: open ? 0 : Math.max(0, calls.length - 1) });

/** Where a call's step stands, in words: waiting for the owner until a time, parked, or gone on without them. */
export function waitLine(c, { t, clockTime }) {
  if (c.parked) return t('Parked: it resumes once you answer');
  if (c.waiting) return t('Waiting for you until {time}', { time: clockTime(c.until) });
  if (c.waitEnded?.why === 'away') return t('You were away: it went on with what it can');
  // A "Not now" undone (src/needs.mjs): the call is back, its step already on its way.
  if (c.waitEnded?.why === 'later') return t('You said not now: it went on with what it can');
  if (c.wait) return t('No answer in time: it went on with what it can');
  return t('It went on meanwhile');
}

/**
 * The calls to announce (notification, sound, blinking title): those not known yet. "known" is the set of the ids
 * already seen, or null before the first reading, whose calls are only remembered (the bar shows them). Returns
 * { fresh, known }, a new set that forgets the calls gone.
 */
export function announce(calls, known) {
  const ids = new Set(calls.map(c => `${c.run}:${c.id}`));
  if (!known) return { fresh: [], known: ids };
  return { fresh: calls.filter(c => !known.has(`${c.run}:${c.id}`)), known: ids };
}

/** The window's title while it blinks: the call and the app's title, in turn. */
export const blinkTitle = (base, line, on) => (on && line ? `!! ${line}` : base);

/** Whether the owner turned the sound on in this browser (off by default). */
export function soundOn(storage) {
  try {
    return storage?.getItem(SOUND_KEY) === '1';
  } catch {
    return false; // no storage: a private window
  }
}

/** Whether the owner wants the browser's notification in this browser (on once they allowed it, until turned off). */
export function notifyOn(storage) {
  try {
    return storage?.getItem(NOTIFY_KEY) !== '0';
  } catch {
    return true;
  }
}

/** Keeps a choice ("1" or "0") in this browser; false when the browser keeps nothing. */
export function keepChoice(storage, key, on) {
  try {
    storage.setItem(key, on ? '1' : '0');
    return true;
  } catch {
    return false;
  }
}

/**
 * The browser's notification for this browser, in one word: "on", "off" (turned off here), "ask" (not allowed yet),
 * "blocked" (refused in the browser's settings), "windows" (this computer, where Windows already notifies each call)
 * or "none" (the browser has none).
 */
export function notifyState({ Notification, here, storage }) {
  if (here) return 'windows';
  if (!Notification) return 'none';
  if (Notification.permission === 'denied') return 'blocked';
  if (Notification.permission !== 'granted') return 'ask';
  return notifyOn(storage) ? 'on' : 'off';
}

/**
 * Shows the browser's notification of new calls: one per call, at most three (then one that counts the rest), through
 * the service worker when there is one (phones need it), else the page's own Notification. Returns how many it showed.
 * text(c): the call in words, { title, body }.
 */
export async function notifyCalls(calls, { Notification, registration, text, more, icon = '/icon-192.png' }) {
  if (!calls.length || Notification?.permission !== 'granted') return 0;
  const one = c => ({ ...text(c), tag: c.id });
  const list = calls.length > 3 ? [...calls.slice(0, 2).map(one), { ...more(calls.length - 2), tag: 'more' }] : calls.map(one);
  let shown = 0;
  for (const n of list) {
    const options = { body: n.body, icon, tag: `chiefmate-call-${n.tag}`, requireInteraction: true, data: { url: '/#operations' } };
    try {
      if (registration?.showNotification) await registration.showNotification(n.title, options);
      else new Notification(n.title, options);
      shown += 1;
    } catch {
      // a browser that refuses it now (no service worker on a phone): the bar and the title still call
    }
  }
  return shown;
}

/**
 * A short, quiet chime of two notes through the Web Audio API, with no file to load. "context": an AudioContext,
 * resumed after the owner's first click on the page (browsers keep it silent until then). Returns whether it played.
 */
export function chime(context) {
  if (!context || context.state === 'closed') return false;
  const play = () => {
    const start = context.currentTime + 0.02;
    for (const [i, frequency] of [880, 660].entries()) {
      const osc = context.createOscillator();
      const gain = context.createGain();
      osc.type = 'sine';
      osc.frequency.value = frequency;
      const at = start + i * 0.22;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.12, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.2);
      osc.connect(gain).connect(context.destination);
      osc.start(at);
      osc.stop(at + 0.22);
    }
  };
  if (context.state === 'running') {
    play();
    return true;
  }
  // Suspended (no click on the page yet, or the tab put aside): it plays if the browser lets it at once, never later.
  const asked = Date.now();
  context.resume?.().then(() => context.state === 'running' && Date.now() - asked < 3000 && play(), () => {});
  return false;
}
