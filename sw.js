// BauView Service Worker – cached app shell für echte Offline-Nutzung
const CACHE='bauview-v37';
const ASSETS=[
  './','./index.html','./app.js','./cloud.js','./assets.js','./manifest.json',
  './vendor/pdf.min.js','./vendor/pdf.worker.min.js','./vendor/jspdf.umd.min.js',
  './vendor/pdf-lib.min.js','./vendor/qrcode.min.js','./vendor/supabase.min.js',
  './icon-192.png','./icon-512.png'
];
self.addEventListener('install',e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',e=>{
  e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET')return;
  e.respondWith(
    caches.match(e.request).then(cached=>cached||fetch(e.request).then(res=>{
      const copy=res.clone();
      caches.open(CACHE).then(c=>c.put(e.request,copy)).catch(()=>{});
      return res;
    }).catch(()=>cached))
  );
});
