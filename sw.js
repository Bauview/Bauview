// BauView Service Worker
//
// Strategie: "Netz zuerst, Speicher nur als echter Rückfall" (network-first).
//   - Ist Internet da: IMMER die aktuellste Version vom Server holen und anzeigen.
//     Nie eine veraltete, gespeicherte Version zeigen, solange online.
//   - Erst wenn das Netz wirklich nicht erreichbar ist (echtes Offline): auf die zuletzt
//     erfolgreich geladene Version aus dem Speicher zurückfallen.
//   - Bei jedem erfolgreichen Online-Laden wird die gespeicherte Version automatisch aktualisiert.
//
// (Vorherige Version nutzte "Speicher zuerst" – das führte während der aktiven Entwicklung dazu,
// dass Geräte zeitweise eine veraltete, bereits überholte Version anzeigten, obwohl online.
// Für eine sich noch häufig ändernde App ist "Netz zuerst" das richtige Verhalten.)
//
// CACHE_VERSION bei grösseren Änderungen an DIESER Datei hochzählen, damit alte Caches sauber
// entfernt werden. v2 hier bewusst hochgezählt, um alte v1-Caches (Stale-Zustand) zu verwerfen.
const CACHE_VERSION = 'bauview-cache-v2';
const APP_URLS = ['./', './index.html'];
const NETWORK_TIMEOUT_MS = 4000; // wie lange maximal aufs Netz gewartet wird, bevor auf den Speicher zurückgefallen wird

self.addEventListener('install', event => {
  self.skipWaiting(); // neue Version sofort aktiv werden lassen, nicht erst beim nächsten kompletten Neustart
  event.waitUntil(
    caches.open(CACHE_VERSION).then(cache => cache.addAll(APP_URLS)).catch(()=>{})
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

function timeout(ms){
  return new Promise((_, reject) => setTimeout(() => reject(new Error('Netzwerk-Zeitlimit')), ms));
}

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  // Nur eigene Seiten-Anfragen behandeln (nicht z.B. Supabase-API-Aufrufe abfangen/cachen)
  if (new URL(event.request.url).origin !== self.location.origin) return;

  event.respondWith(
    Promise.race([fetch(event.request), timeout(NETWORK_TIMEOUT_MS)])
      .then(response => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_VERSION).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request)) // Netz nicht erreichbar/zu langsam -> auf Speicher zurückfallen
  );
});
