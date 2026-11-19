// Service worker: lets browsers install Maamila as an app, and shows the last loaded version when offline.
// Always asks the network first, so visitors get updates right away; the copy is only a fallback.
// Ads, photos and accounts (Supabase, another address) are not touched.
const CACHE = 'maamila-v2';
const SHELL = [
  '/',
  '/css/style.css',
  '/lang/dr.js',
  '/lang/ps.js',
  '/lang/uz.js',
  '/lang/en.js',
  '/js/utils.js',
  '/js/data.js',
  '/js/config.js',
  '/js/app.js',
  '/icons/icon-192.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req.mode === 'navigate' ? '/' : req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req.mode === 'navigate' ? '/' : req, { ignoreSearch: true })),
  );
});
