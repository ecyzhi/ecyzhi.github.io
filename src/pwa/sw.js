// Service worker for ecyzhi.com. The build (src/pwa/integration.mjs) copies
// this file to dist/sw.js and fills in VERSION and PRECACHE with every page
// and asset in the build, so the site and its tools work offline once a
// visitor has opened it once.
const VERSION = '__VERSION__';
const PRECACHE = __PRECACHE__;
const CACHE = `ecyzhi-${VERSION}`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Drop older versions, and anything the old Flutter site left behind.
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
      await self.clients.claim();
    })()
  );
});

// '/tools/collage' and '/tools/collage/index.html' are cached as '/tools/collage/'.
function pageKey(url) {
  let path = url.pathname.replace(/index\.html$/, '');
  if (!path.endsWith('/') && !/\.[a-z0-9]+$/i.test(path)) path += '/';
  return path;
}

function keep(cache, key, response) {
  if (response.ok && response.type === 'basic' && !response.redirected) {
    cache.put(key, response.clone());
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    // Pages: network first so visitors online always get the latest copy,
    // then the cached page, then the 404 page as a last resort.
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const key = pageKey(url);
        try {
          return keep(cache, key, await fetch(request));
        } catch {
          return (await cache.match(key, { ignoreVary: true })) || (await cache.match('/404.html', { ignoreVary: true })) || Response.error();
        }
      })()
    );
    return;
  }

  // Assets: built files have hashed names, so the cached copy is safe to use.
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(request, { ignoreSearch: true, ignoreVary: true });
      if (cached) return cached;
      return keep(cache, request, await fetch(request));
    })()
  );
});
