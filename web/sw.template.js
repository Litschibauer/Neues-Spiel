/**
 * Service Worker — damit die App auch im Funkloch STARTET.
 *
 * Bis hierher war „offline spielbar" nur halb wahr: Der Sim-Kern rechnet ohne
 * Netz, aber die Seite selbst kam vom Server. Ein Neuladen im Tunnel zeigte
 * deshalb den Dinosaurier statt den Hof — und im Feldtest war genau das die
 * eine Stelle, an der man das Versprechen nicht glauben konnte.
 *
 * Die Seite ist vollständig eigenständig: Sim-Kern, Client und Sync-Engine
 * stecken als Inline-Skript darin, es gibt keine zweite Datei zu laden. Damit
 * genügt hier ein sehr kleiner Worker.
 *
 * ── Zwei Strategien, streng getrennt ────────────────────────────────────────
 *
 *  - **Die Hülle** (`/`, Manifest, Icon) kommt aus dem Cache und wird im
 *    Hintergrund erneuert. Sie muss immer da sein, auch bei totem Netz.
 *  - **`/api/*` geht NIE in den Cache.** Ein zwischengespeicherter Snapshot
 *    wäre ein zweiter Spielstand neben dem echten — und damit genau der Fork,
 *    gegen den die halbe Architektur gebaut ist (R3). Ohne Netz soll der
 *    Aufruf schlicht scheitern; die Sync-Engine kann damit umgehen, sie ist
 *    dafür gebaut (§10).
 */

/* VERSION wird beim Ausliefern eingesetzt — siehe src/server/http.ts. */
const CACHE = 'neues-spiel-__VERSION__';

/** Die Hülle. Mehr braucht die App nicht, um zu starten. */
const SHELL = ['/', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  // Sofort übernehmen: Ein Worker, der erst beim übernächsten Start greift,
  // hilft ausgerechnet dem nicht, der die App gerade zum ersten Mal öffnet.
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  // Alte Stände wegräumen. Der Cachename trägt die Version, ein Deploy
  // erneuert also alles — sonst spielt jemand ewig auf einer alten Hülle.
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

  // Spielstand und Sync gehen immer ans Netz. Niemals cachen.
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((hit) => {
      // Im Hintergrund erneuern, damit die nächste Sitzung aktuell startet.
      const fresh = fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => hit);

      // Cache zuerst: Start ohne Netz ist der ganze Zweck.
      return hit || fresh;
    }),
  );
});
