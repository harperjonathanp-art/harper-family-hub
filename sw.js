// Service worker: makes the app installable, lets the shell open offline,
// and shows push notifications.
const CACHE = "family-hub-v6";
const SHELL = ["./index.html", "./manifest.json", "./favicon.svg", "./favicon-32.png",
  "./apple-touch-icon.png", "./icon-192.png", "./icon-512.png", "./icon-512-maskable.png"];
self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.hostname.includes("script.google")) return; // never cache live data
  e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request)));
});

// Every push must show a notification; iOS stops delivering to apps that don't.
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "Family Hub", {
    body: d.body || "",
    tag: d.tag,
    icon: "icon-192.png",
    data: { view: d.view || "today", checkin: d.checkin || null },
  }));
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const data = e.notification.data || {};
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    if (list.length) {
      list[0].postMessage(data);
      return list[0].focus();
    }
    return self.clients.openWindow("./index.html#" + data.view + (data.checkin ? "/" + data.checkin : ""));
  }));
});
