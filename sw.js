// BauView Service Worker
// Sorgt dafür, dass die App-Seite zuverlässig offline geladen werden kann, nicht nur "meistens"
// über den normalen (unzuverlässigen) Browser-Cache.
//
// Strategie: "Cache, dann im Hintergrund aktualisieren" (stale-while-revalidate)
//   - Ist die Seite schon im Cache: SOFORT daraus laden (funktioniert auch komplett offline).
//   - Gleichzeitig im Hintergrund die neueste Version vom Netz holen und den Cache aktualisieren,
//     damit man beim NÄCHSTEN Laden automatisch die neueste Version bekommt.
//   - Ist noch nichts im Cache (allererster Aufruf) und kein Netz da: kann natürlich nicht laden,
//     das ist unvermeidbar (die Seite muss mindestens einmal online geöffnet worden sein).
//
// CACHE_VERSION bei grösseren Änderungen an DIESER Datei (nicht an der App selbst) hochzählen,
// damit alte, evtl. inkompatible Caches sauber entfernt werden.
const CACHE_VERSION = 'bauview-cache-v1';
const APP_URLS = ['./', './index.html'];

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

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  // Nur eigene Seiten-Anfragen behandeln (nicht z.B. Supabase-API-Aufrufe abfangen/cachen)
  if (new URL(event.request.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      const networkFetch = fetch(event.request).then(response => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_VERSION).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => cached); // offline -> auf den Cache zurückfallen
      return cached || networkFetch; // sofort aus dem Cache, sonst aufs Netz warten
    })
  );
});
