const APP_VERSION = '0.1.1';
const CACHE_NAME = `shovel-card-${APP_VERSION}`;
const CORE = [
  './', './index.html', './app.mjs', './styles.css',
  './manifest.webmanifest', './version.json', './data/season.json',
  './src/catalog.mjs', './src/zip.mjs', './src/recognition.mjs',
  './src/opencv-loader.mjs', './vendor/opencv-4.8.0.js',
  './vendor/OPENCV-LICENSE.txt', './vendor/OPENCV-NOTICE.txt',
  './src/ocr.mjs', './vendor/tesseract/tesseract.esm.min.js',
  './vendor/tesseract/worker.min.js',
  './vendor/tesseract/core/tesseract-core-lstm.wasm.js',
  './vendor/tesseract/core/tesseract-core-simd-lstm.wasm.js',
  './vendor/tesseract/lang/chi_sim.traineddata.gz',
  './vendor/tesseract/TESSERACT-JS-LICENSE.md',
  './vendor/tesseract/TESSERACT-JS-BUNDLE-LICENSE.txt',
  './vendor/tesseract/WORKER-BUNDLE-LICENSE.txt',
  './vendor/tesseract/CORE-LICENSE.txt',
  './vendor/tesseract/LANG-LICENSE.txt',
  './vendor/tesseract/NOTICE.md',
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
