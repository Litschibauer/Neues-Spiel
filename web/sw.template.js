const CACHE = 'neues-spiel-__VERSION__';

const SHELL = ['/', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/api/')) return;

  const speichere = (response) => {
    if (response && response.ok) {
      const copy = response.clone();
      caches.open(CACHE).then((cache) => cache.put(request, copy));
    }
    return response;
  };

  // Die Seiten-Hülle (Navigation) holen wir online IMMER frisch — sonst läuft
  // nach einem Deploy mit neuem Regelwerk weiter der alte Client aus dem Cache
  // und stürzt an einem neueren Spielstand ab („offline für immer"). Offline
  // fällt sie auf den Cache zurück.
  const istHuelle = request.mode === 'navigate' || url.pathname === '/';
  if (istHuelle) {
    event.respondWith(
      fetch(request)
        .then(speichere)
        .catch(() => caches.match(request, { ignoreSearch: true }).then((hit) => hit || fetch(request))),
    );
    return;
  }

  // Übrige Dateien: sofort aus dem Cache, im Hintergrund auffrischen.
  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((hit) => {
      const fresh = fetch(request).then(speichere).catch(() => hit);
      return hit || fresh;
    }),
  );
});
