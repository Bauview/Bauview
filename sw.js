// BauView Service Worker
//
// Strategie: "Netz zuerst, Speicher als echter Offline-Rückfall" (network-first).
//   - Ist Internet da: IMMER die aktuellste Version vom Server holen und anzeigen.
//     Nie eine veraltete, gespeicherte Version zeigen, solange online.
//   - Ist wirklich kein Internet da (z.B. auf der Baustelle): sofort auf die zuletzt
//     erfolgreich geladene Version aus dem Speicher zurückfallen, damit das Programm trotzdem
//     startet und nutzbar ist.
//   - Bei jedem erfolgreichen Online-Laden wird die gespeicherte Version automatisch aktualisiert
//     (das passiert also automatisch immer dann, wenn im Büro synchronisiert/gearbeitet wird).
//
// CACHE_VERSION bei grösseren Änderungen an dieser Datei hochzählen.
// v3: räumt beim ersten Aktivieren EINMALIG sämtliche zuvor angelegten Caches auf (unabhängig
// von deren Namen) - das behebt hängengebliebene ältere Service-Worker-Zustände auf einzelnen
// Geräten sauber, bevor als korrekt funktionierende Version weitergearbeitet wird.
const CACHE_VERSION = 'bauview-cache-v3';
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
    (async () => {
      // ALLE bisherigen Caches entfernen (nicht nur die mit "falschem" Namen) – räumt zuverlässig
      // auch ältere, evtl. hängengebliebene Service-Worker-Generationen auf einzelnen Geräten auf.
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
      await self.clients.claim();
    })()
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
      .catch(() => caches.match(event.request)) // Netz nicht erreichbar/zu langsam -> auf Speicher zurückfallen (Offline-Nutzung)
  );
});
