// Starts the Hub. Loaded last, once every other file is in.
"use strict";

/* ============ boot ============ */
(function boot() {
  // Left on older devices from when the Hub was reached with a PIN: no longer used, so not kept.
  ["fd_api", "fd_pin"].forEach(k => localStorage.removeItem(k));
  const cached = localStorage.getItem("fd_cache");
  if (cached) { try { DATA = JSON.parse(cached); } catch (e) {} }
  const [view, checkin] = location.hash.slice(1).split("/"); // from a tapped notification
  if (VIEWS[view]) {
    VIEW = view;
    if (checkin === "huddle" || checkin === "couples") CHECKIN_OPEN = checkin;
    history.replaceState(null, "", location.pathname);
  }
  render();
  refresh(true);
  POLL = setInterval(() => { if (document.visibilityState === "visible") refresh(true); }, 60000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") { refresh(true); if (SIGNIN) pollSignin(); }
  });
  // iOS can reload the app while Google's page is open: pick the sign-in back up.
  if (!cfg.signedIn && loadSignin()) { pollSignin(); SIGNIN_POLL = setInterval(pollSignin, 2500); }
  if ("serviceWorker" in navigator) {
    // The live Hub's own service worker: there is one per site, and it serves this preview too.
    navigator.serviceWorker.register("../sw.js").catch(() => {});
    navigator.serviceWorker.addEventListener("message", e => openFromNotification(e.data));
  }
  syncPush();
})();
