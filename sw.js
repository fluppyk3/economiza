// Service worker: guarda o aplicativo e o motor de OCR para uso sem internet.
// A lista de arquivos vem de precache.json (gerado por tools/make-precache.mjs).
let VERSION = 'v2-flat-ocr-fix';
const cacheName = () => `precocerto-${VERSION}`;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const list = await (await fetch('precache.json', { cache: 'no-store' })).json();
    VERSION = list.version;
    const cache = await caches.open(cacheName());
    // arquivos do aplicativo: precisam ser guardados (senão a instalação falha)
    await cache.addAll(list.shell);
    // motor de OCR (grande): tenta guardar, sem derrubar a instalação se falhar
    await Promise.allSettled(list.vendor.map((u) => cache.add(u)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const list = await (await caches.match('precache.json') ?? await fetch('precache.json')).json().catch(() => null);
    if (list) VERSION = list.version;
    for (const k of await caches.keys()) if (k.startsWith('precocerto-') && k !== cacheName()) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  event.respondWith((async () => {
    const hit = await caches.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok && !req.url.includes('/tests/')) { const c = await caches.open(cacheName()); c.put(req, res.clone()); }
      return res;
    } catch (e) {
      if (req.mode === 'navigate') { const idx = await caches.match('index.html'); if (idx) return idx; }
      throw e;
    }
  })());
});
