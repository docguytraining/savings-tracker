// ─────────────────────────────────────────────────────────────────────────────
// Service Worker — Savings Tracker
//
// Strategy: Cache-first for the app shell (HTML, JS, icons, manifest).
//           Network-only for Firebase API calls (auth, Firestore).
//
// To force users to receive an updated app shell after a deployment:
//   1. Increment CACHE_VERSION below (e.g. 'v2').
//   2. Re-deploy. The activate event will delete the old cache automatically.
// ─────────────────────────────────────────────────────────────────────────────

const CACHE_VERSION = 'v7';
const CACHE_NAME    = `savings-tracker-${CACHE_VERSION}`;

// Files that make up the "app shell" — the minimum needed to render the UI
// without a network connection. All paths are relative to the service worker's
// scope (the site root).
const APP_SHELL = [
  '/',
  '/index.html',
  '/project.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  // Firebase SDK files (served from Google's CDN)
  'https://www.gstatic.com/firebasejs/10.4.0/firebase-app.js',
  'https://www.gstatic.com/firebasejs/10.4.0/firebase-firestore.js',
  'https://www.gstatic.com/firebasejs/10.4.0/firebase-auth.js'
];

// ─────────────────────────────────────────────────────────────────────────────
// INSTALL — pre-cache the app shell
//
// `skipWaiting()` activates the new SW immediately instead of waiting for all
// existing tabs to close. This ensures users get updates faster.
// ─────────────────────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  console.log(`[SW ${CACHE_VERSION}] Installing…`);
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log(`[SW ${CACHE_VERSION}] Pre-caching app shell`);
        // addAll() is atomic — if any resource fails, the install fails.
        // If you add resources to APP_SHELL that might be unavailable (e.g.
        // third-party URLs), use individual cache.add() calls inside a
        // Promise.allSettled() instead.
        return cache.addAll(APP_SHELL);
      })
      .then(() => {
        console.log(`[SW ${CACHE_VERSION}] App shell cached`);
        return self.skipWaiting();
      })
      .catch((err) => {
        console.error(`[SW ${CACHE_VERSION}] Pre-cache failed:`, err);
      })
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// ACTIVATE — clean up outdated caches
//
// `clients.claim()` lets the new SW take control of open pages immediately
// without requiring a page reload.
// ─────────────────────────────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  console.log(`[SW ${CACHE_VERSION}] Activating…`);
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames
            .filter(name => name.startsWith('savings-tracker-') && name !== CACHE_NAME)
            .map(name => {
              console.log(`[SW] Deleting old cache: ${name}`);
              return caches.delete(name);
            })
        );
      })
      .then(() => {
        console.log(`[SW ${CACHE_VERSION}] Active and controlling`);
        return self.clients.claim();
      })
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// FETCH — intercept network requests
//
// Routing logic:
//
//   • Firebase API endpoints (Firestore / Auth / Identity Toolkit) are passed
//     directly to the network. Caching authentication tokens or Firestore
//     responses would cause stale/incorrect data and break offline detection.
//
//   • Everything else uses a "cache-first, fall back to network" strategy.
//     This keeps the app fast for repeat visits and functional when offline.
//     New responses from the network are stored in the cache for next time.
//
//   • If both cache and network fail (fully offline, resource not cached),
//     a bare HTML fallback is returned for document requests so the user sees
//     a useful "offline" message instead of the browser's default error page.
// ─────────────────────────────────────────────────────────────────────────────

// Hostnames that must always go to the network
const NETWORK_ONLY_HOSTS = [
  'firestore.googleapis.com',
  'identitytoolkit.googleapis.com',   // Firebase Auth REST API
  'securetoken.googleapis.com',        // Firebase token exchange
  'firebase.googleapis.com',
  'accounts.google.com'
];

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle GET requests — POST/PUT/DELETE must always go to network
  if (request.method !== 'GET') return;

  // Parse the URL to check the host
  let url;
  try { url = new URL(request.url); } catch { return; }

  // Pass Firebase / Google auth requests straight to the network
  if (NETWORK_ONLY_HOSTS.some(host => url.hostname.includes(host))) return;

  // For everything else: cache-first strategy
  event.respondWith(
    caches.match(request)
      .then((cachedResponse) => {
        if (cachedResponse) {
          // Cache hit — return immediately, then refresh in background
          // (stale-while-revalidate pattern for same-origin resources)
          if (url.origin === self.location.origin) {
            fetch(request)
              .then((networkResponse) => {
                if (networkResponse && networkResponse.ok) {
                  caches.open(CACHE_NAME).then(cache => cache.put(request, networkResponse));
                }
              })
              .catch(() => { /* ignore background refresh failures */ });
          }
          return cachedResponse;
        }

        // Cache miss — fetch from network and store the response
        return fetch(request)
          .then((networkResponse) => {
            // Only cache valid same-origin responses
            if (
              networkResponse &&
              networkResponse.ok &&
              networkResponse.type === 'basic'   // 'basic' means same-origin
            ) {
              const responseToCache = networkResponse.clone();
              caches.open(CACHE_NAME).then(cache => cache.put(request, responseToCache));
            }
            return networkResponse;
          })
          .catch(() => {
            // Both cache and network failed — offline fallback
            if (request.destination === 'document') {
              // Return the cached index.html so the app shell still renders
              return caches.match('/index.html');
            }
            // For other resources (images, scripts) there is no useful fallback;
            // return a generic 503 so the browser doesn't show a cryptic error.
            return new Response('Offline — resource unavailable', {
              status:  503,
              headers: { 'Content-Type': 'text/plain' }
            });
          });
      })
  );
});
