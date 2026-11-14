/* AireMañana service worker: the site works offline with the last forecast it saw.
   Network first for everything (the forecast changes every evening), cache only as a fallback. */
const CACHE = "airemanana-v1";
const SHELL = ["./", "index.html", "style.css", "app.js", "i18n.js", "favicon.svg", "manifest.webmanifest",
  "data/forecast.json", "data/evaluation.json", "data/profiles.json", "icons/icon-192.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET") return;
  const own = url.origin === location.origin;
  const lib = /cdn\.jsdelivr\.net|unpkg\.com|fonts\.(googleapis|gstatic)\.com/.test(url.host);
  if (!own && !lib) return;                                   // map tiles etc.: leave to the browser
  const key = own ? new Request(url.origin + url.pathname) : req;   // ignore ?v= cache-busting on our own files
  e.respondWith(fetch(req).then(res => {
    if (res.ok || res.type === "opaque") { const copy = res.clone(); caches.open(CACHE).then(c => c.put(key, copy)); }
    return res;
  }).catch(() => caches.match(key).then(r => r || (req.mode === "navigate" ? caches.match("./") : Response.error()))));
});
