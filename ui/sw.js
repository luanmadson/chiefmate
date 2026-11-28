// The app's service worker, only for the calls' notifications (ui/calls.js): phones show a page's notification only
// through one. It caches nothing and answers no request: the app always comes from Chiefmate itself.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

// A click on a call's notification brings the app to the front (or opens it), where the call bar is.
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = new URL(event.notification.data?.url ?? '/', self.location.origin).href;
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const app = open.find(c => new URL(c.url).origin === self.location.origin);
    if (app) return app.focus();
    return self.clients.openWindow(url);
  })());
});
