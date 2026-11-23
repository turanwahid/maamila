// Service worker: lets browsers install Maamila as an app, and shows the last loaded version when offline.
// Answers from the copy on the phone at once (fast even on weak connections) and refreshes that copy in the
// background, so an update shows from the next visit on.
// Ads, photos and accounts (Supabase, another address) are not touched.
const CACHE = 'maamila-v3';
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
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  const key = req.mode === 'navigate' ? '/' : req;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(key, { ignoreSearch: true });
      const fresh = fetch(req).then((res) => {
        if (res.ok) cache.put(key, res.clone());
        return res;
      });
      if (cached) {
        event.waitUntil(fresh.catch(() => {})); // refresh in the background
        return cached;
      }
      return fresh;
    }),
  );
});
