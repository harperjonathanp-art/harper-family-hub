// Service worker: makes the app installable, lets the shell open offline,
// and shows push notifications.
const CACHE = "family-hub-v9";
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
  if (e.request.mode === "navigate") {
    const network = fetch(e.request, { cache: "no-cache" });
    // Save each good copy for offline use; waitUntil keeps the worker alive until it's written.
    e.waitUntil(network.then(res => {
      if (!res.ok) return;
      const copy = res.clone();
      return caches.open(CACHE).then(c => c.put("./index.html", copy));
    }).catch(() => {}));
    e.respondWith(latestPage(network));
    return;
  }
  e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request)));
});

// The page itself: the latest from the network, so an update shows the first
// time the app opens. The saved copy is used offline, if the server answers
// with an error, or if the network takes more than a few seconds.
function latestPage(network) {
  const saved = () => caches.match("./index.html");
  const good = network.then(res => res.ok ? res : saved().then(hit => hit || res));
  const slow = new Promise(r => setTimeout(r, 4000)).then(saved).then(hit => hit || good);
  return Promise.race([good, slow]).catch(saved);
}

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
