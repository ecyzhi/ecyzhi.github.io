// The site used to be a Flutter web app, which registered a service worker at
// this path and cached the whole app. Browsers that still have it installed
// check this file for updates; this version clears the old caches, removes
// itself and reloads open tabs so returning visitors get the new site.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
      await self.registration.unregister();
      const clients = await self.clients.matchAll({ type: 'window' });
      clients.forEach((client) => client.navigate(client.url));
    })()
  );
});
