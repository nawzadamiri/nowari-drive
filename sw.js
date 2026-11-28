// Offline play and quick return visits.
// Map files carry their own content version (src/datafile.ts). Rebuilds keep the cached files whose addresses match.
// The version is the digest of a file's bytes as the site stores them: a release stores the map squares gzip-compressed
// (scripts/stored-squares.mjs), so a square's plain copy and its compressed copy never share an address, and every check
// here (isCurrent) compares the bytes as stored. A store from before such a change keeps serving its old tabs, and the
// new game never meets those copies (tests/game/stored.test.mjs).
// Everything else (the page, the game's code) comes from the network first, so a new version is never held back; its
// kept copy is used only when the network fails (no signal, a tunnel). The page and the other files without a version
// in their name are always checked with the site (the site lets a browser keep them 10 minutes, which held a new
// version back): an unchanged file costs only the check. The game's code files carry their version in their name.
const FILES = 'nowari-files-2', MAPS = 'nowari-map-files', CLIENT_MAPS = 'nowari-client-maps';
const SHELL = [".","icon.svg","manifest.webmanifest","assets/index-NXq4nx9Y.css","assets/index-NZqRWqux.js","assets/sketch.worker-uEh_DppK.js","assets/tools-eez1d66v.js"]; // Vite replaces this with the exact production entry page and assets.
const legacyVersion = /^(?:[0-9a-f]{10}|none)$/;
const verified = new Set();

async function isCurrent(response, expected) {
  const bytes = await response.clone().arrayBuffer();
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', bytes), 0, 6);
  return Array.from(digest, n => n.toString(16).padStart(2, '0')).join('') === expected;
}
self.addEventListener('install', e => e.waitUntil((async () => {
  if (SHELL.length) {
    const store = await caches.open(FILES);
    await store.addAll(SHELL.map(path => new Request(new URL(path, self.registration.scope), {
      cache: path === '.' ? 'no-cache' : 'default',
    })));
  }
  await self.skipWaiting();
})()));
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
    for (const req of stale) verified.delete(req.url);
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

function shellAddress(req, url) {
  if (req.mode !== 'navigate') return;
  const home = new URL(self.registration.scope);
  if (url.pathname === home.pathname || url.pathname === new URL('index.html', home).pathname) {
    return home.href;
  }
}

async function cachedFile(req, shell) {
  if (shell) {
    const current = await caches.open(FILES).then(cache => cache.match(shell)).catch(() => undefined);
    if (current) return current;
  }
  return caches.match(req, { ignoreSearch: true }).catch(() => undefined);
}

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  const v = url.searchParams.get('v');
  if (v && url.pathname.includes('/data/')) {
    e.respondWith((async () => {
      const store = await caches.open(MAPS).catch(() => null);
      const old = legacyVersion.test(v);
      const pinned = /^[0-9a-f]{12}$/.test(v);
      const hit = req.cache !== 'reload' &&
        (await store?.match(req).catch(() => undefined) || (old && await caches.match(req).catch(() => undefined)));
      if (hit) {
        if (!pinned || verified.has(req.url) || await isCurrent(hit, v)) {
          if (pinned) verified.add(req.url);
          return hit;
        }
        await store?.delete(req).catch(() => {});
      }
      // A map square asked for by a page from before per-file digests (a map-wide ?v=): squares are now stored
      // gzip-compressed (src/stored.ts), which that page cannot read, so it is told to reload rather than given them.
      if (old && /\/data\/cities\/[a-z0-9-]+\/tiles\//.test(url.pathname)) {
        return new Response('Map version changed. Reload to get the current city.', { status: 409 });
      }
      const res = await fetch(req);
      if (pinned && res.ok && !await isCurrent(res, v)) {
        return new Response('Map version changed. Reload to get the current city.', { status: 409 });
      }
      const active = activeMaps.get(e.clientId);
      if (res.ok && res.status === 200 && (!active || !req.url.startsWith(active.root) || active.urls.has(req.url))) {
        const copy = res.clone();
        e.waitUntil((old ? caches.open(`nowari-map-${v}`) : Promise.resolve(store))
          .then(async cache => {
            if (!cache) return;
            await cache.put(req, copy);
            if (pinned) verified.add(req.url);
          }).catch(() => {}));
      }
      return res;
    })());
    return;
  }
  const asset = url.pathname.startsWith(new URL('assets/', self.registration.scope).pathname);
  const fresh = req.mode === 'navigate' || !asset;
  // Shared spots and start options affect the game, not the HTML. Older query entries must not outrank the saved shell.
  const shell = shellAddress(req, url);
  e.respondWith((async () => {
    let res;
    try { res = await fetch(fresh ? new Request(req, { cache: 'no-cache' }) : req); }
    catch { return (await cachedFile(req, shell)) ?? Response.error(); }
    // A temporary server failure can use the saved shell. A tab still playing an older release can also need
    // a content-addressed asset that the new deployment has replaced.
    if (res.status >= 500 || (asset && res.status === 404)) return (await cachedFile(req, shell)) ?? res;
    if (res.ok && res.status === 200) {
      const copy = res.clone();
      e.waitUntil(caches.open(FILES).then(c => c.put(shell ?? req, copy)).catch(() => {}));
    }
    return res;
  })());
});
