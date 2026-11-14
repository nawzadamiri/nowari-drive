// Offline play: every file the game fetches from its own site is kept as it comes in. The network always comes first,
// so a new version is never held back; the kept copy is used only when the network fails (no signal, a tunnel).
const KEEP = 'nowari-files';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(fetch(req).then(res => {
    if (res.ok && res.status === 200) {
      const copy = res.clone();
      e.waitUntil(caches.open(KEEP).then(c => c.put(req, copy)).catch(() => {}));
    }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true }).then(hit => hit || Response.error())));
});
