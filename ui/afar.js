// What the app does from another device (the remote access), where nobody would see a window open on the computer
// where Chiefmate runs. The server keeps the same rules (fromAfar in src/server.mjs); the unit tests check both agree.

/** Not offered from afar, as each action's request: a line says it is done on the computer. */
export const ONLY_ON_PC = {
  'project-open': { route: '/api/project/open', body: { app: 'folder' } },
  'project-vscode': { route: '/api/project/open', body: { app: 'vscode' } },
  'browser-focus': { route: '/api/browser', body: { action: 'focus' } },
  // A file of your user folder: from afar, only found ("dryRun"), its path shown to copy.
  'file-open': { route: '/api/files/open', body: { path: 'Documents\\notes.md' } },
};

/** Offered from afar in a version of their own: the request as sent, and what the server makes of it. */
export const AFAR_VERSION = {
  // A session asked in a window opens in the app.
  'session-window': { route: '/api/session', body: { window: true }, becomes: { window: false } },
  'builder-session': { route: '/api/prompt-builder/session', body: { window: true }, becomes: { window: false } },
  // The development environment runs in the background, and its page shows the system's address.
  'dev-start': { route: '/api/project/dev', body: { action: 'start' }, becomes: { action: 'start', background: true } },
};

/** Whether the app is open on the computer where Chiefmate runs (not through the remote access). */
export const onThisComputer = (host = globalThis.location?.hostname) => ['localhost', '127.0.0.1'].includes(host);

/** Whether an action is offered here. */
export const offered = (action, host) => onThisComputer(host) || !(action in ONLY_ON_PC);
