const CACHE_NAME = 'delivery-tracker-cache-v5';
const PRE_CACHE_RESOURCES = [
  '/',
  '/index.html',
  '/manifest.json?v=2',
  '/icon-192.png?v=2',
  '/icon-512.png?v=2'
];

// On installation, pre-cache core essentials
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRE_CACHE_RESOURCES);
    })
  );
  self.skipWaiting();
});

// Clean up old caches on activation
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Stale-While-Revalidate strategy for offline asset caching
self.addEventListener('fetch', (event) => {
  const requestUrl = new URL(event.request.url);

  // Skip caching for Firebase Realtime Database, Auth, and Dev Server / HMR WebSockets
  if (
    event.request.method !== 'GET' ||
    !event.request.url.startsWith('http') ||
    requestUrl.host.includes('firebase') ||
    requestUrl.pathname.includes('/api/') ||
    requestUrl.pathname.includes('socket') ||
    requestUrl.href.includes('hot-update')
  ) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        // Fetch fresh copy in the background to update cache
        fetch(event.request)
          .then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200) {
              caches.open(CACHE_NAME).then((cache) => {
                cache.put(event.request, networkResponse);
              });
            }
          })
          .catch(() => {
            // Silence network failure when offline
          });
        return cachedResponse;
      }

      return fetch(event.request).then((networkResponse) => {
        if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
          return networkResponse;
        }

        const responseToCache = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, responseToCache);
        });

        return networkResponse;
      });
    })
  );
});
