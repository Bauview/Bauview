// BauView Service Worker
// Ermöglicht, dass die App-Oberfläche selbst auch ohne Internetverbindung geladen werden kann.
// Die eigentlichen Projektdaten (Mängel, Pläne usw.) liegen ohnehin bereits lokal in der
// Browser-Datenbank (IndexedDB) und sind davon unabhängig.
//
// Strategie: "Netzwerk zuerst, Cache als Rückfallebene" - bei bestehender Verbindung wird IMMER
// die aktuelle Version geladen (kein Risiko einer veralteten, "hängenden" Version); nur wenn
// wirklich keine Verbindung besteht, wird die zuletzt erfolgreich geladene Version aus dem
// Zwischenspeicher verwendet.

const CACHE_NAME = 'bauview-cache-v1'; // bei grösseren Änderungen an dieser Datei hochzählen

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(['./', './index.html']))
      .catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  // Nur eigene GET-Anfragen auf die App-Seite behandeln - alles andere (insbesondere Aufrufe an
  // Supabase für die Cloud-Synchronisierung) unverändert normal durchlassen.
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request)
      .then(resp => {
        const clone = resp.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone)).catch(() => {});
        return resp;
      })
      .catch(() =>
        caches.match(event.request).then(cached => cached || caches.match('./index.html'))
      )
  );
});
