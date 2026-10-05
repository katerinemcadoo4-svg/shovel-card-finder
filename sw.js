const APP_VERSION = '0.4.0';
const CACHE_NAME = `shovel-card-${APP_VERSION}`;
const CORE = [
  './', './index.html', './app.mjs', './styles.css',
  './manifest.webmanifest', './version.json', './data/season.json',
  './src/catalog.mjs', './src/zip.mjs', './src/quiz.mjs', './src/lineups.mjs', './src/formation.mjs', './data/lineups.json',
  './src/history.mjs', './src/lineup-selection.mjs',
  './assets/icon.svg', './assets/icon-192.png',
  './assets/icon-512.png', './assets/apple-touch-icon.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(CORE)));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith('shovel-card-') && name !== CACHE_NAME).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname === new URL('version.json', self.registration.scope).pathname) {
    event.respondWith(fetch(request).catch(() => caches.match(request)));
    return;
  }

  if (request.mode === 'navigate') {
    // Keep the HTML and cached modules from the same installed release until
    // the user accepts the waiting worker. Network-first HTML can mix versions.
    event.respondWith(caches.match(new URL('index.html', self.registration.scope))
      .then(cached => cached || fetch(request)));
    return;
  }

  event.respondWith(caches.match(request).then(cached => cached || fetch(request)));
});
