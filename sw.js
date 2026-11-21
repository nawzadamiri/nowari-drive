// Offline play and quick return visits.
// Map files carry their own content version (src/datafile.ts). Rebuilds keep the cached files whose addresses match.
// Everything else (the page, the game's code) comes from the network first, so a new version is never held back; its
// kept copy is used only when the network fails (no signal, a tunnel). The page and the other files without a version
// in their name are always checked with the site (the site lets a browser keep them 10 minutes, which held a new
// version back): an unchanged file costs only the check. The game's code files carry their version in their name.
const FILES = 'nowari-files-2', MAPS = 'nowari-map-files';
self.addEventListener('install', () => self.skipWaiting());

/** Keep previous versions usable for a page that is already open when this worker takes over. */
async function migrateMapStores() {
  const old = (await caches.keys()).filter(name => /^nowari-map-(?:[0-9a-f]{10}|none)$/.test(name));
  if (!old.length) return;
  const current = await caches.open(MAPS);
  for (const name of old) {
    const previous = await caches.open(name);
    for (const request of await previous.keys()) {
      if (await current.match(request)) continue;
      const response = await previous.match(request);
      if (response) await current.put(request, response);
    }
    await caches.delete(name);
  }
}

self.addEventListener('activate', e => e.waitUntil(
  Promise.all([caches.delete('nowari-files'), migrateMapStores()]).catch(() => {}).then(() => self.clients.claim()),
));

const activeMaps = new Map();
let pruning = Promise.resolve();
self.addEventListener('message', e => {
  if (e.data?.type !== 'map-versions' || !e.source?.id) return;
  const { base, versions } = e.data;
  if (typeof base !== 'string' || !versions || typeof versions !== 'object') return;
  const root = new URL(base, self.registration.scope);
  const cities = new URL('data/cities/', self.registration.scope);
  if (root.origin !== cities.origin || root.search || root.hash || !root.pathname.startsWith(cities.pathname) ||
      !/^[a-z0-9-]+\/$/.test(root.pathname.slice(cities.pathname.length))) return;
  const urls = new Set();
  for (const [path, v] of Object.entries(versions)) {
    if (typeof v !== 'string' || !/^[0-9a-f]{12}$/.test(v)) continue;
    const address = new URL(path, root);
    if (address.href !== root.href + path || address.search || address.hash || address.pathname.endsWith('/')) continue;
    address.searchParams.set('v', v);
    urls.add(address.href);
  }
  if (!urls.size) return;
  activeMaps.set(e.source.id, { root: root.href, urls });
  e.waitUntil(pruning = pruning.then(async () => {
    const windows = await self.clients.matchAll({ type: 'window' });
    const ids = new Set(windows.map(c => c.id));
    for (const id of activeMaps.keys()) if (!ids.has(id)) activeMaps.delete(id);
    // An older page may still be playing with legacy URLs. Keep its files until it closes.
    if (windows.some(c => !activeMaps.has(c.id))) return;
    const keep = Array.from(activeMaps.values()).filter(map => map.root === root.href);
    if (!keep.length) return;
    const store = await caches.open(MAPS);
    const entries = await store.keys();
    await Promise.all(entries.filter(req => req.url.startsWith(root.href) &&
      !keep.some(map => map.urls.has(req.url))).map(req => store.delete(req)));
  }).catch(() => {}));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  const v = url.searchParams.get('v');
  if (v && url.pathname.includes('/data/')) {
    e.respondWith((async () => {
      const store = await caches.open(MAPS);
      // A migration interrupted by storage limits can still serve an older page's cached files.
      const hit = await store.match(req) || (/^[0-9a-f]{10}$/.test(v) && await caches.match(req));
      if (hit) return hit;
      const res = await fetch(req);
      const active = activeMaps.get(e.clientId);
      if (res.ok && res.status === 200 && (!active || !req.url.startsWith(active.root) || active.urls.has(req.url))) {
        e.waitUntil(store.put(req, res.clone()).catch(() => {}));
      }
      return res;
    })().catch(() => fetch(req)));
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
