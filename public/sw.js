// Minimal offline shell. Never caches /api, and never caches redirected (login) responses.
importScripts("version.js");
const CACHE = "cosmiq-shell-" + self.APP_VERSION;
const SHELL = ["./", "index.html", "dive-protocol.js", "dives.js", "places.js", "places-ui.js", "vendor/leaflet.js", "vendor/leaflet.css", "dive-utils.js", "dive-import.js", "garmin-fit.js", "shearwater.js", "sqlite-lite.js", "shearwater-cloud.js", "account.js", "account-area.js", "api-keys.js", "version.js", "auth/kdf.js", "vendor/qrcode.js", "manifest.webmanifest", "icon-192.png", "favicon.svg", "apple-touch-icon.png", "auth/theme.js", "auth/theme.css", "auth/fonts.css", "auth/fonts/Geist-Variable.woff2", "auth/fonts/GeistMono-Variable.woff2", "auth/icon-summary.png", "auth/icon-log.png", "auth/icon-device.png", "auth/logo-light.png", "dan-logo.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {})); self.skipWaiting(); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin || u.pathname.startsWith("/api/")) return;
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok && !r.redirected && r.type === "basic") { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request).then((m) => m || caches.match("index.html"))));
});
