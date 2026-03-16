// Self-destructing service worker — clears old caches and unregisters.
// Pages now use server-side auth guards which return redirects;
// a caching SW conflicts with that flow.

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => self.registration.unregister())
  );
  self.clients.claim();
});
