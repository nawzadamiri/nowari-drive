// Offline play and quick return visits.
// Map files carry their own content version (src/datafile.ts). Rebuilds keep the cached files whose addresses match.
// Everything else (the page, the game's code) comes from the network first, so a new version is never held back; its
// kept copy is used only when the network fails (no signal, a tunnel). The page and the other files without a version
// in their name are always checked with the site (the site lets a browser keep them 10 minutes, which held a new
// version back): an unchanged file costs only the check. The game's code files carry their version in their name.
const FILES = 'nowari-files-2', MAPS = 'nowari-map-files', CLIENT_MAPS = 'nowari-client-maps';
const legacyVersion = /^(?:[0-9a-f]{10}|none)$/;
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(
  caches.delete('nowari-files').catch(() => {}).then(() => self.clients.claim()),
));

const activeMaps = new Map();
let pruning = Promise.resolve();
const clientKey = id => new URL(`_nowari-client-maps/${encodeURIComponent(id)}`, self.registration.scope).href;

async function rememberMap(id, map) {
  activeMaps.set(id, map);
  const clients = await caches.open(CLIENT_MAPS);
  const windows = await self.clients.matchAll({ type: 'window' });
  const keys = new Set(windows.map(window => clientKey(window.id)));
  const ids = new Set(windows.map(window => window.id));
  for (const saved of activeMaps.keys()) if (!ids.has(saved)) activeMaps.delete(saved);
  await Promise.all((await clients.keys()).filter(req => !keys.has(req.url)).map(req => clients.delete(req)));
  // Browsers stop idle workers even while a game tab is open. Recover the declarations for those tabs.
  for (const window of windows) {
    if (activeMaps.has(window.id)) continue;
    const stored = await clients.match(clientKey(window.id));
    if (stored) {
      const saved = await stored.json();
      activeMaps.set(window.id, { ...saved, urls: new Set(saved.urls) });
    }
  }
  // Pages from before per-file versions make no declaration. Their caches still serve them in place.
  if (windows.length && windows.every(window => activeMaps.has(window.id))) {
    const maps = [...activeMaps.values()];
    const roots = new Set(maps.map(map => map.root));
    const live = new Set(maps.flatMap(map => [...map.urls]));
    const indexes = new Set(maps.map(map => map.index));
    const indexPath = new URL('data/cities/index.json', self.registration.scope).pathname;
    const store = await caches.open(MAPS);
    const stale = (await store.keys()).filter(req => {
      const url = new URL(req.url);
      if (url.pathname === indexPath) return !indexes.has(null) && !indexes.has(req.url);
      return !live.has(req.url) && (legacyVersion.test(url.searchParams.get('v') ?? '')
        || [...roots].some(root => req.url.startsWith(root)));
    });
    const legacy = (await caches.keys()).filter(name => name.startsWith('nowari-map-') && legacyVersion.test(name.slice(11)));
    await Promise.all([...stale.map(req => store.delete(req)), ...legacy.map(name => caches.delete(name))]);
  }
  // Prune first so an old store occupying the remaining quota cannot prevent cleanup.
  if (ids.has(id)) await clients.put(clientKey(id), new Response(JSON.stringify({ ...map, urls: [...map.urls] })));
}

self.addEventListener('message', e => {
  if (e.data?.type !== 'map-versions' || !e.source?.id) return;
  const { base, versions, index } = e.data;
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
  const indexUrl = typeof index === 'string' && /^[0-9a-f]{12}$/.test(index)
    ? new URL(`index.json?v=${index}`, cities).href : null;
  e.waitUntil(pruning = pruning.then(() => rememberMap(e.source.id, { root: root.href, urls, index: indexUrl }))
    .catch(error => console.warn('Could not update the offline map cache', error)));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  const v = url.searchParams.get('v');
  if (v && url.pathname.includes('/data/')) {
    e.respondWith((async () => {
      const store = await caches.open(MAPS);
      const old = legacyVersion.test(v);
      const hit = req.cache !== 'reload' && (await store.match(req) || (old && await caches.match(req)));
      if (hit) return hit;
      const res = await fetch(req);
      const active = activeMaps.get(e.clientId);
      if (res.ok && res.status === 200 && (!active || !req.url.startsWith(active.root) || active.urls.has(req.url))) {
        const copy = res.clone();
        e.waitUntil((old ? caches.open(`nowari-map-${v}`) : Promise.resolve(store))
          .then(cache => cache.put(req, copy)).catch(() => {}));
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
