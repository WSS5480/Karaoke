// The Dive Karaoke: keeps the app shell on the phone so it opens fast; live data always comes from the server.
const CACHE = "dive-v90";
const SHELL = ["/", "/kj", "/logo.png", "/songs.json", "/manifest.json", "/icon-192.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {})); self.skipWaiting(); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  // each bar has its own app space: The Dive's worker never touches /b/... pages, and nobody caches live data
  const home = location.pathname.replace(/sw\.js$/, "");
  if (e.request.method !== "GET" || u.origin !== location.origin || u.pathname.includes("/api/")) return;
  if (!u.pathname.startsWith(home) || (home.length === 1 && u.pathname.startsWith("\/b\/"))) return;
  // network first, fall back to the saved copy when the signal drops
  e.respondWith(fetch(e.request).then(r => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); } return r; })
    .catch(() => caches.match(e.request).then(m => m || caches.match("/"))));
});

// phone alerts: "you're next" / "you're up" (sound + vibrate come from the phone's notification settings)
self.addEventListener("push", e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (x) { d = { title: "The Dive", body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "The Dive", { body: d.body || "", tag: d.tag || "dive", renotify: true, requireInteraction: d.tag === "dive-up", vibrate: [400, 150, 400, 150, 400], icon: "/icon-192.png", badge: "/icon-192.png", data: { url: d.url || "/" } }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close(); const url = (e.notification.data && e.notification.data.url) || "/";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(ws => { for (const w of ws) if (new URL(w.url).pathname.startsWith(new URL(url, self.location.origin).pathname)) return w.focus(); return self.clients.openWindow(url); }));
});
