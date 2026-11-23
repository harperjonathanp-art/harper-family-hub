// Service worker: makes the app installable, lets it open offline, and shows push notifications.
//
// The page itself always comes from the network when it can (so an update shows the first time the
// app opens), with the last good copy kept for offline. Every other file of the Hub's own carries its
// release number (?v=), so once fetched it never changes: it's kept and served from here, which is
// what lets the whole app open offline. Live data (the Hub's Worker, fonts, photos) is never kept.
// Raise CACHE when this file changes; that also clears the files of older releases.
const CACHE = "family-hub-v15"; // v15: the Evergreen icon (icons/ have no ?v=, so a new icon needs a new cache)
const RELEASE = "25"; // the ?v= in index.html, so the first install can open offline straight away
const SHELL = ["./index.html", "./manifest.json", "./icons/favicon.svg", "./icons/favicon-32.png",
  "./icons/apple-touch-icon.png", "./icons/icon-192.png", "./icons/icon-512.png", "./icons/icon-512-maskable.png"]
  .concat(["css/themes.css", "css/app.css"].concat(["theme", "data", "shell", "today", "calendar", "dinner", "recipes",
    "tasks", "checkins", "settings", "boot"].map(f => "js/" + f + ".js")).map(f => "./" + f + "?v=" + RELEASE));
self.addEventListener("install", e => {
  // Fresh from the server, not the browser's own short-lived copies (a changed icon keeps its name).
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: "reload" })))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return; // live data (the Hub's Worker, fonts, photos): never kept
  if (e.request.mode === "navigate") {
    const home = new URL(self.registration.scope).pathname;
    if (url.pathname !== home && url.pathname !== home + "index.html") return; // other pages (privacy) as they are
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
  // The Hub's own files: from here if kept, else fetched and kept (a new release has new addresses).
  e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
    if (res.ok && url.searchParams.has("v")) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return res;
  })));
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
    icon: "icons/icon-192.png",
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
