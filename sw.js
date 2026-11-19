// Offline play and quick return visits.
// The map files (data/…?v=…) carry the map's version in their address (src/shared.ts dataFile), so a kept copy is
// always the right one: it is used first, and the network only for what is not kept yet. Each map version has a store
// of its own, and the stores of older versions are dropped when a new one is first used.
// Everything else (the page, the game's code) comes from the network first, so a new version is never held back; its
// kept copy is used only when the network fails (no signal, a tunnel). The page and the other files without a version
// in their name are always checked with the site (the site lets a browser keep them 10 minutes, which held a new
// version back): an unchanged file costs only the check. The game's code files carry their version in their name.
const FILES = 'nowari-files-2', MAPS = 'nowari-map-';
self.addEventListener('install', () => self.skipWaiting());
// The first store kept the map files too, under addresses no game asks for any more.
self.addEventListener('activate', e => e.waitUntil(caches.delete('nowari-files').then(() => self.clients.claim())));

const opened = new Set();
function mapStore(v) {
  const name = MAPS + v;
  if (!opened.has(name)) {
    opened.add(name);
    caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith(MAPS) && k !== name).map(k => caches.delete(k)))).catch(() => {});
  }
  return caches.open(name);
}

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  const v = url.searchParams.get('v');
  if (v && url.pathname.includes('/data/')) {
    e.respondWith(mapStore(v).then(store => store.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok && res.status === 200) e.waitUntil(store.put(req, res.clone()).catch(() => {}));
      return res;
    }))).catch(() => fetch(req)));
    return;
  }
  const fresh = req.mode === 'navigate' || !url.pathname.includes('/assets/');
  e.respondWith(fetch(fresh ? new Request(req, { cache: 'no-cache' }) : req).then(res => {
    if (res.ok && res.status === 200) {
      const copy = res.clone();
      e.waitUntil(caches.open(FILES).then(c => c.put(req, copy)).catch(() => {}));
    }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true }).then(hit => hit || Response.error())));
});
