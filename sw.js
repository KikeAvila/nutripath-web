/* Service worker — cachea la app para uso OFFLINE.
   deploy.py sube el número de CACHE en cada publicación para forzar la actualización. */
const CACHE = "nutripath-v27";
const ASSETS = [
  "./",
  "index.html",
  "styles.css",
  "app.js",
  "foods.js",
  "firebase-config.js",
  "manifest.webmanifest",
  "icon-192.png",
  "icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

// El código va "red primero" para que las actualizaciones se apliquen en cuanto
// haya conexión; los iconos van "caché primero". Las llamadas a APIs externas
// (Open Food Facts, Anthropic) NO se cachean.
const NETWORK_FIRST = /(index\.html|app\.js|foods\.js|firebase-config\.js|styles\.css|manifest\.webmanifest)(\?|$)/;

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = e.request.url;
  // No interceptar APIs externas ni el SDK de Firebase (van directas a la red).
  if (/anthropic\.com|openfoodfacts\.org|gstatic\.com|googleapis\.com|unpkg\.com/.test(url)) return;

  const esCodigo = e.request.mode === "navigate" || NETWORK_FIRST.test(url);
  if (esCodigo) {
    e.respondWith(
      fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match(e.request).then((hit) => hit || caches.match("index.html")))
    );
  } else {
    e.respondWith(
      caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match("index.html")))
    );
  }
});
