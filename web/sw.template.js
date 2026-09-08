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

  // Hintergrundmusik nie cachen: groß, optional und wird per Range-Anfrage
  // gestreamt (206-Antworten dürfen nicht im Cache landen). Immer direkt vom Netz.
  if (url.pathname === '/OST.mp3' || url.pathname.startsWith('/musik/')) return;

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

// — Benachrichtigungen ————————————————————————————————————————————————————
// Der Server verschlüsselt jede Nachricht für genau dieses Gerät; hier kommt
// sie entschlüsselt an. Fällt das Auspacken aus, zeigen wir wenigstens etwas.
self.addEventListener('push', (event) => {
  let daten = { titel: 'Dein Hof', text: 'Es gibt Neues auf dem Hof.' };
  try {
    if (event.data) daten = Object.assign(daten, event.data.json());
  } catch (e) {
    if (event.data) daten.text = event.data.text();
  }
  event.waitUntil(
    self.registration.showNotification(daten.titel, {
      body: daten.text,
      icon: '/icon.png',
      badge: '/icon.png',
      tag: daten.art === 'admin' ? 'hof-nachricht' : 'hof-' + (daten.art || 'info'),
      renotify: false,
      data: { url: '/' },
    }),
  );
});

// Tippen bringt den schon offenen Hof nach vorn, statt einen zweiten zu öffnen.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((liste) => {
      for (const client of liste) {
        if (client.url.indexOf(self.location.origin) === 0 && 'focus' in client) return client.focus();
      }
      return self.clients.openWindow('/');
    }),
  );
});
