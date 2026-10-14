const CACHE_NAME = 'my-study-agent-pwa-v1';
const APP_ROOT = new URL('./', self.registration.scope);
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './supabase-config.js',
  './manifest.webmanifest',
  './icons/app-icon.svg',
  './icons/app-icon-192.png',
  './icons/app-icon-512.png',
  './icons/apple-touch-icon.png',
  './vendor/dexie.js',
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_SHELL.map(path => new URL(path, APP_ROOT)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith('my-study-agent-pwa-') && name !== CACHE_NAME)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone());
      return response;
    } catch {
      const cached = await cache.match(request);
      if (cached) return cached;
      if (request.mode === 'navigate') {
        return await cache.match(new URL('./index.html', APP_ROOT))
          || Response.error();
      }
      return Response.error();
    }
  })());
});
